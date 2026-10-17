import { getEnvConfig } from '../config/env';
import { MusicProvider, SnippetPlaybackOptions, Track } from './types';
import { YouTubeMusicProvider } from './YouTubeMusicProvider';

const STORAGE_KEY_SPOTIFY_CATALOG = 'aurelia.spotify.catalog.v1';
const STORAGE_KEY_SPOTIFY_TOKEN = 'aurelia.spotify.access_token.v1';
const STORAGE_KEY_SPOTIFY_REFRESH = 'aurelia.spotify.refresh_token.v1';
const STORAGE_KEY_SPOTIFY_EXPIRES = 'aurelia.spotify.expires_at.v1';
const STORAGE_KEY_SPOTIFY_VERIFIER = 'aurelia.spotify.pkce_verifier.v1';
const STORAGE_KEY_SPOTIFY_YT_MAP = 'aurelia.spotify.yt_map.v1';
const STORAGE_KEY_SPOTIFY_STRATEGY = 'aurelia.spotify.strategy.v1';
export const STORAGE_KEY_ACTIVE_PROVIDER = 'aurelia.active_provider.v1';

const SPOTIFY_SCOPES = [
  'user-library-read',
  'streaming',
  'user-modify-playback-state',
  'user-read-email',
  'user-read-private',
].join(' ');

export type SpotifyPlaybackStrategy = 'youtube-iframe-fallback' | 'web-playback-sdk';

interface SpotifyPlaybackState {
  paused: boolean;
  position: number;
  duration: number;
  track_window?: {
    current_track?: {
      id?: string;
      uri?: string;
    };
  };
}

interface SpotifyPlayerInstance {
  connect: () => Promise<boolean>;
  disconnect: () => void;
  addListener: (
    event: string,
    cb: (payload: {
      device_id?: string;
      message?: string;
      paused?: boolean;
      position?: number;
      duration?: number;
      track_window?: { current_track?: { id?: string; uri?: string } };
    }) => void
  ) => boolean;
  removeListener: (event: string) => boolean;
  getCurrentState: () => Promise<SpotifyPlaybackState | null>;
  setVolume: (volume: number) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  seek: (position_ms: number) => Promise<void>;
  activateElement?: () => Promise<void>;
}

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: {
      Player: new (options: {
        name: string;
        getOAuthToken: (cb: (token: string) => void) => void;
        volume?: number;
      }) => SpotifyPlayerInstance;
    };
  }
}

/**
 * Full Spotify Provider implementing the shared `MusicProvider` interface:
 * - Auth: Authorization Code with PKCE (`user-library-read`, `streaming`, `user-modify-playback-state`)
 * - Track Fetch: Paginated `GET https://api.spotify.com/v1/me/tracks` ("Liked Songs")
 * - Playback Strategy:
 *   - Approach 1 (`web-playback-sdk`): Spotify Web Playback SDK (requires Spotify Premium)
 *   - Approach 2 (`youtube-iframe-fallback`): Matches Spotify track metadata via YouTube Search API
 *     and reuses the hidden YouTube IFrame player for millisecond snippet playback.
 */
export class SpotifyProvider implements MusicProvider {
  public readonly id = 'spotify' as const;
  public readonly displayName = 'Spotify';

  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private expiresAtMs = 0;
  private catalog: Track[] = [];
  private ytVideoMap: Record<string, string> = {};
  private strategy: SpotifyPlaybackStrategy = 'youtube-iframe-fallback';
  private youtubeFallback: YouTubeMusicProvider;

  // Web Playback SDK state
  private sdkPlayer: SpotifyPlayerInstance | null = null;
  private sdkDeviceId: string | null = null;
  private sdkReadyPromise: Promise<string> | null = null;
  private activeTimerId: number | null = null;
  private activeRafId: number | null = null;
  private activeSdkStateCallback: ((state: SpotifyPlaybackState) => void) | null = null;

  constructor(
    youtubeFallback: YouTubeMusicProvider,
    defaultStrategy: SpotifyPlaybackStrategy = 'youtube-iframe-fallback'
  ) {
    this.youtubeFallback = youtubeFallback;
    this.strategy = defaultStrategy;
    this.restoreFromStorage();
  }

  public setPlaybackStrategy(strategy: SpotifyPlaybackStrategy): void {
    this.stopPlayback();
    this.strategy = strategy;
    try {
      localStorage.setItem(STORAGE_KEY_SPOTIFY_STRATEGY, strategy);
    } catch {
      // Ignore storage error
    }
  }

  public getPlaybackStrategy(): SpotifyPlaybackStrategy {
    return this.strategy;
  }

