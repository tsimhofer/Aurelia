import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Disc3,
  Ear,
  Flag,
  Heart,
  LogOut,
  Music2,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings2,
  Share2,
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
import {
  getSavedHostRoomCode,
  PartyAckPayload,
  PartyRoomService,
} from './party/PartyRoomService';
import {
  SpotifyPlaybackStrategy,
  SpotifyProvider,
  STORAGE_KEY_ACTIVE_PROVIDER,
} from './providers/SpotifyProvider';
import { MusicProvider, ProviderId, Track } from './providers/types';
import { YouTubeMusicProvider } from './providers/YouTubeMusicProvider';

type ScreenView = 'quiz' | 'summary';
type OffsetMode = 'zero' | 'random';
type GameMode = 'youtube-music' | 'spotify' | 'party';

const MILESTONE_SECONDS = [0.1, 0.5, 1, 2, 5, 10, 15, 30];
const STORAGE_KEY_PARTY_MEMBERS = 'aurelia.party.members.v1';
const STORAGE_KEY_PENDING_PARTY_ACTION = 'aurelia.party.pending_action.v2';
const STORAGE_KEY_GAME_SESSION = 'aurelia.game.session.v2';
const STORAGE_KEY_SAVED_JOIN_CODE = 'aurelia.party.join_code.v1';
const STORAGE_KEY_SAVED_PLAYER_NAME = 'aurelia.party.player_name.v1';

interface PendingPartyAction {
  mode: 'local-add' | 'remote-join';
  playerName: string;
  provider: ProviderId;
  roomCode?: string;
  createdAt: number;
}

interface PersistedGameSession {
  gameMode: GameMode;
  isPartyLobbyOpen: boolean;
  view: ScreenView;
  offsetMode: OffsetMode;
  currentTrack: Track | null;
  startOffsetSec: number;
  snippetDurationSec: number;
  maxUnlockedDurationSec: number;
  guesses: RoundGuess[];
  roundState: 'playing' | 'won' | 'gave-up';
  roundHistory: CompletedRound[];
  usedTrackIds: string[];
  memberPickCounts: Record<string, number>;
}

function loadSavedGameSession(): PersistedGameSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_GAME_SESSION);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedGameSession;
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // Ignore storage read errors
  }
  return null;
}

function loadInitialPartyMembers(): PartyMember[] {
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
}

