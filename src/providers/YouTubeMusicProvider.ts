import { getEnvConfig } from '../config/env';
import { MusicProvider, SnippetPlaybackOptions, Track } from './types';

const STORAGE_KEY_CATALOG = 'aurelia.ytm.catalog.v1';
const STORAGE_KEY_TOKEN = 'aurelia.ytm.access_token.v1';
const YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: {
              access_token?: string;
              expires_in?: number;
              error?: string;
              error_description?: string;
            }) => void;
            error_callback?: (err: { type: string; message?: string }) => void;
          }) => {
            requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
          };
          revoke: (token: string, done?: () => void) => void;
        };
      };
    };
    YT?: {
      Player: new (
        elementIdOrEl: string | HTMLElement,
        options: {
          height?: string | number;
          width?: string | number;
          videoId?: string;
          playerVars?: Record<string, string | number>;
          events?: {
            onReady?: (event: { target: YTPlayerInstance }) => void;
            onStateChange?: (event: { data: number; target: YTPlayerInstance }) => void;
            onError?: (event: { data: number }) => void;
          };
        }
      ) => YTPlayerInstance;
      PlayerState: {
        UNSTARTED: -1;
        ENDED: 0;
        PLAYING: 1;
        PAUSED: 2;
        BUFFERING: 3;
        CUED: 5;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

export interface YTPlayerInstance {
  cueVideoById: (options: { videoId: string; startSeconds?: number }) => void;
  loadVideoById: (options: { videoId: string; startSeconds?: number }) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  stopVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  setVolume: (volume: number) => void;
  destroy: () => void;
}

interface YouTubePlaylistItemsResponse {
  nextPageToken?: string;
  items?: Array<{
    snippet?: {
      title?: string;
      videoOwnerChannelTitle?: string;
      channelTitle?: string;
      thumbnails?: {
        high?: { url?: string };
        medium?: { url?: string };
        default?: { url?: string };
      };
      resourceId?: {
        videoId?: string;
      };
    };
    contentDetails?: {
      videoId?: string;
    };
  }>;
}

function cleanChannelTitle(raw: string): string {
  return raw.replace(/\s*-\s*Topic$/i, '').trim();
}

export class YouTubeMusicProvider implements MusicProvider {
  public readonly id = 'youtube-music' as const;
  public readonly displayName = 'YouTube Music';

  private accessToken: string | null = null;
  private catalog: Track[] = [];
  private player: YTPlayerInstance | null = null;
  private playerReadyPromise: Promise<YTPlayerInstance> | null = null;
  private activeTimerId: number | null = null;
  private activeRafId: number | null = null;
  private activeStateListener: ((state: number) => void) | null = null;
  private activeErrorListener: ((code: number) => void) | null = null;
  private cuedVideoId: string | null = null;

  constructor() {
    this.restoreFromStorage();
  }

  public isConfigured(): boolean {
    return getEnvConfig().google.isConfigured;
  }

  public isAuthenticated(): boolean {
    return Boolean(this.accessToken) || this.catalog.length > 0;
  }

  public hasActiveToken(): boolean {
    return Boolean(this.accessToken);
  }

  private restoreFromStorage(): void {
    try {
      const savedToken = sessionStorage.getItem(STORAGE_KEY_TOKEN);
      if (savedToken) {
        this.accessToken = savedToken;
      }
      const savedCatalog = localStorage.getItem(STORAGE_KEY_CATALOG);
      if (savedCatalog) {
        const parsed = JSON.parse(savedCatalog) as Track[];
        if (Array.isArray(parsed)) {
          this.catalog = parsed;
        }
      }
    } catch {
      // Ignore storage access errors in restricted contexts
    }
  }

  private loadGisScript(): Promise<void> {
    if (window.google?.accounts?.oauth2) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(
        'script[src="https://accounts.google.com/gsi/client"]'
      );
      if (existing) {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('Failed to load Google Identity Services')), {
          once: true,
        });
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Google Identity Services script'));
      document.head.appendChild(script);
    });
  }

  public async authenticate(): Promise<void> {
    const { google } = getEnvConfig();
    if (!google.clientId) {
      throw new Error(
        'Missing VITE_GOOGLE_CLIENT_ID. Configure your Google Cloud OAuth 2.0 Client ID in .env.local.'
      );
    }

    await this.loadGisScript();

    return new Promise<void>((resolve, reject) => {
      const oauth2 = window.google?.accounts?.oauth2;
      if (!oauth2) {
        reject(new Error('Google Identity Services OAuth2 client unavailable.'));
        return;
      }

      const tokenClient = oauth2.initTokenClient({
        client_id: google.clientId,
        scope: YOUTUBE_READONLY_SCOPE,
        callback: (response) => {
          if (response.error || !response.access_token) {
            reject(
              new Error(response.error_description || response.error || 'OAuth authorization failed.')
            );
            return;
          }
          this.accessToken = response.access_token;
          try {
            sessionStorage.setItem(STORAGE_KEY_TOKEN, response.access_token);
          } catch {
            // Ignore session storage errors
          }
          resolve();
        },
        error_callback: (err) => {
          reject(new Error(err.message || `Google OAuth error: ${err.type}`));
        },
      });

      tokenClient.requestAccessToken({ prompt: 'consent' });
    });
  }

  public disconnect(): void {
    this.stopPlayback();
    if (this.accessToken && window.google?.accounts?.oauth2) {
      try {
        window.google.accounts.oauth2.revoke(this.accessToken);
      } catch {
        // Ignore revoke errors
      }
    }
    this.accessToken = null;
    this.catalog = [];
    try {
      sessionStorage.removeItem(STORAGE_KEY_TOKEN);
      localStorage.removeItem(STORAGE_KEY_CATALOG);
    } catch {
      // Ignore storage errors
    }
  }

  public async fetchLikedTracks(forceRefresh = false): Promise<Track[]> {
    if (!forceRefresh && this.catalog.length > 0) {
      return this.catalog;
    }

    if (!this.accessToken) {
      await this.authenticate();
    }

    const { google } = getEnvConfig();
    const collected: Track[] = [];
    const seenVideoIds = new Set<string>();
    let pageToken: string | undefined;
    const maxPages = 10; // Up to 500 liked tracks

    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({
        part: 'snippet,contentDetails',
        playlistId: 'LM',
        maxResults: '50',
      });
      if (google.apiKey) {
        params.set('key', google.apiKey);
      }
      if (pageToken) {
        params.set('pageToken', pageToken);
      }

      const response = await fetch(
        `https://www.googleapis.com/youtube/v3/playlistItems?${params.toString()}`,
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            Accept: 'application/json',
          },
        }
      );

      if (response.status === 401) {
        this.accessToken = null;
        sessionStorage.removeItem(STORAGE_KEY_TOKEN);
        throw new Error('YouTube OAuth token expired. Please reconnect your account.');
      }

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`YouTube Data API error (${response.status}): ${errBody}`);
      }

      const data = (await response.json()) as YouTubePlaylistItemsResponse;
      for (const item of data.items ?? []) {
        const videoId = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
        const rawTitle = item.snippet?.title?.trim();
        const rawChannel =
          item.snippet?.videoOwnerChannelTitle?.trim() ||
          item.snippet?.channelTitle?.trim() ||
          'Unknown Artist';

        if (
          !videoId ||
          !rawTitle ||
          rawTitle === 'Private video' ||
          rawTitle === 'Deleted video' ||
          seenVideoIds.has(videoId)
        ) {
          continue;
        }

        seenVideoIds.add(videoId);
        const artworkUrl =
          item.snippet?.thumbnails?.high?.url ||
          item.snippet?.thumbnails?.medium?.url ||
          item.snippet?.thumbnails?.default?.url;

        collected.push({
          id: videoId,
          videoId,
          title: rawTitle,
          artist: cleanChannelTitle(rawChannel),
          channelTitle: rawChannel,
          artworkUrl,
          provider: 'youtube-music',
        });
      }

      pageToken = data.nextPageToken;
      if (!pageToken) {
        break;
      }
    }

    this.catalog = collected;
    try {
      localStorage.setItem(STORAGE_KEY_CATALOG, JSON.stringify(collected));
    } catch {
      // Ignore quota errors
    }

    return this.catalog;
  }

  public getCachedCatalog(): Track[] {
    return this.catalog;
  }

  public async initializePlayer(containerElement?: HTMLElement): Promise<void> {
    if (this.player) {
      return;
    }
    if (this.playerReadyPromise) {
      await this.playerReadyPromise;
      return;
    }

    this.playerReadyPromise = new Promise<YTPlayerInstance>((resolve, reject) => {
      const mountPlayer = () => {
        if (!window.YT?.Player) {
          reject(new Error('YouTube IFrame API failed to initialize.'));
          return;
        }

        let hostEl = containerElement ?? document.getElementById('aurelia-yt-hidden-player');
        if (!hostEl) {
          const wrapper = document.createElement('div');
          wrapper.id = 'aurelia-yt-hidden-wrapper';
          wrapper.style.position = 'fixed';
          wrapper.style.width = '1px';
          wrapper.style.height = '1px';
          wrapper.style.bottom = '0';
          wrapper.style.right = '0';
          wrapper.style.opacity = '0.001';
          wrapper.style.pointerEvents = 'none';
          wrapper.style.overflow = 'hidden';
          wrapper.style.zIndex = '-1';
          wrapper.setAttribute('aria-hidden', 'true');

          hostEl = document.createElement('div');
          hostEl.id = 'aurelia-yt-hidden-player';
          wrapper.appendChild(hostEl);
          document.body.appendChild(wrapper);
        }

        this.player = new window.YT.Player(hostEl, {
          height: '1',
          width: '1',
          playerVars: {
            autoplay: 0,
            controls: 0,
            disablekb: 1,
            fs: 0,
            iv_load_policy: 3,
            modestbranding: 1,
            playsinline: 1,
            rel: 0,
            origin: window.location.origin,
          },
          events: {
            onReady: (event) => {
              event.target.setVolume(100);
              resolve(event.target);
            },
            onStateChange: (event) => {
              this.activeStateListener?.(event.data);
            },
            onError: (event) => {
              this.activeErrorListener?.(event.data);
            },
          },
        });
      };

      if (window.YT?.Player) {
        mountPlayer();
        return;
      }

      const previousCallback = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previousCallback?.();
        mountPlayer();
      };

      const existingScript = document.querySelector<HTMLScriptElement>(
        'script[src="https://www.youtube.com/iframe_api"]'
      );
      if (!existingScript) {
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.async = true;
        script.onerror = () => reject(new Error('Failed to load YouTube IFrame API script.'));
        document.head.appendChild(script);
      }
    });

    await this.playerReadyPromise;
  }

  public async cueTrack(track: Track): Promise<{ durationSec?: number }> {
    await this.initializePlayer();
    if (!this.player) {
      throw new Error('YouTube player is not initialized.');
    }

    const videoId = track.videoId || track.id;
    this.stopPlayback();

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.activeStateListener = null;
        this.activeErrorListener = null;
        resolve({ durationSec: this.player?.getDuration() || track.durationSec });
      }, 4000);

      this.activeErrorListener = (errorCode) => {
        window.clearTimeout(timeout);
        this.activeStateListener = null;
        this.activeErrorListener = null;
        reject(new Error(`YouTube video playback restricted or unavailable (code ${errorCode}).`));
      };

      this.activeStateListener = (state) => {
        if (state === window.YT?.PlayerState.CUED || state === window.YT?.PlayerState.PAUSED) {
          window.clearTimeout(timeout);
          this.activeStateListener = null;
          this.activeErrorListener = null;
          const dur = this.player?.getDuration();
          resolve({ durationSec: dur && dur > 0 ? dur : track.durationSec });
        }
      };

      this.cuedVideoId = videoId;
      this.player!.cueVideoById({ videoId, startSeconds: 0 });
    });
  }

  public async playSnippet(track: Track, options: SnippetPlaybackOptions): Promise<void> {
    await this.initializePlayer();
    if (!this.player) {
      throw new Error('YouTube player is not initialized.');
    }

    this.stopPlayback();

    const videoId = track.videoId || track.id;
    const durationMs = Math.max(100, Math.min(30000, Math.round(options.durationSec * 1000)));

    return new Promise<void>((resolve, reject) => {
      let snippetStarted = false;

      const cleanupListeners = () => {
        this.activeStateListener = null;
        this.activeErrorListener = null;
      };

      this.activeErrorListener = (errorCode) => {
        this.stopPlayback();
        const err = new Error(`YouTube IFrame playback error (code ${errorCode}).`);
        options.onError?.(err);
        reject(err);
      };

      const startPrecisionTimer = () => {
        if (snippetStarted) return;
        snippetStarted = true;
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

      this.activeStateListener = (state) => {
        if (state === window.YT?.PlayerState.PLAYING) {
          startPrecisionTimer();
        } else if (state === window.YT?.PlayerState.ENDED && snippetStarted) {
          cleanupListeners();
          this.stopPlayback();
          options.onComplete?.();
          resolve();
        }
      };

      if (this.cuedVideoId !== videoId) {
        this.cuedVideoId = videoId;
        this.player!.loadVideoById({
          videoId,
          startSeconds: options.startOffsetSec,
        });
      } else {
        this.player!.seekTo(options.startOffsetSec, true);
        this.player!.playVideo();
      }
    });
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
    this.activeStateListener = null;
    this.activeErrorListener = null;

    if (this.player) {
      try {
        this.player.pauseVideo();
      } catch {
        // Ignore if player is not yet ready
      }
    }
  }

  public destroy(): void {
    this.stopPlayback();
    if (this.player) {
      try {
        this.player.destroy();
      } catch {
        // Ignore
      }
      this.player = null;
      this.playerReadyPromise = null;
    }
  }
}