  public isConfigured(): boolean {
    return getEnvConfig().spotify.isConfigured;
  }

  public isAuthenticated(): boolean {
    return Boolean(this.accessToken) || this.catalog.length > 0;
  }

  public hasActiveToken(): boolean {
    return Boolean(this.accessToken && Date.now() < this.expiresAtMs - 30_000);
  }

  private restoreFromStorage(): void {
    try {
      const savedToken = sessionStorage.getItem(STORAGE_KEY_SPOTIFY_TOKEN);
      const savedRefresh = localStorage.getItem(STORAGE_KEY_SPOTIFY_REFRESH);
      const savedExpires = sessionStorage.getItem(STORAGE_KEY_SPOTIFY_EXPIRES);
      if (savedToken) {
        this.accessToken = savedToken;
      }
      if (savedRefresh) {
        this.refreshToken = savedRefresh;
      }
      if (savedExpires) {
        this.expiresAtMs = Number(savedExpires) || 0;
      }

      const savedStrategy = localStorage.getItem(STORAGE_KEY_SPOTIFY_STRATEGY);
      if (
        savedStrategy === 'web-playback-sdk' ||
        savedStrategy === 'youtube-iframe-fallback'
      ) {
        this.strategy = savedStrategy;
      }

      const savedCatalog = localStorage.getItem(STORAGE_KEY_SPOTIFY_CATALOG);
      if (savedCatalog) {
        const parsed = JSON.parse(savedCatalog) as Track[];
        if (Array.isArray(parsed)) {
          this.catalog = parsed;
        }
      }

      const savedMap = localStorage.getItem(STORAGE_KEY_SPOTIFY_YT_MAP);
      if (savedMap) {
        const parsedMap = JSON.parse(savedMap) as Record<string, string>;
        if (parsedMap && typeof parsedMap === 'object') {
          this.ytVideoMap = parsedMap;
        }
      }
    } catch {
      // Ignore storage errors
    }
  }

  private async generatePkcePair(): Promise<{ verifier: string; challenge: string }> {
    const array = new Uint8Array(48);
    crypto.getRandomValues(array);
    const verifier = btoa(String.fromCharCode(...array))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    return { verifier, challenge };
  }

  public async authenticate(): Promise<void> {
    const { spotify } = getEnvConfig();
    if (!spotify.clientId) {
      throw new Error(
        'Missing VITE_SPOTIFY_CLIENT_ID. Configure your Spotify Developer Client ID in .env.local.'
      );
    }

    const { verifier, challenge } = await this.generatePkcePair();
    try {
      sessionStorage.setItem(STORAGE_KEY_SPOTIFY_VERIFIER, verifier);
      localStorage.setItem(STORAGE_KEY_ACTIVE_PROVIDER, 'spotify');
    } catch {
      // Ignore storage errors
    }

    const params = new URLSearchParams({
      client_id: spotify.clientId,
      response_type: 'code',
      redirect_uri: spotify.redirectUri,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope: SPOTIFY_SCOPES,
    });

    window.location.assign(`https://accounts.spotify.com/authorize?${params.toString()}`);
  }

  public async handleRedirectCallback(code: string): Promise<void> {
    const { spotify } = getEnvConfig();
    const verifier = sessionStorage.getItem(STORAGE_KEY_SPOTIFY_VERIFIER);
    if (!verifier || !spotify.clientId) {
      throw new Error('Missing PKCE code verifier or Spotify Client ID.');
    }

    const body = new URLSearchParams({
      client_id: spotify.clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: spotify.redirectUri,
      code_verifier: verifier,
    });

    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Spotify token exchange failed (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    this.saveTokenData(data.access_token, data.refresh_token, data.expires_in ?? 3600);
    sessionStorage.removeItem(STORAGE_KEY_SPOTIFY_VERIFIER);
  }

  private saveTokenData(accessToken: string, refreshToken?: string, expiresInSec = 3600): void {
    this.accessToken = accessToken;
    this.expiresAtMs = Date.now() + expiresInSec * 1000;
    if (refreshToken) {
      this.refreshToken = refreshToken;
    }
    try {
      sessionStorage.setItem(STORAGE_KEY_SPOTIFY_TOKEN, accessToken);
      sessionStorage.setItem(STORAGE_KEY_SPOTIFY_EXPIRES, String(this.expiresAtMs));
      if (refreshToken) {
        localStorage.setItem(STORAGE_KEY_SPOTIFY_REFRESH, refreshToken);
      }
    } catch {
      // Ignore storage errors
    }
  }

  private async ensureValidAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAtMs - 30_000) {
      return this.accessToken;
    }

