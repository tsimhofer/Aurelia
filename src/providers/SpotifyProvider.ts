import { getEnvConfig } from '../config/env';
import { MusicProvider, SnippetPlaybackOptions, Track } from './types';
import { YouTubeMusicProvider } from './YouTubeMusicProvider';

const STORAGE_KEY_SPOTIFY_CATALOG = 'aurelia.spotify.catalog.v1';
const STORAGE_KEY_SPOTIFY_TOKEN = 'aurelia.spotify.access_token.v1';
const STORAGE_KEY_SPOTIFY_VERIFIER = 'aurelia.spotify.pkce_verifier.v1';

const SPOTIFY_SCOPES = [
  'user-library-read',
  'streaming',
  'user-modify-playback-state',
].join(' ');

export type SpotifyPlaybackStrategy = 'web-playback-sdk' | 'youtube-iframe-fallback';

/**
 * Modular Spotify Provider (Staged for future activation).
 *
 * Supports:
 * - Authorization Code with PKCE (`user-library-read`, `streaming`, `user-modify-playback-state`)
 * - Track Fetch via `GET https://api.spotify.com/v1/me/tracks`
 * - Dual Playback Strategy:
 *   1. `web-playback-sdk`: Native Spotify Web Playback SDK (requires Spotify Premium)
 *   2. `youtube-iframe-fallback`: Matches Spotify track metadata via YouTube Search API and
 *      reuses the hidden YouTube IFrame player for millisecond snippet scrubbing.
 */
export class SpotifyProvider implements MusicProvider {
  public readonly id = 'spotify' as const;
  public readonly displayName = 'Spotify';

  private accessToken: string | null = null;
  private catalog: Track[] = [];
  private strategy: SpotifyPlaybackStrategy;
  private youtubeFallback: YouTubeMusicProvider;

  constructor(
    youtubeFallback: YouTubeMusicProvider,
    strategy: SpotifyPlaybackStrategy = 'youtube-iframe-fallback'
  ) {
    this.youtubeFallback = youtubeFallback;
    this.strategy = strategy;
    this.restoreFromStorage();
  }

  public setPlaybackStrategy(strategy: SpotifyPlaybackStrategy): void {
    this.strategy = strategy;
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

  private restoreFromStorage(): void {
    try {
      const savedToken = sessionStorage.getItem(STORAGE_KEY_SPOTIFY_TOKEN);
      if (savedToken) {
        this.accessToken = savedToken;
      }
      const savedCatalog = localStorage.getItem(STORAGE_KEY_SPOTIFY_CATALOG);
      if (savedCatalog) {
        const parsed = JSON.parse(savedCatalog) as Track[];
        if (Array.isArray(parsed)) {
          this.catalog = parsed;
        }
      }
    } catch {
      // Ignore storage errors
    }
  }

  private async generatePkcePair(): Promise<{ verifier: string; challenge: string }> {
    const array = new Uint8Array(32);
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
        'Spotify provider is staged. Configure VITE_SPOTIFY_CLIENT_ID and VITE_SPOTIFY_REDIRECT_URI in .env.local to activate.'
      );
    }

