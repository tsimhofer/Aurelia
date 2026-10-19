export interface AureliaEnvConfig {
  google: {
    clientId: string;
    apiKey: string;
    isConfigured: boolean;
  };
  spotify: {
    clientId: string;
    redirectUri: string;
    isConfigured: boolean;
  };
}

const DEFAULT_SPOTIFY_CLIENT_ID = '522f49dc59044c329c2c16f5d87036b3';

export function getEnvConfig(): AureliaEnvConfig {
  const googleClientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim();
  const googleApiKey = (import.meta.env.VITE_GOOGLE_API_KEY ?? '').trim();
  const spotifyClientId = (
    import.meta.env.VITE_SPOTIFY_CLIENT_ID || DEFAULT_SPOTIFY_CLIENT_ID
  ).trim();
  const spotifyRedirectUri = (
    import.meta.env.VITE_SPOTIFY_REDIRECT_URI ||
    (typeof window !== 'undefined' ? window.location.origin + window.location.pathname : '')
  ).trim();

  return {
    google: {
      clientId: googleClientId,
      apiKey: googleApiKey,
      isConfigured: Boolean(googleClientId && googleApiKey),
    },
    spotify: {
      clientId: spotifyClientId,
      redirectUri: spotifyRedirectUri,
      isConfigured: Boolean(spotifyClientId),
    },
  };
}
