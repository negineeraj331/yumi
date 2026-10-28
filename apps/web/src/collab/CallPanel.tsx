import { useEffect, useRef } from "react";
import type { RemotePeer } from "./useWebRTC";

function Video({ stream, muted, label, color, audioOnly }: { stream: MediaStream; muted?: boolean; label: string; color?: string; audioOnly?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div className="video-tile">
      <video ref={ref} autoPlay playsInline muted={muted} />
      <span className="video-label" style={{ borderColor: color }}>{label}</span>
      {audioOnly && <span className="video-badge" title="Weak connection — switched to audio-only">🔊 audio-only</span>}
    </div>
  );
}

interface Props {
  inCall: boolean;
  localStream: MediaStream | null;
  remotePeers: RemotePeer[];
  peerNames: Record<string, { name: string; color: string }>;
  micOn: boolean; camOn: boolean; sharing: boolean; recording: boolean;
  degradedPeers: string[];
  onJoin: () => void; onLeave: () => void;
  onToggleMic: () => void; onToggleCam: () => void; onShare: () => void;
  onToggleRecord: () => void;
}

export function CallPanel({
  inCall, localStream, remotePeers, peerNames, degradedPeers,
  micOn, camOn, sharing, recording, onJoin, onLeave, onToggleMic, onToggleCam, onShare, onToggleRecord,
}: Props) {
  if (!inCall) {
    return (
      <div className="call-idle">
        <button className="btn btn-primary btn-sm" onClick={onJoin}>📹 Start / join call</button>
      </div>
    );
  }
  return (
    <div className="call-panel">
      <div className="video-grid">
        {localStream && <Video stream={localStream} muted label="You" />}
        {remotePeers.map((p) => (
          <Video key={p.userId} stream={p.stream}
            label={peerNames[p.userId]?.name ?? "Peer"} color={peerNames[p.userId]?.color}
            audioOnly={degradedPeers.includes(p.userId)} />
        ))}
      </div>
      <div className="call-controls">
        <button className={`ctool ${!micOn ? "off" : ""}`} onClick={onToggleMic} title="Mute/unmute">{micOn ? "🎤" : "🔇"}</button>
        <button className={`ctool ${!camOn ? "off" : ""}`} onClick={onToggleCam} title="Camera on/off">{camOn ? "📷" : "🚫"}</button>
        <button className={`ctool ${sharing ? "active" : ""}`} onClick={onShare} title="Share screen">🖥️</button>
        <button className={`ctool ${recording ? "rec" : ""}`} onClick={onToggleRecord}
          title={recording ? "Stop recording (downloads .webm)" : "Record call"}>{recording ? "⏺ REC" : "⏺"}</button>
        <button className="btn btn-sm" style={{ background: "var(--error)", color: "#fff" }} onClick={onLeave}>Leave</button>
      </div>
    </div>
  );
}
