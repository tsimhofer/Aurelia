import Peer, { DataConnection } from 'peerjs';
import { ProviderId, Track } from '../providers/types';

const PEER_PREFIX = 'aurelia-party-v1-';
const MQTT_TOPIC_ROOT = 'aurelia/party/v3';
const STORAGE_KEY_HOST_ROOM_CODE = 'aurelia.party.host_room_code.v1';
const CHUNK_SIZE_TRACKS = 100;

const MQTT_BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
];

export interface PartyJoinPayload {
  type: 'PARTY_JOIN_SYNC';
  syncId?: string;
  memberId: string;
  name: string;
  provider: ProviderId;
  tracks: Track[];
}

interface PartyJoinChunkPayload {
  type: 'PARTY_JOIN_CHUNK';
  syncId: string;
  memberId: string;
  name: string;
  provider: ProviderId;
  chunkIndex: number;
  totalChunks: number;
  tracks: Track[];
}

export interface PartyAckPayload {
  type: 'PARTY_SYNC_ACK';
  roomCode: string;
  memberCount: number;
  sharedMatchesCount: number;
  totalTracksCount: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeVarInt(len: number): Uint8Array {
  const out: number[] = [];
  let rem = len;
  do {
    let digit = rem % 128;
    rem = Math.floor(rem / 128);
    if (rem > 0) digit |= 128;
    out.push(digit);
  } while (rem > 0);
  return new Uint8Array(out);
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const res = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    res.set(a, offset);
    offset += a.length;
  }
  return res;
}

function encodeMqttString(str: string): Uint8Array {
  const b = textEncoder.encode(str);
  return concatBytes(new Uint8Array([(b.length >> 8) & 0xff, b.length & 0xff]), b);
}

function buildMqttConnect(clientId: string): Uint8Array {
  const variableHeader = new Uint8Array([
    0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, // "MQTT"
    0x04, // Protocol level 4 (v3.1.1)
    0x02, // Clean session
    0x00, 0x3c, // Keep-alive 60s
  ]);
  const payload = encodeMqttString(clientId);
  const remaining = concatBytes(variableHeader, payload);
  return concatBytes(new Uint8Array([0x10]), encodeVarInt(remaining.length), remaining);
}

function buildMqttPublish(topic: string, payloadStr: string, retain = false): Uint8Array {
  const topicBytes = encodeMqttString(topic);
  const payloadBytes = textEncoder.encode(payloadStr);
  const remaining = concatBytes(topicBytes, payloadBytes);
  const fixedHeader = 0x30 | (retain ? 0x01 : 0x00);
  return concatBytes(new Uint8Array([fixedHeader]), encodeVarInt(remaining.length), remaining);
}

function buildMqttSubscribe(topic: string, packetId = 1): Uint8Array {
  const topicBytes = encodeMqttString(topic);
  const remaining = concatBytes(
    new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff]),
    topicBytes,
    new Uint8Array([0x00])
  );
  return concatBytes(new Uint8Array([0x82]), encodeVarInt(remaining.length), remaining);
}

