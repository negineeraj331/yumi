/**
 * Client-side call recorder, shared by both call modes (mesh + SFU). Composites
 * every participant tile onto a canvas and mixes all audio via WebAudio, then
 * captures the result with MediaRecorder. Media never leaves the browser —
 * stopping downloads a .webm. Records the streams present when recording began.
 */
export interface CallRecorderHandle {
  stop: () => void;
}

export function startCallRecording(streams: MediaStream[]): CallRecorderHandle {
  if (typeof MediaRecorder === "undefined")
    throw new Error("Recording isn't supported in this browser.");

  // Hidden <video> per stream so we can draw frames to a canvas.
  const videos = streams.map((s) => {
    const v = document.createElement("video");
    v.srcObject = s; v.muted = true; v.autoplay = true; v.playsInline = true;
    v.play().catch(() => {});
    return v;
  });

  const canvas = document.createElement("canvas");
  canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext("2d")!;
  let raf = 0;

  const drawFrame = () => {
    const n = Math.max(1, videos.length);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const cw = canvas.width / cols, ch = canvas.height / rows;
    ctx.fillStyle = "#1A160F"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    videos.forEach((v, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      if (v.videoWidth) {
        const scale = Math.max(cw / v.videoWidth, ch / v.videoHeight);
        const dw = v.videoWidth * scale, dh = v.videoHeight * scale;
        ctx.drawImage(v, col * cw + (cw - dw) / 2, row * ch + (ch - dh) / 2, dw, dh);
      }
    });
    raf = requestAnimationFrame(drawFrame);
  };
  drawFrame();

  // Mix audio from every stream that carries an audio track.
  const AC: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
  const ac = new AC();
  const dest = ac.createMediaStreamDestination();
  for (const s of streams) {
    if (s.getAudioTracks().length) {
      try { ac.createMediaStreamSource(s).connect(dest); } catch { /* already connected */ }
    }
  }

  const canvasStream = canvas.captureStream(25);
  const mixed = new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);

  const mime = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"]
    .find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";
  const rec = new MediaRecorder(mixed, { mimeType: mime });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `yumi-call-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  };
  rec.start(1000);

  return {
    stop() {
      if (rec.state !== "inactive") rec.stop();
      if (raf) cancelAnimationFrame(raf);
      ac.close().catch(() => {});
      videos.forEach((v) => { v.srcObject = null; });
    },
  };
}
