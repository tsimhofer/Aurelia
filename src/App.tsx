import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  Disc3,
  Ear,
  Flag,
  Headphones,
  Heart,
  Link2,
  LogOut,
  Music2,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings2,
  Shuffle,
  Sparkles,
  Square,
  Trash2,
  Trophy,
  UserPlus,
  Users,
  Volume2,
  X,
  XCircle,
} from 'lucide-react';
import { ConfettiCanvas } from './components/ConfettiCanvas';
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
  mergePartyCatalogs,
  PARTY_MEMBER_COLORS,
  PartyMember,
  selectNextPartyTrack,
} from './party/partyEngine';
import { PartyAckPayload, PartyRoomService } from './party/PartyRoomService';
import {
  SpotifyPlaybackStrategy,
  SpotifyProvider,
  STORAGE_KEY_ACTIVE_PROVIDER,
} from './providers/SpotifyProvider';
import { MusicProvider, ProviderId, Track } from './providers/types';
import { YouTubeMusicProvider } from './providers/YouTubeMusicProvider';

type ScreenView = 'quiz' | 'summary';
type OffsetMode = 'zero' | 'random';

const MILESTONE_SECONDS = [0.1, 0.5, 1, 2, 5, 10, 15, 30];
const STORAGE_KEY_PARTY_MEMBERS = 'aurelia.party.members.v1';
const STORAGE_KEY_PENDING_PARTY_ACTION = 'aurelia.party.pending_action.v1';

interface PendingPartyAction {
  mode: 'local-add' | 'remote-join';
  playerName: string;
  provider: ProviderId;
  roomCode?: string;
}