    const { verifier, challenge } = await this.generatePkcePair();
    sessionStorage.setItem(STORAGE_KEY_SPOTIFY_VERIFIER, verifier);

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
      throw new Error(`Spotify token exchange failed (${response.status}).`);
    }

    const data = (await response.json()) as { access_token: string };
    this.accessToken = data.access_token;
    sessionStorage.setItem(STORAGE_KEY_SPOTIFY_TOKEN, data.access_token);
    sessionStorage.removeItem(STORAGE_KEY_SPOTIFY_VERIFIER);
  }

  public disconnect(): void {
    this.stopPlayback();
    this.accessToken = null;
    this.catalog = [];
    try {
      sessionStorage.removeItem(STORAGE_KEY_SPOTIFY_TOKEN);
      localStorage.removeItem(STORAGE_KEY_SPOTIFY_CATALOG);
    } catch {
      // Ignore
    }
  }

  public async fetchLikedTracks(forceRefresh = false): Promise<Track[]> {
    if (!forceRefresh && this.catalog.length > 0) {
      return this.catalog;
    }
    if (!this.accessToken) {
      await this.authenticate();
      return [];
    }

    const response = await fetch('https://api.spotify.com/v1/me/tracks?limit=50', {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Spotify API error (${response.status}) when fetching /v1/me/tracks.`);
    }

    const data = (await response.json()) as {
      items?: Array<{
        track?: {
          id?: string;
          uri?: string;
          name?: string;
          duration_ms?: number;
          artists?: Array<{ name?: string }>;
          album?: { images?: Array<{ url?: string }> };
        };
      }>;
    };

    const tracks: Track[] = [];
    for (const item of data.items ?? []) {
      const t = item.track;
      if (!t?.id || !t.name) continue;
      tracks.push({
        id: t.id,
        title: t.name,
        artist: (t.artists ?? []).map((a) => a.name).filter(Boolean).join(', ') || 'Unknown Artist',
        artworkUrl: t.album?.images?.[0]?.url,
        durationSec: t.duration_ms ? t.duration_ms / 1000 : undefined,
        spotifyUri: t.uri,
        provider: 'spotify',
      });
    }

    this.catalog = tracks;
    try {
      localStorage.setItem(STORAGE_KEY_SPOTIFY_CATALOG, JSON.stringify(tracks));
    } catch {
      // Ignore
    }
    return this.catalog;
  }

  public getCachedCatalog(): Track[] {
    return this.catalog;
  }

  public async initializePlayer(containerElement?: HTMLElement): Promise<void> {
    if (this.strategy === 'youtube-iframe-fallback') {
      await this.youtubeFallback.initializePlayer(containerElement);
    }
  }

  private async resolveYouTubeVideoId(track: Track): Promise<string> {
    if (track.videoId) {
      return track.videoId;
    }

    const { google } = getEnvConfig();
    if (!google.apiKey) {
      throw new Error('VITE_GOOGLE_API_KEY is required to match Spotify tracks on YouTube.');
    }

    const query = `${track.artist} - ${track.title} audio`;
    const params = new URLSearchParams({
      part: 'snippet',
      q: query,
      type: 'video',
      videoCategoryId: '10',
      maxResults: '1',
      key: google.apiKey,
    });

    const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`YouTube Search fallback failed (${response.status}).`);
    }

    const data = (await response.json()) as {
      items?: Array<{ id?: { videoId?: string } }>;
    };
    const videoId = data.items?.[0]?.id?.videoId;
    if (!videoId) {
      throw new Error(`No matching YouTube video found for "${track.title}".`);
    }

    track.videoId = videoId;
    return videoId;
  }

  public async cueTrack(track: Track): Promise<{ durationSec?: number }> {
    if (this.strategy === 'youtube-iframe-fallback') {
      const videoId = await this.resolveYouTubeVideoId(track);
      return this.youtubeFallback.cueTrack({ ...track, videoId });
    }
    return { durationSec: track.durationSec };
  }

  public async playSnippet(track: Track, options: SnippetPlaybackOptions): Promise<void> {
    if (this.strategy === 'youtube-iframe-fallback') {
      const videoId = await this.resolveYouTubeVideoId(track);
      return this.youtubeFallback.playSnippet({ ...track, videoId }, options);
    }
    throw new Error('Spotify Web Playback SDK strategy is staged. Use YouTube IFrame fallback or configure Premium SDK.');
  }

  public stopPlayback(): void {
    if (this.strategy === 'youtube-iframe-fallback') {
      this.youtubeFallback.stopPlayback();
    }
  }

  public destroy(): void {
    this.stopPlayback();
  }
}
