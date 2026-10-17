# Aurelia

**Aurelia** is a client-side music recognition quiz web application inspired by Songless, customized to quiz you exclusively on songs from your personal streaming library.

## Architecture & Features

- **Modular `MusicProvider` Interface** (`src/providers/types.ts`):
  - **YouTube Music (`YouTubeMusicProvider`) — Active Default**:
    - Client-side OAuth 2.0 via Google Identity Services (GIS) Token Client (`youtube.readonly`).
    - Fetches liked songs via YouTube Data API v3 (`GET /youtube/v3/playlistItems?playlistId=LM`).
    - Caches track metadata (`videoId`, `title`, `channelTitle`, `artworkUrl`) in memory and `localStorage`.
    - Plays audio snippets via a hidden/masked YouTube IFrame Player API instance using millisecond-precision timers (`seekTo`, `playVideo`, `pauseVideo`).
  - **Spotify (`SpotifyProvider`) — Staged for Future Activation**:
    - OAuth 2.0 Authorization Code with PKCE (`user-library-read`, `streaming`, `user-modify-playback-state`).
    - Track fetching via `GET /v1/me/tracks`.
    - Dual playback strategy support (Spotify Web Playback SDK or YouTube Search + IFrame fallback).
- **Game Mechanics** (`src/game/scoring.ts`):
  - **Playback Scrubber**: Starts at `0.1s` from `0:00` (or random offset) and is draggable up to `30.0s`.
  - **Logarithmic Scoring Curve**: Decays smoothly from `10,000 pts` at `0.1s` down to `3,500 pts` at `30.0s`.
  - **Wrong Guess Penalty**: `-500 pts` per incorrect guess without ending the turn.
  - **Autocomplete**: Bound to the cached catalog of the active provider.
  - **Unlimited Rounds**: Tracks round-by-round history, running total, and an end-of-run ranking tier screen.

## Environment Variables

Copy `.env.example` to `.env.local` and supply your credentials:

```bash
cp .env.example .env.local
```

- `VITE_GOOGLE_CLIENT_ID`: Google Cloud OAuth 2.0 Web Client ID
- `VITE_GOOGLE_API_KEY`: YouTube Data API v3 Key
- `VITE_SPOTIFY_CLIENT_ID`: *(Optional / Deferred)* Spotify App Client ID
- `VITE_SPOTIFY_REDIRECT_URI`: *(Optional / Deferred)* Spotify OAuth Redirect URI
