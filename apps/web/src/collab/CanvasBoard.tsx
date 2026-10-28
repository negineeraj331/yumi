/**
 * CanvasBoard — multi-user drawing surface backed by a Yjs doc via YumiProvider.
 * Shapes: pen, highlight, line, arrow, rect, ellipse, text, sticky note, image,
 * plus a select/move tool. Strokes can be dashed. Cursors ride awareness. See PRD CV-*.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import * as Y from "yjs";
import type { Socket } from "socket.io-client";
import type { PublicUser } from "@yumi/shared";
import { YumiProvider } from "./YumiProvider";

type Tool = "select" | "pen" | "highlight" | "rect" | "ellipse" | "line" | "arrow" | "text" | "note" | "eraser" | "pan";

interface Props {
  socket: Socket; docId: string; user: PublicUser; editable: boolean;
  /** Set by the board so callers (e.g. the Figma modal) can drop an image onto it. */
  insertImageRef?: React.MutableRefObject<((dataUrl: string) => Promise<void>) | null>;
  /** Present when the project is end-to-end encrypted; payloads are sealed with it. */
  cryptoKey?: CryptoKey | null;
}

const PALETTE = ["#1A1A1A", "#C4622D", "#2F5FE0", "#3C8C43", "#C6317E", "#C79A1E", "#0E8F82", "#FFFFFF"];