    const { spotify } = getEnvConfig();
    if (this.refreshToken && spotify.clientId) {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: spotify.clientId,
      });

      const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (response.ok) {
        const data = (await response.json()) as {
          access_token: string;
          refresh_token?: string;
          expires_in?: number;
        };
        this.saveTokenData(data.access_token, data.refresh_token, data.expires_in ?? 3600);
        return data.access_token;
      }
    }

    if (this.accessToken) {
      return this.accessToken;
    }

    await this.authenticate();
    throw new Error('Redirecting to Spotify login...');
  }

  public disconnect(): void {
    this.stopPlayback();
    if (this.sdkPlayer) {
      try {
        this.sdkPlayer.disconnect();
      } catch {
        // Ignore
      }
      this.sdkPlayer = null;
      this.sdkDeviceId = null;
      this.sdkReadyPromise = null;
    }
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAtMs = 0;
    this.catalog = [];
    try {
      sessionStorage.removeItem(STORAGE_KEY_SPOTIFY_TOKEN);
      sessionStorage.removeItem(STORAGE_KEY_SPOTIFY_EXPIRES);
      sessionStorage.removeItem(STORAGE_KEY_SPOTIFY_VERIFIER);
      localStorage.removeItem(STORAGE_KEY_SPOTIFY_REFRESH);
      localStorage.removeItem(STORAGE_KEY_SPOTIFY_CATALOG);
    } catch {
      // Ignore
    }
  }

  public async fetchLikedTracks(forceRefresh = false): Promise<Track[]> {
    if (!forceRefresh && this.catalog.length > 0) {
      return this.catalog;
    }

    const token = await this.ensureValidAccessToken();
    const collected: Track[] = [];
    const seenIds = new Set<string>();
    const limit = 50;
    const maxPages = 10; // Up to 500 liked songs

    for (let page = 0; page < maxPages; page++) {
      const offset = page * limit;
      let response: Response;
      try {
        response = await fetch(
          `https://api.spotify.com/v1/me/tracks?limit=${limit}&offset=${offset}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );
      } catch (err) {
        if (collected.length > 0) break;
        if (this.catalog.length > 0) return this.catalog;
        throw err;
      }

      if (response.status === 401) {
        this.accessToken = null;
        sessionStorage.removeItem(STORAGE_KEY_SPOTIFY_TOKEN);
        throw new Error('Spotify session expired. Please click Sign In with Spotify again.');
      }

      if (!response.ok) {
        if (collected.length > 0) break;
        const errText = await response.text();
        throw new Error(`Spotify API error (${response.status}): ${errText}`);
      }

      const data = (await response.json()) as {
        next?: string | null;
        items?: Array<{
          track?: {
            id?: string;
            uri?: string;
            name?: string;
            duration_ms?: number;
            is_local?: boolean;
            artists?: Array<{ name?: string }>;
            album?: { images?: Array<{ url?: string }> };
          };
        }>;
      };

      for (const item of data.items ?? []) {
        const t = item.track;
        if (!t?.id || !t.name || t.is_local || seenIds.has(t.id)) {
          continue;
        }
        seenIds.add(t.id);

        collected.push({
          id: t.id,
          videoId: this.ytVideoMap[t.id],
          title: t.name.trim(),
          artist:
            (t.artists ?? [])
              .map((a) => a.name?.trim())
              .filter(Boolean)
              .join(', ') || 'Unknown Artist',
          artworkUrl: t.album?.images?.[0]?.url,
          durationSec: t.duration_ms ? Math.round(t.duration_ms / 1000) : undefined,
          spotifyUri: t.uri || `spotify:track:${t.id}`,
          provider: 'spotify',
        });
      }

      if (!data.next) {
        break;
      }
    }

    this.catalog = collected;
    try {
      localStorage.setItem(STORAGE_KEY_SPOTIFY_CATALOG, JSON.stringify(collected));
    } catch {
      // Ignore quota errors
    }

    return this.catalog;
  }

  public getCachedCatalog(): Track[] {
    return this.catalog;
  }

  private async initializeWebPlaybackSdk(): Promise<string> {
    if (this.sdkDeviceId && this.sdkPlayer) {
      return this.sdkDeviceId;
    }
    if (this.sdkReadyPromise) {
      return this.sdkReadyPromise;
    }

    await this.ensureValidAccessToken();

    this.sdkReadyPromise = new Promise<string>((resolve, reject) => {
      const mountSdk = () => {
        if (!window.Spotify?.Player) {
          this.sdkReadyPromise = null;
          reject(new Error('Spotify Web Playback SDK failed to load.'));
          return;
        }

        const player = new window.Spotify.Player({
          name: 'Aurelia Music Quiz Player',
          getOAuthToken: (cb) => {
            void this.ensureValidAccessToken()
              .then((t) => cb(t))
              .catch(() => {
                if (this.accessToken) cb(this.accessToken);
              });
          },
          volume: 1.0,
        });

        player.addListener('ready', ({ device_id }) => {
          if (device_id) {
            this.sdkDeviceId = device_id;
            resolve(device_id);
          }
        });

        player.addListener('not_ready', () => {
          this.sdkDeviceId = null;
        });

        player.addListener('initialization_error', ({ message }) => {
          this.sdkReadyPromise = null;
          reject(new Error(`Spotify SDK initialization error: ${message}`));
        });

        player.addListener('authentication_error', ({ message }) => {
          this.sdkReadyPromise = null;
          reject(new Error(`Spotify SDK auth error: ${message}`));
        });

        player.addListener('account_error', () => {
          this.sdkReadyPromise = null;
          reject(
            new Error(
              'Spotify Web Playback SDK requires a Spotify Premium account. Switch Playback Strategy to "YouTube IFrame Match" in the toolbar.'
            )
          );
        });

        player.addListener('player_state_changed', (state) => {
          if (state && typeof state.paused === 'boolean') {
            this.activeSdkStateCallback?.(state as SpotifyPlaybackState);
          }
        });

        this.sdkPlayer = player;
        void player.connect();
      };

      if (window.Spotify?.Player) {
        mountSdk();
        return;
      }

      const prevReady = window.onSpotifyWebPlaybackSDKReady;
      window.onSpotifyWebPlaybackSDKReady = () => {
        prevReady?.();
        mountSdk();
      };

      const existingScript = document.querySelector<HTMLScriptElement>(
        'script[src="https://sdk.scdn.co/spotify-player.js"]'
      );
      if (!existingScript) {
        const script = document.createElement('script');
        script.src = 'https://sdk.scdn.co/spotify-player.js';
        script.async = true;
        script.onerror = () => {
          this.sdkReadyPromise = null;
          reject(new Error('Failed to load https://sdk.scdn.co/spotify-player.js'));
        };
        document.head.appendChild(script);
      }
    });

    return this.sdkReadyPromise;
  }

  public async initializePlayer(containerElement?: HTMLElement): Promise<void> {
    if (this.strategy === 'youtube-iframe-fallback') {
      await this.youtubeFallback.initializePlayer(containerElement);
    } else {
      await this.initializeWebPlaybackSdk();
    }
  }

  private async resolveYouTubeVideoId(track: Track): Promise<string> {
    if (track.videoId) {
      return track.videoId;
    }
    if (this.ytVideoMap[track.id]) {
      track.videoId = this.ytVideoMap[track.id];
      return track.videoId;
    }

    const { google } = getEnvConfig();
    if (!google.apiKey) {
      throw new Error(
        'VITE_GOOGLE_API_KEY is required to match Spotify tracks via YouTube Search.'
      );
    }

    const query = `${track.artist} - ${track.title} Official Audio`;
    const params = new URLSearchParams({
      part: 'snippet',
      q: query,
      type: 'video',
      videoCategoryId: '10',
      videoEmbeddable: 'true',
      maxResults: '1',
      key: google.apiKey,
    });

    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/search?${params.toString()}`
    );
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`YouTube Search match failed (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as {
      items?: Array<{ id?: { videoId?: string } }>;
    };
    const videoId = data.items?.[0]?.id?.videoId;
    if (!videoId) {
      throw new Error(`No embeddable YouTube match found for "${track.artist} – ${track.title}".`);
    }

    track.videoId = videoId;
    this.ytVideoMap[track.id] = videoId;
    try {
      localStorage.setItem(STORAGE_KEY_SPOTIFY_YT_MAP, JSON.stringify(this.ytVideoMap));
    } catch {
      // Ignore storage quota errors
    }
    return videoId;
  }

  public async cueTrack(track: Track): Promise<{ durationSec?: number }> {
    this.stopPlayback();
    if (this.strategy === 'youtube-iframe-fallback') {
      const videoId = await this.resolveYouTubeVideoId(track);
      const cued = await this.youtubeFallback.cueTrack({ ...track, videoId });
      return { durationSec: cued.durationSec ?? track.durationSec };
    }

    await this.initializeWebPlaybackSdk();
    return { durationSec: track.durationSec };
  }

  public async playSnippet(track: Track, options: SnippetPlaybackOptions): Promise<void> {
    this.stopPlayback();

    if (this.strategy === 'youtube-iframe-fallback') {
      const videoId = await this.resolveYouTubeVideoId(track);
      return this.youtubeFallback.playSnippet({ ...track, videoId }, options);
    }

    // Approach 1: Spotify Web Playback SDK
    const deviceId = await this.initializeWebPlaybackSdk();
    const token = await this.ensureValidAccessToken();
    await this.sdkPlayer?.activateElement?.();

    const durationMs = Math.max(100, Math.min(30000, Math.round(options.durationSec * 1000)));
    const startPositionMs = Math.max(0, Math.round(options.startOffsetSec * 1000));
    const spotifyUri = track.spotifyUri || `spotify:track:${track.id}`;

    return new Promise<void>((resolve, reject) => {
      let timerStarted = false;

      const startPrecisionCountdown = () => {
        if (timerStarted) return;
        timerStarted = true;
        const startPerf = performance.now();

        const tick = () => {
          const elapsedMs = performance.now() - startPerf;
          const elapsedSec = Math.min(options.durationSec, elapsedMs / 1000);
          options.onProgress?.(elapsedSec);
          if (elapsedMs < durationMs) {
            this.activeRafId = requestAnimationFrame(tick);
          }
        };

        this.activeRafId = requestAnimationFrame(tick);
        this.activeTimerId = window.setTimeout(() => {
          this.stopPlayback();
          options.onProgress?.(options.durationSec);
          options.onComplete?.();
          resolve();
        }, durationMs);
      };

      this.activeSdkStateCallback = (state) => {
        if (!state.paused) {
          startPrecisionCountdown();
        }
      };

      void fetch(
        `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            uris: [spotifyUri],
            position_ms: startPositionMs,
          }),
        }
      )
        .then((res) => {
          if (!res.ok) {
            throw new Error(
              `Spotify Web Playback error (${res.status}). Ensure Spotify Premium is active or switch to YouTube IFrame Match.`
            );
          }
          // Fallback trigger if state callback was already firing
          window.setTimeout(() => {
            if (!timerStarted) {
              startPrecisionCountdown();
            }
          }, 350);
        })
        .catch((err) => {
          this.stopPlayback();
          const errorObj = err instanceof Error ? err : new Error(String(err));
          options.onError?.(errorObj);
          reject(errorObj);
        });
    });
  }

  public async playFullTrack(track: Track, startOffsetSec = 0): Promise<void> {
    if (this.activeTimerId !== null) {
      window.clearTimeout(this.activeTimerId);
      this.activeTimerId = null;
    }
    if (this.activeRafId !== null) {
      cancelAnimationFrame(this.activeRafId);
      this.activeRafId = null;
    }
    this.activeSdkStateCallback = null;

    if (this.strategy === 'youtube-iframe-fallback') {
      const videoId = await this.resolveYouTubeVideoId(track);
      await this.youtubeFallback.playFullTrack({ ...track, videoId }, startOffsetSec);
      return;
    }

    const deviceId = await this.initializeWebPlaybackSdk();
    const token = await this.ensureValidAccessToken();
    await this.sdkPlayer?.activateElement?.();

    const state = await this.sdkPlayer?.getCurrentState();
    if (state && !state.paused && state.track_window?.current_track?.id === track.id) {
      // Already playing this track
      return;
    }

    const spotifyUri = track.spotifyUri || `spotify:track:${track.id}`;
    await fetch(
      `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          uris: [spotifyUri],
          position_ms: Math.max(0, Math.round(startOffsetSec * 1000)),
        }),
      }
    );
  }

  public stopPlayback(): void {
    if (this.activeTimerId !== null) {
      window.clearTimeout(this.activeTimerId);
      this.activeTimerId = null;
    }
    if (this.activeRafId !== null) {
      cancelAnimationFrame(this.activeRafId);
      this.activeRafId = null;
    }
    this.activeSdkStateCallback = null;

    if (this.strategy === 'youtube-iframe-fallback') {
      this.youtubeFallback.stopPlayback();
    } else if (this.sdkPlayer) {
      void this.sdkPlayer.pause().catch(() => {
        // Ignore
      });
    }
  }

  public destroy(): void {
    this.stopPlayback();
    if (this.sdkPlayer) {
      try {
        this.sdkPlayer.disconnect();
      } catch {
        // Ignore
      }
      this.sdkPlayer = null;
      this.sdkDeviceId = null;
      this.sdkReadyPromise = null;
    }
  }
}
