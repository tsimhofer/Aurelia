import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Crown,
  Disc3,
  Ear,
  Flag,
  Globe,
  Heart,
  Home,
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
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Trophy,
  UserCheck,
  UserPlus,
  Users,
  Volume2,
  X,
  XCircle,
} from 'lucide-react';
import { ConfettiCanvas } from './components/ConfettiCanvas';
import { getEnvConfig } from './config/env';
import {
  DEFAULT_FILTER_CONFIG,
  evaluateTrackPoolFilters,
  inferTrackEra,
  inferTrackGenres,
  MUSIC_ERA_OPTIONS,
  MUSIC_GENRE_OPTIONS,
  MusicEraId,
  MusicGenreId,
  PoolMatchMode,
  PreGameFilterConfig,
} from './game/musicFilters';
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
  PartyCatalogItem,
  PartyGuessPayload,
  PartyLeaderboardEntry,
  PartyRoomService,
  PartyRoomStatePayload,
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
type PartyLocationMode = 'local' | 'remote' | 'coop';

const MILESTONE_SECONDS = [0.1, 0.5, 1, 2, 5, 10, 15, 30];
const STORAGE_KEY_PARTY_MEMBERS = 'aurelia.party.members.v2';
const STORAGE_KEY_PENDING_PARTY_ACTION = 'aurelia.party.pending_action.v4';
const STORAGE_KEY_GAME_SESSION = 'aurelia.game.session.v4';
const STORAGE_KEY_SAVED_JOIN_CODE = 'aurelia.party.join_code.v1';
const STORAGE_KEY_SAVED_PLAYER_NAME = 'aurelia.party.player_name.v1';
const STORAGE_KEY_SAVED_HOST_NAME = 'aurelia.party.host_name.v1';
const STORAGE_KEY_GUEST_MEMBER_ID = 'aurelia.party.guest_id.v1';

interface PendingPartyAction {
  locationMode: PartyLocationMode;
  mode: 'host-add' | 'local-add' | 'remote-join';
  playerName: string;
  provider: ProviderId;
  roomCode?: string;
  createdAt: number;
}

interface PersistedGameSession {
  gameMode: GameMode;
  partyLocationMode: PartyLocationMode;
  isPartyLobbyOpen: boolean;
  view: ScreenView;
  offsetMode: OffsetMode;
  filterConfig?: PreGameFilterConfig;
  currentTrack: Track | null;
  startOffsetSec: number;
  snippetDurationSec: number;
  maxUnlockedDurationSec: number;
  guesses: RoundGuess[];
  roundState: 'playing' | 'won' | 'gave-up';
  roundHistory: CompletedRound[];
  usedTrackIds: string[];
  memberPickCounts: Record<string, number>;
  partyScores: Record<string, number>;
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
      if (Array.isArray(parsed)) {
        return parsed.map((m) => ({
          ...m,
          isReady: false,
        }));
      }
    }
  } catch {
    // Ignore
  }
  return [];
}