export function CanvasBoard({ socket, docId, user, editable, insertImageRef, cryptoKey = null }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const providerRef = useRef<YumiProvider | null>(null);
  const shapesRef = useRef<Y.Array<Y.Map<any>> | null>(null);
  const undoRef = useRef<Y.UndoManager | null>(null);
  const imgCache = useRef<Map<string, HTMLImageElement>>(new Map());

  const drawing = useRef(false);
  const current = useRef<Y.Map<any> | null>(null);
  const dragging = useRef(false);
  const dragLast = useRef<{ x: number; y: number } | null>(null);
  const view = useRef({ scale: 1, x: 0, y: 0 });
  const panStart = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(user.avatarColor || "#1A1A1A");
  const [size, setSize] = useState(3);
  const [fill, setFill] = useState(false);
  const [dash, setDash] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const toolRef = useRef(tool); toolRef.current = tool;
  const colorRef = useRef(color); colorRef.current = color;
  const sizeRef = useRef(size); sizeRef.current = size;
  const fillRef = useRef(fill); fillRef.current = fill;
  const dashRef = useRef(dash); dashRef.current = dash;
  const selRef = useRef<string | null>(null); selRef.current = selectedId;

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()));
  const screenToWorld = (px: number, py: number) => {
    const v = view.current;
    return { x: (px - v.x) / v.scale, y: (py - v.y) / v.scale };
  };

  const boundsOf = (s: Y.Map<any>): [number, number, number, number] => {
    const type = s.get("type");
    if (type === "pen" || type === "highlight") {
      const a = (s.get("pts") as Y.Array<number>).toArray();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < a.length; i += 2) { minX = Math.min(minX, a[i]); maxX = Math.max(maxX, a[i]); minY = Math.min(minY, a[i + 1]); maxY = Math.max(maxY, a[i + 1]); }
      return [minX, minY, maxX - minX, maxY - minY];
    }
    if (type === "text") return [s.get("x"), s.get("y") - 18, 220, 26];
    const x = s.get("x"), y = s.get("y"), w = s.get("w") ?? 0, h = s.get("h") ?? 0;
    return [Math.min(x, x + w), Math.min(y, y + h), Math.abs(w), Math.abs(h)];
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current, shapes = shapesRef.current;
    if (!canvas || !shapes) return;
    const ctx = canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    const v = view.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(v.scale * dpr, 0, 0, v.scale * dpr, v.x * dpr, v.y * dpr);

    for (const s of shapes.toArray()) {
      drawShape(ctx, s, imgCache.current, draw);

      // selection outline (screen only)
      if (s.get("id") === selRef.current) {
        const [bx, by, bw, bh] = boundsOf(s);
        ctx.globalAlpha = 1; ctx.strokeStyle = "#2F5FE0"; ctx.lineWidth = 1.5 / v.scale;
        ctx.setLineDash([6 / v.scale, 4 / v.scale]);
        ctx.strokeRect(bx - 4, by - 4, bw + 8, bh + 8);
        ctx.setLineDash([]);
      }
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    const states = providerRef.current?.awareness.getStates();
    if (states) for (const [, st] of states) {
      const c = (st as any).cursor, u = (st as any).user;
      if (!c || !u || u.name === user.displayName) continue;
      ctx.fillStyle = u.color;
      ctx.beginPath(); ctx.arc(c.x, c.y, 4 / v.scale, 0, Math.PI * 2); ctx.fill();
      ctx.font = `${12 / v.scale}px sans-serif`; ctx.fillText(u.name, c.x + 8 / v.scale, c.y + 4 / v.scale);
    }
  }, [user.displayName]);

  const resize = useCallback(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
    draw();
  }, [draw]);

  useEffect(() => {
    const provider = new YumiProvider(socket, docId, undefined, cryptoKey);
    providerRef.current = provider;
    const shapes = provider.doc.getArray<Y.Map<any>>("shapes");
    shapesRef.current = shapes;
    undoRef.current = new Y.UndoManager(shapes, { captureTimeout: 100000 });
    provider.awareness.setLocalStateField("user", { name: user.displayName, color: user.avatarColor });
    const onChange = () => draw();
    shapes.observeDeep(onChange);
    provider.awareness.on("update", onChange);
    resize();
    window.addEventListener("resize", resize);
    const raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      shapes.unobserveDeep(onChange);
      provider.awareness.off("update", onChange);
      provider.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  useEffect(() => { draw(); }, [selectedId, draw]);

  const eventPos = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { px: e.clientX - rect.left, py: e.clientY - rect.top };
  };

  const findShapeById = (id: string) => shapesRef.current!.toArray().find((s) => s.get("id") === id) ?? null;
  const topHit = (x: number, y: number) => {
    const shapes = shapesRef.current!;
    for (let i = shapes.length - 1; i >= 0; i--) if (hitTest(shapes.get(i), x, y)) return shapes.get(i);
    return null;
  };

  function moveShape(s: Y.Map<any>, dx: number, dy: number) {
    const type = s.get("type");
    if (type === "pen" || type === "highlight") {
      const pts = s.get("pts") as Y.Array<number>;
      const a = pts.toArray().map((n, i) => (i % 2 === 0 ? n + dx : n + dy));
      pts.delete(0, pts.length); pts.push(a);
    } else {
      s.set("x", s.get("x") + dx); s.set("y", s.get("y") + dy);
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    const { px, py } = eventPos(e);
    canvasRef.current!.setPointerCapture(e.pointerId);
    const t = toolRef.current;

    if (t === "pan" || e.button === 1) {
      panStart.current = { x: px, y: py, ox: view.current.x, oy: view.current.y };
      return;
    }
    const { x, y } = screenToWorld(px, py);

    if (t === "select") {
      const hit = topHit(x, y);
      setSelectedId(hit ? hit.get("id") : null);
      if (hit && editable) { dragging.current = true; dragLast.current = { x, y }; }
      return;
    }
    if (!editable) return;
    const shapes = shapesRef.current!;

    if (t === "eraser") { eraseAt(x, y); return; }
    if (t === "text") {
      const text = window.prompt("Text:");
      if (text) { const m = mkMap({ type: "text", x, y, text, color: colorRef.current, size: sizeRef.current }); shapes.push([m]); undoRef.current?.stopCapturing(); }
      return;
    }
    if (t === "note") {
      const text = window.prompt("Sticky note:") ?? "";
      const m = mkMap({ type: "note", x, y, w: 160, h: 120, text, color: "#FFE9A8", size: 1 });
      shapes.push([m]); undoRef.current?.stopCapturing();
      return;
    }

    drawing.current = true;
    if (t === "pen" || t === "highlight") {
      const pts = new Y.Array<number>(); pts.push([x, y]);
      const m = mkMap({ type: t, color: colorRef.current, size: sizeRef.current, dash: dashRef.current });
      m.set("pts", pts); shapes.push([m]); current.current = m;
    } else {
      const m = mkMap({ type: t, x, y, w: 0, h: 0, color: colorRef.current, size: sizeRef.current, fill: fillRef.current, dash: dashRef.current });
      shapes.push([m]); current.current = m;
    }
  }

  function mkMap(fields: Record<string, any>) {
    const m = new Y.Map<any>();
    m.set("id", uid());
    for (const [k, val] of Object.entries(fields)) m.set(k, val);
    return m;
  }

  function onPointerMove(e: React.PointerEvent) {
    const { px, py } = eventPos(e);
    if (panStart.current) {
      view.current.x = panStart.current.ox + (px - panStart.current.x);
      view.current.y = panStart.current.oy + (py - panStart.current.y);
      draw(); return;
    }
    const { x, y } = screenToWorld(px, py);
    providerRef.current?.awareness.setLocalStateField("cursor", { x, y });

    if (dragging.current && selRef.current && dragLast.current) {
      const s = findShapeById(selRef.current);
      if (s) { moveShape(s, x - dragLast.current.x, y - dragLast.current.y); dragLast.current = { x, y }; }
      return;
    }
    if (!drawing.current || !current.current) return;
    const m = current.current, type = m.get("type");
    if (type === "pen" || type === "highlight") (m.get("pts") as Y.Array<number>).push([x, y]);
    else if (type === "eraser") eraseAt(x, y);
    else { m.set("w", x - m.get("x")); m.set("h", y - m.get("y")); }
  }

  function onPointerUp(e: React.PointerEvent) {
    canvasRef.current?.releasePointerCapture(e.pointerId);
    panStart.current = null;
    if (dragging.current) { dragging.current = false; dragLast.current = null; undoRef.current?.stopCapturing(); }
    if (drawing.current) { drawing.current = false; current.current = null; undoRef.current?.stopCapturing(); }
  }

  function eraseAt(x: number, y: number) {
    const shapes = shapesRef.current!;
    for (let i = shapes.length - 1; i >= 0; i--) if (hitTest(shapes.get(i), x, y)) { shapes.delete(i, 1); break; }
  }

  function hitTest(s: Y.Map<any>, x: number, y: number): boolean {
    const [bx, by, bw, bh] = boundsOf(s);
    const tol = 8 / view.current.scale + (s.get("size") || 2);
    if (s.get("type") === "pen" || s.get("type") === "highlight") {
      const a = (s.get("pts") as Y.Array<number>).toArray();
      for (let i = 0; i < a.length; i += 2) if (Math.hypot(a[i] - x, a[i + 1] - y) < tol) return true;
      return false;
    }
    return x >= bx - tol && x <= bx + bw + tol && y >= by - tol && y <= by + bh + tol;
  }

  function onWheel(e: React.WheelEvent) {
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const before = screenToWorld(px, py);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    view.current.scale = Math.min(8, Math.max(0.15, view.current.scale * factor));
    const after = screenToWorld(px, py);
    view.current.x += (after.x - before.x) * view.current.scale;
    view.current.y += (after.y - before.y) * view.current.scale;
    draw();
  }

  /** Place an already-downscaled data URL as an image shape at the view centre. */
  const placeImage = useCallback((src: string) => new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const centerX = (-view.current.x + (canvasRef.current!.clientWidth / 2)) / view.current.scale;
      const centerY = (-view.current.y + (canvasRef.current!.clientHeight / 2)) / view.current.scale;
      const w = img.naturalWidth, h = img.naturalHeight;
      const m = mkMap({ type: "image", x: centerX - w / 2, y: centerY - h / 2, w, h, src, color: "#000", size: 1 });
      imgCache.current.set(src, img);
      shapesRef.current!.push([m]); undoRef.current?.stopCapturing();
      resolve();
    };
    img.onerror = () => resolve();
    img.src = src;
  }), []);

  async function onImagePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; e.target.value = "";
    if (!file || !editable) return;
    await placeImage(await downscale(file, 800));
  }

  // Expose an insert hook so a rendered Figma frame can be dropped on the board.
  useEffect(() => {
    if (!insertImageRef) return;
    insertImageRef.current = async (dataUrl: string) => {
      if (!editable || !shapesRef.current) return;
      await placeImage(await downscaleDataUrl(dataUrl, 800));
    };
    return () => { insertImageRef.current = null; };
  }, [insertImageRef, editable, placeImage]);

  function viewCenter() {
    const el = canvasRef.current!;
    return {
      x: (-view.current.x + el.clientWidth / 2) / view.current.scale,
      y: (-view.current.y + el.clientHeight / 2) / view.current.scale,
    };
  }

  function insertTemplate(name: string) {
    if (!name || !editable) return;
    const { x: bx, y: by } = viewCenter();
    const shapes = templateShapes(name, bx, by);
    const arr = shapesRef.current!;
    for (const s of shapes) {
      const pts = s.pts as number[] | undefined;
      const m = mkMap({ ...s, pts: undefined });
      if (pts) { const p = new Y.Array<number>(); p.push(pts); m.set("pts", p); }
      arr.push([m]);
    }
    undoRef.current?.stopCapturing();
  }

  function deleteSelected() {
    const id = selRef.current; if (!id) return;
    const shapes = shapesRef.current!;
    for (let i = 0; i < shapes.length; i++) if (shapes.get(i).get("id") === id) { shapes.delete(i, 1); break; }
    setSelectedId(null);
  }

  function clearAll() {
    if (!editable || !window.confirm("Clear the entire board? This cannot be undone.")) return;
    const shapes = shapesRef.current!; shapes.delete(0, shapes.length); setSelectedId(null);
  }

  function exportPng() {
    const url = canvasRef.current!.toDataURL("image/png");
    const a = document.createElement("a"); a.href = url; a.download = "yumi-canvas.png"; a.click();
  }

  // Deep-copy a shape's fields into a fresh Y.Map (a detached Y.Map/Y.Array
  // can't be re-inserted, so reordering requires a clone).
  function cloneShape(s: Y.Map<any>): Y.Map<any> {
    const m = new Y.Map<any>();
    s.forEach((v, k) => {
      if (v instanceof Y.Array) { const arr = new Y.Array<any>(); arr.push((v as Y.Array<any>).toArray()); m.set(k, arr); }
      else m.set(k, v);
    });
    return m;
  }

  // Layers: reorder the selected shape within the array (array order = z-order).
  function reorderSelected(dir: "front" | "back" | "forward" | "backward") {
    const id = selRef.current; if (!id || !editable) return;
    const shapes = shapesRef.current!;
    let idx = -1;
    for (let i = 0; i < shapes.length; i++) if (shapes.get(i).get("id") === id) { idx = i; break; }
    if (idx < 0) return;
    const n = shapes.length;
    let insertAt: number;
    if (dir === "front") insertAt = n - 1;              // append (top)
    else if (dir === "back") insertAt = 0;              // prepend (bottom)
    else if (dir === "forward") { if (idx >= n - 1) return; insertAt = idx + 1; }
    else { if (idx <= 0) return; insertAt = idx - 1; }   // backward
    const clone = cloneShape(shapes.get(idx));
    // One transaction → one undo step + one broadcast for the delete+insert.
    shapes.doc?.transact(() => { shapes.delete(idx, 1); shapes.insert(insertAt, [clone]); });
    undoRef.current?.stopCapturing();
  }

  // Export the WHOLE board (all shapes, fit-to-content) regardless of zoom/pan,
  // onto an offscreen canvas — unlike exportPng which captures only the viewport.
  function exportBoard() {
    const all = shapesRef.current!.toArray();
    if (all.length === 0) return exportPng();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of all) {
      const [x, y, w, h] = boundsOf(s);
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
    }
    const pad = 48;
    const W = Math.max(1, maxX - minX) + pad * 2, H = Math.max(1, maxY - minY) + pad * 2;
    const scale = Math.min(2, 4000 / Math.max(W, H)); // cap output resolution
    const off = document.createElement("canvas");
    off.width = Math.ceil(W * scale); off.height = Math.ceil(H * scale);
    const ctx = off.getContext("2d")!;
    ctx.fillStyle = "#FDFBF7"; ctx.fillRect(0, 0, off.width, off.height); // cream board bg
    ctx.setTransform(scale, 0, 0, scale, (-minX + pad) * scale, (-minY + pad) * scale);
    for (const s of all) drawShape(ctx, s, imgCache.current, () => {});
    const a = document.createElement("a");
    a.href = off.toDataURL("image/png"); a.download = "yumi-board.png"; a.click();
  }

  const tools: { id: Tool; label: string }[] = [
    { id: "select", label: "⬚" }, { id: "pen", label: "✏️" }, { id: "highlight", label: "🖊️" },
    { id: "line", label: "／" }, { id: "arrow", label: "↗" }, { id: "rect", label: "▭" }, { id: "ellipse", label: "◯" },
    { id: "text", label: "T" }, { id: "note", label: "🗒️" }, { id: "eraser", label: "⌫" }, { id: "pan", label: "✋" },
  ];

  return (
    <div className="canvas-wrap">
      <div className="canvas-toolbar">
        {tools.map((t) => (
          <button key={t.id} className={`ctool ${tool === t.id ? "active" : ""}`} title={t.id}
            onClick={() => setTool(t.id)} disabled={!editable && t.id !== "pan" && t.id !== "select"}>{t.label}</button>
        ))}
        <button className="ctool" title="Upload image" onClick={() => fileInputRef.current?.click()} disabled={!editable}>🖼️</button>
        <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onImagePick} />
        <select className="lang-select" title="Insert template" value="" disabled={!editable}
          onChange={(e) => { insertTemplate(e.target.value); e.target.value = ""; }}>
          <option value="">Template…</option>
          <option value="flowchart">Flowchart</option>
          <option value="wireframe">Wireframe</option>
          <option value="kanban">Kanban board</option>
          <option value="mindmap">Mind map</option>
        </select>
        <select className="lang-select" title="Insert stencil" value="" disabled={!editable}
          onChange={(e) => { insertTemplate(e.target.value); e.target.value = ""; }}>
          <option value="">Stencil…</option>
          <option value="s-process">Process box</option>
          <option value="s-terminator">Start / End</option>
          <option value="s-container">Container</option>
          <option value="s-swimlane">Swimlanes</option>
        </select>
        <span className="ctool-sep" />
        {PALETTE.map((c) => (
          <button key={c} className={`cswatch ${color === c ? "active" : ""}`} style={{ background: c }} onClick={() => setColor(c)} title={c} />
        ))}
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="cswatch-picker" title="Custom color" />
        <label className="ctool-check" title="Fill shapes"><input type="checkbox" checked={fill} onChange={(e) => setFill(e.target.checked)} /> fill</label>
        <label className="ctool-check" title="Dashed stroke"><input type="checkbox" checked={dash} onChange={(e) => setDash(e.target.checked)} /> dash</label>
        <span className="ctool-sep" />
        <input type="range" min={1} max={20} value={size} onChange={(e) => setSize(Number(e.target.value))} title="Brush size" />
        <span className="ctool-sep" />
        {selectedId && (
          <>
            <button className="ctool" title="Bring to front" onClick={() => reorderSelected("front")} disabled={!editable}>⤒</button>
            <button className="ctool" title="Bring forward" onClick={() => reorderSelected("forward")} disabled={!editable}>↑</button>
            <button className="ctool" title="Send backward" onClick={() => reorderSelected("backward")} disabled={!editable}>↓</button>
            <button className="ctool" title="Send to back" onClick={() => reorderSelected("back")} disabled={!editable}>⤓</button>
            <button className="ctool" title="Delete selected" onClick={deleteSelected} disabled={!editable}>🗑</button>
          </>
        )}
        <button className="ctool" title="Undo" onClick={() => undoRef.current?.undo()} disabled={!editable}>↶</button>
        <button className="ctool" title="Redo" onClick={() => undoRef.current?.redo()} disabled={!editable}>↷</button>
        <button className="ctool" title="Zoom 100%" onClick={() => { view.current = { scale: 1, x: 0, y: 0 }; draw(); }}>⤢</button>
        <button className="ctool" title="Clear board" onClick={clearAll} disabled={!editable}>🧹</button>
        <button className="ctool" title="Export current view (PNG)" onClick={exportPng}>⇩</button>
        <button className="ctool" title="Export full board (PNG)" onClick={exportBoard}>⧉</button>
      </div>
      <canvas
        ref={canvasRef} className="canvas-surface"
        style={{ cursor: tool === "pan" ? "grab" : tool === "select" ? "default" : "crosshair" }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={onPointerUp} onPointerLeave={onPointerUp} onWheel={onWheel}
      />
    </div>
  );
}

