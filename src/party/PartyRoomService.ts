import Peer, { DataConnection } from 'peerjs';
import { ProviderId, Track } from '../providers/types';

const PEER_PREFIX = 'aurelia-party-v1-';

export interface PartyJoinPayload {
  type: 'PARTY_JOIN_SYNC';
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

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export class PartyRoomService {
  private peer: Peer | null = null;
  private connections: DataConnection[] = [];
  private roomCode: string | null = null;

  public getRoomCode(): string | null {
    return this.roomCode;
  }

  public async hostRoom(
    onGuestSync: (payload: PartyJoinPayload, replyAck: (ack: Omit<PartyAckPayload, 'type' | 'roomCode'>) => void) => void,
    onError?: (err: Error) => void
  ): Promise<string> {
    this.destroy();
    const code = generateRoomCode();
    this.roomCode = code;

    return new Promise<string>((resolve, reject) => {
      const peer = new Peer(`${PEER_PREFIX}${code}`);
      this.peer = peer;

      peer.on('open', () => {
        resolve(code);
      });

      peer.on('connection', (conn) => {
        this.connections.push(conn);
        conn.on('data', (raw) => {
          const data = raw as PartyJoinPayload;
          if (data && data.type === 'PARTY_JOIN_SYNC' && Array.isArray(data.tracks)) {
            onGuestSync(data, (stats) => {
              const ack: PartyAckPayload = {
                type: 'PARTY_SYNC_ACK',
                roomCode: code,
                ...stats,
              };
              conn.send(ack);
            });
          }
        });
      });

      peer.on('error', (err) => {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        onError?.(errorObj);
        reject(errorObj);
      });
    });
  }

  public async sendCatalogToHost(
    roomCode: string,
    payload: Omit<PartyJoinPayload, 'type'>
  ): Promise<PartyAckPayload> {
    const cleanCode = roomCode.trim().toUpperCase();
    if (!cleanCode) {
      throw new Error('Please enter a valid 5-character Party Room Code.');
    }

    return new Promise<PartyAckPayload>((resolve, reject) => {
      const guestPeer = new Peer();
      const timeout = window.setTimeout(() => {
        guestPeer.destroy();
        reject(new Error(`Timed out connecting to Party Room "${cleanCode}". Verify the host room is open.`));
      }, 12000);

      guestPeer.on('open', () => {
        const conn = guestPeer.connect(`${PEER_PREFIX}${cleanCode}`, { reliable: true });

        conn.on('open', () => {
          const fullPayload: PartyJoinPayload = {
            type: 'PARTY_JOIN_SYNC',
            ...payload,
          };
          conn.send(fullPayload);
        });

        conn.on('data', (raw) => {
          const data = raw as PartyAckPayload;
          if (data && data.type === 'PARTY_SYNC_ACK') {
            window.clearTimeout(timeout);
            setTimeout(() => guestPeer.destroy(), 500);
            resolve(data);
          }
        });

        conn.on('error', (err) => {
          window.clearTimeout(timeout);
          guestPeer.destroy();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });

      guestPeer.on('error', (err) => {
        window.clearTimeout(timeout);
        guestPeer.destroy();
        reject(new Error(`Could not connect to Room "${cleanCode}": ${err.message || err.type}`));
      });
    });
  }

  public destroy(): void {
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
  }
}
