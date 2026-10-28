/**
 * useSfu — call transport backed by the mediasoup SFU (the scaling path for
 * 5–50 participants). Each client uploads its mic/cam once to the server and
 * consumes every other peer's forwarded streams, so upload cost stays flat as
 * the room grows (unlike the P2P mesh, which is O(n) uploads per peer).
 *
 * Returns the SAME shape as useWebRTC so SessionPage/CallPanel can use either
 * interchangeably based on the server-advertised call mode.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { Device, type types as mc } from "mediasoup-client";
import { SOCKET_EVENTS } from "@yumi/shared";
import { startCallRecording, type CallRecorderHandle } from "./callRecorder";

export interface RemotePeer { userId: string; stream: MediaStream }

// Socket.io ack call as a promise; server returns { error } on failure.
function request<T = any>(socket: Socket, event: string, data?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.emit(event, data ?? {}, (res: any) => {
      if (res && res.error) reject(new Error(res.error));
      else resolve(res as T);
    });
  });
}

export function useSfu(socket: Socket | null, _myUserId: string) {
  const [inCall, setInCall] = useState(false);
  const [remotePeers, setRemotePeers] = useState<RemotePeer[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [recording, setRecording] = useState(false);

  const localStream = useRef<MediaStream | null>(null);
  const camTrack = useRef<MediaStreamTrack | null>(null);
  const device = useRef<Device | null>(null);
  const sendTransport = useRef<mc.Transport | null>(null);
  const recvTransport = useRef<mc.Transport | null>(null);
  const audioProducer = useRef<mc.Producer | null>(null);
  const videoProducer = useRef<mc.Producer | null>(null);

  // Consumed remote media, indexed for teardown.
  const consumers = useRef<Map<string, mc.Consumer>>(new Map());   // consumerId → consumer
  const byProducer = useRef<Map<string, string>>(new Map());        // producerId → consumerId
  const consuming = useRef<Set<string>>(new Set());                 // producerIds in-flight/consumed (dedupe)
  const peerStreams = useRef<Map<string, MediaStream>>(new Map());  // peerId → combined stream

  const recorder = useRef<CallRecorderHandle | null>(null);
  const remotePeersRef = useRef<RemotePeer[]>([]);
  useEffect(() => { remotePeersRef.current = remotePeers; }, [remotePeers]);

  const publishPeers = () =>
    setRemotePeers([...peerStreams.current.entries()].map(([userId, stream]) => ({ userId, stream })));

  // Consume one remote producer and wire its track into that peer's stream.
  const consume = useCallback(async (producerId: string, peerId: string) => {
    if (!socket || !recvTransport.current || !device.current) return;
    if (consuming.current.has(producerId)) return; // already handled (snapshot + event overlap)
    consuming.current.add(producerId);
    try {
      const params = await request<any>(socket, SOCKET_EVENTS.SFU_CONSUME, {
        transportId: recvTransport.current.id,
        producerId,
        rtpCapabilities: device.current.rtpCapabilities,
      });
      const consumer = await recvTransport.current.consume({
        id: params.id, producerId: params.producerId, kind: params.kind, rtpParameters: params.rtpParameters,
      });
      consumers.current.set(consumer.id, consumer);
      byProducer.current.set(producerId, consumer.id);

      const owner = params.peerId ?? peerId;
      let stream = peerStreams.current.get(owner);
      if (!stream) { stream = new MediaStream(); peerStreams.current.set(owner, stream); }
      stream.addTrack(consumer.track);
      publishPeers();

      await request(socket, SOCKET_EVENTS.SFU_RESUME_CONSUMER, { consumerId: consumer.id });
    } catch (e) {
      consuming.current.delete(producerId);
      console.error("[sfu] consume failed:", (e as Error).message);
    }
  }, [socket]);

  // A producer went away: drop its track; remove the peer tile if it's now empty.
  const onProducerClosed = useCallback((producerId: string, peerId: string) => {
    const consumerId = byProducer.current.get(producerId);
    if (consumerId) {
      const consumer = consumers.current.get(consumerId);
      const stream = peerStreams.current.get(peerId);
      if (consumer && stream) { try { stream.removeTrack(consumer.track); } catch {} }
      consumer?.close();
      consumers.current.delete(consumerId);
      byProducer.current.delete(producerId);
    }
    consuming.current.delete(producerId);
    const stream = peerStreams.current.get(peerId);
    if (stream && stream.getTracks().length === 0) peerStreams.current.delete(peerId);
    publishPeers();
  }, []);

  const removePeer = useCallback((peerId: string) => {
    const stream = peerStreams.current.get(peerId);
    stream?.getTracks().forEach((t) => t.stop());
    peerStreams.current.delete(peerId);
    // Drop any consumers/state tied to this peer.
    for (const [pid, cid] of byProducer.current) {
      const c = consumers.current.get(cid);
      if (c && (c.appData as any)?.peerId === peerId) { c.close(); consumers.current.delete(cid); byProducer.current.delete(pid); consuming.current.delete(pid); }
    }
    publishPeers();
  }, []);

  // Server → client notifications.
  useEffect(() => {
    if (!socket) return;
    const onNew = ({ producerId, peerId }: { producerId: string; peerId: string }) => { if (inCall) consume(producerId, peerId); };
    const onClosed = ({ producerId, peerId }: { producerId: string; peerId: string }) => onProducerClosed(producerId, peerId);
    const onLeft = ({ peerId }: { peerId: string }) => removePeer(peerId);
    socket.on(SOCKET_EVENTS.SFU_NEW_PRODUCER, onNew);
    socket.on(SOCKET_EVENTS.SFU_PRODUCER_CLOSED, onClosed);
    socket.on(SOCKET_EVENTS.SFU_PEER_LEFT, onLeft);
    return () => {
      socket.off(SOCKET_EVENTS.SFU_NEW_PRODUCER, onNew);
      socket.off(SOCKET_EVENTS.SFU_PRODUCER_CLOSED, onClosed);
      socket.off(SOCKET_EVENTS.SFU_PEER_LEFT, onLeft);
    };
  }, [socket, inCall, consume, onProducerClosed, removePeer]);

  const joinCall = useCallback(async () => {
    if (!socket || inCall) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch {
      throw new Error("Could not access camera/microphone. Check browser permissions.");
    }
    localStream.current = stream;
    camTrack.current = stream.getVideoTracks()[0] ?? null;

    try {
      // 1. Load a Device with the router's capabilities.
      const { rtpCapabilities } = await request<any>(socket, SOCKET_EVENTS.SFU_RTP_CAPS);
      const dev = new Device();
      await dev.load({ routerRtpCapabilities: rtpCapabilities });
      device.current = dev;

      // 2. Send transport — connect + produce handlers proxy to the server.
      const sendParams = await request<any>(socket, SOCKET_EVENTS.SFU_CREATE_TRANSPORT, { direction: "send" });
      const send = dev.createSendTransport(sendParams);
      send.on("connect", ({ dtlsParameters }, cb, errb) => {
        request(socket, SOCKET_EVENTS.SFU_CONNECT_TRANSPORT, { transportId: send.id, dtlsParameters }).then(() => cb()).catch(errb);
      });
      send.on("produce", ({ kind, rtpParameters, appData }, cb, errb) => {
        request<any>(socket, SOCKET_EVENTS.SFU_PRODUCE, { transportId: send.id, kind, rtpParameters, appData })
          .then(({ id }) => cb({ id })).catch(errb);
      });
      sendTransport.current = send;

      // 3. Recv transport — connect handler only (we never produce on it).
      const recvParams = await request<any>(socket, SOCKET_EVENTS.SFU_CREATE_TRANSPORT, { direction: "recv" });
      const recv = dev.createRecvTransport(recvParams);
      recv.on("connect", ({ dtlsParameters }, cb, errb) => {
        request(socket, SOCKET_EVENTS.SFU_CONNECT_TRANSPORT, { transportId: recv.id, dtlsParameters }).then(() => cb()).catch(errb);
      });
      recvTransport.current = recv;

      setInCall(true);
      setMicOn(true); setCamOn(true);

      // 4. Produce our own tracks.
      const audio = stream.getAudioTracks()[0];
      const video = stream.getVideoTracks()[0];
      if (audio) audioProducer.current = await send.produce({ track: audio, appData: { source: "mic" } });
      if (video) videoProducer.current = await send.produce({ track: video, appData: { source: "cam" } });

      // 5. Join the media room and consume everyone already producing.
      const { producers } = await request<any>(socket, SOCKET_EVENTS.SFU_JOIN);
      for (const p of producers as { producerId: string; peerId: string }[]) await consume(p.producerId, p.peerId);
    } catch (e) {
      // Roll back a partial join so a retry starts clean.
      stream.getTracks().forEach((t) => t.stop());
      localStream.current = null;
      setInCall(false);
      throw new Error(`Could not join SFU call: ${(e as Error).message}`);
    }
  }, [socket, inCall, consume]);

  const leaveCall = useCallback(() => {
    if (recorder.current) { recorder.current.stop(); recorder.current = null; setRecording(false); }
    socket?.emit(SOCKET_EVENTS.SFU_LEAVE);
    consumers.current.forEach((c) => { try { c.close(); } catch {} });
    consumers.current.clear();
    byProducer.current.clear();
    consuming.current.clear();
    peerStreams.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    peerStreams.current.clear();
    try { sendTransport.current?.close(); } catch {}
    try { recvTransport.current?.close(); } catch {}
    sendTransport.current = null; recvTransport.current = null;
    audioProducer.current = null; videoProducer.current = null;
    device.current = null;
    localStream.current?.getTracks().forEach((t) => t.stop());
    localStream.current = null;
    camTrack.current = null;
    setRemotePeers([]);
    setInCall(false);
    setSharing(false);
  }, [socket]);

  const toggleMic = useCallback(() => {
    const p = audioProducer.current;
    const t = localStream.current?.getAudioTracks()[0];
    if (!p || !t) return;
    if (p.paused) { p.resume(); t.enabled = true; setMicOn(true); }
    else { p.pause(); t.enabled = false; setMicOn(false); }
  }, []);

  const toggleCam = useCallback(() => {
    const p = videoProducer.current;
    const t = localStream.current?.getVideoTracks()[0];
    if (!p || !t) return;
    if (p.paused) { p.resume(); t.enabled = true; setCamOn(true); }
    else { p.pause(); t.enabled = false; setCamOn(false); }
  }, []);

  const shareScreen = useCallback(async () => {
    const vp = videoProducer.current;
    if (!vp) return;
    if (sharing) {
      if (camTrack.current) await vp.replaceTrack({ track: camTrack.current });
      setSharing(false);
      return;
    }
    try {
      const disp = await (navigator.mediaDevices as any).getDisplayMedia({ video: true });
      const screenTrack: MediaStreamTrack = disp.getVideoTracks()[0];
      await vp.replaceTrack({ track: screenTrack });
      setSharing(true);
      screenTrack.onended = async () => { if (camTrack.current) await vp.replaceTrack({ track: camTrack.current }); setSharing(false); };
    } catch { /* user cancelled the picker */ }
  }, [sharing]);

  const startRecording = useCallback(async () => {
    if (recorder.current || !localStream.current) return;
    const streams: MediaStream[] = [localStream.current, ...remotePeersRef.current.map((p) => p.stream)];
    recorder.current = startCallRecording(streams);
    setRecording(true);
  }, []);

  const stopRecording = useCallback(() => {
    recorder.current?.stop();
    recorder.current = null;
    setRecording(false);
  }, []);

  // Clean up on unmount.
  useEffect(() => () => { if (inCall) leaveCall(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    inCall, remotePeers, micOn, camOn, sharing, recording,
    degradedPeers: [] as string[], // SFU has no per-peer audio-only ladder; kept for shape parity
    localStream: localStream.current,
    joinCall, leaveCall, toggleMic, toggleCam, shareScreen,
    startRecording, stopRecording,
  };
}