/** Draw one shape's body onto ctx (no selection chrome). Shared by the live
 *  canvas and full-board export so both render identically. */
function drawShape(
  ctx: CanvasRenderingContext2D,
  s: Y.Map<any>,
  imgCache: Map<string, HTMLImageElement>,
  onImageLoad: () => void
) {
  const type = s.get("type");
  ctx.strokeStyle = s.get("color"); ctx.fillStyle = s.get("color");
  ctx.lineWidth = s.get("size"); ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.globalAlpha = type === "highlight" ? 0.35 : 1;
  ctx.setLineDash(s.get("dash") ? [s.get("size") * 3 + 4, s.get("size") * 2 + 3] : []);

  if (type === "pen" || type === "highlight") {
    const a = (s.get("pts") as Y.Array<number>).toArray();
    if (type === "highlight") ctx.lineWidth = s.get("size") * 4;
    ctx.beginPath();
    for (let i = 0; i < a.length; i += 2) i === 0 ? ctx.moveTo(a[i], a[i + 1]) : ctx.lineTo(a[i], a[i + 1]);
    ctx.stroke();
  } else if (type === "rect") {
    if (s.get("fill")) ctx.fillRect(s.get("x"), s.get("y"), s.get("w"), s.get("h"));
    ctx.strokeRect(s.get("x"), s.get("y"), s.get("w"), s.get("h"));
  } else if (type === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(s.get("x") + s.get("w") / 2, s.get("y") + s.get("h") / 2, Math.abs(s.get("w") / 2), Math.abs(s.get("h") / 2), 0, 0, Math.PI * 2);
    if (s.get("fill")) ctx.fill();
    ctx.stroke();
  } else if (type === "line") {
    ctx.beginPath(); ctx.moveTo(s.get("x"), s.get("y")); ctx.lineTo(s.get("x") + s.get("w"), s.get("y") + s.get("h")); ctx.stroke();
  } else if (type === "arrow") {
    const x0 = s.get("x"), y0 = s.get("y"), x1 = x0 + s.get("w"), y1 = y0 + s.get("h");
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    // solid arrowhead at the end (unaffected by dash)
    const ang = Math.atan2(y1 - y0, x1 - x0), head = Math.max(10, s.get("size") * 3 + 6);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - head * Math.cos(ang - Math.PI / 7), y1 - head * Math.sin(ang - Math.PI / 7));
    ctx.lineTo(x1 - head * Math.cos(ang + Math.PI / 7), y1 - head * Math.sin(ang + Math.PI / 7));
    ctx.closePath(); ctx.fill();
  } else if (type === "text") {
    ctx.font = `${s.get("size") * 6 + 10}px sans-serif`; ctx.fillText(s.get("text"), s.get("x"), s.get("y"));
  } else if (type === "note") {
    ctx.fillStyle = s.get("color"); ctx.fillRect(s.get("x"), s.get("y"), s.get("w"), s.get("h"));
    ctx.fillStyle = "#1A1A1A"; ctx.font = "14px sans-serif";
    wrapText(ctx, s.get("text") ?? "", s.get("x") + 8, s.get("y") + 22, s.get("w") - 16, 18);
  } else if (type === "image") {
    const src = s.get("src");
    let img = imgCache.get(src);
    if (!img) { img = new Image(); img.onload = () => onImageLoad(); img.src = src; imgCache.set(src, img); }
    if (img.complete && img.naturalWidth) ctx.drawImage(img, s.get("x"), s.get("y"), s.get("w"), s.get("h"));
  }
}

