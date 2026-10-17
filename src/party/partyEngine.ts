import { PartyMemberRef, ProviderId, Track } from '../providers/types';

export const PARTY_MEMBER_COLORS = [
  '#ff3355',
  '#1ed760',
  '#38bdf8',
  '#fbbf24',
  '#a855f7',
  '#fb923c',
  '#2dd4bf',
  '#f472b6',
];

export interface PartyMember {
  id: string;
  name: string;
  color: string;
  provider: ProviderId;
  tracks: Track[];
  isReady: boolean;
  isHost?: boolean;
}

export interface MergedPartyPool {
  tracks: Track[];
  sharedMatchesCount: number;
  totalUniqueCount: number;
}

function stripMusicNoise(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s*-\s*topic$/i, '')
    .replace(
      /[\(\[\{][^\)\]\}]*(official|video|audio|lyric|visualizer|remaster|hd|4k|hq|live|version|edit|mix|feat\.?|ft\.?)[^\)\]\}]*[\)\]\}]/gi,
      ' '
    )
    .replace(/\b(feat\.?|ft\.?|featuring)\s+[^-\(\[\|]+/gi, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Produces one or more canonical keys for cross-provider (Spotify <-> YouTube Music)
 * exact song matching.
 */
export function getCanonicalSongKeys(track: Track): string[] {
  const keys = new Set<string>();

  if (track.videoId) {
    keys.add(`vid::${track.videoId}`);
  }
  keys.add(`id::${track.provider}::${track.id}`);

  const cleanArtist = stripMusicNoise(track.artist.split(',')[0] ?? track.artist);
  const cleanTitle = stripMusicNoise(track.title);

  if (cleanArtist && cleanTitle) {
    keys.add(`meta::${cleanArtist}::${cleanTitle}`);
  }

  // Handle YouTube titles formatted as "Artist - Song Title"
  if (track.title.includes(' - ')) {
    const [leftRaw, ...rightParts] = track.title.split(' - ');
    const rightRaw = rightParts.join(' - ');
    const splitArtist = stripMusicNoise(leftRaw);
    const splitSong = stripMusicNoise(rightRaw);

    if (splitArtist && splitSong) {
      keys.add(`meta::${splitArtist}::${splitSong}`);
      // Also handle first artist token if multiple artists are listed
      const primarySplitArtist = stripMusicNoise(leftRaw.split(/[,&x]/i)[0] ?? leftRaw);
      if (primarySplitArtist && primarySplitArtist !== splitArtist) {
        keys.add(`meta::${primarySplitArtist}::${splitSong}`);
      }
    }
    if (cleanArtist && splitSong) {
      keys.add(`meta::${cleanArtist}::${splitSong}`);
    }
  }

  return Array.from(keys);
}

/**
 * Merges playlists from multiple party members (across Spotify and YouTube Music).
 * Deduplicates exact song matches and records all members who favorited each track.
 */
export function mergePartyCatalogs(members: PartyMember[]): MergedPartyPool {
  const mergedTracks: Track[] = [];
  const keyToTrackIndex = new Map<string, number>();

  for (const member of members) {
    const memberRef: PartyMemberRef = {
      memberId: member.id,
      name: member.name,
      color: member.color,
      provider: member.provider,
    };

    for (const rawTrack of member.tracks) {
      const candidateKeys = getCanonicalSongKeys(rawTrack);
      let existingIdx: number | undefined;

      for (const k of candidateKeys) {
        const found = keyToTrackIndex.get(k);
        if (found !== undefined) {
          existingIdx = found;
          break;
        }
      }

      if (existingIdx !== undefined) {
        const existing = mergedTracks[existingIdx];
        const favs = existing.favoritedBy ? [...existing.favoritedBy] : [];
        if (!favs.some((f) => f.memberId === member.id)) {
          favs.push(memberRef);
        }

        // Prefer keeping a direct YouTube videoId for zero-latency playback,
        // while preferring cleaner Spotify metadata/artwork when available.
        mergedTracks[existingIdx] = {
          ...existing,
          videoId: existing.videoId || rawTrack.videoId,
          spotifyUri: existing.spotifyUri || rawTrack.spotifyUri,
          artworkUrl:
            (rawTrack.provider === 'spotify' ? rawTrack.artworkUrl : existing.artworkUrl) ||
            existing.artworkUrl ||
            rawTrack.artworkUrl,
          title:
            rawTrack.provider === 'spotify' && existing.provider !== 'spotify'
              ? rawTrack.title
              : existing.title,
          artist:
            rawTrack.provider === 'spotify' && existing.provider !== 'spotify'
              ? rawTrack.artist
              : existing.artist,
          durationSec: existing.durationSec ?? rawTrack.durationSec,
          favoritedBy: favs,
        };

        for (const k of candidateKeys) {
          keyToTrackIndex.set(k, existingIdx);
        }
      } else {
        const newIdx = mergedTracks.length;
        mergedTracks.push({
          ...rawTrack,
          favoritedBy: [memberRef],
        });
        for (const k of candidateKeys) {
          keyToTrackIndex.set(k, newIdx);
        }
      }
    }
  }

  const sharedMatchesCount = mergedTracks.filter(
    (t) => (t.favoritedBy?.length ?? 0) >= 2
  ).length;

  return {
    tracks: mergedTracks,
    sharedMatchesCount,
    totalUniqueCount: mergedTracks.length,
  };
}

/**
 * Selects the next track in Party Mode:
 * 1. First prefers unplayed exact matches shared by 2+ users (sorted by highest overlap,
 *    then lowest cumulative player exposure).
 * 2. Once shared matches are exhausted (or if none exist), performs fair deficit-balanced
 *    selection across all party members so every user gets equal song representation.
 */
export function selectNextPartyTrack(
  pool: Track[],
  usedTrackIds: Set<string>,
  memberPickCounts: Record<string, number>,
  members: PartyMember[]
): { chosen: Track; updatedPickCounts: Record<string, number> } {
  const unplayed = pool.filter((t) => !usedTrackIds.has(t.id));
  const candidatePool = unplayed.length > 0 ? unplayed : pool;

  // 1. Check for shared exact matches (favorited by >= 2 party members)
  const sharedMatches = candidatePool.filter((t) => (t.favoritedBy?.length ?? 0) >= 2);

  let chosen: Track;

  if (sharedMatches.length > 0 && members.length >= 2) {
    // Prefer highest overlap count, then lowest average pick count of involved members
    const scored = sharedMatches.map((track) => {
      const favs = track.favoritedBy ?? [];
      const overlapCount = favs.length;
      const avgExposure =
        favs.reduce((sum, f) => sum + (memberPickCounts[f.memberId] ?? 0), 0) /
        Math.max(1, favs.length);
      return { track, overlapCount, avgExposure };
    });

    scored.sort((a, b) => {
      if (b.overlapCount !== a.overlapCount) {
        return b.overlapCount - a.overlapCount;
      }
      return a.avgExposure - b.avgExposure;
    });

    // Pick randomly among the top-tier shared matches
    const bestOverlap = scored[0].overlapCount;
    const minExp = scored[0].avgExposure;
    const topCandidates = scored.filter(
      (s) => s.overlapCount === bestOverlap && Math.abs(s.avgExposure - minExp) <= 1
    );
    chosen = topCandidates[Math.floor(Math.random() * topCandidates.length)].track;
  } else if (members.length >= 2) {
    // 2. Fair round-robin / deficit-balanced selection across all members with available tracks
    const membersWithTracks = members.filter((m) =>
      candidatePool.some((t) => t.favoritedBy?.some((f) => f.memberId === m.id))
    );

    if (membersWithTracks.length > 0) {
      const minPicks = Math.min(
        ...membersWithTracks.map((m) => memberPickCounts[m.id] ?? 0)
      );
      const underRepresentedMembers = membersWithTracks.filter(
        (m) => (memberPickCounts[m.id] ?? 0) === minPicks
      );
      const targetMember =
        underRepresentedMembers[
          Math.floor(Math.random() * underRepresentedMembers.length)
        ];

      const memberTracks = candidatePool.filter((t) =>
        t.favoritedBy?.some((f) => f.memberId === targetMember.id)
      );
      chosen = memberTracks[Math.floor(Math.random() * memberTracks.length)];
    } else {
      chosen = candidatePool[Math.floor(Math.random() * candidatePool.length)];
    }
  } else {
    chosen = candidatePool[Math.floor(Math.random() * candidatePool.length)];
  }

  const updatedPickCounts = { ...memberPickCounts };
  for (const fav of chosen.favoritedBy ?? []) {
    updatedPickCounts[fav.memberId] = (updatedPickCounts[fav.memberId] ?? 0) + 1;
  }

  return { chosen, updatedPickCounts };
}
