import Peer, { DataConnection } from 'peerjs';
import { ProviderId, Track } from '../providers/types';

const PEER_PREFIX = 'aurelia-party-v1-';
const NTFY_JOIN_PREFIX = 'aurelia_party_v2_';
const NTFY_ACK_PREFIX = 'aurelia_party_ack_v2_';
const STORAGE_KEY_HOST_ROOM_CODE = 'aurelia.party.host_room_code.v1';

export interface PartyJoinPayload {
  type: 'PARTY_JOIN_SYNC';
  syncId?: string;
  memberId: string;
  name: string;
  provider: ProviderId;
  tracks: Track[];
}

export interface PartyAckPayload {
  type: 'PARTY_SYNC_ACK';
  roomCode: string;
  memberCount: number;
  sharedMatchesCount: number;
  totalTracksCount: number;
}

interface NtfyEnvelope {
  id: string;
  time: number;
  event: string;
  message?: string;
  attachment?: {
    url?: string;
  };
}

export function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export function getSavedHostRoomCode(): string | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_HOST_ROOM_CODE);
    if (saved && /^[A-Z0-9]{5}$/.test(saved)) {
      return saved;
    }
  } catch {
    // Ignore storage errors
  }
  return null;
}

export function clearSavedHostRoomCode(): void {
  try {
    localStorage.removeItem(STORAGE_KEY_HOST_ROOM_CODE);
  } catch {
    // Ignore storage errors
  }
}

export class PartyRoomService {
  private peer: Peer | null = null;
  private connections: DataConnection[] = [];
  private roomCode: string | null = null;
  private eventSource: EventSource | null = null;
  private pollTimerId: number | null = null;
  private visibilityListener: (() => void) | null = null;
  private processedSyncIds = new Set<string>();
  private processedNtfyIds = new Set<string>();
  private activeGuestSyncHandler:
    | ((
        payload: PartyJoinPayload,
        replyAck: (ack: Omit<PartyAckPayload, 'type' | 'roomCode'>) => void
      ) => void)
    | null = null;

  public getRoomCode(): string | null {
    return this.roomCode;
  }

  public async hostRoom(
    onGuestSync: (
      payload: PartyJoinPayload,
      replyAck: (ack: Omit<PartyAckPayload, 'type' | 'roomCode'>) => void
    ) => void,
    onError?: (err: Error) => void,
    forceNewCode = false
  ): Promise<string> {
    this.destroy(false);

    const existing = !forceNewCode ? getSavedHostRoomCode() : null;
    const code = existing || generateRoomCode();
    this.roomCode = code;
    this.activeGuestSyncHandler = onGuestSync;

    try {
      localStorage.setItem(STORAGE_KEY_HOST_ROOM_CODE, code);
    } catch {
      // Ignore storage errors
    }

    const handleIncomingPayload = (data: PartyJoinPayload, peerConn?: DataConnection) => {
      if (!data || data.type !== 'PARTY_JOIN_SYNC' || !Array.isArray(data.tracks)) {
        return;
      }
      const dedupeKey =
        data.syncId || `${data.memberId}::${data.name}::${data.provider}::${data.tracks.length}`;
      if (this.processedSyncIds.has(dedupeKey)) {
        return;
      }
      this.processedSyncIds.add(dedupeKey);

      this.activeGuestSyncHandler?.(data, (stats) => {
        const ack: PartyAckPayload = {
          type: 'PARTY_SYNC_ACK',
          roomCode: code,
          ...stats,
        };
        if (peerConn) {
          try {
            peerConn.send(ack);
          } catch {
            // Ignore peer send error
          }
        }
        // Also publish ACK over HTTPS relay for mobile guests
        void fetch(`https://ntfy.sh/${NTFY_ACK_PREFIX}${code}`, {
          method: 'POST',
          body: JSON.stringify(ack),
        }).catch(() => {
          // Ignore relay ack error
        });
      });
    };

    // 1. Start Universal HTTPS Relay (SSE stream + background polling for mobile reliability)
    this.startRelaySubscription(code, handleIncomingPayload);

    // 2. Also start PeerJS WebRTC listener in background (non-blocking)
    try {
      const peer = new Peer(`${PEER_PREFIX}${code}`);
      this.peer = peer;

      peer.on('connection', (conn) => {
        this.connections.push(conn);
        conn.on('data', (raw) => {
          handleIncomingPayload(raw as PartyJoinPayload, conn);
        });
      });

      peer.on('error', (err) => {
        // Do not fail room hosting if PeerJS has an issue; HTTPS relay handles all mobile traffic
        console.warn('PeerJS background notice:', err);
        if (onError && !this.roomCode) {
          onError(err instanceof Error ? err : new Error(String(err)));
        }
      });
    } catch {
      // HTTPS relay remains active
    }

    return code;
  }

