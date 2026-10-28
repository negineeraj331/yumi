/**
 * useWebRTC — P2P mesh video/audio over the Yumi signaling relay (rtc:signal).
 * Glare-free: the peer with the smaller userId always creates the offer.
 * Media never touches the server (PRD §5.3). Mesh is for ≤4 peers; SFU is Phase 2.
 *
 * Connection fallback ladder (per peer):
 *   1. Direct/STUN — and relay via TURN automatically when NAT blocks a direct path.
 *   2. On `failed`: an ICE restart to recover from a transient network change.
 *   3. Still failing: drop that peer's outbound video (audio-only) to cut the
 *      bandwidth/NAT burden, then ICE-restart again.
 *   4. Still failing: give up on that peer and remove them.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { SOCKET_EVENTS } from "@yumi/shared";
import { startCallRecording, type CallRecorderHandle } from "./callRecorder";

// STUN always; TURN (relay) added when configured, so calls survive symmetric
// NAT / restrictive firewalls where a direct P2P path can't be established.
function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  const turnUrls = (import.meta.env.VITE_TURN_URLS as string | undefined)?.trim();
  if (turnUrls) {
    servers.push({
      urls: turnUrls.split(",").map((u) => u.trim()).filter(Boolean),
      username: import.meta.env.VITE_TURN_USERNAME as string | undefined,
      credential: import.meta.env.VITE_TURN_CREDENTIAL as string | undefined,
    });
  }
  return servers;
}
const ICE: RTCConfiguration = { iceServers: buildIceServers() };

export interface RemotePeer { userId: string; stream: MediaStream }

export function useWebRTC(socket: Socket | null, myUserId: string) {
  const [inCall, setInCall] = useState(false);
  const [remotePeers, setRemotePeers] = useState<RemotePeer[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [sharing, setSharing] = useState(false);

  const [recording, setRecording] = useState(false);
  // Peers the ladder has dropped to audio-only after repeated connection failures.
  const [degradedPeers, setDegradedPeers] = useState<string[]>([]);

  const localStream = useRef<MediaStream | null>(null);
  const pcs = useRef<Map<string, RTCPeerConnection>>(new Map());
  const camTrack = useRef<MediaStreamTrack | null>(null);
  // Per-peer count of consecutive connection failures (drives the fallback ladder).
  const failures = useRef<Map<string, number>>(new Map());

  // Live mirror of remote peers so recording can snapshot current streams.
  const remotePeersRef = useRef<RemotePeer[]>([]);
  useEffect(() => { remotePeersRef.current = remotePeers; }, [remotePeers]);

  // Recording plumbing (shared recorder captures streams present at start).
  const recorder = useRef<CallRecorderHandle | null>(null);

  const setRemote = (userId: string, stream: MediaStream) =>
    setRemotePeers((prev) => {
      const others = prev.filter((p) => p.userId !== userId);
      return [...others, { userId, stream }];
    });

  const removeRemote = (userId: string) => {
    setRemotePeers((prev) => prev.filter((p) => p.userId !== userId));
    setDegradedPeers((prev) => prev.filter((id) => id !== userId));
    failures.current.delete(userId);
  };

  // Rung 2/3: renegotiate with an ICE restart. Smaller-id side drives the new
  // offer so the two peers never both offer at once (glare-free, same rule as call()).
  const restartConnection = useCallback(
    async (peerId: string) => {
      const pc = pcs.current.get(peerId);
      if (!pc || pc.signalingState === "closed") return;
      try { pc.restartIce?.(); } catch { /* older browsers: the fresh offer below still restarts ICE */ }
      if (myUserId < peerId) {
        try {
          const offer = await pc.createOffer({ iceRestart: true });
          await pc.setLocalDescription(offer);
          socket?.emit(SOCKET_EVENTS.RTC_SIGNAL, { kind: "offer", to: peerId, description: offer });
        } catch { /* connection torn down mid-restart */ }
      }
    },
    [socket, myUserId]
  );

  // Rung 3: stop sending video to this peer (audio survives on far less bandwidth).
  const degradeToAudio = useCallback((peerId: string) => {
    const pc = pcs.current.get(peerId);
    if (!pc) return;
    pc.getSenders().filter((s) => s.track?.kind === "video").forEach((s) => s.replaceTrack(null).catch(() => {}));
    setDegradedPeers((prev) => (prev.includes(peerId) ? prev : [...prev, peerId]));
  }, []);

  const handleFailure = useCallback(
    (peerId: string) => {
      const n = (failures.current.get(peerId) ?? 0) + 1;
      failures.current.set(peerId, n);
      if (n === 1) {
        restartConnection(peerId);
      } else if (n === 2) {
        degradeToAudio(peerId);
        restartConnection(peerId);
      } else {
        pcs.current.get(peerId)?.close();
        pcs.current.delete(peerId);
        removeRemote(peerId);
      }
    },
    [restartConnection, degradeToAudio]
  );

  const makePc = useCallback(
    (peerId: string) => {
      const existing = pcs.current.get(peerId);
      if (existing) return existing;
      const pc = new RTCPeerConnection(ICE);
      localStream.current?.getTracks().forEach((t) => pc.addTrack(t, localStream.current!));
      pc.onicecandidate = (e) => {
        if (e.candidate)
          socket?.emit(SOCKET_EVENTS.RTC_SIGNAL, { kind: "ice", to: peerId, candidate: e.candidate });
      };
      pc.ontrack = (e) => setRemote(peerId, e.streams[0]);
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === "connected") failures.current.set(peerId, 0); // recovered — reset the ladder
        else if (st === "failed") handleFailure(peerId);
        else if (st === "closed") removeRemote(peerId);
        // "disconnected" is usually transient; let ICE self-heal before the ladder acts.
      };
      pcs.current.set(peerId, pc);
      return pc;
    },
    [socket, handleFailure]
  );

  const call = useCallback(
    async (peerId: string) => {
      const pc = makePc(peerId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket?.emit(SOCKET_EVENTS.RTC_SIGNAL, { kind: "offer", to: peerId, description: offer });
    },
    [makePc, socket]
  );

  // Signaling handler
  useEffect(() => {
    if (!socket) return;
    const onSignal = async (msg: any) => {
      const from = msg.from as string;
      if (!from || from === myUserId) return;
      if (msg.to && msg.to !== myUserId) return;
      if (!inCall && msg.kind !== "join") return;

      if (msg.kind === "join") {
        // A newcomer announced themselves. Tell them we're here, then the
        // smaller-id side initiates the offer.
        socket.emit(SOCKET_EVENTS.RTC_SIGNAL, { kind: "ack", to: from });
        if (myUserId < from) call(from);
      } else if (msg.kind === "ack") {
        if (myUserId < from) call(from);
      } else if (msg.kind === "offer") {
        const pc = makePc(from);
        await pc.setRemoteDescription(new RTCSessionDescription(msg.description));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit(SOCKET_EVENTS.RTC_SIGNAL, { kind: "answer", to: from, description: answer });
      } else if (msg.kind === "answer") {
        await pcs.current.get(from)?.setRemoteDescription(new RTCSessionDescription(msg.description));
      } else if (msg.kind === "ice") {
        try { await pcs.current.get(from)?.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
      } else if (msg.kind === "leave") {
        pcs.current.get(from)?.close();
        pcs.current.delete(from);
        removeRemote(from);
      }
    };
    socket.on(SOCKET_EVENTS.RTC_SIGNAL, onSignal);
    return () => { socket.off(SOCKET_EVENTS.RTC_SIGNAL, onSignal); };
  }, [socket, myUserId, inCall, call, makePc]);

  const joinCall = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStream.current = stream;
      camTrack.current = stream.getVideoTracks()[0] ?? null;
      setInCall(true);
      setMicOn(true); setCamOn(true);
      socket?.emit(SOCKET_EVENTS.RTC_SIGNAL, { kind: "join" });
    } catch (err) {
      throw new Error("Could not access camera/microphone. Check browser permissions.");
    }
  }, [socket]);

  const leaveCall = useCallback(() => {
    if (recorder.current) stopRecording();
    socket?.emit(SOCKET_EVENTS.RTC_SIGNAL, { kind: "leave" });
    pcs.current.forEach((pc) => pc.close());
    pcs.current.clear();
    failures.current.clear();
    localStream.current?.getTracks().forEach((t) => t.stop());
    localStream.current = null;
    setRemotePeers([]);
    setDegradedPeers([]);
    setInCall(false);
    setSharing(false);
  }, [socket]);

  const toggleMic = useCallback(() => {
    const t = localStream.current?.getAudioTracks()[0];
    if (t) { t.enabled = !t.enabled; setMicOn(t.enabled); }
  }, []);

  const toggleCam = useCallback(() => {
    const t = localStream.current?.getVideoTracks()[0];
    if (t) { t.enabled = !t.enabled; setCamOn(t.enabled); }
  }, []);

  const replaceVideoTrack = (track: MediaStreamTrack) => {
    pcs.current.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      sender?.replaceTrack(track);
    });
  };

  const shareScreen = useCallback(async () => {
    if (sharing) {
      if (camTrack.current) { replaceVideoTrack(camTrack.current); }
      setSharing(false);
      return;
    }
    try {
      const disp = await (navigator.mediaDevices as any).getDisplayMedia({ video: true });
      const screenTrack: MediaStreamTrack = disp.getVideoTracks()[0];
      replaceVideoTrack(screenTrack);
      setSharing(true);
      screenTrack.onended = () => { if (camTrack.current) replaceVideoTrack(camTrack.current); setSharing(false); };
    } catch { /* user cancelled */ }
  }, [sharing]);

  // Record the call locally (participants present at start; media stays local).
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

  // Clean up on unmount
  useEffect(() => () => { stopRecording(); leaveCall(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    inCall, remotePeers, micOn, camOn, sharing, recording, degradedPeers,
    localStream: localStream.current,
    joinCall, leaveCall, toggleMic, toggleCam, shareScreen,
    startRecording, stopRecording,
  };
}