export function App() {
  const env = useMemo(() => getEnvConfig(), []);
  const savedSession = useMemo(() => loadSavedGameSession(), []);
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

  // Determine initial GameMode ('youtube-music' | 'spotify' | 'party')
  const [gameMode, setGameMode] = useState<GameMode>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.has('party')) {
        return 'party';
      }
      const pendingRaw = localStorage.getItem(STORAGE_KEY_PENDING_PARTY_ACTION);
      if (pendingRaw) {
        const pending = JSON.parse(pendingRaw) as PendingPartyAction;
        if (Date.now() - (pending.createdAt ?? 0) < 15 * 60 * 1000) {
          return 'party';
        }
      }
      if (params.has('code') || params.has('error')) {
        return 'spotify';
      }
      if (savedSession?.gameMode) {
        return savedSession.gameMode;
      }
      const savedProvider = localStorage.getItem(STORAGE_KEY_ACTIVE_PROVIDER);
      if (savedProvider === 'spotify' || savedProvider === 'youtube-music') {
        return savedProvider;
      }
    } catch {
      // Ignore storage errors
    }
    return 'youtube-music';
  });

  const activeProviderId: ProviderId = gameMode === 'spotify' ? 'spotify' : 'youtube-music';
  const activeProvider: MusicProvider =
    activeProviderId === 'youtube-music' ? ytProviderRef.current : spotifyProviderRef.current;

  const [spotifyStrategy, setSpotifyStrategy] = useState<SpotifyPlaybackStrategy>(() =>
    spotifyProviderRef.current!.getPlaybackStrategy()
  );

  const [soloCatalog, setSoloCatalog] = useState<Track[]>(() =>
    activeProvider.getCachedCatalog()
  );
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Party Mode State & Synchronous Ref (fixes React 18 async batching in WebRTC/SSE callbacks)
  const [partyMembers, setPartyMembers] = useState<PartyMember[]>(loadInitialPartyMembers);
  const partyMembersRef = useRef<PartyMember[]>(partyMembers);
  useEffect(() => {
    partyMembersRef.current = partyMembers;
    try {
      localStorage.setItem(STORAGE_KEY_PARTY_MEMBERS, JSON.stringify(partyMembers));
    } catch {
      // Ignore quota errors
    }
  }, [partyMembers]);

  const [memberPickCounts, setMemberPickCounts] = useState<Record<string, number>>(
    () => savedSession?.memberPickCounts ?? {}
  );

  const [isPartyLobbyOpen, setIsPartyLobbyOpen] = useState<boolean>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('party')) return true;
    if (savedSession && typeof savedSession.isPartyLobbyOpen === 'boolean') {
      return savedSession.isPartyLobbyOpen;
    }
    return true;
  });

  const [partyTab, setPartyTab] = useState<'host' | 'join'>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('party')) return 'join';
    try {
      const pendingRaw = localStorage.getItem(STORAGE_KEY_PENDING_PARTY_ACTION);
      if (pendingRaw) {
        const pending = JSON.parse(pendingRaw) as PendingPartyAction;
        if (pending.mode === 'remote-join') return 'join';
      }
    } catch {
      // Ignore
    }
    return 'host';
  });

  const [newPlayerName, setNewPlayerName] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_SAVED_PLAYER_NAME) ?? '';
    } catch {
      return '';
    }
  });
  const [newPlayerProvider, setNewPlayerProvider] = useState<ProviderId>('youtube-music');
  const [hostRoomCode, setHostRoomCode] = useState<string | null>(() => getSavedHostRoomCode());
  const [isPollingRoom, setIsPollingRoom] = useState<boolean>(false);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);

  // Remote Join State
  const [joinRoomCode, setJoinRoomCode] = useState<string>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = params.get('party')?.trim().toUpperCase();
      if (fromUrl) {
        localStorage.setItem(STORAGE_KEY_SAVED_JOIN_CODE, fromUrl);
        return fromUrl;
      }
      return localStorage.getItem(STORAGE_KEY_SAVED_JOIN_CODE) ?? '';
    } catch {
      return '';
    }
  });
  const [guestAck, setGuestAck] = useState<PartyAckPayload | null>(null);

  const handlePlayerNameChange = (val: string) => {
    setNewPlayerName(val);
    try {
      localStorage.setItem(STORAGE_KEY_SAVED_PLAYER_NAME, val);
    } catch {
      // Ignore
    }
  };

  const handleJoinCodeChange = (val: string) => {
    const clean = val.toUpperCase().replace(/[^A-Z0-9]/g, '');
    setJoinRoomCode(clean);
    try {
      localStorage.setItem(STORAGE_KEY_SAVED_JOIN_CODE, clean);
    } catch {
      // Ignore
    }
  };

  const mergedPartyPool = useMemo(() => mergePartyCatalogs(partyMembers), [partyMembers]);

  const isPartyMode = gameMode === 'party';
  const catalog = isPartyMode ? mergedPartyPool.tracks : soloCatalog;

  // Game & Round State (Restored from savedSession on page refresh)
  const [view, setView] = useState<ScreenView>(() => savedSession?.view ?? 'quiz');
  const [offsetMode, setOffsetMode] = useState<OffsetMode>(
    () => savedSession?.offsetMode ?? 'zero'
  );
  const [currentTrack, setCurrentTrack] = useState<Track | null>(
    () => savedSession?.currentTrack ?? null
  );
  const [startOffsetSec, setStartOffsetSec] = useState<number>(
    () => savedSession?.startOffsetSec ?? 0
  );
  const [snippetDurationSec, setSnippetDurationSec] = useState<number>(
    () => savedSession?.snippetDurationSec ?? MIN_SNIPPET_SECONDS
  );
  const [maxUnlockedDurationSec, setMaxUnlockedDurationSec] = useState<number>(
    () => savedSession?.maxUnlockedDurationSec ?? MIN_SNIPPET_SECONDS
  );
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackElapsedSec, setPlaybackElapsedSec] = useState<number>(0);

  const [guesses, setGuesses] = useState<RoundGuess[]>(() => savedSession?.guesses ?? []);
  const [roundState, setRoundState] = useState<'playing' | 'won' | 'gave-up'>(
    () => savedSession?.roundState ?? 'playing'
  );
  const [roundHistory, setRoundHistory] = useState<CompletedRound[]>(
    () => savedSession?.roundHistory ?? []
  );
  const [usedTrackIds, setUsedTrackIds] = useState<Set<string>>(
    () => new Set(savedSession?.usedTrackIds ?? [])
  );

  // Persist active game session whenever round/game state updates
  useEffect(() => {
    try {
      const payload: PersistedGameSession = {
        gameMode,
        isPartyLobbyOpen,
        view,
        offsetMode,
        currentTrack,
        startOffsetSec,
        snippetDurationSec,
        maxUnlockedDurationSec,
        guesses,
        roundState,
        roundHistory,
        usedTrackIds: Array.from(usedTrackIds),
        memberPickCounts,
      };
      localStorage.setItem(STORAGE_KEY_GAME_SESSION, JSON.stringify(payload));
    } catch {
      // Ignore storage errors
    }
  }, [
    gameMode,
    isPartyLobbyOpen,
    view,
    offsetMode,
    currentTrack,
    startOffsetSec,
    snippetDurationSec,
    maxUnlockedDurationSec,
    guesses,
    roundState,
    roundHistory,
    usedTrackIds,
    memberPickCounts,
  ]);

  // Autocomplete State
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedSuggestionIdx, setSelectedSuggestionIdx] = useState<number>(0);
  const [isDropdownOpen, setIsDropdownOpen] = useState<boolean>(false);

  const getPlaybackProviderForTrack = (track: Track): MusicProvider => {
    if (track.videoId || track.provider === 'youtube-music') {
      return ytProviderRef.current!;
    }
    return spotifyProviderRef.current!;
  };

  // Pre-cue restored currentTrack on mount so pressing Play after a refresh works immediately
  useEffect(() => {
    if (savedSession?.currentTrack) {
      const provider = getPlaybackProviderForTrack(savedSession.currentTrack);
      void provider.cueTrack(savedSession.currentTrack).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopAllPlayback = useCallback(() => {
    ytProviderRef.current?.stopPlayback();
    spotifyProviderRef.current?.stopPlayback();
    setIsPlaying(false);
  }, []);

  // Cancel the current game & round completely when switching modes
  const cancelCurrentGame = useCallback(() => {
    stopAllPlayback();
    setPlaybackElapsedSec(0);
    setErrorMessage(null);
    setCurrentTrack(null);
    setStartOffsetSec(0);
    setSnippetDurationSec(MIN_SNIPPET_SECONDS);
    setMaxUnlockedDurationSec(MIN_SNIPPET_SECONDS);
    setGuesses([]);
    setRoundState('playing');
    setRoundHistory([]);
    setUsedTrackIds(new Set());
    setMemberPickCounts({});
    setSearchQuery('');
    setIsDropdownOpen(false);
    setView('quiz');
    try {
      localStorage.removeItem(STORAGE_KEY_GAME_SESSION);
    } catch {
      // Ignore
    }
  }, [stopAllPlayback]);

  // Synchronously update partyMembersRef + React state so host callbacks never see stale rosters
  const addOrUpdatePartyMember = useCallback(
    (
      name: string,
      provider: ProviderId,
      tracks: Track[],
      explicitId?: string
    ): PartyMember[] => {
      const currentList = partyMembersRef.current;
      const cleanName = name.trim() || `Player ${currentList.length + 1}`;
      const existingIdx = currentList.findIndex(
        (m) =>
          (explicitId && m.id === explicitId) ||
          (m.name.toLowerCase() === cleanName.toLowerCase() && m.provider === provider)
      );

      let updatedList: PartyMember[];
      if (existingIdx >= 0) {
        updatedList = [...currentList];
        updatedList[existingIdx] = {
          ...updatedList[existingIdx],
          name: cleanName,
          tracks,
        };
      } else {
        const color = PARTY_MEMBER_COLORS[currentList.length % PARTY_MEMBER_COLORS.length];
        updatedList = [
          ...currentList,
          {
            id: explicitId || `member-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: cleanName,
            color,
            provider,
            tracks,
          },
        ];
      }

      partyMembersRef.current = updatedList;
      setPartyMembers(updatedList);
      return updatedList;
    },
    []
  );

  // Start or resume hosting a live party room
  const ensureHostingRoom = useCallback(
    async (forceNewCode = false) => {
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
          undefined,
          forceNewCode
        );
        setHostRoomCode(code);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Could not open live party room.');
      }
    },
    [addOrUpdatePartyMember]
  );

  // Auto-host room whenever in Party Mode (or if a saved host room code exists on reload)
  useEffect(() => {
    if (gameMode === 'party' || getSavedHostRoomCode()) {
      void ensureHostingRoom(false);
    }
  }, [gameMode, ensureHostingRoom]);

  const startNewRound = async (pool: Track[] = catalog, forcePartyMode = isPartyMode) => {
    if (pool.length === 0) return;
    stopAllPlayback();
    setPlaybackElapsedSec(0);
    setErrorMessage(null);

    let chosen: Track;
    if (forcePartyMode) {
      const selection = selectNextPartyTrack(
        pool,
        usedTrackIds,
        memberPickCounts,
        partyMembersRef.current
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

  // Switch between YouTube Music, Spotify, and Party Mode — cancels current game immediately
  const handleSelectMode = (nextMode: GameMode) => {
    if (nextMode === gameMode) {
      if (nextMode === 'party' && !isPartyLobbyOpen) {
        cancelCurrentGame();
        setIsPartyLobbyOpen(true);
      }
      return;
    }

    cancelCurrentGame();
    setIsSettingsOpen(false);
    setGameMode(nextMode);

    if (nextMode === 'party') {
      setIsPartyLobbyOpen(true);
      void ensureHostingRoom(false);
    } else {
      setIsPartyLobbyOpen(false);
      try {
        localStorage.setItem(STORAGE_KEY_ACTIVE_PROVIDER, nextMode);
      } catch {
        // Ignore
      }
      const nextProvider =
        nextMode === 'youtube-music' ? ytProviderRef.current! : spotifyProviderRef.current!;
      const cached = nextProvider.getCachedCatalog();
      setSoloCatalog(cached);
      if (cached.length > 0) {
        void startNewRound(cached, false);
      }
    }
  };

  const handleOffsetModeChange = (nextOffsetMode: OffsetMode) => {
    if (nextOffsetMode === offsetMode) return;
    setOffsetMode(nextOffsetMode);
    cancelCurrentGame();
    if (catalog.length > 0 && (!isPartyMode || !isPartyLobbyOpen)) {
      void startNewRound(catalog, isPartyMode);
    }
  };

  const handleSpotifyStrategyChange = (nextStrategy: SpotifyPlaybackStrategy) => {
    if (nextStrategy === spotifyStrategy) return;
    spotifyProviderRef.current?.setPlaybackStrategy(nextStrategy);
    setSpotifyStrategy(nextStrategy);
    cancelCurrentGame();
    if (catalog.length > 0 && (!isPartyMode || !isPartyLobbyOpen)) {
      void startNewRound(catalog, isPartyMode);
    }
  };

  // Sync theme attribute and solo catalog when mode changes
  useEffect(() => {
    document.documentElement.setAttribute('data-provider', gameMode);
    if (gameMode !== 'party') {
      const cached = activeProvider.getCachedCatalog();
      setSoloCatalog(cached);
    }
  }, [gameMode, activeProvider]);

  // Auto-start round when solo catalog is ready and no track is active
  useEffect(() => {
    if (!isPartyMode && soloCatalog.length > 0 && !currentTrack && view === 'quiz') {
      void startNewRound(soloCatalog, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soloCatalog, isPartyMode]);

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

          // Check if this login was triggered from Party Mode (persisted in localStorage for mobile)
          const pendingRaw = localStorage.getItem(STORAGE_KEY_PENDING_PARTY_ACTION);
          if (pendingRaw) {
            localStorage.removeItem(STORAGE_KEY_PENDING_PARTY_ACTION);
            const pending = JSON.parse(pendingRaw) as PendingPartyAction;
            if (Date.now() - (pending.createdAt ?? 0) < 15 * 60 * 1000) {
              setGameMode('party');
              setIsPartyLobbyOpen(true);
              if (pending.mode === 'local-add') {
                setPartyTab('host');
                addOrUpdatePartyMember(pending.playerName, 'spotify', tracks);
              } else if (pending.mode === 'remote-join' && pending.roomCode) {
                setPartyTab('join');
                setJoinRoomCode(pending.roomCode);
                setNewPlayerName(pending.playerName);
                const ack = await partyRoomRef.current!.sendCatalogToHost(pending.roomCode, {
                  memberId: `guest-${Date.now()}`,
                  name: pending.playerName,
                  provider: 'spotify',
                  tracks,
                });
                setGuestAck(ack);
              }
              return;
            }
          }

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
      } else if (!isPartyMode) {
        await startNewRound(tracks, false);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load library.');
    } finally {
      setIsLoadingLibrary(false);
    }
  };

  // Party Mode: Add a local player on the host's device
  const handleAddPartyPlayer = async (useCached = false) => {
    const cleanName = newPlayerName.trim() || `Player ${partyMembers.length + 1}`;
    const targetProvider =
      newPlayerProvider === 'youtube-music' ? ytProviderRef.current! : spotifyProviderRef.current!;

    if (useCached) {
      const cached = targetProvider.getCachedCatalog();
      if (cached.length > 0) {
        addOrUpdatePartyMember(cleanName, newPlayerProvider, cached);
        handlePlayerNameChange('');
        return;
      }
    }

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
        localStorage.setItem(
          STORAGE_KEY_PENDING_PARTY_ACTION,
          JSON.stringify({
            mode: 'local-add',
            playerName: cleanName,
            provider: 'spotify',
            createdAt: Date.now(),
          } satisfies PendingPartyAction)
        );
      } else {
        ytProviderRef.current!.clearAccessTokenOnly();
      }

      const tracks = await targetProvider.fetchLikedTracks(true);
      if (tracks.length > 0) {
        addOrUpdatePartyMember(cleanName, newPlayerProvider, tracks);
        handlePlayerNameChange('');
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to add party player.');
    } finally {
      setIsLoadingLibrary(false);
    }
  };

  // Party Mode: Remote Guest connects & sends their library to Host
  const handleGuestJoinAndSend = async (useCached = false) => {
    const cleanCode = joinRoomCode.trim().toUpperCase();
    if (!cleanCode || cleanCode.length < 4) {
      setErrorMessage('Enter the 5-character Room Code from the host screen.');
      return;
    }
    const cleanName = newPlayerName.trim() || 'Guest';

    const targetProvider =
      newPlayerProvider === 'youtube-music' ? ytProviderRef.current! : spotifyProviderRef.current!;

    setErrorMessage(null);
    setGuestAck(null);
    setIsLoadingLibrary(true);

    try {
      if (useCached) {
        const cached = targetProvider.getCachedCatalog();
        if (cached.length > 0) {
          const ack = await partyRoomRef.current!.sendCatalogToHost(cleanCode, {
            memberId: `guest-${cleanName.toLowerCase()}-${newPlayerProvider}`,
            name: cleanName,
            provider: newPlayerProvider,
            tracks: cached,
          });
          setGuestAck(ack);
          return;
        }
      }

      if (!targetProvider.isConfigured()) {
        setErrorMessage(`${targetProvider.displayName} is not configured on this deployment.`);
        return;
      }

      if (newPlayerProvider === 'spotify') {
        localStorage.setItem(
          STORAGE_KEY_PENDING_PARTY_ACTION,
          JSON.stringify({
            mode: 'remote-join',
            playerName: cleanName,
            provider: 'spotify',
            roomCode: cleanCode,
            createdAt: Date.now(),
          } satisfies PendingPartyAction)
        );
      }

      const tracks = await targetProvider.fetchLikedTracks(true);
      if (tracks.length > 0) {
        const ack = await partyRoomRef.current!.sendCatalogToHost(cleanCode, {
          memberId: `guest-${cleanName.toLowerCase()}-${newPlayerProvider}`,
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

  const handleShareOrCopyInvite = async () => {
    if (!hostRoomCode) return;
    const inviteUrl = `${window.location.origin}${window.location.pathname}?party=${hostRoomCode}`;
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Join my Aurelia Music Quiz Party!',
          text: `Join my Aurelia Party Room (${hostRoomCode}) with your Spotify or YouTube Music library:`,
          url: inviteUrl,
        });
        return;
      } catch {
        // Fallback to clipboard copy if user cancels share sheet
      }
    }
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2200);
    } catch {
      // Ignore
    }
  };

  const handleManualRoomRefresh = async () => {
    setIsPollingRoom(true);
    try {
      await partyRoomRef.current?.pollRoomNow();
    } finally {
      window.setTimeout(() => setIsPollingRoom(false), 400);
    }
  };

  const handleRemovePartyMember = (memberId: string) => {
    const updated = partyMembersRef.current.filter((m) => m.id !== memberId);
    partyMembersRef.current = updated;
    setPartyMembers(updated);
  };

  const handleClearParty = () => {
    cancelCurrentGame();
    partyRoomRef.current?.destroy(true);
    partyMembersRef.current = [];
    setPartyMembers([]);
    setIsPartyLobbyOpen(true);
    void ensureHostingRoom(true);
  };

  const handleDisconnect = () => {
    cancelCurrentGame();
    activeProvider.disconnect();
    setSoloCatalog([]);
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
      .slice(0, 6);
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
    cancelCurrentGame();
    if (catalog.length > 0) {
      void startNewRound(catalog, isPartyMode);
    }
  };

  const selectedPartyProviderCachedCount = useMemo(() => {
    const p =
      newPlayerProvider === 'youtube-music' ? ytProviderRef.current : spotifyProviderRef.current;
    return p?.getCachedCatalog().length ?? 0;
  }, [newPlayerProvider, soloCatalog]);

  const ranking = useMemo(() => evaluateRunRanking(roundHistory), [roundHistory]);
  const unlockedPercent = (snippetDurationSec / MAX_SNIPPET_SECONDS) * 100;
  const playheadPercent = isPlaying
    ? Math.min(100, (playbackElapsedSec / MAX_SNIPPET_SECONDS) * 100)
    : unlockedPercent;

  return (
    <div className="app-shell" data-provider={gameMode}>
      {/* Simplified Mobile-First Top Navigation */}
      <header className="top-nav">
        <div className="nav-bar-top">
          <div className="brand">
            <div className="brand-icon">
              <Disc3 className={isPlaying ? 'spin-slow' : ''} size={19} />
            </div>
            <span className="brand-title">Aurelia</span>
          </div>

          <div className="nav-right">
            {catalog.length > 0 && (!isPartyMode || !isPartyLobbyOpen) && (
              <div className="session-scoreboard">
                <div className="score-chip">
                  <span className="chip-label">R{view === 'summary' ? roundHistory.length : roundHistory.length + 1}</span>
                </div>
                <div className="score-chip accent">
                  <Trophy size={13} />
                  <span className="chip-val">{runningTotalScore.toLocaleString()}</span>
                </div>
                {roundHistory.length > 0 && (
                  <button
                    type="button"
                    className="btn-ghost-pill"
                    onClick={() => setView(view === 'quiz' ? 'summary' : 'quiz')}
                  >
                    {view === 'quiz' ? 'End Run' : 'Resume'}
                  </button>
                )}
              </div>
            )}

            <button
              type="button"
              className={`btn-icon-circle ${isSettingsOpen ? 'active' : ''}`}
              onClick={() => setIsSettingsOpen((v) => !v)}
              aria-label="Settings"
              title="Settings"
            >
              <Settings2 size={17} />
            </button>
          </div>
        </div>

        {/* Unified 3-Mode Selector (Selecting any mode cancels current game) */}
        <div className="mode-switcher" role="tablist" aria-label="Game Mode">
          <button
            type="button"
            role="tab"
            aria-selected={gameMode === 'youtube-music'}
            className={`mode-tab ${gameMode === 'youtube-music' ? 'active' : ''}`}
            onClick={() => handleSelectMode('youtube-music')}
          >
            <Music2 size={14} />
            <span>YouTube</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={gameMode === 'spotify'}
            className={`mode-tab ${gameMode === 'spotify' ? 'active' : ''}`}
            onClick={() => handleSelectMode('spotify')}
          >
            <Sparkles size={14} />
            <span>Spotify</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={gameMode === 'party'}
            className={`mode-tab ${gameMode === 'party' ? 'active' : ''}`}
            onClick={() => handleSelectMode('party')}
          >
            <Users size={14} />
            <span>Party</span>
            {partyMembers.length > 0 && (
              <span className="party-count-pill">{partyMembers.length}</span>
            )}
          </button>
        </div>
      </header>

      {/* Collapsible Settings Drawer */}
      {isSettingsOpen && (
        <section className="settings-drawer" aria-label="Quiz settings">
          <div className="settings-row">
            <div className="settings-group">
              <span className="settings-title">Snippet Start</span>
              <div className="pill-toggle-group">
                <button
                  type="button"
                  className={`btn-chip ${offsetMode === 'zero' ? 'active' : ''}`}
                  onClick={() => handleOffsetModeChange('zero')}
                >
                  0:00 Start
                </button>
                <button
                  type="button"
                  className={`btn-chip ${offsetMode === 'random' ? 'active' : ''}`}
                  onClick={() => handleOffsetModeChange('random')}
                >
                  <Shuffle size={13} />
                  <span>Random</span>
                </button>
              </div>
            </div>

            {gameMode === 'spotify' && (
              <div className="settings-group">
                <span className="settings-title">Spotify Audio</span>
                <div className="pill-toggle-group">
                  <button
                    type="button"
                    className={`btn-chip ${
                      spotifyStrategy === 'youtube-iframe-fallback' ? 'active' : ''
                    }`}
                    onClick={() => handleSpotifyStrategyChange('youtube-iframe-fallback')}
                  >
                    YouTube Match
                  </button>
                  <button
                    type="button"
                    className={`btn-chip ${
                      spotifyStrategy === 'web-playback-sdk' ? 'active' : ''
                    }`}
                    onClick={() => handleSpotifyStrategyChange('web-playback-sdk')}
                  >
                    Spotify SDK
                  </button>
                </div>
              </div>
            )}

            {!isPartyMode && soloCatalog.length > 0 && (
              <div className="settings-group">
                <span className="settings-title">Library ({soloCatalog.length})</span>
                <div className="pill-toggle-group">
                  <button
                    type="button"
                    className="btn-chip"
                    onClick={() => void handleConnectAndSync(true)}
                    disabled={isLoadingLibrary}
                  >
                    <RefreshCw className={isLoadingLibrary ? 'spin' : ''} size={13} />
                    <span>Re-sync</span>
                  </button>
                  <button type="button" className="btn-chip danger" onClick={handleDisconnect}>
                    <LogOut size={13} />
                    <span>Disconnect</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      <main className="main-stage">
        {errorMessage && (
          <div className="error-toast" role="alert">
            <AlertCircle size={16} />
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

        {/* 1. PARTY MODE LOBBY VIEW */}
        {isPartyMode && (isPartyLobbyOpen || catalog.length === 0) ? (
          <section className="surface-card party-lobby-card" aria-label="Party Mode Lobby">
            <div className="party-mode-tabs">
              <button
                type="button"
                className={`party-tab-btn ${partyTab === 'host' ? 'active' : ''}`}
                onClick={() => setPartyTab('host')}
              >
                <Users size={15} />
                <span>Host Party ({partyMembers.length})</span>
              </button>
              <button
                type="button"
                className={`party-tab-btn ${partyTab === 'join' ? 'active' : ''}`}
                onClick={() => setPartyTab('join')}
              >
                <Send size={15} />
                <span>Join Room Code</span>
              </button>
            </div>

            {partyTab === 'host' ? (
              <div className="party-host-stack">
                {/* Auto-Hosted Room Code Banner */}
                <div className="room-code-banner">
                  <div className="room-code-badge">
                    <span className="code-label">LIVE ROOM CODE (SHARE WITH FRIENDS)</span>
                    <div className="code-value-row">
                      <span className="code-value">{hostRoomCode ?? '...'}</span>
                      <button
                        type="button"
                        className="btn-icon-mini"
                        onClick={() => void handleManualRoomRefresh()}
                        title="Check for joined players now"
                        aria-label="Check for joined players"
                      >
                        <RefreshCw className={isPollingRoom ? 'spin' : ''} size={14} />
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn-secondary btn-share-invite"
                    disabled={!hostRoomCode}
                    onClick={() => void handleShareOrCopyInvite()}
                  >
                    {copiedLink ? <Check size={15} /> : <Share2 size={15} />}
                    <span>{copiedLink ? 'Link Copied!' : 'Share Invite Link'}</span>
                  </button>
                </div>

                {/* Add Player on This Device */}
                <div className="party-add-card">
                  <span className="section-label">Add Player on This Device</span>
                  <div className="party-form-row">
                    <input
                      type="text"
                      className="party-text-input"
                      placeholder="Player Name"
                      value={newPlayerName}
                      onChange={(e) => handlePlayerNameChange(e.target.value)}
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
                        <span>YouTube</span>
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

                  <div className="party-btn-row">
                    {selectedPartyProviderCachedCount > 0 && (
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => void handleAddPartyPlayer(true)}
                      >
                        + Add Saved ({selectedPartyProviderCachedCount} songs)
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={isLoadingLibrary}
                      onClick={() => void handleAddPartyPlayer(false)}
                    >
                      <UserPlus size={15} />
                      <span>
                        {isLoadingLibrary
                          ? 'Syncing...'
                          : `Sign In (${
                              newPlayerProvider === 'youtube-music' ? 'YouTube' : 'Spotify'
                            })`}
                      </span>
                    </button>
                  </div>
                </div>

                {/* Roster & Start Party Quiz */}
                <div className="party-roster-card">
                  <div className="roster-header">
                    <span className="section-label">
                      Joined Players ({partyMembers.length})
                    </span>
                    {partyMembers.length > 0 && (
                      <button
                        type="button"
                        className="btn-chip danger"
                        onClick={handleClearParty}
                      >
                        <Trash2 size={13} />
                        <span>Reset Room</span>
                      </button>
                    )}
                  </div>

                  {partyMembers.length === 0 ? (
                    <p className="party-empty-hint">
                      Share the Room Code above with friends on their phones, or add players here.
                      Shared songs play first!
                    </p>
                  ) : (
                    <>
                      <div className="party-stats-pills">
                        <div className="party-stat-box highlight">
                          <span className="p-stat-num">{mergedPartyPool.sharedMatchesCount}</span>
                          <span className="p-stat-label">Shared Matches</span>
                        </div>
                        <div className="party-stat-box">
                          <span className="p-stat-num">{mergedPartyPool.totalUniqueCount}</span>
                          <span className="p-stat-label">Total Unique Songs</span>
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
                                {member.provider === 'youtube-music' ? 'YouTube' : 'Spotify'} ·{' '}
                                {member.tracks.length} songs
                              </span>
                            </div>
                            <button
                              type="button"
                              className="member-remove"
                              onClick={() => handleRemovePartyMember(member.id)}
                              aria-label={`Remove ${member.name}`}
                            >
                              <X size={15} />
                            </button>
                          </div>
                        ))}
                      </div>

                      <button
                        type="button"
                        className="btn-primary btn-full-width"
                        onClick={() => {
                          cancelCurrentGame();
                          setIsPartyLobbyOpen(false);
                          void startNewRound(mergedPartyPool.tracks, true);
                        }}
                      >
                        <Play size={16} />
                        <span>Start Party Quiz ({mergedPartyPool.totalUniqueCount} Songs)</span>
                      </button>
                    </>
                  )}
                </div>
              </div>
            ) : (
              /* Remote Guest Join Tab (Mobile-Optimized) */
              <div className="party-join-panel">
                <p className="join-lead">
                  Enter the host&apos;s 5-character Room Code and connect your music library to add
                  your songs to the party.
                </p>

                <div className="join-fields-stack">
                  <div className="join-inputs-row">
                    <input
                      type="text"
                      maxLength={6}
                      className="party-text-input code-input"
                      placeholder="CODE"
                      value={joinRoomCode}
                      onChange={(e) => handleJoinCodeChange(e.target.value)}
                    />
                    <input
                      type="text"
                      className="party-text-input"
                      placeholder="Your Name"
                      value={newPlayerName}
                      onChange={(e) => handlePlayerNameChange(e.target.value)}
                    />
                  </div>

                  <div className="provider-segmented full-width">
                    <button
                      type="button"
                      className={`seg-btn ${
                        newPlayerProvider === 'youtube-music' ? 'active' : ''
                      }`}
                      onClick={() => setNewPlayerProvider('youtube-music')}
                    >
                      <Music2 size={14} />
                      <span>YouTube Music</span>
                    </button>
                    <button
                      type="button"
                      className={`seg-btn ${newPlayerProvider === 'spotify' ? 'active' : ''}`}
                      onClick={() => setNewPlayerProvider('spotify')}
                    >
                      <Sparkles size={14} />
                      <span>Spotify</span>
                    </button>
                  </div>
                </div>

                <div className="party-btn-row">
                  {selectedPartyProviderCachedCount > 0 && (
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={isLoadingLibrary}
                      onClick={() => void handleGuestJoinAndSend(true)}
                    >
                      <Send size={15} />
                      <span>Send Saved ({selectedPartyProviderCachedCount} songs)</span>
                    </button>
                  )}

                  <button
                    type="button"
                    className="btn-primary"
                    disabled={isLoadingLibrary}
                    onClick={() => void handleGuestJoinAndSend(false)}
                  >
                    <Send size={15} />
                    <span>
                      {isLoadingLibrary
                        ? 'Connecting & Sending...'
                        : `Sign In & Send (${
                            newPlayerProvider === 'youtube-music' ? 'YouTube' : 'Spotify'
                          })`}
                    </span>
                  </button>
                </div>

                {guestAck && (
                  <div className="guest-ack-banner">
                    <CheckCircle2 size={18} />
                    <span>
                      Sent to Room <strong>{guestAck.roomCode}</strong>!{' '}
                      {guestAck.memberCount > 1 ? (
                        <>
                          Party now has <strong>{guestAck.memberCount} players</strong> (
                          <strong>{guestAck.sharedMatchesCount} shared</strong> ·{' '}
                          <strong>{guestAck.totalTracksCount} total songs</strong>).
                        </>
                      ) : (
                        <>Your songs are now synced with the host!</>
                      )}
                    </span>
                  </div>
                )}
              </div>
            )}
          </section>
        ) : catalog.length === 0 ? (
          /* 2. SIMPLIFIED SOLO ONBOARDING VIEW */
          <section className="surface-card onboarding-view">
            <div className="hero-badge">
              {activeProviderId === 'youtube-music' ? (
                <Music2 size={14} />
              ) : (
                <Sparkles size={14} />
              )}
              <span>{activeProvider.displayName} Quiz</span>
            </div>
            <h2>Guess your own Liked Songs from 0.1s</h2>
            <p className="onboarding-lead">
              Unlock longer audio clips if you need a hint—the faster you identify the track, the
              higher your score.
            </p>

            <div className="cta-stack">
              <button
                type="button"
                className="btn-cta-connect"
                disabled={!activeProvider.isConfigured() || isLoadingLibrary}
                onClick={() => void handleConnectAndSync(true)}
              >
                {isLoadingLibrary ? (
                  <>
                    <RefreshCw className="spin" size={19} />
                    <span>Loading Liked Songs...</span>
                  </>
                ) : (
                  <>
                    <Play size={19} />
                    <span>Connect {activeProvider.displayName}</span>
                  </>
                )}
              </button>

              {!activeProvider.isConfigured() && (
                <div className="setup-hint-box">
                  <AlertCircle size={15} />
                  <span>
                    {activeProviderId === 'youtube-music' ? (
                      <>
                        Configure <code>VITE_GOOGLE_CLIENT_ID</code> and{' '}
                        <code>VITE_GOOGLE_API_KEY</code> in <code>.env.local</code>.
                      </>
                    ) : (
                      <>
                        Configure <code>VITE_SPOTIFY_CLIENT_ID</code> in <code>.env.local</code>{' '}
                        (Redirect: <code>{env.spotify.redirectUri}</code>).
                      </>
                    )}
                  </span>
                </div>
              )}
            </div>
          </section>
        ) : view === 'summary' ? (
          /* 3. SUMMARY / END-OF-RUN RANKING VIEW */
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
                <span className="tile-label">Avg Time</span>
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
                        <Music2 size={15} />
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
                Keep Playing
              </button>
              <button type="button" className="btn-primary" onClick={handleResetRun}>
                <RotateCcw size={15} />
                <span>New Run</span>
              </button>
            </div>
          </section>
        ) : (
          /* 4. ACTIVE QUIZ VIEW */
          <section
            className={`surface-card quiz-stage ${
              roundState !== 'playing' ? `result-focused ${roundState}` : ''
            }`}
          >
            <ConfettiCanvas active={roundState === 'won'} />

            {isPartyMode && (
              <div className="party-active-bar">
                <div className="party-roster-chips">
                  <span className="party-bar-label">
                    <Users size={13} /> {mergedPartyPool.sharedMatchesCount} shared ·{' '}
                    {mergedPartyPool.totalUniqueCount} songs
                  </span>
                  {partyMembers.map((m) => (
                    <span key={m.id} className="fav-mini-pill" style={{ borderColor: m.color }}>
                      <i style={{ backgroundColor: m.color }} />
                      {m.name}
                    </span>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn-party-lobby-link"
                  onClick={() => {
                    cancelCurrentGame();
                    setIsPartyLobbyOpen(true);
                  }}
                >
                  Lobby {hostRoomCode ? `(${hostRoomCode})` : ''}
                </button>
              </div>
            )}

            {roundState === 'playing' ? (
              <>
                {/* Compact Status Header */}
                <div className="stage-header">
                  <div className="potential-score-box">
                    <span className="stage-eyebrow">Points at Stake</span>
                    <div className="points-display-row">
                      <span className="points-value">{potentialNetPoints.toLocaleString()}</span>
                      <span className="points-unit">pts</span>
                      {wrongGuessesCount > 0 && (
                        <span className="penalty-badge">
                          −{(wrongGuessesCount * WRONG_GUESS_PENALTY).toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="snippet-length-box">
                    <span className="stage-eyebrow">Clip Length</span>
                    <div className="length-display-row">
                      <Ear size={16} className="ear-icon" />
                      <span className="length-value">{snippetDurationSec.toFixed(1)}s</span>
                      <span className="length-max">/ 30s</span>
                    </div>
                  </div>
                </div>

                {/* Compact Mobile-Friendly Player Deck */}
                <div className={`player-deck ${isPlaying ? 'is-playing' : ''}`}>
                  <div className="player-top-row">
                    <button
                      type="button"
                      className={`hero-play-btn ${isPlaying ? 'playing' : ''}`}
                      onClick={() => void handlePlayToggle()}
                      disabled={!currentTrack}
                      aria-label={isPlaying ? 'Stop playback' : 'Play snippet'}
                    >
                      {isPlaying ? (
                        <Square size={22} />
                      ) : (
                        <Play size={24} className="play-offset" />
                      )}
                    </button>

                    <div className="scrubber-column">
                      <div className="timeline-status-row">
                        <span className="status-text">
                          {isPlaying ? (
                            <>
                              <Volume2 size={14} className="pulse-icon" />{' '}
                              {playbackElapsedSec.toFixed(1)}s / {snippetDurationSec.toFixed(1)}s
                            </>
                          ) : (
                            <>Slide or tap a milestone below</>
                          )}
                        </span>
                        <span className="curve-hint">
                          {baseCurvePoints.toLocaleString()} base
                        </span>
                      </div>

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
                    </div>
                  </div>

                  {/* 8 Milestone Pills (4x2 grid on mobile, single row on desktop) */}
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
                        >
                          {sec}s
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Search & Guess Input */}
                <div className="guess-zone">
                  <div className="search-bar-container">
                    <div className="search-field-box">
                      <Search className="search-icon" size={18} />
                      <input
                        ref={searchInputRef}
                        type="text"
                        className="search-input"
                        placeholder={`Search ${catalog.length} songs...`}
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
                      title="Skip and reveal song"
                    >
                      <Flag size={14} />
                      <span>Skip</span>
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
                                <Music2 size={14} />
                              </div>
                            )}
                            <div className="suggestion-text">
                              <span className="suggestion-title">{track.title}</span>
                              <span className="suggestion-artist">{track.artist}</span>
                            </div>
                            <span className="suggestion-submit-hint">Guess</span>
                          </button>
                        ))
                      ) : (
                        <div className="suggestions-empty">No matching songs found.</div>
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
                        <CheckCircle2 size={16} />
                        <span>Got it in {effectiveScoringDuration.toFixed(1)}s!</span>
                      </span>
                    ) : (
                      <span className="spotlight-status gave-up">
                        <XCircle size={16} />
                        <span>Skipped · Revealed</span>
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
                          <Disc3 className={isPlaying ? 'spin-slow' : ''} size={42} />
                        </div>
                      )}
                      <button
                        type="button"
                        className="spotlight-play-overlay"
                        onClick={() => void handlePlayToggle()}
                        aria-label={isPlaying ? 'Pause song' : 'Resume song'}
                      >
                        {isPlaying ? (
                          <Square size={20} />
                        ) : (
                          <Play size={22} className="play-offset" />
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
                        <span>{isPlaying ? 'Now Playing' : 'Paused'}</span>
                      </div>
                      <h2 className="spotlight-title">{currentTrack.title}</h2>
                      <p className="spotlight-artist">{currentTrack.artist}</p>

                      {/* Favorited By Attribution */}
                      <div className="favorited-by-block">
                        <span className="favorited-by-label">
                          <Heart size={12} className="heart-icon" />
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
                                  {fav.provider === 'youtube-music' ? 'YT' : 'Spotify'}
                                </span>
                              </span>
                            ))
                          ) : (
                            <span className="favorited-user-pill">
                              <span
                                className="fav-dot"
                                style={{ backgroundColor: 'var(--accent)' }}
                              />
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
                      <Trophy size={15} />
                      <span>Run Summary</span>
                    </button>
                    <button
                      type="button"
                      autoFocus
                      className="btn-primary btn-next-song-lg"
                      onClick={() => void startNewRound()}
                    >
                      <span>Next Song</span>
                      <ArrowRight size={17} />
                    </button>
                  </div>
                </div>
              )
            )}

            {/* Attempts List */}
            {guesses.length > 0 && (
              <div className="attempts-section">
                <div className="attempts-header">
                  <span>Attempts ({guesses.length})</span>
                  <span>−{WRONG_GUESS_PENALTY} pts / wrong</span>
                </div>
                <div className="attempts-list">
                  {guesses.map((g, idx) => (
                    <div
                      key={`${g.trackId}-${idx}`}
                      className={`attempt-item ${g.correct ? 'correct' : 'wrong'}`}
                    >
                      {g.correct ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                      <div className="attempt-song">
                        <strong>{g.title}</strong>
                        <span>{g.artist}</span>
                      </div>
                      <span className="attempt-badge">
                        {g.snippetDurationAtGuessSec.toFixed(1)}s
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
