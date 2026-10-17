import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Disc3,
  FastForward,
  Flag,
  LogOut,
  Music2,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Shuffle,
  Sparkles,
  Square,
  Trophy,
  XCircle,
} from 'lucide-react';
import { getEnvConfig } from './config/env';
import {
  calculateLogarithmicBaseScore,
  calculateNetRoundScore,
  CompletedRound,
  evaluateRunRanking,
  MAX_SNIPPET_SECONDS,
  MIN_SNIPPET_SECONDS,
  RoundGuess,
  WRONG_GUESS_PENALTY,
} from './game/scoring';
import {
  SpotifyPlaybackStrategy,
  SpotifyProvider,
  STORAGE_KEY_ACTIVE_PROVIDER,
} from './providers/SpotifyProvider';
import { MusicProvider, ProviderId, Track } from './providers/types';
import { YouTubeMusicProvider } from './providers/YouTubeMusicProvider';

type ScreenView = 'quiz' | 'summary';
type OffsetMode = 'zero' | 'random';

export function App() {
  const env = useMemo(() => getEnvConfig(), []);
  const ytProviderRef = useRef<YouTubeMusicProvider | null>(null);
  const spotifyProviderRef = useRef<SpotifyProvider | null>(null);

  if (!ytProviderRef.current) {
    ytProviderRef.current = new YouTubeMusicProvider();
  }
  if (!spotifyProviderRef.current) {
    spotifyProviderRef.current = new SpotifyProvider(ytProviderRef.current);
  }

  const [activeProviderId, setActiveProviderId] = useState<ProviderId>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.has('code') || params.has('error')) {
        return 'spotify';
      }
      const saved = localStorage.getItem(STORAGE_KEY_ACTIVE_PROVIDER);
      if (saved === 'spotify' || saved === 'youtube-music') {
        return saved;
      }
    } catch {
      // Ignore storage errors
    }
    return 'youtube-music';
  });

  const [spotifyStrategy, setSpotifyStrategy] = useState<SpotifyPlaybackStrategy>(() =>
    spotifyProviderRef.current!.getPlaybackStrategy()
  );

  const activeProvider: MusicProvider =
    activeProviderId === 'youtube-music' ? ytProviderRef.current : spotifyProviderRef.current;

  const [catalog, setCatalog] = useState<Track[]>(() => activeProvider.getCachedCatalog());
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Game & Round State
  const [view, setView] = useState<ScreenView>('quiz');
  const [offsetMode, setOffsetMode] = useState<OffsetMode>('zero');
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [startOffsetSec, setStartOffsetSec] = useState<number>(0);
  const [snippetDurationSec, setSnippetDurationSec] = useState<number>(MIN_SNIPPET_SECONDS);
  const [maxUnlockedDurationSec, setMaxUnlockedDurationSec] = useState<number>(MIN_SNIPPET_SECONDS);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackElapsedSec, setPlaybackElapsedSec] = useState<number>(0);

  const [guesses, setGuesses] = useState<RoundGuess[]>([]);
  const [roundState, setRoundState] = useState<'playing' | 'won' | 'gave-up'>('playing');
  const [roundHistory, setRoundHistory] = useState<CompletedRound[]>([]);
  const [usedTrackIds, setUsedTrackIds] = useState<Set<string>>(() => new Set());

  // Autocomplete State
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedSuggestionIdx, setSelectedSuggestionIdx] = useState<number>(0);
  const [isDropdownOpen, setIsDropdownOpen] = useState<boolean>(false);

  const switchProvider = (nextProviderId: ProviderId) => {
    activeProvider.stopPlayback();
    setIsPlaying(false);
    setErrorMessage(null);
    setActiveProviderId(nextProviderId);
    try {
      localStorage.setItem(STORAGE_KEY_ACTIVE_PROVIDER, nextProviderId);
    } catch {
      // Ignore
    }
  };

  const handleSpotifyStrategyChange = (nextStrategy: SpotifyPlaybackStrategy) => {
    spotifyProviderRef.current?.setPlaybackStrategy(nextStrategy);
    setSpotifyStrategy(nextStrategy);
    setErrorMessage(null);
  };

  // Sync catalog when switching provider
  useEffect(() => {
    activeProvider.stopPlayback();
    setIsPlaying(false);
    const cached = activeProvider.getCachedCatalog();
    setCatalog(cached);
    setCurrentTrack(null);
  }, [activeProvider, activeProviderId]);

  // Handle Spotify PKCE OAuth redirect callback (?code=...) on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const authError = params.get('error');

    if (!code && !authError) {
      return;
    }

    // Clean query params from address bar
    const cleanUrl = window.location.origin + window.location.pathname + window.location.hash;
    window.history.replaceState({}, document.title, cleanUrl);

    if (authError) {
      setErrorMessage(`Spotify authorization failed: ${authError}`);
      return;
    }

    if (code && spotifyProviderRef.current) {
      setIsLoadingLibrary(true);
      setErrorMessage(null);
      void spotifyProviderRef.current
        .handleRedirectCallback(code)
        .then(() => spotifyProviderRef.current!.fetchLikedTracks(true))
        .then((tracks) => {
          setCatalog(tracks);
          if (tracks.length === 0) {
            setErrorMessage('Connected to Spotify, but no Liked Songs were found in your library.');
          }
        })
        .catch((err) => {
          setErrorMessage(
            err instanceof Error ? err.message : 'Spotify authentication exchange failed.'
          );
        })
        .finally(() => {
          setIsLoadingLibrary(false);
        });
    }
  }, []);

  const wrongGuessesCount = useMemo(
    () => guesses.filter((g) => !g.correct).length,
    [guesses]
  );

  const effectiveScoringDuration = Math.max(snippetDurationSec, maxUnlockedDurationSec);
  const baseCurvePoints = calculateLogarithmicBaseScore(effectiveScoringDuration);
  const potentialNetPoints = calculateNetRoundScore(effectiveScoringDuration, wrongGuessesCount);
  const runningTotalScore = useMemo(
    () => roundHistory.reduce((sum, r) => sum + r.pointsAwarded, 0),
    [roundHistory]
  );

  // Start a new round whenever catalog is ready and no current track is active
  const startNewRound = async (pool: Track[] = catalog) => {
    if (pool.length === 0) return;
    activeProvider.stopPlayback();
    setIsPlaying(false);
    setPlaybackElapsedSec(0);
    setErrorMessage(null);

    const unplayed = pool.filter((t) => !usedTrackIds.has(t.id));
    const candidatePool = unplayed.length > 0 ? unplayed : pool;
    const chosen = candidatePool[Math.floor(Math.random() * candidatePool.length)];

    setCurrentTrack(chosen);
    setSnippetDurationSec(MIN_SNIPPET_SECONDS);
    setMaxUnlockedDurationSec(MIN_SNIPPET_SECONDS);
    setGuesses([]);
    setRoundState('playing');
    setSearchQuery('');
    setIsDropdownOpen(false);

    try {
      const { durationSec } = await activeProvider.cueTrack(chosen);
      if (offsetMode === 'random' && durationSec && durationSec > 45) {
        const safeMaxStart = Math.max(0, Math.floor(durationSec - 35));
        setStartOffsetSec(Math.floor(Math.random() * safeMaxStart));
      } else {
        setStartOffsetSec(0);
      }
    } catch (err) {
      setStartOffsetSec(0);
      setErrorMessage(err instanceof Error ? err.message : 'Unable to cue track.');
    }
  };

  useEffect(() => {
    if (catalog.length > 0 && !currentTrack && view === 'quiz') {
      void startNewRound(catalog);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog]);

  const handleConnectAndSync = async (forceRefresh = false) => {
    setErrorMessage(null);
    setIsLoadingLibrary(true);
    try {
      const tracks = await activeProvider.fetchLikedTracks(forceRefresh);
      setCatalog(tracks);
      if (tracks.length === 0) {
        setErrorMessage(
          'Connected successfully, but no liked songs were returned from your library.'
        );
      } else {
        await startNewRound(tracks);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load library.');
    } finally {
      setIsLoadingLibrary(false);
    }
  };

  const handleDisconnect = () => {
    activeProvider.disconnect();
    setCatalog([]);
    setCurrentTrack(null);
    setRoundHistory([]);
    setUsedTrackIds(new Set());
  };

  const handlePlayToggle = async () => {
    if (!currentTrack) return;
    if (isPlaying) {
      activeProvider.stopPlayback();
      setIsPlaying(false);
      return;
    }

    setErrorMessage(null);
    setIsPlaying(true);
    setPlaybackElapsedSec(0);
    setMaxUnlockedDurationSec((prev) => Math.max(prev, snippetDurationSec));

    try {
      await activeProvider.playSnippet(currentTrack, {
        startOffsetSec,
        durationSec: snippetDurationSec,
        onProgress: (elapsed) => setPlaybackElapsedSec(elapsed),
        onComplete: () => {
          setIsPlaying(false);
        },
        onError: (err) => {
          setIsPlaying(false);
          setErrorMessage(err.message);
        },
      });
    } catch (err) {
      setIsPlaying(false);
      setErrorMessage(err instanceof Error ? err.message : 'Playback error');
    }
  };

  const handleScrubberChange = (newDuration: number) => {
    const clamped = Number(
      Math.max(MIN_SNIPPET_SECONDS, Math.min(MAX_SNIPPET_SECONDS, newDuration)).toFixed(1)
    );
    setSnippetDurationSec(clamped);
    if (roundState === 'playing') {
      setMaxUnlockedDurationSec((prev) => Math.max(prev, clamped));
    }
  };

  const filteredSuggestions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const guessedIds = new Set(guesses.map((g) => g.trackId));
    return catalog
      .filter((t) => {
        if (guessedIds.has(t.id)) return false;
        return (
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          (t.channelTitle && t.channelTitle.toLowerCase().includes(q))
        );
      })
      .slice(0, 8);
  }, [catalog, searchQuery, guesses]);

  const submitGuess = (guessedTrack: Track) => {
    if (!currentTrack || roundState !== 'playing') return;

    const isCorrect =
      guessedTrack.id === currentTrack.id ||
      (guessedTrack.title.toLowerCase() === currentTrack.title.toLowerCase() &&
        guessedTrack.artist.toLowerCase() === currentTrack.artist.toLowerCase());

    const usedDur = Math.max(snippetDurationSec, maxUnlockedDurationSec);
    const nextGuess: RoundGuess = {
      trackId: guessedTrack.id,
      title: guessedTrack.title,
      artist: guessedTrack.artist,
      snippetDurationAtGuessSec: usedDur,
      correct: isCorrect,
    };

    const updatedGuesses = [...guesses, nextGuess];
    setGuesses(updatedGuesses);
    setSearchQuery('');
    setIsDropdownOpen(false);

    if (isCorrect) {
      activeProvider.stopPlayback();
      setIsPlaying(false);
      const awarded = calculateNetRoundScore(usedDur, wrongGuessesCount);
      setRoundState('won');
      setUsedTrackIds((prev) => new Set(prev).add(currentTrack.id));
      setRoundHistory((prev) => [
        ...prev,
        {
          roundNumber: prev.length + 1,
          targetTrack: currentTrack,
          status: 'won',
          unlockedDurationSec: usedDur,
          startOffsetSec,
          wrongGuesses: wrongGuessesCount,
          guesses: updatedGuesses,
          pointsAwarded: awarded,
        },
      ]);
    }
  };

  const handleGiveUp = () => {
    if (!currentTrack || roundState !== 'playing') return;
    activeProvider.stopPlayback();
    setIsPlaying(false);
    const usedDur = Math.max(snippetDurationSec, maxUnlockedDurationSec);
    setRoundState('gave-up');
    setUsedTrackIds((prev) => new Set(prev).add(currentTrack.id));
    setRoundHistory((prev) => [
      ...prev,
      {
        roundNumber: prev.length + 1,
        targetTrack: currentTrack,
        status: 'gave-up',
        unlockedDurationSec: usedDur,
        startOffsetSec,
        wrongGuesses: wrongGuessesCount,
        guesses,
        pointsAwarded: 0,
      },
    ]);
  };

  const handleResetRun = () => {
    setRoundHistory([]);
    setUsedTrackIds(new Set());
    setView('quiz');
    if (catalog.length > 0) {
      void startNewRound(catalog);
    }
  };

  const ranking = useMemo(() => evaluateRunRanking(roundHistory), [roundHistory]);

  return (
    <div className="app-shell">
      <header className="top-nav">
        <div className="brand">
          <div className="brand-icon">
            <Disc3 className={isPlaying ? 'spin-slow' : ''} size={24} />
          </div>
          <div>
            <h1>Aurelia</h1>
            <p className="brand-subtitle">Personal Library Audio Recognition</p>
          </div>
        </div>

        <div className="provider-tabs" role="tablist" aria-label="Music Providers">
          <button
            type="button"
            className={`provider-tab ${activeProviderId === 'youtube-music' ? 'active' : ''}`}
            onClick={() => switchProvider('youtube-music')}
          >
            <Music2 size={15} />
            <span>YouTube Music</span>
            <span className="badge-primary">Primary</span>
          </button>
          <button
            type="button"
            className={`provider-tab ${activeProviderId === 'spotify' ? 'active' : ''}`}
            onClick={() => switchProvider('spotify')}
          >
            <Sparkles size={15} />
            <span>Spotify</span>
            <span className={env.spotify.isConfigured ? 'badge-spotify' : 'badge-staged'}>
              {env.spotify.isConfigured ? 'Ready' : 'Setup'}
            </span>
          </button>
        </div>

        <div className="score-pill-group">
          <div className="stat-pill">
            <span className="stat-label">Rounds</span>
            <span className="stat-value">{roundHistory.length}</span>
          </div>
          <div className="stat-pill highlight">
            <Trophy size={15} />
            <span className="stat-label">Total</span>
            <span className="stat-value">{runningTotalScore.toLocaleString()} pts</span>
          </div>
          {roundHistory.length > 0 && (
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => setView(view === 'quiz' ? 'summary' : 'quiz')}
            >
              {view === 'quiz' ? 'Finish Run' : 'Back to Quiz'}
            </button>
          )}
        </div>
      </header>

      <main className="main-container">
        {!activeProvider.isConfigured() && (
          <section className="config-notice" role="status">
            <AlertCircle size={20} />
            <div>
              <strong>
                {activeProviderId === 'youtube-music'
                  ? 'Google Cloud OAuth & YouTube Data API v3 Credentials Required'
                  : 'Spotify Developer Client ID Required (PKCE OAuth 2.0)'}
              </strong>
              <p>
                {activeProviderId === 'youtube-music'
                  ? 'Populate VITE_GOOGLE_CLIENT_ID and VITE_GOOGLE_API_KEY in .env.local (or GitHub Actions repository variables) to fetch your Liked Music (playlistId=LM).'
                  : `Populate VITE_SPOTIFY_CLIENT_ID and VITE_SPOTIFY_REDIRECT_URI (default: ${env.spotify.redirectUri}) in .env.local to authenticate via PKCE and fetch your Spotify Liked Songs (/v1/me/tracks).`}
              </p>
            </div>
          </section>
        )}

        {errorMessage && (
          <div className="error-banner" role="alert">
            <AlertCircle size={18} />
            <span>{errorMessage}</span>
          </div>
        )}

        {catalog.length === 0 ? (
          <section className="card onboarding-card">
            <div className="onboarding-header">
              <h2>Connect Your {activeProvider.displayName} Library</h2>
              <p>
                Aurelia quizzes you exclusively on songs from your personal streaming collection.
                Start from a <strong>0.1s</strong> micro-snippet and scrub up to{' '}
                <strong>30.0s</strong> along a logarithmic scoring curve.
              </p>
            </div>

            {activeProviderId === 'spotify' && (
              <div className="strategy-selector-box">
                <div className="strategy-label-row">
                  <Radio size={16} />
                  <span>Spotify Playback Strategy:</span>
                </div>
                <div className="strategy-buttons">
                  <button
                    type="button"
                    className={`btn-chip ${
                      spotifyStrategy === 'youtube-iframe-fallback' ? 'active' : ''
                    }`}
                    onClick={() => handleSpotifyStrategyChange('youtube-iframe-fallback')}
                  >
                    Approach 2: YouTube IFrame Match (Free & Premium)
                  </button>
                  <button
                    type="button"
                    className={`btn-chip ${
                      spotifyStrategy === 'web-playback-sdk' ? 'active' : ''
                    }`}
                    onClick={() => handleSpotifyStrategyChange('web-playback-sdk')}
                  >
                    Approach 1: Spotify Web Playback SDK (Premium Required)
                  </button>
                </div>
              </div>
            )}

            <div className="mechanics-grid">
              <div className="mechanic-item">
                <span className="mechanic-value">0.1s → 30s</span>
                <span className="mechanic-label">Draggable Millisecond Scrubber</span>
              </div>
              <div className="mechanic-item">
                <span className="mechanic-value">10,000 → 3,500</span>
                <span className="mechanic-label">Logarithmic Decay Curve</span>
              </div>
              <div className="mechanic-item">
                <span className="mechanic-value">-500 pts</span>
                <span className="mechanic-label">Wrong Guess Penalty (Turn Continues)</span>
              </div>
            </div>

            <div className="onboarding-actions">
              <button
                type="button"
                className="btn-primary btn-lg"
                disabled={!activeProvider.isConfigured() || isLoadingLibrary}
                onClick={() => void handleConnectAndSync(true)}
              >
                <RefreshCw className={isLoadingLibrary ? 'spin' : ''} size={18} />
                <span>
                  {isLoadingLibrary
                    ? `Syncing ${activeProvider.displayName} Liked Songs...`
                    : `Sign In with ${activeProvider.displayName}`}
                </span>
              </button>
              {activeProviderId === 'youtube-music' ? (
                <span className="env-status-hint">
                  Env check: <code>VITE_GOOGLE_CLIENT_ID</code>{' '}
                  {env.google.clientId ? '✓ Set' : '✗ Unset'} · <code>VITE_GOOGLE_API_KEY</code>{' '}
                  {env.google.apiKey ? '✓ Set' : '✗ Unset'}
                </span>
              ) : (
                <span className="env-status-hint">
                  Env check: <code>VITE_SPOTIFY_CLIENT_ID</code>{' '}
                  {env.spotify.clientId ? '✓ Set' : '✗ Unset'} · <code>Redirect URI</code>{' '}
                  <code>{env.spotify.redirectUri}</code>
                </span>
              )}
            </div>
          </section>
        ) : view === 'summary' ? (
          <section className="card summary-card">
            <div className="summary-header">
              <div className={`rank-badge tier-${ranking.tier.replace('+', 'plus').toLowerCase()}`}>
                {ranking.tier}
              </div>
              <div>
                <span className="eyebrow">End-of-Run Evaluation</span>
                <h2>{ranking.title}</h2>
                <p>{ranking.description}</p>
              </div>
            </div>

            <div className="summary-metrics">
              <div className="metric-box">
                <span className="metric-label">Total Score</span>
                <span className="metric-number">{runningTotalScore.toLocaleString()}</span>
              </div>
              <div className="metric-box">
                <span className="metric-label">Avg Points / Round</span>
                <span className="metric-number">
                  {ranking.averagePointsPerRound.toLocaleString()}
                </span>
              </div>
              <div className="metric-box">
                <span className="metric-label">Accuracy Rate</span>
                <span className="metric-number">{ranking.winRatePercent}%</span>
              </div>
              <div className="metric-box">
                <span className="metric-label">Avg Snippet Unlocked</span>
                <span className="metric-number">{ranking.averageDurationSec}s</span>
              </div>
            </div>

            <div className="history-list">
              <h3>Round Breakdown ({roundHistory.length})</h3>
              {roundHistory.map((item) => (
                <div key={item.roundNumber} className="history-row">
                  <span className="round-index">#{item.roundNumber}</span>
                  {item.targetTrack.artworkUrl && (
                    <img
                      src={item.targetTrack.artworkUrl}
                      alt={item.targetTrack.title}
                      className="history-thumb"
                    />
                  )}
                  <div className="history-track-meta">
                    <strong>{item.targetTrack.title}</strong>
                    <span>{item.targetTrack.artist}</span>
                  </div>
                  <div className="history-stats">
                    <span className="pill-mono">{item.unlockedDurationSec.toFixed(1)}s</span>
                    {item.wrongGuesses > 0 && (
                      <span className="pill-penalty">
                        -{item.wrongGuesses * WRONG_GUESS_PENALTY} pts
                      </span>
                    )}
                    <span
                      className={`pill-score ${item.status === 'won' ? 'won' : 'lost'}`}
                    >
                      +{item.pointsAwarded.toLocaleString()} pts
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <div className="summary-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setView('quiz')}
              >
                Continue Current Run
              </button>
              <button type="button" className="btn-primary" onClick={handleResetRun}>
                <RotateCcw size={16} />
                <span>Start Fresh Run</span>
              </button>
            </div>
          </section>
        ) : (
          <section className="card quiz-card">
            <div className="quiz-topbar">
              <div className="round-indicator">
                <span className="badge-round">Round #{roundHistory.length + 1}</span>
                <span className="catalog-count">
                  {catalog.length} {activeProvider.displayName} Tracks Cached
                </span>
              </div>

              <div className="toolbar-controls">
                {activeProviderId === 'spotify' && (
                  <button
                    type="button"
                    className="btn-chip active"
                    onClick={() =>
                      handleSpotifyStrategyChange(
                        spotifyStrategy === 'youtube-iframe-fallback'
                          ? 'web-playback-sdk'
                          : 'youtube-iframe-fallback'
                      )
                    }
                    title="Switch Spotify playback engine between YouTube IFrame Match and Spotify Web Playback SDK"
                  >
                    <Radio size={14} />
                    <span>
                      {spotifyStrategy === 'youtube-iframe-fallback'
                        ? 'Engine: YT Match'
                        : 'Engine: Spotify SDK'}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  className={`btn-chip ${offsetMode === 'random' ? 'active' : ''}`}
                  onClick={() =>
                    setOffsetMode((prev) => (prev === 'zero' ? 'random' : 'zero'))
                  }
                  title="Toggle starting from 0:00 vs random song offset"
                >
                  <Shuffle size={14} />
                  <span>
                    {offsetMode === 'zero' ? 'Start: 0:00' : `Random Offset (+${startOffsetSec}s)`}
                  </span>
                </button>
                <button
                  type="button"
                  className="btn-chip"
                  onClick={() => void handleConnectAndSync(true)}
                  disabled={isLoadingLibrary}
                  title="Re-sync Liked Songs from API"
                >
                  <RefreshCw className={isLoadingLibrary ? 'spin' : ''} size={14} />
                  <span>Sync</span>
                </button>
                <button
                  type="button"
                  className="btn-chip danger"
                  onClick={handleDisconnect}
                  title="Disconnect account and clear cache"
                >
                  <LogOut size={14} />
                </button>
              </div>
            </div>

            {/* Score & Logarithmic Curve Readout */}
            <div className="score-banner">
              <div className="score-block">
                <span className="score-caption">Current Potential</span>
                <span className="score-big">{potentialNetPoints.toLocaleString()}</span>
                <span className="score-sub">
                  Base {baseCurvePoints.toLocaleString()} pts @ {effectiveScoringDuration.toFixed(1)}s
                  {wrongGuessesCount > 0
                    ? ` − ${(wrongGuessesCount * WRONG_GUESS_PENALTY).toLocaleString()} penalty`
                    : ''}
                </span>
              </div>

              <div className="scrubber-readout">
                <span className="duration-badge">{snippetDurationSec.toFixed(1)}s</span>
                <span className="duration-sub">/ {MAX_SNIPPET_SECONDS.toFixed(1)}s max</span>
              </div>
            </div>

            {/* Playback & Scrubber Controls */}
            <div className="scrubber-panel">
              <div className="play-row">
                <button
                  type="button"
                  className={`btn-play-circle ${isPlaying ? 'playing' : ''}`}
                  onClick={() => void handlePlayToggle()}
                  disabled={!currentTrack}
                  aria-label={isPlaying ? 'Stop snippet' : 'Play snippet'}
                >
                  {isPlaying ? <Square size={22} /> : <Play size={24} />}
                </button>

                <div className="slider-container">
                  <div className="slider-labels">
                    <span>0.1s (10,000 pts)</span>
                    <span>
                      {isPlaying
                        ? `Playing: ${playbackElapsedSec.toFixed(2)}s / ${snippetDurationSec.toFixed(1)}s`
                        : 'Drag Scrubber to Unlock Audio'}
                    </span>
                    <span>30.0s (3,500 pts)</span>
                  </div>
                  <input
                    type="range"
                    min={MIN_SNIPPET_SECONDS}
                    max={MAX_SNIPPET_SECONDS}
                    step={0.1}
                    value={snippetDurationSec}
                    onChange={(e) => handleScrubberChange(parseFloat(e.target.value))}
                    className="scrubber-range"
                    aria-label="Snippet duration in seconds"
                  />
                </div>
              </div>

              <div className="quick-step-row">
                <span className="step-hint">Quick Extend:</span>
                {[0.1, 0.5, 1.0, 2.0, 5.0].map((delta) => (
                  <button
                    key={delta}
                    type="button"
                    className="btn-step"
                    onClick={() => handleScrubberChange(snippetDurationSec + delta)}
                    disabled={snippetDurationSec >= MAX_SNIPPET_SECONDS}
                  >
                    +{delta}s
                  </button>
                ))}
                <button
                  type="button"
                  className="btn-step"
                  onClick={() => handleScrubberChange(MAX_SNIPPET_SECONDS)}
                  disabled={snippetDurationSec >= MAX_SNIPPET_SECONDS}
                >
                  Max (30s)
                </button>
              </div>
            </div>

            {/* Autocomplete Search Input (Active when round is playing) */}
            {roundState === 'playing' ? (
              <div className="search-section">
                <div className="search-box-wrapper">
                  <Search className="search-icon" size={18} />
                  <input
                    type="text"
                    className="search-input"
                    placeholder="Search your liked songs by title or artist..."
                    value={searchQuery}
                    onFocus={() => setIsDropdownOpen(true)}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setSelectedSuggestionIdx(0);
                      setIsDropdownOpen(true);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setSelectedSuggestionIdx((i) =>
                          Math.min(i + 1, Math.max(0, filteredSuggestions.length - 1))
                        );
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setSelectedSuggestionIdx((i) => Math.max(0, i - 1));
                      } else if (
                        e.key === 'Enter' &&
                        filteredSuggestions[selectedSuggestionIdx]
                      ) {
                        e.preventDefault();
                        submitGuess(filteredSuggestions[selectedSuggestionIdx]);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn-giveup"
                    onClick={handleGiveUp}
                    title="Reveal track and move on (0 pts)"
                  >
                    <Flag size={15} />
                    <span>Give Up</span>
                  </button>
                </div>

                {isDropdownOpen && filteredSuggestions.length > 0 && (
                  <ul className="autocomplete-list" role="listbox">
                    {filteredSuggestions.map((track, idx) => (
                      <li
                        key={track.id}
                        role="option"
                        aria-selected={idx === selectedSuggestionIdx}
                        className={`autocomplete-item ${
                          idx === selectedSuggestionIdx ? 'selected' : ''
                        }`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          submitGuess(track);
                        }}
                      >
                        {track.artworkUrl && (
                          <img
                            src={track.artworkUrl}
                            alt=""
                            className="suggestion-thumb"
                          />
                        )}
                        <div className="suggestion-meta">
                          <strong>{track.title}</strong>
                          <span>{track.artist}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              /* Round Result Reveal Banner */
              currentTrack && (
                <div className={`round-reveal ${roundState}`}>
                  <div className="reveal-main">
                    {currentTrack.artworkUrl && (
                      <img
                        src={currentTrack.artworkUrl}
                        alt={currentTrack.title}
                        className="reveal-artwork"
                      />
                    )}
                    <div className="reveal-info">
                      <span className="reveal-tag">
                        {roundState === 'won' ? (
                          <>
                            <CheckCircle2 size={16} /> Identified at{' '}
                            {effectiveScoringDuration.toFixed(1)}s (+
                            {roundHistory[roundHistory.length - 1]?.pointsAwarded.toLocaleString()}{' '}
                            pts)
                          </>
                        ) : (
                          <>
                            <XCircle size={16} /> Round Skipped (0 pts)
                          </>
                        )}
                      </span>
                      <h3>{currentTrack.title}</h3>
                      <p>{currentTrack.artist}</p>
                    </div>
                  </div>

                  <div className="reveal-actions">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => setView('summary')}
                    >
                      <Trophy size={16} />
                      <span>End Run & Rank</span>
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => void startNewRound()}
                    >
                      <FastForward size={16} />
                      <span>Next Track</span>
                    </button>
                  </div>
                </div>
              )
            )}

            {/* Current Round Guesses Log */}
            {guesses.length > 0 && (
              <div className="guesses-log">
                <h4>
                  Round Attempts ({guesses.length}) — Incorrect guesses cost -{WRONG_GUESS_PENALTY}{' '}
                  pts
                </h4>
                <div className="guesses-stack">
                  {guesses.map((g, idx) => (
                    <div
                      key={`${g.trackId}-${idx}`}
                      className={`guess-pill ${g.correct ? 'correct' : 'wrong'}`}
                    >
                      {g.correct ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                      <span className="guess-name">
                        <strong>{g.title}</strong> — {g.artist}
                      </span>
                      <span className="guess-meta">
                        {g.snippetDurationAtGuessSec.toFixed(1)}s{' '}
                        {!g.correct && `(-${WRONG_GUESS_PENALTY} pts)`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
export default App;