function getOrCreateGuestMemberId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY_GUEST_MEMBER_ID);
    if (existing) return existing;
    const created = `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    localStorage.setItem(STORAGE_KEY_GUEST_MEMBER_ID, created);
    return created;
  } catch {
    return `guest-${Date.now().toString(36)}`;
  }
}

export function App() {
  const env = useMemo(() => getEnvConfig(), []);
  const savedSession = useMemo(() => loadSavedGameSession(), []);
  const guestMemberId = useMemo(() => getOrCreateGuestMemberId(), []);
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

  // Party Mode Differentiation: 'local' (Same Room), 'remote' (Online Room), or 'coop' (Co-Op Shared Score)
  const [partyLocationMode, setPartyLocationMode] = useState<PartyLocationMode>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.has('party')) return 'remote';
      const pendingRaw = localStorage.getItem(STORAGE_KEY_PENDING_PARTY_ACTION);
      if (pendingRaw) {
        const pending = JSON.parse(pendingRaw) as PendingPartyAction;
        if (pending.locationMode) return pending.locationMode;
      }
      if (savedSession?.partyLocationMode) {
        return savedSession.partyLocationMode;
      }
    } catch {
      // Ignore
    }
    return 'local';
  });
  const partyLocationModeRef = useRef<PartyLocationMode>(partyLocationMode);
  useEffect(() => {
    partyLocationModeRef.current = partyLocationMode;
  }, [partyLocationMode]);

  const [coopRoundWinnerName, setCoopRoundWinnerName] = useState<string | undefined>(undefined);

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

  // Host Name & Party Members State
  const [hostName, setHostName] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_SAVED_HOST_NAME) || 'Host';
    } catch {
      return 'Host';
    }
  });

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
  const [partyScores, setPartyScores] = useState<Record<string, number>>(
    () => savedSession?.partyScores ?? {}
  );
  const partyScoresRef = useRef<Record<string, number>>(partyScores);
  useEffect(() => {
    partyScoresRef.current = partyScores;
  }, [partyScores]);

  // Per-round player guess states in Online Party Mode
  const [roundPlayerStates, setRoundPlayerStates] = useState<
    Record<
      string,
      {
        roundStatus: 'guessing' | 'correct' | 'gave-up';
        roundPoints: number;
        wrongAttempts: number;
        guessTimestampMs?: number;
        guessSnippetSec?: number;
        lastGuessTitle?: string;
      }
    >
  >({});
  const roundPlayerStatesRef = useRef(roundPlayerStates);
  useEffect(() => {
    roundPlayerStatesRef.current = roundPlayerStates;
  }, [roundPlayerStates]);

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

  // Remote Guest State
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
  const [guestIsReady, setGuestIsReady] = useState<boolean>(false);
  const [guestRoomState, setGuestRoomState] = useState<PartyRoomStatePayload | null>(null);
  const [guestCatalog, setGuestCatalog] = useState<PartyCatalogItem[]>([]);
  const [guestSyncedRoundKey, setGuestSyncedRoundKey] = useState<string>('');
  const [currentRoundId, setCurrentRoundId] = useState<string>('');
  const [isPreparingRound, setIsPreparingRound] = useState<boolean>(false);

  const handleHostNameChange = (val: string) => {
    setHostName(val);
    try {
      localStorage.setItem(STORAGE_KEY_SAVED_HOST_NAME, val);
    } catch {
      // Ignore
    }
    const clean = val.trim() || 'Host';
    const current = partyMembersRef.current;
    if (current.some((m) => m.isHost)) {
      const updated = current.map((m) => (m.isHost ? { ...m, name: clean } : m));
      partyMembersRef.current = updated;
      setPartyMembers(updated);
    }
  };

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
  const allPartyMembersReady = useMemo(
    () => partyMembers.length > 0 && partyMembers.every((m) => m.isReady),
    [partyMembers]
  );
  const unreadyPartyMembersCount = useMemo(
    () => partyMembers.filter((m) => !m.isReady).length,
    [partyMembers]
  );

  const isPartyMode = gameMode === 'party';
  const isOnlinePartyHost = isPartyMode && partyTab === 'host';
  const isRemoteGuestPlaying =
    isPartyMode &&
    partyTab === 'join' &&
    Boolean(
      guestRoomState &&
        (guestRoomState.status === 'playing' || guestRoomState.status === 'revealed')
    );

  const [filterConfig, setFilterConfig] = useState<PreGameFilterConfig>(
    () => savedSession?.filterConfig ?? DEFAULT_FILTER_CONFIG
  );
  const [isSoloFilterOpen, setIsSoloFilterOpen] = useState<boolean>(
    () => (savedSession?.roundHistory?.length ?? 0) === 0 && (savedSession?.guesses?.length ?? 0) === 0
  );

  const rawCatalog = isPartyMode ? mergedPartyPool.tracks : soloCatalog;

  const effectiveFilterConfig = useMemo<PreGameFilterConfig>(
    () => ({
      matchMode:
        !isPartyMode && filterConfig.matchMode === 'shared' ? 'all' : filterConfig.matchMode,
      genres: filterConfig.genres,
      eras: filterConfig.eras,
    }),
    [isPartyMode, filterConfig]
  );

  const filteredPoolStats = useMemo(
    () =>
      evaluateTrackPoolFilters(
        rawCatalog,
        isPartyMode ? partyMembers : [],
        effectiveFilterConfig
      ),
    [rawCatalog, isPartyMode, partyMembers, effectiveFilterConfig]
  );

  const catalog = filteredPoolStats.filteredTracks;

  const hasActiveFilters =
    effectiveFilterConfig.matchMode !== 'all' ||
    effectiveFilterConfig.genres.length > 0 ||
    effectiveFilterConfig.eras.length > 0;

  const activeFilterBadges = useMemo(() => {
    const badges: string[] = [];
    if (effectiveFilterConfig.matchMode === 'shared') {
      badges.push('Shared Libraries Only');
    } else if (effectiveFilterConfig.matchMode === 'similar') {
      badges.push('Similar Music Only');
    }
    for (const g of effectiveFilterConfig.genres) {
      const label = MUSIC_GENRE_OPTIONS.find((opt) => opt.id === g)?.shortLabel;
      if (label) badges.push(label);
    }
    for (const e of effectiveFilterConfig.eras) {
      const label = MUSIC_ERA_OPTIONS.find((opt) => opt.id === e)?.shortLabel;
      if (label) badges.push(label);
    }
    return badges;
  }, [effectiveFilterConfig]);

  // Game & Round State (Each player controls their own music player & snippet duration!)
  const [view, setView] = useState<ScreenView>(() => savedSession?.view ?? 'quiz');
  const [offsetMode, setOffsetMode] = useState<OffsetMode>(
    () => savedSession?.offsetMode ?? 'zero'
  );
  const [currentTrack, setCurrentTrack] = useState<Track | null>(
    () => savedSession?.currentTrack ?? null
  );
  const currentTrackRef = useRef<Track | null>(currentTrack);
  useEffect(() => {
    currentTrackRef.current = currentTrack;
  }, [currentTrack]);

  const [startOffsetSec, setStartOffsetSec] = useState<number>(
    () => savedSession?.startOffsetSec ?? 0
  );
  const [snippetDurationSec, setSnippetDurationSec] = useState<number>(
    () => savedSession?.snippetDurationSec ?? MIN_SNIPPET_SECONDS
  );
  const [maxUnlockedDurationSec, setMaxUnlockedDurationSec] = useState<number>(
    () => savedSession?.maxUnlockedDurationSec ?? MIN_SNIPPET_SECONDS
  );
  const maxUnlockedRef = useRef<number>(maxUnlockedDurationSec);
  useEffect(() => {
    maxUnlockedRef.current = maxUnlockedDurationSec;
  }, [maxUnlockedDurationSec]);

  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackElapsedSec, setPlaybackElapsedSec] = useState<number>(0);

  const [guesses, setGuesses] = useState<RoundGuess[]>(() => savedSession?.guesses ?? []);
  const [roundState, setRoundState] = useState<'playing' | 'won' | 'gave-up'>(
    () => savedSession?.roundState ?? 'playing'
  );
  const roundStateRef = useRef(roundState);
  useEffect(() => {
    roundStateRef.current = roundState;
  }, [roundState]);

  const [roundHistory, setRoundHistory] = useState<CompletedRound[]>(
    () => savedSession?.roundHistory ?? []
  );
  const [usedTrackIds, setUsedTrackIds] = useState<Set<string>>(
    () => new Set(savedSession?.usedTrackIds ?? [])
  );

  const runningTotalScore = useMemo(
    () => roundHistory.reduce((sum, r) => sum + r.pointsAwarded, 0),
    [roundHistory]
  );

  // Persist active game session
  useEffect(() => {
    try {
      const payload: PersistedGameSession = {
        gameMode,
        partyLocationMode,
        isPartyLobbyOpen,
        view,
        offsetMode,
        filterConfig,
        currentTrack,
        startOffsetSec,
        snippetDurationSec,
        maxUnlockedDurationSec,
        guesses,
        roundState,
        roundHistory,
        usedTrackIds: Array.from(usedTrackIds),
        memberPickCounts,
        partyScores,
      };
      localStorage.setItem(STORAGE_KEY_GAME_SESSION, JSON.stringify(payload));
    } catch {
      // Ignore storage errors
    }
  }, [
    gameMode,
    partyLocationMode,
    isPartyLobbyOpen,
    view,
    offsetMode,
    filterConfig,
    currentTrack,
    startOffsetSec,
    snippetDurationSec,
    maxUnlockedDurationSec,
    guesses,
    roundState,
    roundHistory,
    usedTrackIds,
    memberPickCounts,
    partyScores,
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

  useEffect(() => {
    if (savedSession?.currentTrack && !(savedSession.gameMode === 'party' && savedSession.isPartyLobbyOpen)) {
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

  // When a Guest is in the lobby or receives a new round / track from the Host,
  // guarantee 100% synchronization to the Host's exact currentTrack, videoId, and startOffsetSec!
  useEffect(() => {
    if (isPartyMode && partyTab === 'join' && guestRoomState?.status === 'lobby') {
      if (guestSyncedRoundKey !== '') {
        stopAllPlayback();
        setGuestSyncedRoundKey('');
        setCurrentTrack(null);
        setGuesses([]);
        setRoundState('playing');
      }
      return;
    }

    if (!isRemoteGuestPlaying || !guestRoomState?.currentTrack) return;

    const incomingTrack = guestRoomState.currentTrack;
    const incomingOffset = guestRoomState.startOffsetSec ?? 0;
    const roundIdentity = `${guestRoomState.roundId || guestRoomState.roundNumber}::${incomingTrack.id}`;
    const fullSyncKey = `${roundIdentity}::${incomingTrack.videoId ?? ''}::${incomingOffset}`;

    if (fullSyncKey !== guestSyncedRoundKey) {
      const isNewRoundTrack = !guestSyncedRoundKey.startsWith(`${roundIdentity}::`);
      stopAllPlayback();
      setGuestSyncedRoundKey(fullSyncKey);
      currentTrackRef.current = incomingTrack;
      setCurrentTrack(incomingTrack);
      setStartOffsetSec(incomingOffset);

      if (isNewRoundTrack) {
        setSnippetDurationSec(MIN_SNIPPET_SECONDS);
        maxUnlockedRef.current = MIN_SNIPPET_SECONDS;
        setMaxUnlockedDurationSec(MIN_SNIPPET_SECONDS);
        setGuesses([]);
        roundStateRef.current = 'playing';
        setRoundState('playing');
        setSearchQuery('');
        setIsDropdownOpen(false);
      }

      const provider = getPlaybackProviderForTrack(incomingTrack);
      void provider.cueTrack(incomingTrack).catch(() => {});
    } else if (guestRoomState.status === 'revealed' && roundState === 'playing') {
      const effectiveLocMode = guestRoomState.partyLocationMode ?? partyLocationMode;
      const anyCorrect = guestRoomState.leaderboard.some((e) => e.roundStatus === 'correct');
      const myEntry = guestRoomState.leaderboard.find((e) => e.memberId === guestMemberId);
      const nextSt =
        effectiveLocMode === 'coop'
          ? anyCorrect
            ? 'won'
            : 'gave-up'
          : myEntry?.roundStatus === 'correct'
            ? 'won'
            : 'gave-up';
      roundStateRef.current = nextSt;
      setRoundState(nextSt);
      if (effectiveLocMode === 'remote' || effectiveLocMode === 'coop') {
        setIsPlaying(true);
        const provider = getPlaybackProviderForTrack(incomingTrack);
        void provider.playFullTrack(incomingTrack, incomingOffset).catch(() => {
          setIsPlaying(false);
        });
      }
    }
  }, [
    isPartyMode,
    partyTab,
    isRemoteGuestPlaying,
    guestRoomState,
    guestSyncedRoundKey,
    roundState,
    guestMemberId,
    partyLocationMode,
    stopAllPlayback,
  ]);

  // Build the live PartyLeaderboardEntry[] (in Co-Op mode, all players share runningTotalScore)
  const partyLeaderboard = useMemo<PartyLeaderboardEntry[]>(() => {
    const entries: PartyLeaderboardEntry[] = partyMembers.map((m) => {
      const rState = roundPlayerStates[m.id];
      return {
        memberId: m.id,
        name: m.name,
        color: m.color,
        provider: m.provider,
        trackCount: m.tracks.length,
        isReady: m.isReady,
        isHost: m.isHost,
        totalScore:
          partyLocationMode === 'coop' ? runningTotalScore : (partyScores[m.id] ?? 0),
        roundStatus: rState?.roundStatus ?? 'guessing',
        roundPoints: rState?.roundPoints ?? 0,
        wrongAttempts: rState?.wrongAttempts ?? 0,
        guessTimestampMs: rState?.guessTimestampMs,
        guessSnippetSec: rState?.guessSnippetSec,
        lastGuessTitle: rState?.lastGuessTitle,
      };
    });

    if (partyLocationMode === 'coop') {
      return entries;
    }

    return entries.sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      if (a.guessSnippetSec !== undefined && b.guessSnippetSec !== undefined) {
        return a.guessSnippetSec - b.guessSnippetSec;
      }
      return 0;
    });
  }, [partyMembers, roundPlayerStates, partyScores, partyLocationMode, runningTotalScore]);

  // Broadcast live room state from Host to all connected Guests (only when round track is ready!)
  useEffect(() => {
    if (!isOnlinePartyHost || !hostRoomCode || isPreparingRound) return;

    const status: PartyRoomStatePayload['status'] = isPartyLobbyOpen
      ? 'lobby'
      : view === 'summary'
        ? 'summary'
        : roundState === 'playing'
          ? 'playing'
          : 'revealed';

    const lastRoundPts = roundHistory[roundHistory.length - 1]?.pointsAwarded ?? 0;

    const statePayload: PartyRoomStatePayload = {
      type: 'PARTY_ROOM_STATE',
      roomCode: hostRoomCode,
      updatedAtMs: Date.now(),
      status,
      partyLocationMode,
      sharedScore: runningTotalScore,
      lastRoundPoints: lastRoundPts,
      roundWinnerName: coopRoundWinnerName,
      hostName: hostName.trim() || 'Host',
      sharedMatchesCount: mergedPartyPool.sharedMatchesCount,
      totalTracksCount: mergedPartyPool.totalUniqueCount,
      roundId: status === 'lobby' ? '' : currentRoundId,
      roundNumber:
        status === 'lobby' ? 0 : roundHistory.length + (roundState === 'playing' ? 1 : 0),
      roundStartedAtMs: 0,
      startOffsetSec: status === 'lobby' ? 0 : startOffsetSec,
      snippetDurationSec,
      maxUnlockedDurationSec,
      isPlayingAudio: isPlaying,
      currentTrack: status === 'lobby' ? null : currentTrack,
      leaderboard: partyLeaderboard,
    };

    partyRoomRef.current?.broadcastRoomState(statePayload);
  }, [
    isOnlinePartyHost,
    hostRoomCode,
    isPreparingRound,
    isPartyLobbyOpen,
    partyLocationMode,
    runningTotalScore,
    coopRoundWinnerName,
    view,
    roundState,
    hostName,
    mergedPartyPool.sharedMatchesCount,
    mergedPartyPool.totalUniqueCount,
    currentRoundId,
    roundHistory,
    startOffsetSec,
    snippetDurationSec,
    maxUnlockedDurationSec,
    isPlaying,
    currentTrack,
    partyLeaderboard,
  ]);

  // Broadcast merged catalog search index whenever active filtered pool changes on the Host
  useEffect(() => {
    const poolToBroadcast = catalog.length > 0 ? catalog : mergedPartyPool.tracks;
    if (isOnlinePartyHost && poolToBroadcast.length > 0) {
      partyRoomRef.current?.broadcastCatalogIndex(poolToBroadcast);
    }
  }, [isOnlinePartyHost, catalog, mergedPartyPool.tracks]);

  const resetAllPartyMembersToUnready = useCallback(() => {
    const current = partyMembersRef.current;
    if (current.length === 0) return;
    const updated = current.map((m) => ({ ...m, isReady: false }));
    partyMembersRef.current = updated;
    setPartyMembers(updated);
  }, []);

  const cancelCurrentGame = useCallback(() => {
    stopAllPlayback();
    setPlaybackElapsedSec(0);
    setErrorMessage(null);
    currentTrackRef.current = null;
    setCurrentTrack(null);
    setCurrentRoundId('');
    setCoopRoundWinnerName(undefined);
    setStartOffsetSec(0);
    setSnippetDurationSec(MIN_SNIPPET_SECONDS);
    maxUnlockedRef.current = MIN_SNIPPET_SECONDS;
    setMaxUnlockedDurationSec(MIN_SNIPPET_SECONDS);
    setGuesses([]);
    roundStateRef.current = 'playing';
    setRoundState('playing');
    setRoundHistory([]);
    setUsedTrackIds(new Set());
    setMemberPickCounts({});
    setPartyScores({});
    roundPlayerStatesRef.current = {};
    setRoundPlayerStates({});
    setGuestSyncedRoundKey('');
    setSearchQuery('');
    setIsDropdownOpen(false);
    setView('quiz');
    try {
      localStorage.removeItem(STORAGE_KEY_GAME_SESSION);
    } catch {
      // Ignore
    }
  }, [stopAllPlayback]);

  const addOrUpdatePartyMember = useCallback(
    (
      name: string,
      provider: ProviderId,
      tracks: Track[],
      options?: { explicitId?: string; isHost?: boolean; isReady?: boolean }
    ): PartyMember[] => {
      const currentList = partyMembersRef.current;
      const cleanName = name.trim() || `Player ${currentList.length + 1}`;
      const explicitId = options?.explicitId;
      const isHost = options?.isHost ?? false;
      const defaultReady = options?.isReady ?? false;

      const existingIdx = currentList.findIndex(
        (m) =>
          (isHost && m.isHost) ||
          (explicitId && m.id === explicitId) ||
          (m.name.toLowerCase() === cleanName.toLowerCase() && m.provider === provider)
      );

      let updatedList: PartyMember[];
      if (existingIdx >= 0) {
        updatedList = [...currentList];
        updatedList[existingIdx] = {
          ...updatedList[existingIdx],
          name: cleanName,
          provider,
          tracks,
          isHost: isHost || updatedList[existingIdx].isHost,
          isReady: options?.isReady ?? updatedList[existingIdx].isReady,
        };
      } else {
        const color = PARTY_MEMBER_COLORS[currentList.length % PARTY_MEMBER_COLORS.length];
        updatedList = [
          ...currentList,
          {
            id:
              explicitId ||
              (isHost
                ? 'host-player'
                : `member-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
            name: cleanName,
            color,
            provider,
            tracks,
            isHost,
            isReady: defaultReady,
          },
        ];
      }

      partyMembersRef.current = updatedList;
      setPartyMembers(updatedList);
      return updatedList;
    },
    []
  );

  // Reveal the active Party round when all players finish, Co-Op team solves, or Host clicks Reveal
  const revealPartyRound = useCallback(
    (didAnyoneWin: boolean, explicitPts?: number, explicitDurSec?: number) => {
      const track = currentTrackRef.current;
      if (!track || roundStateRef.current !== 'playing') return;

      const usedDur = explicitDurSec ?? maxUnlockedRef.current;
      const nextState = didAnyoneWin ? 'won' : 'gave-up';
      roundStateRef.current = nextState;
      setRoundState(nextState);
      setIsPlaying(true);

      const playbackProvider = getPlaybackProviderForTrack(track);
      void playbackProvider.playFullTrack(track, startOffsetSec).catch(() => {
        setIsPlaying(false);
      });

      setUsedTrackIds((prev) => new Set(prev).add(track.id));

      const bestRoundPts =
        explicitPts !== undefined
          ? explicitPts
          : Math.max(
              0,
              ...Object.values(roundPlayerStatesRef.current).map((s) => s.roundPoints)
            );

      setRoundHistory((prev) => [
        ...prev,
        {
          roundNumber: prev.length + 1,
          targetTrack: track,
          status: nextState,
          unlockedDurationSec: usedDur,
          startOffsetSec,
          wrongGuesses: 0,
          guesses: [],
          pointsAwarded: bestRoundPts,
        },
      ]);
    },
    [startOffsetSec]
  );

  // Process a guess in Party Mode (Points based strictly on unlocked snippet duration, never counting down over time!)
  const handleProcessPartyGuess = useCallback(
    (guess: PartyGuessPayload) => {
      const track = currentTrackRef.current;
      if (!track || roundStateRef.current !== 'playing') return;

      const isCoop = partyLocationModeRef.current === 'coop';
      const currentStates = { ...roundPlayerStatesRef.current };
      const prevEntry = currentStates[guess.memberId] ?? {
        roundStatus: 'guessing',
        roundPoints: 0,
        wrongAttempts: 0,
      };

      if (!isCoop && prevEntry.roundStatus !== 'guessing') return;

      const isMatch =
        !guess.gaveUp &&
        (guess.trackId === track.id ||
          (guess.trackTitle.toLowerCase() === track.title.toLowerCase() &&
            guess.trackArtist.toLowerCase() === track.artist.toLowerCase()));

      const playerUnlockedClipSec = Math.max(
        MIN_SNIPPET_SECONDS,
        guess.snippetDurationSec || MIN_SNIPPET_SECONDS
      );

      // In Co-Op mode, all players share a single team score and win/skip together!
      if (isCoop) {
        if (guess.gaveUp) {
          currentStates[guess.memberId] = {
            ...prevEntry,
            roundStatus: 'gave-up',
            roundPoints: 0,
            guessTimestampMs: guess.timestampMs,
            guessSnippetSec: playerUnlockedClipSec,
          };
          roundPlayerStatesRef.current = currentStates;
          setRoundPlayerStates(currentStates);
          revealPartyRound(false, 0, playerUnlockedClipSec);
          return;
        }

        if (isMatch) {
          const totalTeamWrongAttempts = Object.values(currentStates).reduce(
            (sum, s) => sum + s.wrongAttempts,
            0
          );
          const awarded = calculateNetRoundScore(playerUnlockedClipSec, totalTeamWrongAttempts);
          currentStates[guess.memberId] = {
            ...prevEntry,
            roundStatus: 'correct',
            roundPoints: awarded,
            guessTimestampMs: guess.timestampMs,
            guessSnippetSec: playerUnlockedClipSec,
            lastGuessTitle: guess.trackTitle,
          };
          roundPlayerStatesRef.current = currentStates;
          setRoundPlayerStates(currentStates);
          setCoopRoundWinnerName(guess.memberName);
          revealPartyRound(true, awarded, playerUnlockedClipSec);
          return;
        }

        // Wrong guess in Co-Op: increment team wrong attempts, keep guessing open!
        currentStates[guess.memberId] = {
          ...prevEntry,
          wrongAttempts: prevEntry.wrongAttempts + 1,
          lastGuessTitle: guess.trackTitle,
        };
        roundPlayerStatesRef.current = currentStates;
        setRoundPlayerStates(currentStates);

        const hostMember =
          partyMembersRef.current.find((m) => m.isHost) ?? partyMembersRef.current[0];
        if (!hostMember || guess.memberId !== hostMember.id) {
          setGuesses((prev) => [
            ...prev,
            {
              trackId: guess.trackId,
              title: `${guess.trackTitle} (${guess.memberName})`,
              artist: guess.trackArtist,
              snippetDurationAtGuessSec: playerUnlockedClipSec,
              correct: false,
            },
          ]);
        }
        return;
      }

      if (guess.gaveUp) {
        currentStates[guess.memberId] = {
          ...prevEntry,
          roundStatus: 'gave-up',
          roundPoints: 0,
          guessTimestampMs: guess.timestampMs,
          guessSnippetSec: playerUnlockedClipSec,
        };
      } else if (isMatch) {
        const awarded = calculateNetRoundScore(playerUnlockedClipSec, prevEntry.wrongAttempts);
        currentStates[guess.memberId] = {
          ...prevEntry,
          roundStatus: 'correct',
          roundPoints: awarded,
          guessTimestampMs: guess.timestampMs,
          guessSnippetSec: playerUnlockedClipSec,
          lastGuessTitle: guess.trackTitle,
        };

        const updatedScores = {
          ...partyScoresRef.current,
          [guess.memberId]: (partyScoresRef.current[guess.memberId] ?? 0) + awarded,
        };
        partyScoresRef.current = updatedScores;
        setPartyScores(updatedScores);
      } else {
        currentStates[guess.memberId] = {
          ...prevEntry,
          wrongAttempts: prevEntry.wrongAttempts + 1,
          lastGuessTitle: guess.trackTitle,
        };
      }

      roundPlayerStatesRef.current = currentStates;
      setRoundPlayerStates(currentStates);

      const members = partyMembersRef.current;
      if (
        members.length > 0 &&
        members.every((m) => {
          const st = currentStates[m.id]?.roundStatus ?? 'guessing';
          return st === 'correct' || st === 'gave-up';
        })
      ) {
        const anyCorrect = members.some((m) => currentStates[m.id]?.roundStatus === 'correct');
        revealPartyRound(anyCorrect);
      }
    },
    [revealPartyRound]
  );

  const ensureHostingRoom = useCallback(
    async (forceNewCode = false) => {
      try {
        const code = await partyRoomRef.current!.hostRoom(
          {
            onGuestSync: (guestPayload, replyAck) => {
              const updatedMembers = addOrUpdatePartyMember(
                guestPayload.name,
                guestPayload.provider,
                guestPayload.tracks,
                {
                  explicitId: guestPayload.memberId,
                  isHost: false,
                  isReady: false, // Guests explicitly mark Ready before game starts
                }
              );
              const merged = mergePartyCatalogs(updatedMembers);
              replyAck({
                memberCount: updatedMembers.length,
                sharedMatchesCount: merged.sharedMatchesCount,
                totalTracksCount: merged.totalUniqueCount,
              });
            },
            onMemberReady: (readyPayload) => {
              const current = partyMembersRef.current;
              const idx = current.findIndex(
                (m) =>
                  m.id === readyPayload.memberId ||
                  m.name.toLowerCase() === readyPayload.name.toLowerCase()
              );
              if (idx >= 0) {
                const updated = [...current];
                updated[idx] = {
                  ...updated[idx],
                  isReady: readyPayload.isReady,
                };
                partyMembersRef.current = updated;
                setPartyMembers(updated);
              }
            },
            onPlayerGuess: (guessPayload) => {
              handleProcessPartyGuess(guessPayload);
            },
          },
          forceNewCode
        );
        setHostRoomCode(code);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Could not open live party room.');
      }
    },
    [addOrUpdatePartyMember, handleProcessPartyGuess]
  );

  useEffect(() => {
    if ((gameMode === 'party' && partyTab === 'host') || getSavedHostRoomCode()) {
      void ensureHostingRoom(false);
    }
  }, [gameMode, partyTab, ensureHostingRoom]);

  // Connect guest listener automatically when in Join mode with a valid 5-char code
  useEffect(() => {
    if (gameMode === 'party' && partyTab === 'join' && joinRoomCode.trim().length >= 5) {
      partyRoomRef.current?.connectAsGuest(joinRoomCode, {
        onRoomState: (state) => {
          setGuestRoomState(state);
          const me = state.leaderboard.find((e) => e.memberId === guestMemberId);
          if (me) {
            setGuestIsReady(me.isReady);
          }
        },
        onCatalogUpdate: (items) => {
          setGuestCatalog(items);
        },
      });
    }
  }, [gameMode, partyTab, joinRoomCode, guestMemberId]);

  const startNewRound = async (
    pool: Track[] = catalog,
    forcePartyMode = isPartyMode,
    overrideUsedIds?: Set<string>,
    overridePickCounts?: Record<string, number>,
    explicitRoundNum?: number
  ) => {
    if (pool.length === 0) return;
    stopAllPlayback();
    setPlaybackElapsedSec(0);
    setErrorMessage(null);
    setIsPreparingRound(true);

    const activeUsedIds = new Set(overrideUsedIds ?? usedTrackIds);
    let activePickCounts = { ...(overridePickCounts ?? memberPickCounts) };
    let finalChosen: Track | null = null;
    let finalOffsetSec = 0;

    // Try up to 3 candidate tracks in case a track's YouTube video is unembeddable
    for (let attempt = 0; attempt < 3; attempt++) {
      let candidate: Track;
      if (forcePartyMode) {
        const selection = selectNextPartyTrack(
          pool,
          activeUsedIds,
          activePickCounts,
          partyMembersRef.current
        );
        candidate = { ...selection.chosen };
        activePickCounts = selection.updatedPickCounts;
      } else {
        const unplayed = pool.filter((t) => !activeUsedIds.has(t.id));
        const candidatePool = unplayed.length > 0 ? unplayed : pool;
        candidate = { ...candidatePool[Math.floor(Math.random() * candidatePool.length)] };
      }

      try {
        // Always resolve a YouTube videoId for Spotify tracks up front in Party Mode (or YouTube fallback)
        // so every player hears the exact same audio source!
        if (
          !candidate.videoId &&
          (forcePartyMode || spotifyStrategy === 'youtube-iframe-fallback') &&
          spotifyProviderRef.current
        ) {
          const resolvedVideoId = await spotifyProviderRef.current.resolveYouTubeVideoId(candidate);
          candidate = { ...candidate, videoId: resolvedVideoId };
        }

        const playbackProvider = getPlaybackProviderForTrack(candidate);
        const { durationSec } = await playbackProvider.cueTrack(candidate);
        if (candidate.videoId) {
          candidate = { ...candidate };
        }

        if (offsetMode === 'random' && durationSec && durationSec > 45) {
          const safeMaxStart = Math.max(0, Math.floor(durationSec - 35));
          finalOffsetSec = Math.floor(Math.random() * safeMaxStart);
        } else {
          finalOffsetSec = 0;
        }

        finalChosen = candidate;
        break;
      } catch (err) {
        activeUsedIds.add(candidate.id);
        if (attempt === 2) {
          finalChosen = candidate;
          finalOffsetSec = 0;
          setErrorMessage(err instanceof Error ? err.message : 'Unable to cue track.');
        }
      }
    }

    if (!finalChosen) {
      setIsPreparingRound(false);
      return;
    }

    if (forcePartyMode) {
      setMemberPickCounts(activePickCounts);
    }

    const roundNum = explicitRoundNum ?? roundHistory.length + 1;
    const nextRoundId = `r-${roundNum}-${finalChosen.id}-${Date.now()}`;

    currentTrackRef.current = finalChosen;
    setCurrentTrack(finalChosen);
    setCurrentRoundId(nextRoundId);
    setCoopRoundWinnerName(undefined);
    setStartOffsetSec(finalOffsetSec);
    setSnippetDurationSec(MIN_SNIPPET_SECONDS);
    maxUnlockedRef.current = MIN_SNIPPET_SECONDS;
    setMaxUnlockedDurationSec(MIN_SNIPPET_SECONDS);
    setGuesses([]);
    roundStateRef.current = 'playing';
    setRoundState('playing');
    roundPlayerStatesRef.current = {};
    setRoundPlayerStates({});
    setSearchQuery('');
    setIsDropdownOpen(false);
    setIsPreparingRound(false);
  };

  // Switch between YouTube Music, Spotify, and Party Mode — cancels current game immediately
  const handleSelectMode = (nextMode: GameMode) => {
    if (nextMode === gameMode) {
      if (nextMode === 'party' && !isPartyLobbyOpen) {
        cancelCurrentGame();
        resetAllPartyMembersToUnready();
        setIsPartyLobbyOpen(true);
      }
      return;
    }

    cancelCurrentGame();
    setIsSettingsOpen(false);
    setGameMode(nextMode);

    if (nextMode === 'party') {
      resetAllPartyMembersToUnready();
      setIsPartyLobbyOpen(true);
    } else {
      setIsPartyLobbyOpen(false);
      setIsSoloFilterOpen(true);
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
        const nextStats = evaluateTrackPoolFilters(cached, [], {
          matchMode: filterConfig.matchMode === 'shared' ? 'all' : filterConfig.matchMode,
          genres: filterConfig.genres,
          eras: filterConfig.eras,
        });
        const initialPool =
          nextStats.filteredTracks.length > 0 ? nextStats.filteredTracks : cached;
        void startNewRound(initialPool, false, new Set(), {}, 1);
      }
    }
  };

  const handleSelectPartyLocationMode = (nextLocMode: PartyLocationMode) => {
    if (nextLocMode === partyLocationMode) return;
    cancelCurrentGame();
    resetAllPartyMembersToUnready();
    setPartyLocationMode(nextLocMode);
    setIsPartyLobbyOpen(true);
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

  useEffect(() => {
    document.documentElement.setAttribute('data-provider', gameMode);
    if (gameMode !== 'party') {
      const cached = activeProvider.getCachedCatalog();
      setSoloCatalog(cached);
    }
  }, [gameMode, activeProvider]);

  useEffect(() => {
    if (
      !isPartyMode &&
      catalog.length > 0 &&
      view === 'quiz' &&
      roundHistory.length === 0 &&
      guesses.length === 0 &&
      (!currentTrack || !catalog.some((t) => t.id === currentTrack.id))
    ) {
      void startNewRound(catalog, false, new Set(), {}, 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, isPartyMode]);

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

          const pendingRaw = localStorage.getItem(STORAGE_KEY_PENDING_PARTY_ACTION);
          if (pendingRaw) {
            localStorage.removeItem(STORAGE_KEY_PENDING_PARTY_ACTION);
            const pending = JSON.parse(pendingRaw) as PendingPartyAction;
            if (Date.now() - (pending.createdAt ?? 0) < 15 * 60 * 1000) {
              setGameMode('party');
              setPartyLocationMode(pending.locationMode || 'local');
              setIsPartyLobbyOpen(true);
              if (pending.mode === 'host-add') {
                setPartyTab('host');
                addOrUpdatePartyMember(pending.playerName, 'spotify', tracks, {
                  explicitId: 'host-player',
                  isHost: true,
                  isReady: false,
                });
              } else if (pending.mode === 'local-add') {
                addOrUpdatePartyMember(pending.playerName, 'spotify', tracks, {
                  isHost: false,
                  isReady: false,
                });
              } else if (pending.mode === 'remote-join' && pending.roomCode) {
                setPartyLocationMode(pending.locationMode || 'remote');
                setPartyTab('join');
                setJoinRoomCode(pending.roomCode);
                setNewPlayerName(pending.playerName);
                const ack = await partyRoomRef.current!.sendCatalogToHost(
                  pending.roomCode,
                  {
                    memberId: guestMemberId,
                    name: pending.playerName,
                    provider: 'spotify',
                    tracks,
                  },
                  {
                    onRoomState: (st) => setGuestRoomState(st),
                    onCatalogUpdate: (items) => setGuestCatalog(items),
                  }
                );
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

  // Points depend strictly on unlocked snippet duration and wrong guesses (no time countdown!)
  const effectiveScoringDuration = Math.max(snippetDurationSec, maxUnlockedDurationSec);
  const baseCurvePoints = calculateLogarithmicBaseScore(effectiveScoringDuration);
  const potentialNetPoints = calculateNetRoundScore(effectiveScoringDuration, wrongGuessesCount);

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
        await startNewRound(tracks, false, new Set(), {}, 1);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load library.');
    } finally {
      setIsLoadingLibrary(false);
    }
  };

  // Party Mode: Connect Host's own library (using hostName) or add a local player
  const handleAddHostOrLocalPlayer = async (asHost: boolean, useCached = false) => {
    const cleanName = asHost
      ? hostName.trim() || 'Host'
      : newPlayerName.trim() || `Player ${partyMembers.length + 1}`;
    const targetProvider =
      newPlayerProvider === 'youtube-music' ? ytProviderRef.current! : spotifyProviderRef.current!;

    if (useCached) {
      const cached = targetProvider.getCachedCatalog();
      if (cached.length > 0) {
        addOrUpdatePartyMember(cleanName, newPlayerProvider, cached, {
          explicitId: asHost ? 'host-player' : undefined,
          isHost: asHost,
          isReady: false,
        });
        if (!asHost) handlePlayerNameChange('');
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
            locationMode: partyLocationMode,
            mode: asHost ? 'host-add' : 'local-add',
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
        addOrUpdatePartyMember(cleanName, newPlayerProvider, tracks, {
          explicitId: asHost ? 'host-player' : undefined,
          isHost: asHost,
          isReady: false,
        });
        if (!asHost) handlePlayerNameChange('');
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to add party player.');
    } finally {
      setIsLoadingLibrary(false);
    }
  };

  // Party Mode: Guest connects & sends their library to Host
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
    setGuestIsReady(false);
    setIsLoadingLibrary(true);

    const guestCbs = {
      onRoomState: (st: PartyRoomStatePayload) => setGuestRoomState(st),
      onCatalogUpdate: (items: PartyCatalogItem[]) => setGuestCatalog(items),
    };

    try {
      if (useCached) {
        const cached = targetProvider.getCachedCatalog();
        if (cached.length > 0) {
          const ack = await partyRoomRef.current!.sendCatalogToHost(
            cleanCode,
            {
              memberId: guestMemberId,
              name: cleanName,
              provider: newPlayerProvider,
              tracks: cached,
            },
            guestCbs
          );
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
            locationMode: partyLocationMode,
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
        const ack = await partyRoomRef.current!.sendCatalogToHost(
          cleanCode,
          {
            memberId: guestMemberId,
            name: cleanName,
            provider: newPlayerProvider,
            tracks,
          },
          guestCbs
        );
        setGuestAck(ack);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to join party room.');
    } finally {
      setIsLoadingLibrary(false);
    }
  };

  const handleToggleGuestReady = () => {
    const nextReady = !guestIsReady;
    setGuestIsReady(nextReady);
    partyRoomRef.current?.sendGuestReady(
      joinRoomCode,
      guestMemberId,
      newPlayerName.trim() || 'Guest',
      nextReady
    );
  };

  const handleHostToggleMemberReady = (memberId: string) => {
    const updated = partyMembersRef.current.map((m) =>
      m.id === memberId ? { ...m, isReady: !m.isReady } : m
    );
    partyMembersRef.current = updated;
    setPartyMembers(updated);
  };

  const handleHostReadyAllLocal = () => {
    const allAlreadyReady = partyMembersRef.current.every((m) => m.isReady);
    const updated = partyMembersRef.current.map((m) => ({
      ...m,
      isReady: !allAlreadyReady,
    }));
    partyMembersRef.current = updated;
    setPartyMembers(updated);
  };

  const handleSelectMatchMode = (mode: PoolMatchMode) => {
    setFilterConfig((prev) => ({ ...prev, matchMode: mode }));
  };

  const handleToggleGenre = (genreId: MusicGenreId) => {
    setFilterConfig((prev) => {
      const exists = prev.genres.includes(genreId);
      return {
        ...prev,
        genres: exists ? prev.genres.filter((g) => g !== genreId) : [...prev.genres, genreId],
      };
    });
  };

  const handleClearGenres = () => {
    setFilterConfig((prev) => ({ ...prev, genres: [] }));
  };

  const handleToggleEra = (eraId: MusicEraId) => {
    setFilterConfig((prev) => {
      const exists = prev.eras.includes(eraId);
      return {
        ...prev,
        eras: exists ? prev.eras.filter((e) => e !== eraId) : [...prev.eras, eraId],
      };
    });
  };

  const handleClearEras = () => {
    setFilterConfig((prev) => ({ ...prev, eras: [] }));
  };

  const handleResetFilters = () => {
    setFilterConfig(DEFAULT_FILTER_CONFIG);
  };

  const handleApplySoloFiltersAndStart = async () => {
    if (catalog.length === 0 || isPreparingRound) return;
    cancelCurrentGame();
    setIsSoloFilterOpen(false);
    await startNewRound(catalog, false, new Set(), {}, 1);
  };

  const handleStartPartyQuiz = async () => {
    if (!allPartyMembersReady || catalog.length === 0 || isPreparingRound) {
      return;
    }
    cancelCurrentGame();
    await startNewRound(catalog, true, new Set(), {}, 1);
    setIsPartyLobbyOpen(false);
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
        // Fallback to clipboard copy
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

  // In Remote Guest mode, always bind directly to the Host's broadcast currentTrack and startOffsetSec
  // so it is impossible for a Guest to ever play or guess against a different song!
  const effectiveTrack = isRemoteGuestPlaying
    ? guestRoomState?.currentTrack ?? currentTrack
    : currentTrack;
  const effectiveStartOffsetSec = isRemoteGuestPlaying
    ? guestRoomState?.startOffsetSec ?? startOffsetSec
    : startOffsetSec;

  const triggerPlayDuration = async (targetDurationSec: number) => {
    if (!effectiveTrack) return;
    setIsSoloFilterOpen(false);
    setErrorMessage(null);
    setIsPlaying(true);
    setPlaybackElapsedSec(0);
    maxUnlockedRef.current = Math.max(maxUnlockedRef.current, targetDurationSec);
    setMaxUnlockedDurationSec((prev) => Math.max(prev, targetDurationSec));

    try {
      const playbackProvider = getPlaybackProviderForTrack(effectiveTrack);
      await playbackProvider.playSnippet(effectiveTrack, {
        startOffsetSec: effectiveStartOffsetSec,
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
    if (!effectiveTrack) return;
    if (isPlaying) {
      stopAllPlayback();
      return;
    }
    if (roundState !== 'playing') {
      setIsPlaying(true);
      try {
        const playbackProvider = getPlaybackProviderForTrack(effectiveTrack);
        await playbackProvider.playFullTrack(effectiveTrack, effectiveStartOffsetSec);
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
      maxUnlockedRef.current = Math.max(maxUnlockedRef.current, clamped);
      setMaxUnlockedDurationSec((prev) => Math.max(prev, clamped));
    }
    if (autoPlay && effectiveTrack) {
      void triggerPlayDuration(clamped);
    }
  };

  const searchablePool = useMemo<PartyCatalogItem[]>(() => {
    if (isRemoteGuestPlaying) {
      if (guestCatalog.length > 0) return guestCatalog;
      const fallback =
        newPlayerProvider === 'youtube-music'
          ? ytProviderRef.current?.getCachedCatalog() ?? []
          : spotifyProviderRef.current?.getCachedCatalog() ?? [];
      return fallback.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        artworkUrl: t.artworkUrl,
      }));
    }
    const sourcePool = catalog.length > 0 ? catalog : rawCatalog;
    return sourcePool.map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      artworkUrl: t.artworkUrl,
    }));
  }, [isRemoteGuestPlaying, guestCatalog, newPlayerProvider, catalog, rawCatalog]);

  const filteredSuggestions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const guessedIds = new Set(guesses.map((g) => g.trackId));
    return searchablePool
      .filter((t) => {
        if (guessedIds.has(t.id)) return false;
        return t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q);
      })
      .slice(0, 6);
  }, [searchablePool, searchQuery, guesses]);

  // Submit a guess (In every mode, uses the player's own unlocked snippet duration!)
  const submitGuess = (guessedItem: PartyCatalogItem) => {
    if (!effectiveTrack || roundState !== 'playing') return;

    setSearchQuery('');
    setIsDropdownOpen(false);

    const isCorrect =
      guessedItem.id === effectiveTrack.id ||
      (guessedItem.title.toLowerCase() === effectiveTrack.title.toLowerCase() &&
        guessedItem.artist.toLowerCase() === effectiveTrack.artist.toLowerCase());

    const usedDur = Math.max(snippetDurationSec, maxUnlockedDurationSec);
    const nowMs = Date.now();

    const nextGuess: RoundGuess = {
      trackId: guessedItem.id,
      title: guessedItem.title,
      artist: guessedItem.artist,
      snippetDurationAtGuessSec: usedDur,
      correct: isCorrect,
    };

    const updatedGuesses = [...guesses, nextGuess];
    setGuesses(updatedGuesses);

    // 1. Remote Guest in Party Mode
    if (isRemoteGuestPlaying && guestRoomState) {
      partyRoomRef.current?.sendGuestGuess(joinRoomCode, {
        guessId: `g-${guestMemberId}-${nowMs}`,
        roundNumber: guestRoomState.roundNumber,
        memberId: guestMemberId,
        memberName: newPlayerName.trim() || 'Guest',
        trackId: guessedItem.id,
        trackTitle: guessedItem.title,
        trackArtist: guessedItem.artist,
        correct: isCorrect,
        timestampMs: nowMs,
        elapsedSec: usedDur,
        snippetDurationSec: usedDur,
      });

      const effectiveLocMode = guestRoomState.partyLocationMode ?? partyLocationMode;
      if (isCorrect && effectiveLocMode === 'remote') {
        setIsPlaying(true);
        const playbackProvider = getPlaybackProviderForTrack(effectiveTrack);
        void playbackProvider.playFullTrack(effectiveTrack, effectiveStartOffsetSec).catch(() => {
          setIsPlaying(false);
        });
      }
      return;
    }

    // 2. Host in Party Mode
    if (isOnlinePartyHost) {
      const hostMember = partyMembers.find((m) => m.isHost) ?? partyMembers[0];
      if (hostMember) {
        handleProcessPartyGuess({
          type: 'PARTY_PLAYER_GUESS',
          guessId: `h-${hostMember.id}-${nowMs}`,
          roundNumber: roundHistory.length + 1,
          memberId: hostMember.id,
          memberName: hostMember.name,
          trackId: guessedItem.id,
          trackTitle: guessedItem.title,
          trackArtist: guessedItem.artist,
          correct: isCorrect,
          timestampMs: nowMs,
          elapsedSec: usedDur,
          snippetDurationSec: usedDur,
        });
      }
      return;
    }

    // 3. Solo Mode
    if (isCorrect) {
      const awarded = calculateNetRoundScore(usedDur, wrongGuessesCount);
      setRoundState('won');
      setIsPlaying(true);
      const playbackProvider = getPlaybackProviderForTrack(effectiveTrack);
      void playbackProvider.playFullTrack(effectiveTrack, effectiveStartOffsetSec).catch(() => {
        setIsPlaying(false);
      });
      setUsedTrackIds((prev) => new Set(prev).add(effectiveTrack.id));
      setRoundHistory((prev) => [
        ...prev,
        {
          roundNumber: prev.length + 1,
          targetTrack: effectiveTrack,
          status: 'won',
          unlockedDurationSec: usedDur,
          startOffsetSec: effectiveStartOffsetSec,
          wrongGuesses: wrongGuessesCount,
          guesses: updatedGuesses,
          pointsAwarded: awarded,
        },
      ]);
    }
  };

  const handleGiveUp = () => {
    const nowMs = Date.now();
    const usedDur = Math.max(snippetDurationSec, maxUnlockedDurationSec);

    if (isRemoteGuestPlaying && guestRoomState) {
      partyRoomRef.current?.sendGuestGuess(joinRoomCode, {
        guessId: `giveup-${guestMemberId}-${nowMs}`,
        roundNumber: guestRoomState.roundNumber,
        memberId: guestMemberId,
        memberName: newPlayerName.trim() || 'Guest',
        trackId: '',
        trackTitle: 'Skipped',
        trackArtist: '',
        correct: false,
        gaveUp: true,
        timestampMs: nowMs,
        elapsedSec: usedDur,
        snippetDurationSec: usedDur,
      });
      return;
    }

    if (!effectiveTrack || roundState !== 'playing') return;

    if (isOnlinePartyHost) {
      const hostMember = partyMembers.find((m) => m.isHost) ?? partyMembers[0];
      if (hostMember) {
        handleProcessPartyGuess({
          type: 'PARTY_PLAYER_GUESS',
          guessId: `giveup-${hostMember.id}-${nowMs}`,
          roundNumber: roundHistory.length + 1,
          memberId: hostMember.id,
          memberName: hostMember.name,
          trackId: '',
          trackTitle: 'Skipped',
          trackArtist: '',
          correct: false,
          gaveUp: true,
          timestampMs: nowMs,
          elapsedSec: usedDur,
          snippetDurationSec: usedDur,
        });
      } else {
        revealPartyRound(false);
      }
      return;
    }

    setRoundState('gave-up');
    setIsPlaying(true);
    const playbackProvider = getPlaybackProviderForTrack(effectiveTrack);
    void playbackProvider.playFullTrack(effectiveTrack, effectiveStartOffsetSec).catch(() => {
      setIsPlaying(false);
    });
    setUsedTrackIds((prev) => new Set(prev).add(effectiveTrack.id));
    setRoundHistory((prev) => [
      ...prev,
      {
        roundNumber: prev.length + 1,
        targetTrack: effectiveTrack,
        status: 'gave-up',
        unlockedDurationSec: usedDur,
        startOffsetSec: effectiveStartOffsetSec,
        wrongGuesses: wrongGuessesCount,
        guesses,
        pointsAwarded: 0,
      },
    ]);
  };

  const handleResetRun = () => {
    cancelCurrentGame();
    if (isPartyMode) {
      resetAllPartyMembersToUnready();
      setIsPartyLobbyOpen(true);
    } else {
      setIsSoloFilterOpen(true);
      if (catalog.length > 0) {
        void startNewRound(catalog, false);
      }
    }
  };

  const selectedPartyProviderCachedCount = useMemo(() => {
    const p =
      newPlayerProvider === 'youtube-music' ? ytProviderRef.current : spotifyProviderRef.current;
    return p?.getCachedCatalog().length ?? 0;
  }, [newPlayerProvider, soloCatalog]);

  const hostMemberEntry = useMemo(
    () => partyMembers.find((m) => m.isHost) ?? partyMembers[0],
    [partyMembers]
  );
  const hostRoundStatus = hostMemberEntry
    ? roundPlayerStates[hostMemberEntry.id]?.roundStatus ?? 'guessing'
    : 'guessing';

  const guestMyEntry = useMemo(
    () => guestRoomState?.leaderboard.find((e) => e.memberId === guestMemberId),
    [guestRoomState, guestMemberId]
  );

  const effectivePartyLocationMode: PartyLocationMode = isRemoteGuestPlaying
    ? guestRoomState?.partyLocationMode ?? partyLocationMode
    : partyLocationMode;
  const isCoopParty = isPartyMode && effectivePartyLocationMode === 'coop';
  const effectiveSharedScore = isRemoteGuestPlaying
    ? guestRoomState?.sharedScore ?? guestMyEntry?.totalScore ?? runningTotalScore
    : runningTotalScore;
  const effectiveRoundWinnerName = isRemoteGuestPlaying
    ? guestRoomState?.roundWinnerName
    : coopRoundWinnerName;

  const activeOnlineStatus = isCoopParty
    ? roundState === 'won'
      ? 'correct'
      : roundState === 'gave-up'
        ? 'gave-up'
        : 'guessing'
    : isRemoteGuestPlaying
      ? guestMyEntry?.roundStatus ?? 'guessing'
      : isOnlinePartyHost
        ? hostRoundStatus
        : 'guessing';

  const activeLeaderboard = isRemoteGuestPlaying
    ? guestRoomState?.leaderboard ?? []
    : isOnlinePartyHost
      ? partyLeaderboard
      : [];

  const ranking = useMemo(() => evaluateRunRanking(roundHistory), [roundHistory]);
  const unlockedPercent = (snippetDurationSec / MAX_SNIPPET_SECONDS) * 100;
  const playheadPercent = isPlaying
    ? Math.min(100, (playbackElapsedSec / MAX_SNIPPET_SECONDS) * 100)
    : unlockedPercent;

  const renderPreGameFilterControls = (isPartyContext: boolean) => (
    <div className="pregame-filter-card" aria-label="Pre-Game Song Selection">
      <div className="pregame-filter-header">
        <span className="section-label">
          <SlidersHorizontal size={13} /> Pre-Game Song Selection &amp; Filters
        </span>
        <div className="pregame-filter-meta">
          <span className="filter-match-pill">
            <strong>{catalog.length}</strong> / {rawCatalog.length} songs match
          </span>
          {hasActiveFilters && (
            <button type="button" className="btn-reset-filters" onClick={handleResetFilters}>
              Reset Filters
            </button>
          )}
        </div>
      </div>

      {/* 1. Library Overlap / Similarity Selection */}
      <div className="filter-group">
        <span className="filter-group-label">Library Selection</span>
        <div className={`match-mode-grid ${isPartyContext ? 'cols-3' : 'cols-2'}`}>
          <button
            type="button"
            className={`match-mode-btn ${
              effectiveFilterConfig.matchMode === 'all' ? 'active' : ''
            }`}
            onClick={() => handleSelectMatchMode('all')}
          >
            <div className="match-mode-top">
              <strong>All Songs</strong>
              <span className="match-mode-count">{filteredPoolStats.allCount}</span>
            </div>
            <span className="match-mode-desc">
              {isPartyContext
                ? 'Play all merged songs (shared matches first, fair rotation)'
                : 'Play from your entire liked songs library'}
            </span>
          </button>

          {isPartyContext && (
            <button
              type="button"
              className={`match-mode-btn ${
                effectiveFilterConfig.matchMode === 'shared' ? 'active' : ''
              }`}
              onClick={() => handleSelectMatchMode('shared')}
            >
              <div className="match-mode-top">
                <strong>Shared Libraries Only</strong>
                <span className="match-mode-count">{filteredPoolStats.sharedCount}</span>
              </div>
              <span className="match-mode-desc">
                Only play songs favorited by 2+ players
              </span>
            </button>
          )}

          <button
            type="button"
            className={`match-mode-btn ${
              effectiveFilterConfig.matchMode === 'similar' ? 'active' : ''
            }`}
            onClick={() => handleSelectMatchMode('similar')}
          >
            <div className="match-mode-top">
              <strong>Similar Music Only</strong>
              <span className="match-mode-count">{filteredPoolStats.similarCount}</span>
            </div>
            <span className="match-mode-desc">
              {isPartyContext
                ? 'Shared songs, shared artists & overlapping genres'
                : 'Songs by your recurring favorite artists'}
            </span>
          </button>
        </div>
      </div>

      {/* 2. Genre Selection */}
      <div className="filter-group">
        <span className="filter-group-label">Genres</span>
        <div className="filter-chips-wrap">
          <button
            type="button"
            className={`filter-chip ${
              effectiveFilterConfig.genres.length === 0 ? 'active' : ''
            }`}
            onClick={handleClearGenres}
          >
            <span>All Genres</span>
          </button>
          {MUSIC_GENRE_OPTIONS.map((genre) => {
            const count = filteredPoolStats.genreCounts[genre.id] ?? 0;
            const isSelected = effectiveFilterConfig.genres.includes(genre.id);
            return (
              <button
                key={genre.id}
                type="button"
                className={`filter-chip ${isSelected ? 'active' : ''} ${
                  count === 0 && !isSelected ? 'empty' : ''
                }`}
                onClick={() => handleToggleGenre(genre.id)}
              >
                <span>{genre.shortLabel}</span>
                <span className="filter-chip-count">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 3. Era / Decade Selection */}
      <div className="filter-group">
        <span className="filter-group-label">Eras &amp; Decades</span>
        <div className="filter-chips-wrap">
          <button
            type="button"
            className={`filter-chip ${
              effectiveFilterConfig.eras.length === 0 ? 'active' : ''
            }`}
            onClick={handleClearEras}
          >
            <span>All Eras</span>
          </button>
          {MUSIC_ERA_OPTIONS.map((era) => {
            const count = filteredPoolStats.eraCounts[era.id] ?? 0;
            const isSelected = effectiveFilterConfig.eras.includes(era.id);
            return (
              <button
                key={era.id}
                type="button"
                className={`filter-chip ${isSelected ? 'active' : ''} ${
                  count === 0 && !isSelected ? 'empty' : ''
                }`}
                onClick={() => handleToggleEra(era.id)}
              >
                <span>{era.shortLabel}</span>
                <span className="filter-chip-count">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {catalog.length === 0 && (
        <div className="filter-empty-warning">
          <AlertCircle size={15} />
          <span>
            No songs match your current filter selection.{' '}
            {effectiveFilterConfig.matchMode === 'shared' && filteredPoolStats.sharedCount === 0
              ? 'No exact duplicate songs were found across players — try "Similar Music Only" or "All Songs"!'
              : 'Try selecting additional genres/eras or resetting filters.'}
          </span>
          <button type="button" className="btn-chip" onClick={handleResetFilters}>
            Reset Filters
          </button>
        </div>
      )}

      {!isPartyContext && (
        <div className="solo-filter-actions">
          <button
            type="button"
            className="btn-primary btn-full-width"
            disabled={catalog.length === 0 || isPreparingRound}
            onClick={() => void handleApplySoloFiltersAndStart()}
          >
            <Play size={15} />
            <span>
              {catalog.length === 0
                ? 'Select Filters with Matching Songs to Start'
                : `Start Game with Selection (${catalog.length} Songs)`}
            </span>
          </button>
        </div>
      )}
    </div>
  );

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
            {((rawCatalog.length > 0 && (!isPartyMode || !isPartyLobbyOpen)) ||
              isRemoteGuestPlaying) && (
              <div className="session-scoreboard">
                <div className="score-chip">
                  <span className="chip-label">
                    R
                    {isRemoteGuestPlaying && guestRoomState
                      ? guestRoomState.roundNumber
                      : view === 'summary'
                        ? roundHistory.length
                        : roundHistory.length + 1}
                  </span>
                </div>
                <div
                  className="score-chip accent"
                  title={isCoopParty ? 'Co-Op Shared Team Score' : 'Score'}
                >
                  {isCoopParty ? <Heart size={13} /> : <Trophy size={13} />}
                  <span className="chip-val">
                    {isCoopParty
                      ? `Co-Op: ${effectiveSharedScore.toLocaleString()}`
                      : isRemoteGuestPlaying
                        ? (guestMyEntry?.totalScore ?? 0).toLocaleString()
                        : runningTotalScore.toLocaleString()}
                  </span>
                </div>
                {!isRemoteGuestPlaying && roundHistory.length > 0 && (
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

        {/* ====================================================================
            1. PARTY MODE LOBBY VIEW (Same Room Local, Online Remote, or Co-Op)
            ==================================================================== */}
        {isPartyMode && !isRemoteGuestPlaying && (isPartyLobbyOpen || rawCatalog.length === 0) ? (
          <section className="surface-card party-lobby-card" aria-label="Party Mode Lobby">
            {/* Top-Level Party Differentiation: Same Room (Local), Online Room (Remote), Co-Op (Shared Score) */}
            <div className="party-location-switcher">
              <button
                type="button"
                className={`party-loc-btn ${partyLocationMode === 'local' ? 'active' : ''}`}
                onClick={() => handleSelectPartyLocationMode('local')}
              >
                <Home size={16} />
                <div>
                  <strong>Same Room (Local)</strong>
                  <span>Play in one room · Individual scores</span>
                </div>
              </button>
              <button
                type="button"
                className={`party-loc-btn ${partyLocationMode === 'remote' ? 'active' : ''}`}
                onClick={() => handleSelectPartyLocationMode('remote')}
              >
                <Globe size={16} />
                <div>
                  <strong>Online Room (Remote)</strong>
                  <span>Join via Room Code · Individual scores</span>
                </div>
              </button>
              <button
                type="button"
                className={`party-loc-btn ${partyLocationMode === 'coop' ? 'active' : ''}`}
                onClick={() => handleSelectPartyLocationMode('coop')}
              >
                <Heart size={16} />
                <div>
                  <strong>Co-Op (Shared Score)</strong>
                  <span>Others add music · One shared score</span>
                </div>
              </button>
            </div>

            <div className="party-mode-tabs">
              <button
                type="button"
                className={`party-tab-btn ${partyTab === 'host' ? 'active' : ''}`}
                onClick={() => setPartyTab('host')}
              >
                <Crown size={15} />
                <span>
                  {partyLocationMode === 'coop'
                    ? `Host Co-Op Party (${partyMembers.length})`
                    : partyLocationMode === 'local'
                      ? `Host Same-Room Party (${partyMembers.length})`
                      : `Host Online Room (${partyMembers.length})`}
                </span>
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
                <div className="room-code-banner">
                  <div className="room-code-badge">
                    <span className="code-label">
                      {partyLocationMode === 'coop'
                        ? 'CO-OP ROOM CODE (FRIENDS CAN ALSO ADD MUSIC VIA CODE)'
                        : partyLocationMode === 'local'
                          ? 'SAME-ROOM SYNC CODE (OPTIONAL FOR SECOND DEVICES)'
                          : 'ONLINE ROOM CODE (SHARE WITH FRIENDS)'}
                    </span>
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

                {/* Host / Local / Co-Op Player Add Card */}
                {partyLocationMode === 'local' || partyLocationMode === 'coop' ? (
                  <div className="party-add-card">
                    <span className="section-label">
                      <UserPlus size={13} />{' '}
                      {partyLocationMode === 'coop'
                        ? 'Add Co-Op Players & Their Music (Shared Score)'
                        : 'Add Players in This Room'}
                    </span>
                    <div className="party-form-row">
                      <input
                        type="text"
                        className="party-text-input"
                        placeholder={`Player Name (e.g. ${
                          partyMembers.length === 0 ? hostName || 'Player 1' : `Player ${partyMembers.length + 1}`
                        })`}
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
                          onClick={() =>
                            void handleAddHostOrLocalPlayer(partyMembers.length === 0, true)
                          }
                        >
                          <Check size={14} />
                          <span>
                            + Add Saved ({selectedPartyProviderCachedCount} songs)
                          </span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={isLoadingLibrary}
                        onClick={() =>
                          void handleAddHostOrLocalPlayer(partyMembers.length === 0, false)
                        }
                      >
                        <UserPlus size={15} />
                        <span>
                          {isLoadingLibrary
                            ? 'Syncing...'
                            : `Sign In & Add (${
                                newPlayerProvider === 'youtube-music' ? 'YouTube' : 'Spotify'
                              })`}
                        </span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="party-add-card">
                    <span className="section-label">
                      <Crown size={12} /> Your Host Name & Music Library
                    </span>
                    <div className="party-form-row">
                      <input
                        type="text"
                        className="party-text-input"
                        placeholder="Your Host Name (e.g. Thomas)"
                        value={hostName}
                        onChange={(e) => handleHostNameChange(e.target.value)}
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
                          onClick={() => void handleAddHostOrLocalPlayer(true, true)}
                        >
                          <Check size={14} />
                          <span>
                            Use Saved as {hostName.trim() || 'Host'} (
                            {selectedPartyProviderCachedCount})
                          </span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={isLoadingLibrary}
                        onClick={() => void handleAddHostOrLocalPlayer(true, false)}
                      >
                        <UserPlus size={15} />
                        <span>
                          {isLoadingLibrary
                            ? 'Syncing...'
                            : `Connect ${
                                newPlayerProvider === 'youtube-music' ? 'YouTube' : 'Spotify'
                              } as ${hostName.trim() || 'Host'}`}
                        </span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Unified Party Roster, Ready Sync Gate & Start Button */}
                <div className="party-roster-card">
                  <div className="roster-header">
                    <span className="section-label">
                      {partyLocationMode === 'coop'
                        ? `Co-Op Team & Music Pool (${partyMembers.length} Contributors)`
                        : partyLocationMode === 'local'
                          ? `Same-Room Party Roster (${partyMembers.length} Players)`
                          : `Online Room Roster (${partyMembers.length} Joined)`}
                    </span>
                    <div className="party-btn-row">
                      {partyMembers.length > 0 && !allPartyMembersReady && (
                        <button
                          type="button"
                          className="btn-chip"
                          onClick={handleHostReadyAllLocal}
                          title="Mark local players on this device as Ready"
                        >
                          <UserCheck size={13} />
                          <span>Ready Local ✓</span>
                        </button>
                      )}
                      {partyMembers.length > 0 && (
                        <button
                          type="button"
                          className="btn-chip danger"
                          onClick={handleClearParty}
                        >
                          <Trash2 size={13} />
                          <span>Reset</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {partyMembers.length === 0 ? (
                    <p className="party-empty-hint">
                      {partyLocationMode === 'coop'
                        ? 'Add friends & their music libraries above (or via the Room Code). Everyone works together toward one shared Co-Op score!'
                        : partyLocationMode === 'local'
                          ? 'Add players on this device (or have friends in the room join with the Room Code above). Mark everyone Ready to start!'
                          : 'Set your Host Name above and connect your library, then share the Room Code so remote players can join and mark Ready!'}
                    </p>
                  ) : (
                    <>
                      <div className="party-stats-pills">
                        <div className="party-stat-box highlight">
                          <span className="p-stat-num">
                            {mergedPartyPool.sharedMatchesCount}
                          </span>
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
                              <strong>
                                {member.name} {member.isHost ? '(Host)' : ''}
                              </strong>
                              <span>
                                {member.provider === 'youtube-music' ? 'YouTube' : 'Spotify'} ·{' '}
                                {member.tracks.length} songs
                              </span>
                            </div>
                            <button
                              type="button"
                              className={`ready-pill ${member.isReady ? 'ready' : 'waiting'}`}
                              onClick={() => handleHostToggleMemberReady(member.id)}
                              title="Click to toggle Ready status"
                            >
                              {member.isReady ? 'Ready ✓' : 'Tap to Ready'}
                            </button>
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

                      {renderPreGameFilterControls(true)}

                      <button
                        type="button"
                        className="btn-primary btn-full-width"
                        disabled={!allPartyMembersReady || catalog.length === 0 || isPreparingRound}
                        onClick={() => void handleStartPartyQuiz()}
                      >
                        <Play size={16} />
                        <span>
                          {isPreparingRound
                            ? 'Syncing First Song for All Players...'
                            : !allPartyMembersReady
                              ? `Sync Up: Waiting for ${unreadyPartyMembersCount} player${
                                  unreadyPartyMembersCount > 1 ? 's' : ''
                                } to Ready Up...`
                              : catalog.length === 0
                                ? 'No Songs Match Filters — Adjust Selection Above'
                                : partyLocationMode === 'coop'
                                  ? `Start Co-Op Quiz (${catalog.length} Songs · Shared Score)`
                                  : `Start ${
                                      partyLocationMode === 'local' ? 'Same-Room' : 'Online'
                                    } Party Quiz (${catalog.length} Songs)`}
                        </span>
                      </button>
                    </>
                  )}
                </div>
              </div>
            ) : (
              /* Guest Join & Ready Lobby Tab (Works for Co-Op, Same-Room Second Devices & Remote Players) */
              <div className="party-join-panel">
                <p className="join-lead">
                  Enter the host&apos;s 5-character Room Code, sync your library, and tap{' '}
                  <strong>I&apos;m Ready</strong> so everyone starts on the exact same song!
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
                      className={`seg-btn ${
                        newPlayerProvider === 'spotify' ? 'active' : ''
                      }`}
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
                        : `Sign In & Join (${
                            newPlayerProvider === 'youtube-music' ? 'YouTube' : 'Spotify'
                          })`}
                    </span>
                  </button>
                </div>

                {(guestAck || guestRoomState) && (
                  <div className="guest-ready-card">
                    <div className="guest-ack-banner">
                      <CheckCircle2 size={18} />
                      <span>
                        Connected to Room{' '}
                        <strong>{guestRoomState?.roomCode ?? guestAck?.roomCode}</strong>
                        {guestRoomState ? (
                          <>
                            {' '}
                            (Host: <strong>{guestRoomState.hostName}</strong> ·{' '}
                            <strong>{guestRoomState.totalTracksCount} songs</strong>
                            {guestRoomState.partyLocationMode === 'coop' ? ' · Co-Op Shared Score' : ''})
                          </>
                        ) : null}
                      </span>
                    </div>

                    <button
                      type="button"
                      className={`btn-ready-toggle ${guestIsReady ? 'is-ready' : ''}`}
                      onClick={handleToggleGuestReady}
                    >
                      <UserCheck size={18} />
                      <span>
                        {guestIsReady
                          ? 'Ready ✓ — Waiting for Host to Start Quiz (Tap to Unready)'
                          : "I'm Ready! (Tap so Host Can Start Quiz)"}
                      </span>
                    </button>

                    {guestRoomState && guestRoomState.leaderboard.length > 0 && (
                      <div className="member-list">
                        {guestRoomState.leaderboard.map((m) => (
                          <div key={m.memberId} className="member-row">
                            <span
                              className="member-dot"
                              style={{ backgroundColor: m.color }}
                            />
                            <div className="member-info">
                              <strong>
                                {m.name} {m.isHost ? '(Host)' : ''}
                              </strong>
                              <span>{m.trackCount} songs</span>
                            </div>
                            <span className={`ready-pill ${m.isReady ? 'ready' : 'waiting'}`}>
                              {m.isReady ? 'Ready ✓' : 'Waiting...'}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
        ) : !isRemoteGuestPlaying && rawCatalog.length === 0 ? (
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
              Unlock longer audio clips if you need a hint—points only decrease when you unlock
              more of the song, never over time.
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
        ) : !isRemoteGuestPlaying && view === 'summary' ? (
          /* 3. SUMMARY / END-OF-RUN RANKING VIEW */
          <section className="surface-card summary-view">
            <div className="summary-hero">
              <div className={`rank-crest tier-${ranking.tier.replace('+', 'plus').toLowerCase()}`}>
                <span className="crest-tier">{ranking.tier}</span>
                <span className="crest-sub">RANK</span>
              </div>
              <div className="summary-copy">
                <span className="eyebrow">
                  {isCoopParty ? 'Co-Op Run Complete' : 'Run Complete'} · {roundHistory.length}{' '}
                  Songs
                </span>
                <h2>{ranking.title}</h2>
                <p>{ranking.description}</p>
              </div>
            </div>

            <div className="stats-grid-4">
              <div className="stat-tile">
                <span className="tile-label">
                  {isCoopParty ? 'Shared Co-Op Score' : 'Total Score'}
                </span>
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
                <span className="tile-label">Avg Clip</span>
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
          /* ==================================================================
             4. UNIFIED ACTIVE QUIZ STAGE (Solo, Local Party, Online Host, Co-Op, AND Remote Guest!)
             Every player has their own Music Player & controls snippet length!
             ================================================================== */
          <section
            className={`surface-card quiz-stage ${
              roundState !== 'playing' ? `result-focused ${roundState}` : ''
            }`}
          >
            <ConfettiCanvas
              active={roundState === 'won' || activeOnlineStatus === 'correct'}
            />

            {isPartyMode ? (
              <div className="party-active-bar">
                <div className="party-roster-chips">
                  {isCoopParty ? (
                    <>
                      <span className="party-bar-label">
                        <Heart size={13} /> Co-Op Shared Score:{' '}
                        <strong>{effectiveSharedScore.toLocaleString()} pts</strong> ·
                      </span>
                      {(isRemoteGuestPlaying ? activeLeaderboard : partyMembers).map((m) => {
                        const id = 'memberId' in m ? m.memberId : m.id;
                        return (
                          <span
                            key={id}
                            className="fav-mini-pill"
                            style={{ borderColor: m.color }}
                          >
                            <i style={{ backgroundColor: m.color }} />
                            {m.name}
                          </span>
                        );
                      })}
                    </>
                  ) : isRemoteGuestPlaying && guestRoomState ? (
                    <span className="party-bar-label">
                      <Globe size={13} /> Online Room <strong>{guestRoomState.roomCode}</strong> ·
                      Host: <strong>{guestRoomState.hostName}</strong>
                    </span>
                  ) : partyLocationMode === 'remote' ? (
                    <span className="party-bar-label">
                      <Globe size={13} /> Online Room <strong>{hostRoomCode}</strong> ·{' '}
                      {catalog.length} active songs
                    </span>
                  ) : (
                    <>
                      <span className="party-bar-label">
                        <Home size={13} /> Local Party ({catalog.length} active songs):
                      </span>
                      {partyMembers.map((m) => (
                        <span
                          key={m.id}
                          className="fav-mini-pill"
                          style={{ borderColor: m.color }}
                        >
                          <i style={{ backgroundColor: m.color }} />
                          {m.name}
                        </span>
                      ))}
                    </>
                  )}
                  {!isRemoteGuestPlaying &&
                    activeFilterBadges.map((badge) => (
                      <span key={badge} className="active-filter-tag">
                        {badge}
                      </span>
                    ))}
                </div>

                <div className="party-bar-actions">
                  {isOnlinePartyHost && roundState === 'playing' && (
                    <button
                      type="button"
                      className="btn-party-lobby-link"
                      onClick={() => revealPartyRound(false)}
                    >
                      Reveal Song
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-party-lobby-link"
                    onClick={() => {
                      if (isRemoteGuestPlaying) {
                        stopAllPlayback();
                        setGuestRoomState(null);
                        setGuestAck(null);
                      } else {
                        cancelCurrentGame();
                        resetAllPartyMembersToUnready();
                        setIsPartyLobbyOpen(true);
                      }
                    }}
                  >
                    {isRemoteGuestPlaying ? 'Leave Room' : 'Lobby & Filters'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="solo-filter-stage-wrap">
                <div className="party-active-bar solo-pool-bar">
                  <div className="party-roster-chips">
                    <span className="party-bar-label">
                      <SlidersHorizontal size={13} /> Song Pool:{' '}
                      <strong>
                        {catalog.length} of {rawCatalog.length} songs
                      </strong>
                    </span>
                    {activeFilterBadges.length > 0 ? (
                      activeFilterBadges.map((badge) => (
                        <span key={badge} className="active-filter-tag">
                          {badge}
                        </span>
                      ))
                    ) : (
                      <span className="active-filter-tag subtle">All Genres &amp; Eras</span>
                    )}
                  </div>
                  <div className="party-bar-actions">
                    <button
                      type="button"
                      className={`btn-party-lobby-link ${isSoloFilterOpen ? 'active' : ''}`}
                      onClick={() => setIsSoloFilterOpen((v) => !v)}
                    >
                      <SlidersHorizontal size={12} />
                      <span>{isSoloFilterOpen ? 'Hide Song Filters' : 'Song Filters'}</span>
                    </button>
                  </div>
                </div>
                {isSoloFilterOpen && renderPreGameFilterControls(false)}
              </div>
            )}

            {roundState === 'playing' ? (
              <>
                {/* Status Header: Points do NOT count down with time — only change with unlocked clip length */}
                <div className="stage-header">
                  <div className="potential-score-box">
                    <span className="stage-eyebrow">
                      {isCoopParty ? 'Co-Op Points at Stake (Shared Score)' : 'Points at Stake'}
                    </span>
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
                    <span className="stage-eyebrow">Your Clip Length</span>
                    <div className="length-display-row">
                      <Ear size={16} className="ear-icon" />
                      <span className="length-value">{snippetDurationSec.toFixed(1)}s</span>
                      <span className="length-max">/ 30s</span>
                    </div>
                  </div>
                </div>

                {/* Every Player's Own Music Player & Snippet Duration Controls */}
                <div className={`player-deck ${isPlaying ? 'is-playing' : ''}`}>
                  <div className="player-top-row">
                    <button
                      type="button"
                      className={`hero-play-btn ${isPlaying ? 'playing' : ''}`}
                      onClick={() => void handlePlayToggle()}
                      disabled={!effectiveTrack || isPreparingRound}
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
                          {isPreparingRound ? (
                            <>Syncing song across players...</>
                          ) : isPlaying ? (
                            <>
                              <Volume2 size={14} className="pulse-icon" />{' '}
                              {playbackElapsedSec.toFixed(1)}s / {snippetDurationSec.toFixed(1)}s
                            </>
                          ) : (
                            <>Choose how long to play (0.1s – 30s)</>
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

                  {/* 8 Milestone Pills */}
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

                {/* Search & Guess Input (or Locked-In Banner in Competitive Online Party Mode) */}
                {!isCoopParty &&
                (isOnlinePartyHost || isRemoteGuestPlaying) &&
                activeOnlineStatus === 'correct' ? (
                  <div className="guest-locked-banner correct">
                    <CheckCircle2 size={20} />
                    <div>
                      <strong>
                        Correct at {effectiveScoringDuration.toFixed(1)}s clip!
                      </strong>
                      <span>
                        +{potentialNetPoints.toLocaleString()} pts locked in · Waiting for other
                        players...
                      </span>
                    </div>
                  </div>
                ) : !isCoopParty &&
                  (isOnlinePartyHost || isRemoteGuestPlaying) &&
                  activeOnlineStatus === 'gave-up' ? (
                  <div className="guest-locked-banner skipped">
                    <Flag size={18} />
                    <div>
                      <strong>Round Skipped</strong>
                      <span>Waiting for other players to finish guessing...</span>
                    </div>
                  </div>
                ) : (
                  <div className="guess-zone">
                    <div className="search-bar-container">
                      <div className="search-field-box">
                        <Search className="search-icon" size={18} />
                        <input
                          ref={searchInputRef}
                          type="text"
                          className="search-input"
                          placeholder={`Search ${searchablePool.length} songs...`}
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
                )}
              </>
            ) : (
              /* FOCUSED ROUND RESULT SPOTLIGHT */
              effectiveTrack && (
                <div className={`result-spotlight ${roundState}`}>
                  <div className="spotlight-badge-row">
                    {roundState === 'won' ? (
                      <span className="spotlight-status won">
                        <CheckCircle2 size={16} />
                        <span>
                          {isCoopParty
                            ? effectiveRoundWinnerName
                              ? `Co-Op: ${effectiveRoundWinnerName} identified at ${effectiveScoringDuration.toFixed(1)}s clip!`
                              : `Co-Op Team identified at ${effectiveScoringDuration.toFixed(1)}s clip!`
                            : `Identified at ${effectiveScoringDuration.toFixed(1)}s clip!`}
                        </span>
                      </span>
                    ) : (
                      <span className="spotlight-status gave-up">
                        <XCircle size={16} />
                        <span>Skipped · Revealed</span>
                      </span>
                    )}

                    <span className="spotlight-points-award">
                      +
                      {isCoopParty
                        ? (isRemoteGuestPlaying
                            ? (guestRoomState?.lastRoundPoints ?? 0)
                            : (roundHistory[roundHistory.length - 1]?.pointsAwarded ?? 0)
                          ).toLocaleString()
                        : isRemoteGuestPlaying
                          ? (guestMyEntry?.roundPoints ?? 0).toLocaleString()
                          : (
                              roundHistory[roundHistory.length - 1]?.pointsAwarded ?? 0
                            ).toLocaleString()}{' '}
                      pts{isCoopParty ? ' (Shared)' : ''}
                    </span>
                  </div>

                  <div className="spotlight-stage">
                    <div className={`spotlight-cover-wrap ${isPlaying ? 'playing' : ''}`}>
                      {effectiveTrack.artworkUrl ? (
                        <img
                          src={effectiveTrack.artworkUrl}
                          alt={effectiveTrack.title}
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
                      <h2 className="spotlight-title">{effectiveTrack.title}</h2>
                      <p className="spotlight-artist">{effectiveTrack.artist}</p>
                      <div className="spotlight-tags-row">
                        <span className="spotlight-era-tag">
                          {MUSIC_ERA_OPTIONS.find((e) => e.id === inferTrackEra(effectiveTrack))
                            ?.shortLabel ?? '2010s'}
                          {effectiveTrack.releaseYear ? ` (${effectiveTrack.releaseYear})` : ''}
                        </span>
                        {inferTrackGenres(effectiveTrack)
                          .slice(0, 2)
                          .map((gId) => {
                            const gLabel = MUSIC_GENRE_OPTIONS.find(
                              (opt) => opt.id === gId
                            )?.shortLabel;
                            return gLabel ? (
                              <span key={gId} className="spotlight-genre-tag">
                                {gLabel}
                              </span>
                            ) : null;
                          })}
                      </div>

                      {/* Favorited By Attribution */}
                      <div className="favorited-by-block">
                        <span className="favorited-by-label">
                          <Heart size={12} className="heart-icon" />
                          {(effectiveTrack.favoritedBy?.length ?? 0) >= 2
                            ? 'Shared Match! Favorited by:'
                            : 'Favorited by:'}
                        </span>
                        <div className="favorited-by-pills">
                          {effectiveTrack.favoritedBy && effectiveTrack.favoritedBy.length > 0 ? (
                            effectiveTrack.favoritedBy.map((fav) => (
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

                  {!isRemoteGuestPlaying && (
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
                        disabled={isPreparingRound}
                        className="btn-primary btn-next-song-lg"
                        onClick={() => void startNewRound()}
                      >
                        <span>{isPreparingRound ? 'Syncing Next Song...' : 'Next Song'}</span>
                        <ArrowRight size={17} />
                      </button>
                    </div>
                  )}
                </div>
              )
            )}

            {/* Party Standings OR Co-Op Shared Score Team Board */}
            {(isOnlinePartyHost || isRemoteGuestPlaying) && activeLeaderboard.length > 0 && (
              <div className="party-live-board">
                <div className="attempts-header">
                  <span>
                    {isCoopParty
                      ? `Co-Op Team (${activeLeaderboard.length} Music Contributors)`
                      : 'Party Standings'}
                  </span>
                  <span>
                    {isCoopParty
                      ? `Shared Score: ${effectiveSharedScore.toLocaleString()} pts`
                      : 'Scored by Unlocked Clip Length'}
                  </span>
                </div>
                <div className="member-list">
                  {activeLeaderboard.map((entry, idx) => (
                    <div key={entry.memberId} className="member-row">
                      {!isCoopParty && <span className="rank-num">#{idx + 1}</span>}
                      <span
                        className="member-dot"
                        style={{ backgroundColor: entry.color }}
                      />
                      <div className="member-info">
                        <strong>
                          {entry.name} {entry.isHost ? '(Host)' : ''}
                        </strong>
                        <span>
                          {isCoopParty
                            ? entry.roundStatus === 'correct'
                              ? `✓ Solved @${entry.guessSnippetSec?.toFixed(1)}s (+${entry.roundPoints.toLocaleString()} shared pts)`
                              : `${entry.trackCount} songs in Co-Op pool`
                            : entry.roundStatus === 'correct'
                              ? `✓ @${entry.guessSnippetSec?.toFixed(1)}s clip (+${entry.roundPoints.toLocaleString()})`
                              : entry.roundStatus === 'gave-up'
                                ? 'Skipped'
                                : entry.wrongAttempts > 0
                                  ? `Guessing (${entry.wrongAttempts} wrong)`
                                  : 'Guessing...'}
                        </span>
                      </div>
                      <span className="board-total-pts">
                        {isCoopParty
                          ? `${entry.trackCount} songs`
                          : `${entry.totalScore.toLocaleString()} pts`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Attempts List */}
            {guesses.length > 0 && (
              <div className="attempts-section">
                <div className="attempts-header">
                  <span>{isCoopParty ? 'Co-Op Team Attempts' : 'Your Attempts'} ({guesses.length})</span>
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
                        @{g.snippetDurationAtGuessSec.toFixed(1)}s
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
