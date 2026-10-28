/**
 * SFU (Selective Forwarding Unit) over mediasoup — the scaling path for calls
 * beyond the P2P mesh's ~4-peer ceiling (PRD §5.3). Each peer uploads their
 * media once to the server, which forwards it to every other peer, so a client's
 * upload cost stays flat as the room grows (mesh is O(n) uploads per peer).
 *
 * One shared Worker hosts a Router per project room. Each peer gets a send and a
 * recv WebRtcTransport; they Produce their mic/cam and Consume everyone else's.
 * Media is SRTP between client and worker — it never flows through Node/Socket.io
 * (that carries only signaling). Signaling uses Socket.io ack callbacks for the
 * request/response pairs and server→client emits for producer/peer notifications.
 */
import type { Server, Socket } from "socket.io";
import * as mediasoup from "mediasoup";
import type { types as ms } from "mediasoup";
import { SOCKET_EVENTS } from "@yumi/shared";
import { config } from "./config.js";

const MEDIA_CODECS: ms.RtpCodecCapability[] = [
  { kind: "audio", mimeType: "audio/opus", preferredPayloadType: 100, clockRate: 48000, channels: 2 },
  {
    kind: "video",
    mimeType: "video/VP8",
    preferredPayloadType: 101,
    clockRate: 90000,
    parameters: { "x-google-start-bitrate": 1000 },
  },
];

interface Peer {
  socketId: string;
  userId: string;
  transports: Map<string, ms.WebRtcTransport>;
  producers: Map<string, ms.Producer>;
  consumers: Map<string, ms.Consumer>;
}

interface Room {
  router: ms.Router;
  peers: Map<string, Peer>; // keyed by userId
}

let worker: ms.Worker | null = null;
let workerStarting: Promise<ms.Worker> | null = null;
const rooms = new Map<string, Room>(); // keyed by projectId

async function getWorker(): Promise<ms.Worker> {
  if (worker) return worker;
  if (workerStarting) return workerStarting;
  workerStarting = mediasoup
    .createWorker({
      logLevel: "warn",
      rtcMinPort: config.mediasoup.rtcMinPort,
      rtcMaxPort: config.mediasoup.rtcMaxPort,
    })
    .then((w) => {
      w.on("died", () => {
        // A dead worker takes all its routers/transports with it; drop state so
        // the next call rebuilds cleanly rather than handing out dead handles.
        console.error("[sfu] mediasoup worker died — resetting SFU state");
        worker = null;
        workerStarting = null;
        rooms.clear();
      });
      worker = w;
      console.log(`[sfu] mediasoup worker up (pid ${w.pid}), rtc ports ${config.mediasoup.rtcMinPort}-${config.mediasoup.rtcMaxPort}`);
      return w;
    });
  return workerStarting;
}

async function getRoom(projectId: string): Promise<Room> {
  const existing = rooms.get(projectId);
  if (existing) return existing;
  const w = await getWorker();
  const router = await w.createRouter({ mediaCodecs: MEDIA_CODECS });
  const room: Room = { router, peers: new Map() };
  rooms.set(projectId, room);
  return room;
}

