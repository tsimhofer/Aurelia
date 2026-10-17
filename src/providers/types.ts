export type ProviderId = 'youtube-music' | 'spotify';

export interface Track {
  /** Provider-specific unique ID (e.g., YouTube videoId or Spotify track ID) */
  id: string;
  /** Video ID for YouTube IFrame playback (direct for YT, resolved for Spotify fallback) */
  videoId?: string;
  /** Cleaned or raw track title */
  title: string;
  /** Artist or channel name (channelTitle in YouTube Data API v3) */
  artist: string;
  /** Raw YouTube channelTitle if applicable */
  channelTitle?: string;
  /** Album or thumbnail image URL */
  artworkUrl?: string;
  /** Known duration in seconds (optional, updated once loaded in player) */
  durationSec?: number;
  /** Source provider identifier */
  provider: ProviderId;
  /** Optional Spotify URI for Web Playback SDK */
  spotifyUri?: string;
}

export interface SnippetPlaybackOptions {
  /** Start offset into the song in seconds (e.g., 0 or a random offset) */
  startOffsetSec: number;
  /** Snippet length to play in seconds (0.1s to 30.0s) */
  durationSec: number;
  /** Optional progress callback fired with elapsed seconds within the snippet */
  onProgress?: (elapsedSec: number) => void;
  /** Callback fired when the snippet finishes playing */
  onComplete?: () => void;
  /** Callback fired if playback fails (e.g., unembeddable video) */
  onError?: (error: Error) => void;
}

export interface MusicProvider {
  readonly id: ProviderId;
  readonly displayName: string;

  /** Returns true if required OAuth/API credentials are present in configuration */
  isConfigured(): boolean;

  /** Returns true if the user currently has an active access token or cached session */
  isAuthenticated(): boolean;

  /** Initiates client-side OAuth 2.0 flow (GIS token client for YT, PKCE for Spotify) */
  authenticate(): Promise<void>;

  /** Clears tokens and cached library data */
  disconnect(): void;

  /** Fetches the user's liked songs from the remote API and caches them locally */
  fetchLikedTracks(forceRefresh?: boolean): Promise<Track[]>;

  /** Returns the currently cached catalog for fast synchronous autocomplete filtering */
  getCachedCatalog(): Track[];

  /** Initializes the underlying audio/video player (e.g., hidden YouTube IFrame or Spotify SDK) */
  initializePlayer(containerElement?: HTMLElement): Promise<void>;

  /** Preloads/cues a track for low-latency snippet playback and returns track duration if available */
  cueTrack(track: Track): Promise<{ durationSec?: number }>;

  /** Plays a precise audio snippet using millisecond timers */
  playSnippet(track: Track, options: SnippetPlaybackOptions): Promise<void>;

  /** Plays the track continuously without snippet timer cutoff (e.g., on round reveal) */
  playFullTrack(track: Track, startOffsetSec?: number): Promise<void>;

  /** Immediately stops/pauses active playback and clears snippet timers */
  stopPlayback(): void;

  /** Cleans up timers and player instances */
  destroy(): void;
}