  private async processNtfyEnvelope(
    env: NtfyEnvelope,
    onPayload: (data: PartyJoinPayload) => void
  ): Promise<void> {
    if (!env || env.event !== 'message' || !env.id) return;
    if (this.processedNtfyIds.has(env.id)) return;
    this.processedNtfyIds.add(env.id);

    try {
      if (env.attachment?.url) {
        const res = await fetch(env.attachment.url);
        if (res.ok) {
          const parsed = (await res.json()) as PartyJoinPayload;
          onPayload(parsed);
        }
      } else if (env.message && env.message.startsWith('{')) {
        const parsed = JSON.parse(env.message) as PartyJoinPayload;
        onPayload(parsed);
      }
    } catch {
      // Ignore malformed message on topic
    }
  }

  public async pollRoomNow(): Promise<void> {
    if (!this.roomCode || !this.activeGuestSyncHandler) return;
    const code = this.roomCode;
    try {
      const res = await fetch(`https://ntfy.sh/${NTFY_JOIN_PREFIX}${code}/json?poll=1&since=all`);
      if (!res.ok) return;
      const text = await res.text();
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      for (const line of lines) {
        try {
          const env = JSON.parse(line) as NtfyEnvelope;
          await this.processNtfyEnvelope(env, (payload) => {
            if (!this.activeGuestSyncHandler) return;
            const dedupeKey =
              payload.syncId ||
              `${payload.memberId}::${payload.name}::${payload.provider}::${payload.tracks.length}`;
            if (this.processedSyncIds.has(dedupeKey)) return;
            this.processedSyncIds.add(dedupeKey);

            this.activeGuestSyncHandler(payload, (stats) => {
              const ack: PartyAckPayload = {
                type: 'PARTY_SYNC_ACK',
                roomCode: code,
                ...stats,
              };
              void fetch(`https://ntfy.sh/${NTFY_ACK_PREFIX}${code}`, {
                method: 'POST',
                body: JSON.stringify(ack),
              }).catch(() => {});
            });
          });
        } catch {
          // Ignore line parse error
        }
      }
    } catch {
      // Ignore network poll error
    }
  }