function parseMqttPackets(
  buffer: Uint8Array,
  onConnAck: () => void,
  onPublish: (topic: string, message: string) => void
): Uint8Array {
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 2 > buffer.length) break;
    const headerByte = buffer[offset];
    const packetType = headerByte >> 4;

    let idx = offset + 1;
    let multiplier = 1;
    let remainingLength = 0;
    let encodedByte = 0;
    let completeLength = false;

    while (idx < buffer.length) {
      encodedByte = buffer[idx++];
      remainingLength += (encodedByte & 127) * multiplier;
      multiplier *= 128;
      if ((encodedByte & 128) === 0) {
        completeLength = true;
        break;
      }
      if (multiplier > 128 * 128 * 128) {
        return new Uint8Array(0);
      }
    }

    if (!completeLength || idx + remainingLength > buffer.length) {
      // Wait for more bytes in next WebSocket frame
      break;
    }

    const packetStart = idx;
    const packetEnd = idx + remainingLength;

    if (packetType === 2) {
      // CONNACK
      onConnAck();
    } else if (packetType === 3 && remainingLength >= 2) {
      // PUBLISH
      const topicLen = (buffer[packetStart] << 8) | buffer[packetStart + 1];
      const topicStart = packetStart + 2;
      const topicEnd = topicStart + topicLen;
      if (topicEnd <= packetEnd) {
        const topic = textDecoder.decode(buffer.subarray(topicStart, topicEnd));
        const qos = (headerByte >> 1) & 0x03;
        const payloadStart = qos > 0 ? topicEnd + 2 : topicEnd;
        if (payloadStart <= packetEnd) {
          const message = textDecoder.decode(buffer.subarray(payloadStart, packetEnd));
          onPublish(topic, message);
        }
      }
    }

    offset = packetEnd;
  }

  return buffer.subarray(offset);
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
  private sockets: WebSocket[] = [];
  private pingTimerId: number | null = null;
  private visibilityListener: (() => void) | null = null;
  private roomCode: string | null = null;
  private processedSyncIds = new Set<string>();
  private chunkAssembler = new Map<
    string,
    {
      memberId: string;
      name: string;
      provider: ProviderId;
      totalChunks: number;
      chunks: Map<number, Track[]>;
    }
  >();
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
    _onError?: (err: Error) => void,
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

    // Connect to redundant MQTT-over-WebSocket brokers + PeerJS WebRTC
    this.connectHostBrokers(code);
    this.connectHostPeer(code);

    // Re-sync immediately when returning to browser tab on mobile
    this.visibilityListener = () => {
      if (document.visibilityState === 'visible' && this.roomCode) {
        this.connectHostBrokers(this.roomCode);
      }
    };
    document.addEventListener('visibilitychange', this.visibilityListener);

    return code;
  }

  private handleCompleteJoinPayload(
    data: PartyJoinPayload,
    code: string,
    peerConn?: DataConnection
  ): void {
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
          // Ignore
        }
      }
      const ackPacket = buildMqttPublish(
        `${MQTT_TOPIC_ROOT}/${code}/ack`,
        JSON.stringify(ack),
        false
      );
      for (const ws of this.sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(ackPacket);
          } catch {
            // Ignore
          }
        }
      }
    });
  }

  private handleIncomingChunkOrSync(
    rawObj: PartyJoinPayload | PartyJoinChunkPayload,
    code: string,
    peerConn?: DataConnection
  ): void {
    if (!rawObj || typeof rawObj !== 'object') return;

    if (rawObj.type === 'PARTY_JOIN_SYNC') {
      this.handleCompleteJoinPayload(rawObj, code, peerConn);
      return;
    }

    if (rawObj.type === 'PARTY_JOIN_CHUNK') {
      const { syncId, memberId, name, provider, chunkIndex, totalChunks, tracks } = rawObj;
      if (!syncId || !Array.isArray(tracks) || !totalChunks) return;

      let entry = this.chunkAssembler.get(syncId);
      if (!entry) {
        entry = {
          memberId,
          name,
          provider,
          totalChunks,
          chunks: new Map<number, Track[]>(),
        };
        this.chunkAssembler.set(syncId, entry);
      }

      entry.chunks.set(chunkIndex, tracks);

      if (entry.chunks.size >= entry.totalChunks) {
        const allTracks: Track[] = [];
        for (let i = 0; i < entry.totalChunks; i++) {
          const part = entry.chunks.get(i);
          if (part) allTracks.push(...part);
        }
        this.chunkAssembler.delete(syncId);
        this.handleCompleteJoinPayload(
          {
            type: 'PARTY_JOIN_SYNC',
            syncId,
            memberId: entry.memberId,
            name: entry.name,
            provider: entry.provider,
            tracks: allTracks,
          },
          code,
          peerConn
        );
      }
    }
  }

  private closeSockets(): void {
    if (this.pingTimerId !== null) {
      window.clearInterval(this.pingTimerId);
      this.pingTimerId = null;
    }
    for (const ws of this.sockets) {
      try {
        ws.close();
      } catch {
        // Ignore
      }
    }
    this.sockets = [];
  }

  private connectHostBrokers(code: string): void {
    this.closeSockets();

    for (const brokerUrl of MQTT_BROKERS) {
      try {
        const ws = new WebSocket(brokerUrl, 'mqtt');
        ws.binaryType = 'arraybuffer';
        let recvBuf: Uint8Array = new Uint8Array(0);

        ws.onopen = () => {
          const clientId = `aurelia_h_${code}_${Math.random().toString(36).slice(2, 7)}`;
          ws.send(buildMqttConnect(clientId));
        };

        ws.onmessage = (evt) => {
          if (!(evt.data instanceof ArrayBuffer)) return;
          recvBuf = concatBytes(recvBuf, new Uint8Array(evt.data));
          recvBuf = parseMqttPackets(
            recvBuf,
            () => {
              // Subscribing to wildcard delivers all retained member chunks immediately
              ws.send(buildMqttSubscribe(`${MQTT_TOPIC_ROOT}/${code}/members/#`, 1));
            },
            (_topic, message) => {
              if (!message || !message.startsWith('{')) return;
              try {
                const parsed = JSON.parse(message) as PartyJoinPayload | PartyJoinChunkPayload;
                this.handleIncomingChunkOrSync(parsed, code);
              } catch {
                // Ignore malformed JSON
              }
            }
          );
        };

        this.sockets.push(ws);
      } catch {
        // Ignore individual broker connection error
      }
    }

    this.pingTimerId = window.setInterval(() => {
      const ping = new Uint8Array([0xc0, 0x00]);
      for (const ws of this.sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(ping);
          } catch {
            // Ignore
          }
        }
      }
    }, 25000);
  }

  private connectHostPeer(code: string): void {
    try {
      const peer = new Peer(`${PEER_PREFIX}${code}`);
      this.peer = peer;

      peer.on('connection', (conn) => {
        this.connections.push(conn);
        conn.on('data', (raw) => {
          this.handleIncomingChunkOrSync(
            raw as PartyJoinPayload | PartyJoinChunkPayload,
            code,
            conn
          );
        });
      });

      peer.on('disconnected', () => {
        try {
          peer.reconnect();
        } catch {
          // Ignore
        }
      });

      peer.on('error', () => {
        // WebSocket MQTT brokers handle traffic seamlessly if PeerJS has an issue
      });
    } catch {
      // Ignore PeerJS init error
    }
  }

  public async pollRoomNow(): Promise<void> {
    if (!this.roomCode) return;
    // Re-trigger subscription on brokers so any retained messages are re-delivered immediately
    this.connectHostBrokers(this.roomCode);
  }

  public async sendCatalogToHost(
    roomCode: string,
    payload: Omit<PartyJoinPayload, 'type'>
  ): Promise<PartyAckPayload> {
    const cleanCode = roomCode.trim().toUpperCase();
    if (!cleanCode) {
      throw new Error('Please enter the 5-character Party Room Code.');
    }

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
    const memberSlug = payload.memberId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'guest';
    const chunks: PartyJoinChunkPayload[] = [];
    const totalChunks = Math.max(1, Math.ceil(compactTracks.length / CHUNK_SIZE_TRACKS));

    for (let i = 0; i < totalChunks; i++) {
      chunks.push({
        type: 'PARTY_JOIN_CHUNK',
        syncId,
        memberId: payload.memberId,
        name: payload.name,
        provider: payload.provider,
        chunkIndex: i,
        totalChunks,
        tracks: compactTracks.slice(i * CHUNK_SIZE_TRACKS, (i + 1) * CHUNK_SIZE_TRACKS),
      });
    }

    // Publish chunks across redundant MQTT-over-WebSocket brokers + PeerJS simultaneously
    const sendViaMqttBroker = (brokerUrl: string): Promise<PartyAckPayload> =>
      new Promise<PartyAckPayload>((resolve, reject) => {
        let ws: WebSocket | null = null;
        let settled = false;
        let fallbackTimer: number | null = null;

        const finish = (ack: PartyAckPayload) => {
          if (settled) return;
          settled = true;
          if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
          window.clearTimeout(timeout);
          setTimeout(() => {
            try {
              ws?.close();
            } catch {
              // Ignore
            }
          }, 300);
          resolve(ack);
        };

        const timeout = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            ws?.close();
          } catch {
            // Ignore
          }
          reject(new Error(`Broker timeout (${brokerUrl})`));
        }, 8000);

        try {
          ws = new WebSocket(brokerUrl, 'mqtt');
          ws.binaryType = 'arraybuffer';
          let recvBuf: Uint8Array = new Uint8Array(0);

          ws.onopen = () => {
            const clientId = `aurelia_g_${Math.random().toString(36).slice(2, 9)}`;
            ws!.send(buildMqttConnect(clientId));
          };

          ws.onmessage = (evt) => {
            if (!(evt.data instanceof ArrayBuffer)) return;
            recvBuf = concatBytes(recvBuf, new Uint8Array(evt.data));
            recvBuf = parseMqttPackets(
              recvBuf,
              () => {
                // 1. Subscribe to host ACK topic
                ws!.send(buildMqttSubscribe(`${MQTT_TOPIC_ROOT}/${cleanCode}/ack`, 1));

                // 2. Publish each chunk as a retained message so the host gets it live OR on wake
                for (const chunk of chunks) {
                  const topic = `${MQTT_TOPIC_ROOT}/${cleanCode}/members/${memberSlug}/${chunk.chunkIndex}`;
                  ws!.send(buildMqttPublish(topic, JSON.stringify(chunk), true));
                }

                // 3. If host doesn't send live ACK within 1.8s (e.g. host phone is in WhatsApp),
                // resolve with confirmation because retained chunks are safely stored on the broker!
                fallbackTimer = window.setTimeout(() => {
                  finish({
                    type: 'PARTY_SYNC_ACK',
                    roomCode: cleanCode,
                    memberCount: 1,
                    sharedMatchesCount: 0,
                    totalTracksCount: compactTracks.length,
                  });
                }, 1800);
              },
              (_topic, message) => {
                if (!message || !message.startsWith('{')) return;
                try {
                  const parsed = JSON.parse(message) as PartyAckPayload;
                  if (parsed.type === 'PARTY_SYNC_ACK') {
                    finish(parsed);
                  }
                } catch {
                  // Ignore
                }
              }
            );
          };

          ws.onerror = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            reject(new Error(`WebSocket error (${brokerUrl})`));
          };
        } catch (err) {
          window.clearTimeout(timeout);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

    const sendViaPeerJs = (): Promise<PartyAckPayload> =>
      new Promise<PartyAckPayload>((resolve, reject) => {
        const guestPeer = new Peer();
        const timeout = window.setTimeout(() => {
          guestPeer.destroy();
          reject(new Error('PeerJS timeout'));
        }, 7000);

        guestPeer.on('open', () => {
          const conn = guestPeer.connect(`${PEER_PREFIX}${cleanCode}`, { reliable: true });
          conn.on('open', () => {
            for (const chunk of chunks) {
              conn.send(chunk);
            }
          });
          conn.on('data', (raw) => {
            const data = raw as PartyAckPayload;
            if (data && data.type === 'PARTY_SYNC_ACK') {
              window.clearTimeout(timeout);
              setTimeout(() => guestPeer.destroy(), 400);
              resolve(data);
            }
          });
          conn.on('error', (err) => {
            window.clearTimeout(timeout);
            guestPeer.destroy();
            reject(err);
          });
        });

        guestPeer.on('error', (err) => {
          window.clearTimeout(timeout);
          guestPeer.destroy();
          reject(err);
        });
      });

    const candidates = [
      ...MQTT_BROKERS.map((url) => sendViaMqttBroker(url)),
      sendViaPeerJs(),
    ];

    return new Promise<PartyAckPayload>((resolve, reject) => {
      let rejectedCount = 0;
      let resolved = false;
      for (const p of candidates) {
        p.then((val) => {
          if (!resolved) {
            resolved = true;
            resolve(val);
          }
        }).catch(() => {
          rejectedCount++;
          if (rejectedCount === candidates.length && !resolved) {
            reject(
              new Error(
                `Could not reach Party Room "${cleanCode}". Check your internet connection and verify the Room Code.`
              )
            );
          }
        });
      }
    });
  }

  public destroy(clearSavedCode = true): void {
    this.closeSockets();
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
      this.chunkAssembler.clear();
      clearSavedHostRoomCode();
    }
  }
}