const INK = "#1A1A1A", NOTE = "#FFE9A8", ACCENT = "#C4622D";

/** Returns a starter set of shape field-objects centered on (bx,by). */
function templateShapes(name: string, bx: number, by: number): Record<string, any>[] {
  if (name === "flowchart") {
    return [
      { type: "rect", x: bx - 60, y: by - 150, w: 120, h: 46, color: INK, size: 2 },
      { type: "text", x: bx - 26, y: by - 121, text: "Start", color: INK, size: 2 },
      { type: "line", x: bx, y: by - 104, w: 0, h: 34, color: INK, size: 2 },
      { type: "rect", x: bx - 70, y: by - 70, w: 140, h: 46, color: INK, size: 2 },
      { type: "text", x: bx - 40, y: by - 41, text: "Process", color: INK, size: 2 },
      { type: "line", x: bx, y: by - 24, w: 0, h: 34, color: INK, size: 2 },
      { type: "rect", x: bx - 70, y: by + 10, w: 140, h: 46, color: INK, size: 2 },
      { type: "text", x: bx - 44, y: by + 39, text: "Decision", color: INK, size: 2 },
      { type: "line", x: bx, y: by + 56, w: 0, h: 34, color: INK, size: 2 },
      { type: "rect", x: bx - 60, y: by + 90, w: 120, h: 46, color: INK, size: 2 },
      { type: "text", x: bx - 20, y: by + 119, text: "End", color: INK, size: 2 },
    ];
  }
  if (name === "wireframe") {
    return [
      { type: "rect", x: bx - 180, y: by - 130, w: 360, h: 260, color: INK, size: 2 },
      { type: "rect", x: bx - 180, y: by - 130, w: 360, h: 44, color: INK, size: 1 },
      { type: "text", x: bx - 170, y: by - 100, text: "Logo", color: INK, size: 1 },
      { type: "rect", x: bx - 180, y: by - 86, w: 90, h: 216, color: INK, size: 1 },
      { type: "text", x: bx - 172, y: by - 58, text: "Nav", color: INK, size: 1 },
      { type: "rect", x: bx - 80, y: by - 70, w: 250, h: 56, color: INK, size: 1 },
      { type: "rect", x: bx - 80, y: by - 4, w: 250, h: 56, color: INK, size: 1 },
      { type: "rect", x: bx - 80, y: by + 66, w: 250, h: 56, color: INK, size: 1 },
      { type: "text", x: bx - 72, y: by - 36, text: "Content", color: INK, size: 1 },
    ];
  }
  if (name === "kanban") {
    const out: Record<string, any>[] = [];
    ["To Do", "Doing", "Done"].forEach((c, i) => {
      const x = bx - 180 + i * 130;
      out.push({ type: "rect", x, y: by - 120, w: 110, h: 240, color: INK, size: 1 });
      out.push({ type: "text", x: x + 10, y: by - 94, text: c, color: INK, size: 1 });
    });
    out.push({ type: "note", x: bx - 172, y: by - 70, w: 94, h: 54, text: "Task A", color: NOTE, size: 1 });
    out.push({ type: "note", x: bx - 172, y: by - 8, w: 94, h: 54, text: "Task B", color: NOTE, size: 1 });
    out.push({ type: "note", x: bx - 42, y: by - 70, w: 94, h: 54, text: "In progress", color: NOTE, size: 1 });
    return out;
  }
  // --- Stencils: single reusable elements composed from primitives ---
  if (name === "s-process") return [
    { type: "rect", x: bx - 70, y: by - 24, w: 140, h: 48, color: INK, size: 2 },
    { type: "text", x: bx - 38, y: by + 6, text: "Process", color: INK, size: 2 },
  ];
  if (name === "s-terminator") return [
    { type: "ellipse", x: bx - 70, y: by - 24, w: 140, h: 48, color: INK, size: 2 },
    { type: "text", x: bx - 24, y: by + 6, text: "Start", color: INK, size: 2 },
  ];
  if (name === "s-container") return [
    { type: "rect", x: bx - 150, y: by - 110, w: 300, h: 220, color: INK, size: 1, dash: true },
    { type: "text", x: bx - 142, y: by - 88, text: "Group", color: INK, size: 1 },
  ];
  if (name === "s-swimlane") return [
    { type: "rect", x: bx - 200, y: by - 90, w: 400, h: 180, color: INK, size: 1 },
    { type: "line", x: bx - 200, y: by, w: 400, h: 0, color: INK, size: 1 },
    { type: "text", x: bx - 192, y: by - 66, text: "Lane 1", color: INK, size: 1 },
    { type: "text", x: bx - 192, y: by + 26, text: "Lane 2", color: INK, size: 1 },
  ];

  // mindmap
  const out: Record<string, any>[] = [{ type: "note", x: bx - 50, y: by - 25, w: 100, h: 50, text: "Idea", color: ACCENT, size: 1 }];
  for (const s of [{ dx: -180, dy: -100, t: "Branch 1" }, { dx: 160, dy: -100, t: "Branch 2" }, { dx: -180, dy: 90, t: "Branch 3" }, { dx: 160, dy: 90, t: "Branch 4" }]) {
    out.push({ type: "line", x: bx, y: by, w: s.dx, h: s.dy, color: INK, size: 1 });
    out.push({ type: "note", x: bx + s.dx - 45, y: by + s.dy - 22, w: 90, h: 44, text: s.t, color: NOTE, size: 1 });
  }
  return out;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number) {
  const words = text.split(/\s+/); let line = ""; let yy = y;
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, x, yy); line = w; yy += lh; }
    else line = test;
  }
  if (line) ctx.fillText(line, x, yy);
}

async function downscale(file: File, maxDim: number): Promise<string> {
  const dataUrl = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.readAsDataURL(file); });
  return downscaleDataUrl(dataUrl, maxDim);
}

/** Same size cap as uploaded images, for sources that are already data URLs (e.g. a rendered Figma frame). */
async function downscaleDataUrl(dataUrl: string, maxDim: number): Promise<string> {
  const img = await new Promise<HTMLImageElement>((res) => { const i = new Image(); i.onload = () => res(i); i.src = dataUrl; });
  let { width, height } = img;
  if (width > maxDim || height > maxDim) {
    const scale = maxDim / Math.max(width, height); width = Math.round(width * scale); height = Math.round(height * scale);
  }
  const c = document.createElement("canvas"); c.width = width; c.height = height;
  c.getContext("2d")!.drawImage(img, 0, 0, width, height);
  return c.toDataURL("image/jpeg", 0.82);
}