export function App() {
  const env = useMemo(() => getEnvConfig(), []);
  const ytProviderRef = useRef<YouTubeMusicProvider | null>(null);
  const spotifyProviderRef = useRef<SpotifyProvider | null>(null);
  const partyRoomRef = useRef<PartyRoomService | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  if (!ytProviderRef.current) {
    ytProviderRef.current = new YouTubeMusicProvider();
  }
  if (!spotifyProviderRef.current) {
    spotifyProviderRef.current = new SpotifyProvider(ytProviderRef.current);
  }
  if (!partyRoomRef.current) {
    partyRoomRef.current = new PartyRoomService();
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

  const [soloCatalog, setSoloCatalog] = useState<Track[]>(() =>
    activeProvider.getCachedCatalog()
  );
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Party Mode State
  const [partyMembers, setPartyMembers] = useState<PartyMember[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_PARTY_MEMBERS);
      if (raw) {
        const parsed = JSON.parse(raw) as PartyMember[];
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // Ignore
    }
    return [];
  });
  const [memberPickCounts, setMemberPickCounts] = useState<Record<string, number>>({});
  const [isPartyModalOpen, setIsPartyModalOpen] = useState<boolean>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.has('party');
  });
  const [partyTab, setPartyTab] = useState<'host' | 'join'>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.has('party') ? 'join' : 'host';
  });
  const [newPlayerName, setNewPlayerName] = useState<string>('');
  const [newPlayerProvider, setNewPlayerProvider] = useState<ProviderId>('youtube-music');
  const [hostRoomCode, setHostRoomCode] = useState<string | null>(null);
  const [isHostingRoom, setIsHostingRoom] = useState<boolean>(false);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);

  // Remote Join State
  const [joinRoomCode, setJoinRoomCode] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return (params.get('party') ?? '').toUpperCase();
  });
  const [guestAck, setGuestAck] = useState<PartyAckPayload | null>(null);

  // Persist party members
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_PARTY_MEMBERS, JSON.stringify(partyMembers));
    } catch {
      // Ignore quota errors
    }
  }, [partyMembers]);

  const mergedPartyPool = useMemo(
    () => mergePartyCatalogs(partyMembers),
    [partyMembers]
  );

  const isPartyActive = partyMembers.length > 0;
  const catalog = isPartyActive ? mergedPartyPool.tracks : soloCatalog;

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

  // Select the right playback provider for any track (supports mixed YT + Spotify party tracks)
  const getPlaybackProviderForTrack = (track: Track): MusicProvider => {
    if (track.videoId || track.provider === 'youtube-music') {
      return ytProviderRef.current!;
    }
    return spotifyProviderRef.current!;
  };

  const stopAllPlayback = () => {
    ytProviderRef.current?.stopPlayback();
    spotifyProviderRef.current?.stopPlayback();
    setIsPlaying(false);
  };

  const switchProvider = (nextProviderId: ProviderId) => {
    stopAllPlayback();
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

  // Sync solo catalog and theme attribute when switching provider
  useEffect(() => {
    document.documentElement.setAttribute('data-provider', activeProviderId);
    stopAllPlayback();
    const cached = activeProvider.getCachedCatalog();
    setSoloCatalog(cached);
    if (!isPartyActive) {
      setCurrentTrack(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProvider, activeProviderId]);

  const addOrUpdatePartyMember = (
    name: string,
    provider: ProviderId,
    tracks: Track[],
    explicitId?: string
  ): PartyMember[] => {
    const cleanName = name.trim() || `Player ${partyMembers.length + 1}`;
    let updatedList: PartyMember[] = [];
    setPartyMembers((prev) => {
      const existingIdx = prev.findIndex(
        (m) =>
          (explicitId && m.id === explicitId) ||
          (m.name.toLowerCase() === cleanName.toLowerCase() && m.provider === provider)
      );
      if (existingIdx >= 0) {
        updatedList = [...prev];
        updatedList[existingIdx] = {
          ...updatedList[existingIdx],
          name: cleanName,
          tracks,
        };
        return updatedList;
      }
      const color = PARTY_MEMBER_COLORS[prev.length % PARTY_MEMBER_COLORS.length];
      updatedList = [
        ...prev,
        {
          id: explicitId || `member-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: cleanName,
          color,
          provider,
          tracks,
        },
      ];
      return updatedList;
    });
    return updatedList;
  };

  // Handle Spotify PKCE OAuth redirect callback (?code=...) on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const authError = params.get('error');

    if (!code && !authError) {
      return;
    }

    const partyParam = params.get('party');
    const cleanUrl =
      window.location.origin +
      window.location.pathname +
      (partyParam ? `?party=${partyParam}` : '') +
      window.location.hash;
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
        .then(async (tracks) => {
          setSoloCatalog(tracks);

          // Check if this login was triggered from Party Mode
          const pendingRaw = sessionStorage.getItem(STORAGE_KEY_PENDING_PARTY_ACTION);
          if (pendingRaw) {
            sessionStorage.removeItem(STORAGE_KEY_PENDING_PARTY_ACTION);
            const pending = JSON.parse(pendingRaw) as PendingPartyAction;
            if (pending.mode === 'local-add') {
              addOrUpdatePartyMember(pending.playerName, 'spotify', tracks);
              setIsPartyModalOpen(true);
            } else if (pending.mode === 'remote-join' && pending.roomCode) {
              setIsPartyModalOpen(true);
              setPartyTab('join');
              const ack = await partyRoomRef.current!.sendCatalogToHost(pending.roomCode, {
                memberId: `guest-${Date.now()}`,
                name: pending.playerName,
                provider: 'spotify',
                tracks,
              });
              setGuestAck(ack);
            }
          } else if (tracks.length === 0) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const startNewRound = async (pool: Track[] = catalog) => {
    if (pool.length === 0) return;
    stopAllPlayback();
    setPlaybackElapsedSec(0);
    setErrorMessage(null);

    let chosen: Track;
    if (isPartyActive) {
      const selection = selectNextPartyTrack(
        pool,
        usedTrackIds,
        memberPickCounts,
        partyMembers
      );
      chosen = selection.chosen;
      setMemberPickCounts(selection.updatedPickCounts);
    } else {
      const unplayed = pool.filter((t) => !usedTrackIds.has(t.id));
      const candidatePool = unplayed.length > 0 ? unplayed : pool;
      chosen = candidatePool[Math.floor(Math.random() * candidatePool.length)];
    }

    setCurrentTrack(chosen);
    setSnippetDurationSec(MIN_SNIPPET_SECONDS);
    setMaxUnlockedDurationSec(MIN_SNIPPET_SECONDS);
    setGuesses([]);
    setRoundState('playing');
    setSearchQuery('');
    setIsDropdownOpen(false);

    try {
      const playbackProvider = getPlaybackProviderForTrack(chosen);
      const { durationSec } = await playbackProvider.cueTrack(chosen);
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
      setSoloCatalog(tracks);
      if (tracks.length === 0) {
        setErrorMessage(
          'Connected successfully, but no liked songs were found in your library.'
        );
      } else if (!isPartyActive) {
        await startNewRound(tracks);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load library.');
    } finally {
      setIsLoadingLibrary(false);
    }
  };

  // Party Mode: Add a local player on the same device
  const handleAddPartyPlayer = async () => {
    const cleanName = newPlayerName.trim() || `Player ${partyMembers.length + 1}`;
    const targetProvider =
      newPlayerProvider === 'youtube-music' ? ytProviderRef.current! : spotifyProviderRef.current!;

    if (!targetProvider.isConfigured()) {
      setErrorMessage(
        `${targetProvider.displayName} credentials are not configured in .env.local yet.`
      );
      return;
    }

    setErrorMessage(null);
    setIsLoadingLibrary(true);

    try {
      if (newPlayerProvider === 'spotify') {
        sessionStorage.setItem(
          STORAGE_KEY_PENDING_PARTY_ACTION,
          JSON.stringify({
            mode: 'local-add',
            playerName: cleanName,
            provider: 'spotify',
          } satisfies PendingPartyAction)
        );
      } else {
        // Force fresh account picker for YouTube Music so another user can sign in
        ytProviderRef.current!.disconnect();
      }

      const tracks = await targetProvider.fetchLikedTracks(true);
      if (tracks.length > 0) {
        addOrUpdatePartyMember(cleanName, newPlayerProvider, tracks);
        setNewPlayerName('');
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to add party player.');
    } finally {
      setIsLoadingLibrary(false);
    }
  };

  // Party Mode: Host a live WebRTC Room Code for friends on other devices
  const handleStartHostingRoom = async () => {
    setErrorMessage(null);
    setIsHostingRoom(true);
    try {
      const code = await partyRoomRef.current!.hostRoom(
        (guestPayload, replyAck) => {
          const updatedMembers = addOrUpdatePartyMember(
            guestPayload.name,
            guestPayload.provider,
            guestPayload.tracks,
            guestPayload.memberId
          );
          const merged = mergePartyCatalogs(updatedMembers);
          replyAck({
            memberCount: updatedMembers.length,
            sharedMatchesCount: merged.sharedMatchesCount,
            totalTracksCount: merged.totalUniqueCount,
          });
        },
        (err) => setErrorMessage(err.message)
      );
      setHostRoomCode(code);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not open live party room.');
    } finally {
      setIsHostingRoom(false);
    }
  };

  // Party Mode: Remote Guest connects & sends their Spotify/YouTube Music library to Host
  const handleGuestJoinAndSend = async () => {
    const cleanName = newPlayerName.trim();
    const cleanCode = joinRoomCode.trim().toUpperCase();
    if (!cleanName) {
      setErrorMessage('Please enter your display name first.');
      return;
    }
    if (!cleanCode) {
      setErrorMessage('Please enter the 5-character Room Code from the host.');
      return;
    }

    const targetProvider =
      newPlayerProvider === 'youtube-music' ? ytProviderRef.current! : spotifyProviderRef.current!;

    if (!targetProvider.isConfigured()) {
      setErrorMessage(`${targetProvider.displayName} is not configured on this deployment.`);
      return;
    }

    setErrorMessage(null);
    setGuestAck(null);
    setIsLoadingLibrary(true);

    try {
      if (newPlayerProvider === 'spotify') {
        sessionStorage.setItem(
          STORAGE_KEY_PENDING_PARTY_ACTION,
          JSON.stringify({
            mode: 'remote-join',
            playerName: cleanName,
            provider: 'spotify',
            roomCode: cleanCode,
          } satisfies PendingPartyAction)
        );
      }

      const tracks = await targetProvider.fetchLikedTracks(true);
      if (tracks.length > 0) {
        const ack = await partyRoomRef.current!.sendCatalogToHost(cleanCode, {
          memberId: `guest-${Date.now()}`,
          name: cleanName,
          provider: newPlayerProvider,
          tracks,
        });
        setGuestAck(ack);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to join party room.');
    } finally {
      setIsLoadingLibrary(false);
    }
  };

  const handleCopyInviteLink = () => {
    if (!hostRoomCode) return;
    const inviteUrl = `${window.location.origin}${window.location.pathname}?party=${hostRoomCode}`;
    void navigator.clipboard.writeText(inviteUrl);
    setCopiedLink(true);
    window.setTimeout(() => setCopiedLink(false), 2200);
  };

  const handleRemovePartyMember = (memberId: string) => {
    setPartyMembers((prev) => prev.filter((m) => m.id !== memberId));
  };

  const handleClearParty = () => {
    stopAllPlayback();
    partyRoomRef.current?.destroy();
    setHostRoomCode(null);
    setPartyMembers([]);
    setMemberPickCounts({});
    setCurrentTrack(null);
  };

  const handleDisconnect = () => {
    stopAllPlayback();
    activeProvider.disconnect();
    setSoloCatalog([]);
    setCurrentTrack(null);
    setRoundHistory([]);
    setUsedTrackIds(new Set());
    setIsSettingsOpen(false);
  };

  const triggerPlayDuration = async (targetDurationSec: number) => {
    if (!currentTrack) return;
    setErrorMessage(null);
    setIsPlaying(true);
    setPlaybackElapsedSec(0);
    setMaxUnlockedDurationSec((prev) => Math.max(prev, targetDurationSec));

    try {
      const playbackProvider = getPlaybackProviderForTrack(currentTrack);
      await playbackProvider.playSnippet(currentTrack, {
        startOffsetSec,
        durationSec: targetDurationSec,
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

  const handlePlayToggle = async () => {
    if (!currentTrack) return;
    if (isPlaying) {
      stopAllPlayback();
      return;
    }
    if (roundState !== 'playing') {
      setIsPlaying(true);
      try {
        const playbackProvider = getPlaybackProviderForTrack(currentTrack);
        await playbackProvider.playFullTrack(currentTrack, startOffsetSec);
      } catch (err) {
        setIsPlaying(false);
        setErrorMessage(err instanceof Error ? err.message : 'Playback error');
      }
      return;
    }
    await triggerPlayDuration(snippetDurationSec);
  };

  const handleScrubberChange = (newDuration: number, autoPlay = false) => {
    const clamped = Number(
      Math.max(MIN_SNIPPET_SECONDS, Math.min(MAX_SNIPPET_SECONDS, newDuration)).toFixed(1)
    );
    setSnippetDurationSec(clamped);
    if (roundState === 'playing') {
      setMaxUnlockedDurationSec((prev) => Math.max(prev, clamped));
    }
    if (autoPlay && currentTrack) {
      void triggerPlayDuration(clamped);
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
      .slice(0, 7);
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
      const awarded = calculateNetRoundScore(usedDur, wrongGuessesCount);
      setRoundState('won');
      setIsPlaying(true);
      const playbackProvider = getPlaybackProviderForTrack(currentTrack);
      void playbackProvider.playFullTrack(currentTrack, startOffsetSec).catch(() => {
        setIsPlaying(false);
      });
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
    const usedDur = Math.max(snippetDurationSec, maxUnlockedDurationSec);
    setRoundState('gave-up');
    setIsPlaying(true);
    const playbackProvider = getPlaybackProviderForTrack(currentTrack);
    void playbackProvider.playFullTrack(currentTrack, startOffsetSec).catch(() => {
      setIsPlaying(false);
    });
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
    setMemberPickCounts({});
    setView('quiz');
    if (catalog.length > 0) {
      void startNewRound(catalog);
    }
  };

  const ranking = useMemo(() => evaluateRunRanking(roundHistory), [roundHistory]);
  const unlockedPercent = (snippetDurationSec / MAX_SNIPPET_SECONDS) * 100;
  const playheadPercent = isPlaying
    ? Math.min(100, (playbackElapsedSec / MAX_SNIPPET_SECONDS) * 100)
    : unlockedPercent;

  return (
    <div className="app-shell" data-provider={activeProviderId}>
      {/* Header */}
      <header className="top-nav">
        <div className="brand-cluster">
          <div className="brand">
            <div className="brand-icon">
              <Disc3 className={isPlaying ? 'spin-slow' : ''} size={21} />
            </div>
            <span className="brand-title">Aurelia</span>
          </div>

          <div className="provider-segmented" role="tablist" aria-label="Music Source">
            <button
              type="button"
              role="tab"
              aria-selected={activeProviderId === 'youtube-music'}
              className={`seg-btn ${activeProviderId === 'youtube-music' ? 'active' : ''}`}
              onClick={() => switchProvider('youtube-music')}
            >
              <Music2 size={14} />
              <span>YouTube Music</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeProviderId === 'spotify'}
              className={`seg-btn ${activeProviderId === 'spotify' ? 'active' : ''}`}
              onClick={() => switchProvider('spotify')}
            >
              <Sparkles size={14} />
              <span>Spotify</span>
            </button>
          </div>
        </div>

        <div className="nav-right">
          <button
            type="button"
            className={`btn-party-toggle ${isPartyModalOpen || isPartyActive ? 'active' : ''}`}
            onClick={() => setIsPartyModalOpen((v) => !v)}
          >
            <Users size={15} />
            <span>Party Mode</span>
            {isPartyActive && <span className="party-count-pill">{partyMembers.length}</span>}
          </button>

          {catalog.length > 0 && (
            <div className="session-scoreboard">
              <div className="score-chip">
                <span className="chip-label">Round</span>
                <span className="chip-val">
                  {view === 'summary' ? roundHistory.length : roundHistory.length + 1}
                </span>
              </div>
              <div className="score-chip accent">
                <Trophy size={14} />
                <span className="chip-val">{runningTotalScore.toLocaleString()}</span>
              </div>
              {roundHistory.length > 0 && (
                <button
                  type="button"
                  className="btn-ghost-pill"
                  onClick={() => setView(view === 'quiz' ? 'summary' : 'quiz')}
                >
                  {view === 'quiz' ? 'Finish Run' : 'Resume Quiz'}
                </button>
              )}
            </div>
          )}

          {catalog.length > 0 && (
            <button
              type="button"
              className={`btn-icon-circle ${isSettingsOpen ? 'active' : ''}`}
              onClick={() => setIsSettingsOpen((v) => !v)}
              aria-label="Library and playback settings"
              title="Settings & Library"
            >
              <Settings2 size={18} />
            </button>
          )}
        </div>
      </header>

      {/* PARTY MODE LOBBY / MANAGER PANEL */}
      {isPartyModalOpen && (
        <section className="party-drawer" aria-label="Party Mode Lobby">
          <div className="party-drawer-header">
            <div>
              <h3>
                <Users size={18} /> Party Mode — Multi-User Playlist Merger
              </h3>
              <p>
                Everyone connects either <strong>Spotify</strong> or{' '}
                <strong>YouTube Music</strong>. Exact song matches across libraries are played
                first, followed by fair rotation across all players.
              </p>
            </div>
            <button
              type="button"
              className="btn-icon-circle"
              onClick={() => setIsPartyModalOpen(false)}
              aria-label="Close Party Lobby"
            >
              <X size={16} />
            </button>
          </div>

          <div className="party-mode-tabs">
            <button
              type="button"
              className={`btn-chip ${partyTab === 'host' ? 'active' : ''}`}
              onClick={() => setPartyTab('host')}
            >
              <Users size={14} />
              <span>Party Roster & Host Room ({partyMembers.length} Players)</span>
            </button>
            <button
              type="button"
              className={`btn-chip ${partyTab === 'join' ? 'active' : ''}`}
              onClick={() => setPartyTab('join')}
            >
              <Send size={14} />
              <span>Join a Friend&apos;s Room Code</span>
            </button>
          </div>

          {partyTab === 'host' ? (
            <div className="party-host-grid">
              {/* Left Column: Add Player Locally or Host Remote Room */}
              <div className="party-add-card">
                <h4>Add Player to This Party</h4>
                <div className="party-form-row">
                  <input
                    type="text"
                    className="party-text-input"
                    placeholder="Player Name (e.g. Alex)"
                    value={newPlayerName}
                    onChange={(e) => setNewPlayerName(e.target.value)}
                  />
                  <div className="provider-segmented">
                    <button
                      type="button"
                      className={`seg-btn ${
                        newPlayerProvider === 'youtube-music' ? 'active' : ''
                      }`}
                      onClick={() => setNewPlayerProvider('youtube-music')}
                    >
                      <Music2 size={13} />
                      <span>YT Music</span>
                    </button>
                    <button
                      type="button"
                      className={`seg-btn ${newPlayerProvider === 'spotify' ? 'active' : ''}`}
                      onClick={() => setNewPlayerProvider('spotify')}
                    >
                      <Sparkles size={13} />
                      <span>Spotify</span>
                    </button>
                  </div>
                </div>

                <div className="party-action-buttons">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={isLoadingLibrary}
                    onClick={() => void handleAddPartyPlayer()}
                  >
                    <UserPlus size={16} />
                    <span>
                      {isLoadingLibrary
                        ? 'Syncing Library...'
                        : `Sign In & Add (${
                            newPlayerProvider === 'youtube-music' ? 'YouTube Music' : 'Spotify'
                          })`}
                    </span>
                  </button>

                  {soloCatalog.length > 0 && (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => {
                        addOrUpdatePartyMember(
                          newPlayerName.trim() || 'Host',
                          activeProviderId,
                          soloCatalog
                        );
                        setNewPlayerName('');
                      }}
                    >
                      + Add Already Loaded Library ({soloCatalog.length})
                    </button>
                  )}
                </div>

                {/* Remote P2P Room Code Section */}
                <div className="live-room-box">
                  <div className="live-room-info">
                    <strong>Invite Friends on Their Own Devices</strong>
                    <span>
                      Generate a live Room Code so friends can join from their phone or laptop.
                    </span>
                  </div>
                  {hostRoomCode ? (
                    <div className="room-code-banner">
                      <div className="room-code-badge">
                        <span className="code-label">ROOM CODE</span>
                        <span className="code-value">{hostRoomCode}</span>
                      </div>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={handleCopyInviteLink}
                      >
                        {copiedLink ? <Check size={15} /> : <Copy size={15} />}
                        <span>{copiedLink ? 'Invite Link Copied!' : 'Copy Invite Link'}</span>
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={isHostingRoom}
                      onClick={() => void handleStartHostingRoom()}
                    >
                      <Link2 size={15} />
                      <span>{isHostingRoom ? 'Opening Room...' : 'Create Live Room Code'}</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Right Column: Active Party Roster & Merge Statistics */}
              <div className="party-roster-card">
                <div className="roster-header">
                  <h4>Merged Party Pool</h4>
                  {partyMembers.length > 0 && (
                    <button
                      type="button"
                      className="btn-chip danger"
                      onClick={handleClearParty}
                    >
                      <Trash2 size={13} />
                      <span>Clear Party</span>
                    </button>
                  )}
                </div>

                {partyMembers.length === 0 ? (
                  <p className="party-empty-hint">
                    No players added yet. Add 2 or more players via YouTube Music or Spotify to
                    merge libraries and prioritize shared songs!
                  </p>
                ) : (
                  <>
                    <div className="party-stats-pills">
                      <div className="party-stat-box highlight">
                        <span className="p-stat-num">
                          {mergedPartyPool.sharedMatchesCount}
                        </span>
                        <span className="p-stat-label">Exact Shared Matches (Played First)</span>
                      </div>
                      <div className="party-stat-box">
                        <span className="p-stat-num">
                          {mergedPartyPool.totalUniqueCount}
                        </span>
                        <span className="p-stat-label">Total Unique Songs (Fair Rotation)</span>
                      </div>
                    </div>

                    <div className="member-list">
                      {partyMembers.map((member) => (
                        <div key={member.id} className="member-row">
                          <span
                            className="member-dot"
                            style={{ backgroundColor: member.color }}
                          />
                          <div className="member-info">
                            <strong>{member.name}</strong>
                            <span>
                              {member.provider === 'youtube-music' ? 'YouTube Music' : 'Spotify'} ·{' '}
                              {member.tracks.length} songs · Picked{' '}
                              {memberPickCounts[member.id] ?? 0}×
                            </span>
                          </div>
                          <button
                            type="button"
                            className="member-remove"
                            onClick={() => handleRemovePartyMember(member.id)}
                            title="Remove player from party"
                          >
                            <X size={15} />
                          </button>
                        </div>
                      ))}
                    </div>

                    <div className="party-start-footer">
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={() => {
                          setIsPartyModalOpen(false);
                          void startNewRound(mergedPartyPool.tracks);
                        }}
                      >
                        <Play size={16} />
                        <span>Start Party Quiz ({mergedPartyPool.totalUniqueCount} Songs)</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : (
            /* Remote Guest Join Tab */
            <div className="party-join-panel">
              <h4>Join a Friend&apos;s Party Room</h4>
              <p>
                Enter the 5-character Room Code displayed on the host&apos;s screen, choose your
                streaming service, and beam your Liked Songs into the party pool.
              </p>

              <div className="party-form-row">
                <input
                  type="text"
                  maxLength={8}
                  className="party-text-input code-input"
                  placeholder="ROOM CODE (e.g. K7M9P)"
                  value={joinRoomCode}
                  onChange={(e) => setJoinRoomCode(e.target.value.toUpperCase())}
                />
                <input
                  type="text"
                  className="party-text-input"
                  placeholder="Your Display Name"
                  value={newPlayerName}
                  onChange={(e) => setNewPlayerName(e.target.value)}
                />
                <div className="provider-segmented">
                  <button
                    type="button"
                    className={`seg-btn ${
                      newPlayerProvider === 'youtube-music' ? 'active' : ''
                    }`}
                    onClick={() => setNewPlayerProvider('youtube-music')}
                  >
                    <Music2 size={13} />
                    <span>YouTube Music</span>
                  </button>
                  <button
                    type="button"
                    className={`seg-btn ${newPlayerProvider === 'spotify' ? 'active' : ''}`}
                    onClick={() => setNewPlayerProvider('spotify')}
                  >
                    <Sparkles size={13} />
                    <span>Spotify</span>
                  </button>
                </div>
              </div>

              <button
                type="button"
                className="btn-primary"
                disabled={isLoadingLibrary}
                onClick={() => void handleGuestJoinAndSend()}
              >
                <Send size={16} />
                <span>
                  {isLoadingLibrary
                    ? 'Connecting & Sending Library...'
                    : `Sign In with ${
                        newPlayerProvider === 'youtube-music' ? 'YouTube Music' : 'Spotify'
                      } & Join Room`}
                </span>
              </button>

              {guestAck && (
                <div className="guest-ack-banner">
                  <CheckCircle2 size={18} />
                  <span>
                    Synced to Room <strong>{guestAck.roomCode}</strong>! Party now has{' '}
                    <strong>{guestAck.memberCount} players</strong>,{' '}
                    <strong>{guestAck.sharedMatchesCount} exact shared matches</strong>, and{' '}
                    <strong>{guestAck.totalTracksCount} total songs</strong>.
                  </span>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* Collapsible Settings Popover */}
      {isSettingsOpen && catalog.length > 0 && (
        <section className="settings-drawer" aria-label="Quiz settings">
          <div className="settings-row">
            <div className="settings-group">
              <span className="settings-title">Snippet Start Point</span>
              <div className="pill-toggle-group">
                <button
                  type="button"
                  className={`btn-chip ${offsetMode === 'zero' ? 'active' : ''}`}
                  onClick={() => setOffsetMode('zero')}
                >
                  Beginning (0:00)
                </button>
                <button
                  type="button"
                  className={`btn-chip ${offsetMode === 'random' ? 'active' : ''}`}
                  onClick={() => setOffsetMode('random')}
                >
                  <Shuffle size={13} />
                  <span>Random Offset</span>
                </button>
              </div>
            </div>

            {activeProviderId === 'spotify' && (
              <div className="settings-group">
                <span className="settings-title">Spotify Audio Engine</span>
                <div className="pill-toggle-group">
                  <button
                    type="button"
                    className={`btn-chip ${
                      spotifyStrategy === 'youtube-iframe-fallback' ? 'active' : ''
                    }`}
                    onClick={() => handleSpotifyStrategyChange('youtube-iframe-fallback')}
                  >
                    YouTube Match (Free/Premium)
                  </button>
                  <button
                    type="button"
                    className={`btn-chip ${
                      spotifyStrategy === 'web-playback-sdk' ? 'active' : ''
                    }`}
                    onClick={() => handleSpotifyStrategyChange('web-playback-sdk')}
                  >
                    Spotify SDK (Premium)
                  </button>
                </div>
              </div>
            )}

            <div className="settings-group">
              <span className="settings-title">Library ({catalog.length} songs cached)</span>
              <div className="pill-toggle-group">
                <button
                  type="button"
                  className="btn-chip"
                  onClick={() => void handleConnectAndSync(true)}
                  disabled={isLoadingLibrary}
                >
                  <RefreshCw className={isLoadingLibrary ? 'spin' : ''} size={13} />
                  <span>Re-sync Library</span>
                </button>
                <button type="button" className="btn-chip danger" onClick={handleDisconnect}>
                  <LogOut size={13} />
                  <span>Disconnect</span>
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      <main className="main-stage">
        {errorMessage && (
          <div className="error-toast" role="alert">
            <AlertCircle size={17} />
            <span>{errorMessage}</span>
            <button
              type="button"
              className="toast-close"
              onClick={() => setErrorMessage(null)}
              aria-label="Dismiss error"
            >
              <X size={15} />
            </button>
          </div>
        )}

        {/* ONBOARDING VIEW */}
        {catalog.length === 0 ? (
          <section className="surface-card onboarding-view">
            <div className="hero-badge">
              <Headphones size={16} />
              <span>Your Personal Streaming Library Quiz</span>
            </div>
            <h2>How well do you know your own Liked Songs?</h2>
            <p className="onboarding-lead">
              Connect your <strong>{activeProvider.displayName}</strong> library for solo play, or
              open <strong>Party Mode</strong> to merge playlists across Spotify and YouTube Music.
            </p>

            <div className="steps-showcase">
              <div className="step-card">
                <div className="step-num">1</div>
                <strong>Listen to 0.1s</strong>
                <span>Start with a tiny audio spark worth the maximum 10,000 pts.</span>
              </div>
              <div className="step-card">
                <div className="step-num">2</div>
                <strong>Scrub up to 30s</strong>
                <span>Need more melody? Drag the slider or tap a milestone to unlock audio.</span>
              </div>
              <div className="step-card">
                <div className="step-num">3</div>
                <strong>Solo or Party Mode</strong>
                <span>
                  Merge friends&apos; Spotify & YouTube Music libraries—shared matches play first!
                </span>
              </div>
            </div>

            {activeProviderId === 'spotify' && (
              <div className="onboarding-engine-choice">
                <span className="engine-label">Playback Mode:</span>
                <button
                  type="button"
                  className={`btn-chip ${
                    spotifyStrategy === 'youtube-iframe-fallback' ? 'active' : ''
                  }`}
                  onClick={() => handleSpotifyStrategyChange('youtube-iframe-fallback')}
                >
                  YouTube Audio Match (Works on all accounts)
                </button>
                <button
                  type="button"
                  className={`btn-chip ${
                    spotifyStrategy === 'web-playback-sdk' ? 'active' : ''
                  }`}
                  onClick={() => handleSpotifyStrategyChange('web-playback-sdk')}
                >
                  Spotify Premium SDK
                </button>
              </div>
            )}

            <div className="cta-stack">
              <div className="onboarding-btn-row">
                <button
                  type="button"
                  className="btn-cta-connect"
                  disabled={!activeProvider.isConfigured() || isLoadingLibrary}
                  onClick={() => void handleConnectAndSync(true)}
                >
                  {isLoadingLibrary ? (
                    <>
                      <RefreshCw className="spin" size={20} />
                      <span>Loading Your Liked Songs...</span>
                    </>
                  ) : (
                    <>
                      <Play size={20} />
                      <span>Connect {activeProvider.displayName} & Play</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  className="btn-secondary btn-cta-party"
                  onClick={() => setIsPartyModalOpen(true)}
                >
                  <Users size={19} />
                  <span>Start / Join Party Mode</span>
                </button>
              </div>

              {!activeProvider.isConfigured() && (
                <div className="setup-hint-box">
                  <AlertCircle size={16} />
                  <span>
                    {activeProviderId === 'youtube-music' ? (
                      <>
                        Add <code>VITE_GOOGLE_CLIENT_ID</code> and <code>VITE_GOOGLE_API_KEY</code>{' '}
                        to <code>.env.local</code> to enable YouTube Music login.
                      </>
                    ) : (
                      <>
                        Add <code>VITE_SPOTIFY_CLIENT_ID</code> to <code>.env.local</code> (Redirect
                        URI: <code>{env.spotify.redirectUri}</code>) to enable Spotify login.
                      </>
                    )}
                  </span>
                </div>
              )}
            </div>
          </section>
        ) : view === 'summary' ? (
          /* SUMMARY / END-OF-RUN RANKING VIEW */
          <section className="surface-card summary-view">
            <div className="summary-hero">
              <div className={`rank-crest tier-${ranking.tier.replace('+', 'plus').toLowerCase()}`}>
                <span className="crest-tier">{ranking.tier}</span>
                <span className="crest-sub">RANK</span>
              </div>
              <div className="summary-copy">
                <span className="eyebrow">Run Complete · {roundHistory.length} Songs</span>
                <h2>{ranking.title}</h2>
                <p>{ranking.description}</p>
              </div>
            </div>

            <div className="stats-grid-4">
              <div className="stat-tile">
                <span className="tile-label">Total Score</span>
                <span className="tile-value accent">{runningTotalScore.toLocaleString()}</span>
              </div>
              <div className="stat-tile">
                <span className="tile-label">Avg / Song</span>
                <span className="tile-value">
                  {ranking.averagePointsPerRound.toLocaleString()}
                </span>
              </div>
              <div className="stat-tile">
                <span className="tile-label">Accuracy</span>
                <span className="tile-value">{ranking.winRatePercent}%</span>
              </div>
              <div className="stat-tile">
                <span className="tile-label">Avg Time Needed</span>
                <span className="tile-value">{ranking.averageDurationSec}s</span>
              </div>
            </div>

            <div className="round-history-section">
              <h3>Played Songs</h3>
              <div className="history-scroll">
                {roundHistory.map((item) => (
                  <div key={item.roundNumber} className="history-item">
                    <span className="history-num">#{item.roundNumber}</span>
                    {item.targetTrack.artworkUrl ? (
                      <img src={item.targetTrack.artworkUrl} alt="" className="history-art" />
                    ) : (
                      <div className="history-art-placeholder">
                        <Music2 size={16} />
                      </div>
                    )}
                    <div className="history-song">
                      <strong>{item.targetTrack.title}</strong>
                      <span>{item.targetTrack.artist}</span>
                      {item.targetTrack.favoritedBy && item.targetTrack.favoritedBy.length > 0 && (
                        <div className="history-favs-row">
                          {item.targetTrack.favoritedBy.map((fav) => (
                            <span
                              key={fav.memberId}
                              className="fav-mini-pill"
                              style={{ borderColor: fav.color }}
                            >
                              <i style={{ backgroundColor: fav.color }} />
                              {fav.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="history-badges">
                      <span className="tag-duration">{item.unlockedDurationSec.toFixed(1)}s</span>
                      {item.wrongGuesses > 0 && (
                        <span className="tag-penalty">
                          -{item.wrongGuesses * WRONG_GUESS_PENALTY}
                        </span>
                      )}
                      <span className={`tag-points ${item.status}`}>
                        {item.status === 'won'
                          ? `+${item.pointsAwarded.toLocaleString()}`
                          : 'Skipped'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="summary-actions">
              <button type="button" className="btn-secondary" onClick={() => setView('quiz')}>
                Keep Playing Run
              </button>
              <button type="button" className="btn-primary" onClick={handleResetRun}>
                <RotateCcw size={16} />
                <span>Start New Run</span>
              </button>
            </div>
          </section>
        ) : (
          /* ACTIVE QUIZ VIEW */
          <section
            className={`surface-card quiz-stage ${
              roundState !== 'playing' ? `result-focused ${roundState}` : ''
            }`}
          >
            <ConfettiCanvas active={roundState === 'won'} />

            {isPartyActive && roundState === 'playing' && (
              <div className="party-active-bar">
                <div className="party-roster-chips">
                  <span className="party-bar-label">
                    <Users size={13} /> Party Pool ({mergedPartyPool.sharedMatchesCount} shared ·{' '}
                    {mergedPartyPool.totalUniqueCount} total):
                  </span>
                  {partyMembers.map((m) => (
                    <span key={m.id} className="fav-mini-pill" style={{ borderColor: m.color }}>
                      <i style={{ backgroundColor: m.color }} />
                      {m.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {roundState === 'playing' ? (
              <>
                {/* Top Status Row: Potential Points & Snippet Badge */}
                <div className="stage-header">
                  <div className="potential-score-box">
                    <span className="stage-eyebrow">Points at Stake</span>
                    <div className="points-display-row">
                      <span className="points-value">{potentialNetPoints.toLocaleString()}</span>
                      <span className="points-unit">pts</span>
                      {wrongGuessesCount > 0 && (
                        <span
                          className="penalty-badge"
                          title={`${wrongGuessesCount} wrong guess(es)`}
                        >
                          −{(wrongGuessesCount * WRONG_GUESS_PENALTY).toLocaleString()} penalty
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="snippet-length-box">
                    <span className="stage-eyebrow">Unlocked Audio</span>
                    <div className="length-display-row">
                      <Ear size={18} className="ear-icon" />
                      <span className="length-value">{snippetDurationSec.toFixed(1)}s</span>
                      <span className="length-max">/ 30s</span>
                    </div>
                  </div>
                </div>

                {/* Central Audio Player & Interactive Timeline Scrubber */}
                <div className={`player-deck ${isPlaying ? 'is-playing' : ''}`}>
                  <div className="player-main-row">
                    <button
                      type="button"
                      className={`hero-play-btn ${isPlaying ? 'playing' : ''}`}
                      onClick={() => void handlePlayToggle()}
                      disabled={!currentTrack}
                      aria-label={isPlaying ? 'Stop playback' : 'Play snippet'}
                    >
                      {isPlaying ? (
                        <Square size={26} />
                      ) : (
                        <Play size={28} className="play-offset" />
                      )}
                    </button>

                    <div className="timeline-column">
                      <div className="timeline-status-row">
                        <span className="status-text">
                          {isPlaying ? (
                            <>
                              <Volume2 size={15} className="pulse-icon" /> Playing snippet (
                              {playbackElapsedSec.toFixed(1)}s / {snippetDurationSec.toFixed(1)}s)
                            </>
                          ) : (
                            <>Drag slider or tap a milestone to unlock more of the song</>
                          )}
                        </span>
                        <span className="curve-hint">
                          Base: {baseCurvePoints.toLocaleString()} pts
                        </span>
                      </div>

                      {/* Custom Visual Progress + Scrubber */}
                      <div className="scrubber-track-wrapper">
                        <div className="scrubber-rail">
                          <div
                            className="scrubber-unlocked-fill"
                            style={{ width: `${unlockedPercent}%` }}
                          />
                          {isPlaying && (
                            <div
                              className="scrubber-playhead-fill"
                              style={{ width: `${playheadPercent}%` }}
                            />
                          )}
                        </div>
                        <input
                          type="range"
                          min={MIN_SNIPPET_SECONDS}
                          max={MAX_SNIPPET_SECONDS}
                          step={0.1}
                          value={snippetDurationSec}
                          onChange={(e) => handleScrubberChange(parseFloat(e.target.value), false)}
                          className="scrubber-input-overlay"
                          aria-label="Snippet duration in seconds"
                        />
                      </div>

                      {/* Clickable Milestone Pills */}
                      <div className="milestone-bar">
                        {MILESTONE_SECONDS.map((sec) => {
                          const isActive = Math.abs(snippetDurationSec - sec) < 0.05;
                          const isUnlocked = sec <= maxUnlockedDurationSec;
                          return (
                            <button
                              key={sec}
                              type="button"
                              className={`milestone-pill ${isActive ? 'current' : ''} ${
                                isUnlocked ? 'unlocked' : ''
                              }`}
                              onClick={() => handleScrubberChange(sec, true)}
                              title={`Set snippet to ${sec}s (${calculateLogarithmicBaseScore(sec).toLocaleString()} base pts) and play`}
                            >
                              {sec}s
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Search & Guess Input */}
                <div className="guess-zone">
                  <div className="search-bar-container">
                    <div className="search-field-box">
                      <Search className="search-icon" size={19} />
                      <input
                        ref={searchInputRef}
                        type="text"
                        className="search-input"
                        placeholder={`Search ${catalog.length} songs in ${
                          isPartyActive ? 'the merged Party pool' : `your ${activeProvider.displayName} library`
                        }...`}
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
                          } else if (e.key === 'Escape') {
                            setIsDropdownOpen(false);
                          }
                        }}
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          className="clear-search-btn"
                          onClick={() => {
                            setSearchQuery('');
                            searchInputRef.current?.focus();
                          }}
                          aria-label="Clear search"
                        >
                          <X size={16} />
                        </button>
                      )}
                    </div>

                    <button
                      type="button"
                      className="btn-skip-round"
                      onClick={handleGiveUp}
                      title="Reveal the song and move to the next round"
                    >
                      <Flag size={15} />
                      <span>Give Up</span>
                    </button>
                  </div>

                  {/* Autocomplete Suggestions Dropdown */}
                  {isDropdownOpen && searchQuery.trim().length > 0 && (
                    <div className="suggestions-popover" role="listbox">
                      {filteredSuggestions.length > 0 ? (
                        filteredSuggestions.map((track, idx) => (
                          <button
                            key={track.id}
                            type="button"
                            role="option"
                            aria-selected={idx === selectedSuggestionIdx}
                            className={`suggestion-row ${
                              idx === selectedSuggestionIdx ? 'selected' : ''
                            }`}
                            onMouseEnter={() => setSelectedSuggestionIdx(idx)}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              submitGuess(track);
                            }}
                          >
                            {track.artworkUrl ? (
                              <img src={track.artworkUrl} alt="" className="suggestion-art" />
                            ) : (
                              <div className="suggestion-art-fallback">
                                <Music2 size={15} />
                              </div>
                            )}
                            <div className="suggestion-text">
                              <span className="suggestion-title">{track.title}</span>
                              <span className="suggestion-artist">{track.artist}</span>
                            </div>
                            <span className="suggestion-submit-hint">Guess ↵</span>
                          </button>
                        ))
                      ) : (
                        <div className="suggestions-empty">
                          No matching tracks found in the library pool.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : (
              /* FOCUSED ROUND RESULT SPOTLIGHT */
              currentTrack && (
                <div className={`result-spotlight ${roundState}`}>
                  <div className="spotlight-badge-row">
                    {roundState === 'won' ? (
                      <span className="spotlight-status won">
                        <CheckCircle2 size={17} />
                        <span>Identified in {effectiveScoringDuration.toFixed(1)}s!</span>
                      </span>
                    ) : (
                      <span className="spotlight-status gave-up">
                        <XCircle size={17} />
                        <span>Round Skipped · Track Revealed</span>
                      </span>
                    )}

                    <span className="spotlight-points-award">
                      +
                      {(
                        roundHistory[roundHistory.length - 1]?.pointsAwarded ?? 0
                      ).toLocaleString()}{' '}
                      pts
                    </span>
                  </div>

                  <div className="spotlight-stage">
                    <div className={`spotlight-cover-wrap ${isPlaying ? 'playing' : ''}`}>
                      {currentTrack.artworkUrl ? (
                        <img
                          src={currentTrack.artworkUrl}
                          alt={currentTrack.title}
                          className="spotlight-cover"
                        />
                      ) : (
                        <div className="spotlight-cover-fallback">
                          <Disc3 className={isPlaying ? 'spin-slow' : ''} size={46} />
                        </div>
                      )}
                      <button
                        type="button"
                        className="spotlight-play-overlay"
                        onClick={() => void handlePlayToggle()}
                        aria-label={isPlaying ? 'Pause song' : 'Resume song'}
                        title={isPlaying ? 'Pause playback' : 'Resume playback'}
                      >
                        {isPlaying ? (
                          <Square size={22} />
                        ) : (
                          <Play size={24} className="play-offset" />
                        )}
                      </button>
                    </div>

                    <div className="spotlight-meta">
                      <div className="now-playing-indicator">
                        <span className={`eq-bars ${isPlaying ? 'active' : ''}`}>
                          <i />
                          <i />
                          <i />
                        </span>
                        <span>
                          {isPlaying
                            ? 'Now Playing — Continues until you click Next Song'
                            : 'Playback Paused — Click cover to resume'}
                        </span>
                      </div>
                      <h2 className="spotlight-title">{currentTrack.title}</h2>
                      <p className="spotlight-artist">{currentTrack.artist}</p>

                      {/* Favorited By Attribution in Result View */}
                      <div className="favorited-by-block">
                        <span className="favorited-by-label">
                          <Heart size={13} className="heart-icon" />
                          {(currentTrack.favoritedBy?.length ?? 0) >= 2
                            ? 'Shared Match! Favorited by:'
                            : 'Favorited by:'}
                        </span>
                        <div className="favorited-by-pills">
                          {currentTrack.favoritedBy && currentTrack.favoritedBy.length > 0 ? (
                            currentTrack.favoritedBy.map((fav) => (
                              <span
                                key={fav.memberId}
                                className="favorited-user-pill"
                                style={{ borderColor: fav.color }}
                              >
                                <span
                                  className="fav-dot"
                                  style={{ backgroundColor: fav.color }}
                                />
                                <strong>{fav.name}</strong>
                                <span className="fav-provider-tag">
                                  {fav.provider === 'youtube-music' ? 'YT Music' : 'Spotify'}
                                </span>
                              </span>
                            ))
                          ) : (
                            <span className="favorited-user-pill">
                              <span className="fav-dot" style={{ backgroundColor: 'var(--accent)' }} />
                              <strong>You</strong>
                              <span className="fav-provider-tag">{activeProvider.displayName}</span>
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="spotlight-actions">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => setView('summary')}
                    >
                      <Trophy size={16} />
                      <span>View Run Rank</span>
                    </button>
                    <button
                      type="button"
                      autoFocus
                      className="btn-primary btn-next-song-lg"
                      onClick={() => void startNewRound()}
                    >
                      <span>Next Song</span>
                      <ArrowRight size={18} />
                    </button>
                  </div>
                </div>
              )
            )}

            {/* Wrong / Previous Attempts List */}
            {guesses.length > 0 && (
              <div className="attempts-section">
                <div className="attempts-header">
                  <span>Your Attempts ({guesses.length})</span>
                  <span>−{WRONG_GUESS_PENALTY} pts per wrong guess</span>
                </div>
                <div className="attempts-list">
                  {guesses.map((g, idx) => (
                    <div
                      key={`${g.trackId}-${idx}`}
                      className={`attempt-item ${g.correct ? 'correct' : 'wrong'}`}
                    >
                      {g.correct ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                      <div className="attempt-song">
                        <strong>{g.title}</strong>
                        <span>{g.artist}</span>
                      </div>
                      <span className="attempt-badge">
                        @{g.snippetDurationAtGuessSec.toFixed(1)}s{' '}
                        {!g.correct && `· −${WRONG_GUESS_PENALTY}`}
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