  private startRelaySubscription(
    code: string,
    onPayload: (data: PartyJoinPayload) => void
  ): void {
    // Immediate poll to pick up any mobile guests who joined while host was backgrounded/refreshing
    void this.pollRoomNow();

    // Live SSE stream for instant (<200ms) updates
    try {
      const es = new EventSource(`https://ntfy.sh/${NTFY_JOIN_PREFIX}${code}/sse?since=all`);
      this.eventSource = es;
      es.onmessage = (evt) => {
        try {
          const env = JSON.parse(evt.data) as NtfyEnvelope;
          void this.processNtfyEnvelope(env, onPayload);
        } catch {
          // Ignore parse error
        }
      };
    } catch {
      // Fallback to polling
    }

    // Periodic poll every 2.5s (handles mobile background/foreground transitions seamlessly)
    this.pollTimerId = window.setInterval(() => {
      void this.pollRoomNow();
    }, 2500);

    // Also poll immediately when host returns to browser tab on mobile
    this.visibilityListener = () => {
      if (document.visibilityState === 'visible') {
        void this.pollRoomNow();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityListener);
  }

  public async sendCatalogToHost(
    roomCode: string,
    payload: Omit<PartyJoinPayload, 'type'>
  ): Promise<PartyAckPayload> {
    const cleanCode = roomCode.trim().toUpperCase();
    if (!cleanCode) {
      throw new Error('Please enter the 5-character Party Room Code.');
    }

    // Trim track fields to keep mobile upload lightweight and fast
    const compactTracks: Track[] = payload.tracks.slice(0, 500).map((t) => ({
      id: t.id,
      videoId: t.videoId,
      title: t.title,
      artist: t.artist,
      artworkUrl: t.artworkUrl,
      durationSec: t.durationSec,
      spotifyUri: t.spotifyUri,
      provider: t.provider,
    }));

    const syncId = `${payload.memberId}-${Date.now()}`;
    const fullPayload: PartyJoinPayload = {
      type: 'PARTY_JOIN_SYNC',
      syncId,
      memberId: payload.memberId,
      name: payload.name,
      provider: payload.provider,
      tracks: compactTracks,
    };

    // Listen for live ACK from host if host tab is currently active
    let closeAckStream = () => {};
    const liveAckPromise = new Promise<PartyAckPayload | null>((resolve) => {
      let es: EventSource | null = null;
      closeAckStream = () => {
        es?.close();
      };
      const timer = window.setTimeout(() => {
        es?.close();
        resolve(null);
      }, 2400);

      try {
        es = new EventSource(`https://ntfy.sh/${NTFY_ACK_PREFIX}${cleanCode}/sse`);
        es.onmessage = (evt) => {
          try {
            const env = JSON.parse(evt.data) as NtfyEnvelope;
            if (env.message && env.message.startsWith('{')) {
              const parsed = JSON.parse(env.message) as PartyAckPayload;
              if (parsed.type === 'PARTY_SYNC_ACK') {
                window.clearTimeout(timer);
                es?.close();
                resolve(parsed);
              }
            }
          } catch {
            // Ignore
          }
        };
        es.onerror = () => {
          window.clearTimeout(timer);
          es?.close();
          resolve(null);
        };
      } catch {
        window.clearTimeout(timer);
        resolve(null);
      }
    });

    // Primary Delivery: HTTPS PUT to room topic (works across all mobile networks and persists)
    const uploadRes = await fetch(`https://ntfy.sh/${NTFY_JOIN_PREFIX}${cleanCode}`, {
      method: 'PUT',
      headers: {
        Filename: `join-${payload.memberId}.json`,
      },
      body: JSON.stringify(fullPayload),
    });

    if (!uploadRes.ok) {
      closeAckStream();
      throw new Error(`Failed to send library to room "${cleanCode}" (status ${uploadRes.status}).`);
    }

    // Wait up to 2.4s for the host's live merged-pool statistics ACK;
    // if the host is momentarily in another mobile app, return immediate delivery confirmation!
    const liveAck = await liveAckPromise;
    if (liveAck) {
      return liveAck;
    }

    return {
      type: 'PARTY_SYNC_ACK',
      roomCode: cleanCode,
      memberCount: 1,
      sharedMatchesCount: 0,
      totalTracksCount: compactTracks.length,
    };
  }

  public destroy(clearSavedCode = true): void {
    if (this.eventSource) {
      try {
        this.eventSource.close();
      } catch {
        // Ignore
      }
      this.eventSource = null;
    }
    if (this.pollTimerId !== null) {
      window.clearInterval(this.pollTimerId);
      this.pollTimerId = null;
    }
    if (this.visibilityListener) {
      document.removeEventListener('visibilitychange', this.visibilityListener);
      this.visibilityListener = null;
    }
    for (const c of this.connections) {
      try {
        c.close();
      } catch {
        // Ignore
      }
    }
    this.connections = [];
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {
        // Ignore
      }
      this.peer = null;
    }
    this.roomCode = null;
    if (clearSavedCode) {
      this.processedSyncIds.clear();
      this.processedNtfyIds.clear();
      clearSavedHostRoomCode();
    }
  }
}