async function createTransport(room: Room): Promise<ms.WebRtcTransport> {
  return room.router.createWebRtcTransport({
    listenIps: [{ ip: "0.0.0.0", announcedIp: config.mediasoup.announcedIp }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1_000_000,
  });
}

function transportParams(t: ms.WebRtcTransport) {
  return {
    id: t.id,
    iceParameters: t.iceParameters,
    iceCandidates: t.iceCandidates,
    dtlsParameters: t.dtlsParameters,
  };
}

/** Tear down a peer: closing transports cascades to its producers/consumers. */
function closePeer(room: Room, projectId: string, userId: string, io: Server) {
  const peer = room.peers.get(userId);
  if (!peer) return;
  for (const producerId of peer.producers.keys()) {
    io.to(projectId).emit(SOCKET_EVENTS.SFU_PRODUCER_CLOSED, { producerId, peerId: userId });
  }
  peer.transports.forEach((t) => { try { t.close(); } catch { /* already closed */ } });
  room.peers.delete(userId);
  io.to(projectId).emit(SOCKET_EVENTS.SFU_PEER_LEFT, { peerId: userId });

  // Last one out closes the router so the worker reclaims its resources.
  if (room.peers.size === 0) {
    try { room.router.close(); } catch { /* noop */ }
    rooms.delete(projectId);
  }
}

/**
 * Register SFU signaling handlers on a connected socket. `getContext` reads the
 * live { projectId, userId } from socket.data (set by the gateway on JOIN), so
 * handlers always act on the room the socket is currently in.
 */
export function registerSfuHandlers(
  io: Server,
  socket: Socket,
  getContext: () => { projectId?: string; userId: string }
) {
  // Wrap an async ack handler so a thrown error returns { error } instead of
  // hanging the client's pending request forever.
  const ack = (fn: (data: any) => Promise<any>) => async (data: any, cb?: (r: any) => void) => {
    try { const r = await fn(data ?? {}); cb?.(r ?? {}); }
    catch (e) { console.error("[sfu] handler error:", (e as Error).message); cb?.({ error: (e as Error).message }); }
  };

  const requireRoom = async () => {
    const { projectId, userId } = getContext();
    if (!projectId) throw new Error("Not in a project room");
    const room = await getRoom(projectId);
    return { room, projectId, userId };
  };

  const requirePeer = (room: Room, userId: string): Peer => {
    let peer = room.peers.get(userId);
    if (!peer) {
      peer = { socketId: socket.id, userId, transports: new Map(), producers: new Map(), consumers: new Map() };
      room.peers.set(userId, peer);
    }
    peer.socketId = socket.id; // survive reconnects within the same call
    return peer;
  };

  socket.on(SOCKET_EVENTS.SFU_RTP_CAPS, ack(async () => {
    const { room } = await requireRoom();
    return { rtpCapabilities: room.router.rtpCapabilities };
  }));

  socket.on(SOCKET_EVENTS.SFU_CREATE_TRANSPORT, ack(async ({ direction }) => {
    const { room, userId } = await requireRoom();
    const peer = requirePeer(room, userId);
    const transport = await createTransport(room);
    peer.transports.set(transport.id, transport);
    transport.on("dtlsstatechange", (s) => { if (s === "closed") transport.close(); });
    return { direction, ...transportParams(transport) };
  }));

  socket.on(SOCKET_EVENTS.SFU_CONNECT_TRANSPORT, ack(async ({ transportId, dtlsParameters }) => {
    const { room, userId } = await requireRoom();
    const peer = requirePeer(room, userId);
    const transport = peer.transports.get(transportId);
    if (!transport) throw new Error("Unknown transport");
    await transport.connect({ dtlsParameters });
    return { connected: true };
  }));

  socket.on(SOCKET_EVENTS.SFU_PRODUCE, ack(async ({ transportId, kind, rtpParameters, appData }) => {
    const { room, projectId, userId } = await requireRoom();
    const peer = requirePeer(room, userId);
    const transport = peer.transports.get(transportId);
    if (!transport) throw new Error("Unknown transport");
    const producer = await transport.produce({ kind, rtpParameters, appData: { ...appData, peerId: userId } });
    peer.producers.set(producer.id, producer);
    producer.on("transportclose", () => { peer.producers.delete(producer.id); });
    // Tell everyone else in the room to consume this new stream.
    socket.to(projectId).emit(SOCKET_EVENTS.SFU_NEW_PRODUCER, {
      producerId: producer.id, peerId: userId, kind: producer.kind,
    });
    return { id: producer.id };
  }));

  socket.on(SOCKET_EVENTS.SFU_CONSUME, ack(async ({ transportId, producerId, rtpCapabilities }) => {
    const { room, userId } = await requireRoom();
    const peer = requirePeer(room, userId);
    if (!room.router.canConsume({ producerId, rtpCapabilities })) throw new Error("Cannot consume");
    const transport = peer.transports.get(transportId);
    if (!transport) throw new Error("Unknown recv transport");
    // Start paused; the client resumes once the consumer track is wired up.
    const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
    peer.consumers.set(consumer.id, consumer);
    consumer.on("transportclose", () => { peer.consumers.delete(consumer.id); });
    consumer.on("producerclose", () => {
      peer.consumers.delete(consumer.id);
      socket.emit(SOCKET_EVENTS.SFU_PRODUCER_CLOSED, { producerId, peerId: (consumer.appData as any).peerId });
    });
    return {
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      peerId: (consumer.appData as any).peerId ?? null,
    };
  }));

  socket.on(SOCKET_EVENTS.SFU_RESUME_CONSUMER, ack(async ({ consumerId }) => {
    const { room, userId } = await requireRoom();
    const peer = requirePeer(room, userId);
    await peer.consumers.get(consumerId)?.resume();
    return { resumed: true };
  }));

  // Join the media room: returns every producer already live so the newcomer
  // can consume the peers who were here first.
  socket.on(SOCKET_EVENTS.SFU_JOIN, ack(async () => {
    const { room, userId } = await requireRoom();
    requirePeer(room, userId);
    const producers: { producerId: string; peerId: string; kind: string }[] = [];
    for (const [pid, other] of room.peers) {
      if (pid === userId) continue;
      for (const producer of other.producers.values()) {
        producers.push({ producerId: producer.id, peerId: pid, kind: producer.kind });
      }
    }
    return { producers };
  }));

  socket.on(SOCKET_EVENTS.SFU_LEAVE, () => {
    const { projectId, userId } = getContext();
    if (!projectId) return;
    const room = rooms.get(projectId);
    if (room) closePeer(room, projectId, userId, io);
  });

  // On socket drop, release this peer's media in whatever room it was in.
  socket.on("disconnect", () => {
    const { projectId, userId } = getContext();
    if (!projectId) return;
    const room = rooms.get(projectId);
    if (room) closePeer(room, projectId, userId, io);
  });
}
