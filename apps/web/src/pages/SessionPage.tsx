import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { io, type Socket } from "socket.io-client";
import {
  SOCKET_EVENTS, roleAtLeast, LANGUAGES, isRunnable, isTestable, isProfilable, isDebuggable,
  PERF_ITERATIONS, REGION_MISMATCH_CODE, type Role, type DebugState, type RegionMismatch,
} from "@yumi/shared";
import { API, getAccessToken, api } from "../api";
import { useAuth } from "../auth";
import { useToast } from "../toast";
import { ThemeToggle } from "../theme";
import { RegionNotice, asRegionMismatch } from "../region";
import { CodeEditor } from "../collab/CodeEditor";
import {
  loadStoredKey, storeKey, forgetKey, keyCheck, importProjectKey, isWellFormedKey,
} from "../collab/e2ee";
import { E2eeKeyGate } from "../collab/E2eeKeyGate";
import { CanvasBoard } from "../collab/CanvasBoard";
import { CallPanel } from "../collab/CallPanel";
import { AiPanel } from "../collab/AiPanel";
import { ChatPanel } from "../collab/ChatPanel";
import { LivePreview } from "../collab/LivePreview";
import { ReplayModal } from "../collab/ReplayModal";
import { GithubModal } from "../collab/GithubModal";
import { FigmaModal } from "../collab/FigmaModal";
import { SlackModal } from "../collab/SlackModal";
import { DebugPanel } from "../collab/DebugPanel";
import { ShortcutsModal, useShortcuts, loadKeymap, type Keymap, type LayoutSnapshot } from "../collab/shortcuts";
import { useWebRTC } from "../collab/useWebRTC";
import { useSfu } from "../collab/useSfu";
import type { CallMode } from "@yumi/shared";

interface Presence { userId: string; displayName: string; avatarColor: string; role: Role }
interface TermLine { kind: "info" | "stdout" | "stderr" | "exit" | "perf" | "faster" | "slower"; text: string }
interface Activity { action: string; actor: string; actorColor: string; detail?: string; ts: number }

/* --------------------------- Perf formatting ----------------------------- */

/**
 * busybox `time` (alpine images) resolves to 10ms, so a genuinely fast program
 * reports 0 — say "<10 ms" rather than an untrue "0.0 ms".
 */
function fmtMs(ms: number): string {
  if (ms <= 0) return "<10 ms";
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function fmtKb(kb: number): string {
  return kb < 1024 ? `${kb} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/** Percent change of the current median vs the previous run of the same file. */
function fmtDelta(now: number, prev: number): { text: string; kind: "faster" | "slower" | "exit" } | null {
  if (prev <= 0 || now <= 0) return null;
  const pct = ((now - prev) / prev) * 100;
  if (Math.abs(pct) < 5) return { text: `≈ unchanged vs previous run (${fmtMs(prev)})`, kind: "exit" };
  return pct > 0
    ? { text: `▲ ${pct.toFixed(0)}% slower than previous run (${fmtMs(prev)})`, kind: "slower" }
    : { text: `▼ ${Math.abs(pct).toFixed(0)}% faster than previous run (${fmtMs(prev)})`, kind: "faster" };
}

export function SessionPage() {
  const { projectId } = useParams();
  const { user } = useAuth();
  const { notify } = useToast();
  const [project, setProject] = useState<any>(null);
  const [files, setFiles] = useState<any[]>([]);
  const [role, setRole] = useState<Role>("viewer");
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [connected, setConnected] = useState(false);
  // Set when this deployment turns out not to hold the project's data.
  const [regionBlock, setRegionBlock] = useState<RegionMismatch | null>(null);
  const [tab, setTab] = useState<"code" | "canvas">("code");
  const [newName, setNewName] = useState("");
  const [newLang, setNewLang] = useState("javascript");
  const [socket, setSocket] = useState<Socket | null>(null);
  const [terminal, setTerminal] = useState<TermLine[]>([]);
  const [showTerminal, setShowTerminal] = useState(false);
  const [running, setRunning] = useState(false);
  const [rightTab, setRightTab] = useState<"chat" | "ai" | "activity" | "debug">("chat");
  const [debugState, setDebugState] = useState<DebugState | null>(null);
  const [debugEvals, setDebugEvals] = useState<{ expression: string; value: string }[]>([]);
  const [debugBusy, setDebugBusy] = useState(false);
  // Breakpoints set before a session starts; once it's running the server owns them.
  const [localBreakpoints, setLocalBreakpoints] = useState<number[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [previewOn, setPreviewOn] = useState(false);
  const [showReplay, setShowReplay] = useState(false);
  const [showGithub, setShowGithub] = useState(false);
  const [showFigma, setShowFigma] = useState(false);
  const [showSlack, setShowSlack] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [keymap, setKeymap] = useState<Keymap>(() => loadKeymap());
  // Panel layout — persisted so it follows the user across sessions.
  const [layout, setLayout] = useState<{ sidebar: boolean; rightPanel: boolean }>(() => {
    try { return { sidebar: true, rightPanel: true, ...JSON.parse(localStorage.getItem("yumi.layout") || "{}") }; }
    catch { return { sidebar: true, rightPanel: true }; }
  });
  useEffect(() => { try { localStorage.setItem("yumi.layout", JSON.stringify(layout)); } catch { /* noop */ } }, [layout]);
  const [perfIters, setPerfIters] = useState<number>(PERF_ITERATIONS.default);
  const socketRef = useRef<Socket | null>(null);
  const seenActivity = useRef<Set<string>>(new Set());
  // Last median per file, so each perf run can be compared against the previous
  // one. Room-wide (everyone sees the same broadcasts) and session-scoped.
  const perfHistory = useRef<Map<string, number>>(new Map());
  const termEndRef = useRef<HTMLDivElement>(null);
  const codeContentRef = useRef<(() => string) | null>(null);
  // Set by CanvasBoard while it's mounted; lets the Figma modal place a frame.
  const canvasInsertImageRef = useRef<((dataUrl: string) => Promise<void>) | null>(null);

  // The server advertises the room's call transport on JOINED. Both hooks are
  // instantiated (cheap until joinCall); we drive whichever the mode selects.
  const [callMode, setCallMode] = useState<CallMode>("mesh");
  const mesh = useWebRTC(socket, user?.id ?? "");
  const sfu = useSfu(socket, user?.id ?? "");
  const rtc = callMode === "sfu" ? sfu : mesh;

  // End-to-end encryption: the key lives only in this browser. Until it is
  // present there is nothing to render, because every payload is sealed.
  const e2ee = Boolean(project?.e2ee);
  const [cryptoKey, setCryptoKey] = useState<CryptoKey | null>(null);
  const [keyMissing, setKeyMissing] = useState(false);

  useEffect(() => {
    if (!project) return;
    if (!project.e2ee) { setCryptoKey(null); setKeyMissing(false); return; }
    let cancelled = false;
    (async () => {
      const stored = loadStoredKey(project._id);
      if (!stored) { setKeyMissing(true); return; }
      // A stored key from a different project (or a rotated one) must not be
      // used to write updates nobody can read back.
      if (project.e2eeKeyCheck && await keyCheck(stored) !== project.e2eeKeyCheck) {
        forgetKey(project._id);
        if (!cancelled) { setKeyMissing(true); notify("The saved key does not match this project", "error"); }
        return;
      }
      try {
        const imported = await importProjectKey(stored);
        if (!cancelled) { setCryptoKey(imported); setKeyMissing(false); }
      } catch {
        if (!cancelled) setKeyMissing(true);
      }
    })();
    return () => { cancelled = true; };
  }, [project, notify]);

  const acceptKey = useCallback(async (candidate: string) => {
    if (!project) return false;
    if (!isWellFormedKey(candidate)) return false;
    if (project.e2eeKeyCheck && await keyCheck(candidate) !== project.e2eeKeyCheck) return false;
    storeKey(project._id, candidate);
    setCryptoKey(await importProjectKey(candidate));
    setKeyMissing(false);
    return true;
  }, [project]);

  const editable = useMemo(() => roleAtLeast(role, "editor"), [role]);
  const activeFile = useMemo(() => files.find((f) => f._id === activeFileId) ?? null, [files, activeFileId]);
  const hasCode = project && project.type !== "canvas";
  const hasCanvas = project && project.type !== "code";
  const peerNames = useMemo(() => {
    const m: Record<string, { name: string; color: string }> = {};
    for (const p of presence) m[p.userId] = { name: p.displayName, color: p.avatarColor };
    return m;
  }, [presence]);

  async function refetchFiles() {
    const { files } = await api.getProject(projectId!);
    setFiles(files);
    setActiveFileId((cur) => (cur && files.some((f: any) => f._id === cur) ? cur : files[0]?._id ?? null));
  }

  // Load project metadata (independent of the socket lifecycle).
  useEffect(() => {
    let cancelled = false;
    api.getProject(projectId!)
      .then(({ project, files, role }) => {
        if (cancelled) return;
        setProject(project); setFiles(files); setRole(role as Role);
        setActiveFileId(files[0]?._id ?? null);
        setTab(project.type === "canvas" ? "canvas" : "code");
      })
      .catch((e: any) => {
        if (cancelled) return;
        // Not an error the user made: this deployment does not hold the data.
        const region = asRegionMismatch(e);
        if (region) { setRegionBlock(region); return; }
        notify(e.message ?? "Failed to open project", "error");
      });
    return () => { cancelled = true; };
  }, [projectId]);

  // Socket lifecycle — the socket is created SYNCHRONOUSLY so the effect's
  // cleanup always holds its reference and can disconnect it. Creating it inside
  // an async callback would let cleanup run before assignment, leaking a live
  // connection on every remount (StrictMode/HMR) — each leaked socket then
  // re-receives every room broadcast, showing messages/activity 2-3×.
  useEffect(() => {
    // forceNew: give each mount its own manager so StrictMode's throwaway first
    // mount can't leave a cached/multiplexed connection alive alongside the real
    // one (which would deliver every room broadcast twice).
    const s = io(API, { auth: { token: getAccessToken() }, withCredentials: true, forceNew: true });
    socketRef.current = s; setSocket(s);
    s.on("connect", () => { setConnected(true); s.emit(SOCKET_EVENTS.JOIN, { projectId }); });
    s.on("disconnect", () => setConnected(false));
    s.on(SOCKET_EVENTS.JOINED, ({ callMode }: { callMode?: CallMode }) => { if (callMode) setCallMode(callMode); });
    s.on(SOCKET_EVENTS.PRESENCE_UPDATE, ({ users }: { users: Presence[] }) => setPresence(users));
    s.on(SOCKET_EVENTS.FILES_CHANGED, () => refetchFiles());
    s.on(SOCKET_EVENTS.ACTIVITY, (a: Activity) => {
      // Duplicate broadcasts carry an identical server timestamp — dedupe on it.
      const key = `${a.ts}:${a.actor}:${a.action}:${a.detail ?? ""}`;
      if (seenActivity.current.has(key)) return;
      seenActivity.current.add(key);
      setActivity((prev) => [...prev.slice(-80), a]);
    });
    s.on(SOCKET_EVENTS.RUN_OUTPUT, (p: any) => {
      setShowTerminal(true); setRunning(true);
      setTerminal((prev) => [...prev, { kind: "info", text: `▶ Running ${p.fileName ?? ""} (by ${p.by})…` }]);
    });
    s.on(SOCKET_EVENTS.RUN_DONE, (r: any) => {
      setRunning(false);
      setTerminal((prev) => {
        const out = [...prev];
        if (r.error) out.push({ kind: "stderr", text: r.error });
        if (r.stdout) out.push({ kind: "stdout", text: r.stdout.replace(/\n$/, "") });
        if (r.stderr) out.push({ kind: "stderr", text: r.stderr.replace(/\n$/, "") });
        if (r.timedOut) out.push({ kind: "stderr", text: "⏱ Timed out (10s limit)" });
        out.push({ kind: "exit", text: r.ok ? "✓ exited 0" : `✗ exited ${r.exitCode ?? "?"}` });
        return out;
      });
    });
    s.on(SOCKET_EVENTS.TEST_RUNNING, (p: any) => {
      setShowTerminal(true); setRunning(true);
      setTerminal((prev) => [...prev, { kind: "info", text: `✓ Running tests for ${p.fileName ?? ""} (by ${p.by})…` }]);
    });
    s.on(SOCKET_EVENTS.TEST_DONE, (r: any) => {
      setRunning(false);
      setTerminal((prev) => {
        const out = [...prev];
        if (r.error) out.push({ kind: "stderr", text: r.error });
        if (r.stdout) out.push({ kind: "stdout", text: r.stdout.replace(/\n$/, "") });
        if (r.stderr) out.push({ kind: "stderr", text: r.stderr.replace(/\n$/, "") });
        if (r.timedOut) out.push({ kind: "stderr", text: "⏱ Timed out" });
        const summary = r.total > 0
          ? `${r.ok ? "✓" : "✗"} Tests: ${r.passed}/${r.total} passed${r.failed ? `, ${r.failed} failed` : ""}`
          : (r.error ? "" : `${r.ok ? "✓" : "✗"} Tests ${r.ok ? "passed" : "failed"} (no count parsed)`);
        if (summary) out.push({ kind: r.ok ? "exit" : "stderr", text: summary });
        return out;
      });
    });
    s.on(SOCKET_EVENTS.PERF_RUNNING, (p: any) => {
      setShowTerminal(true); setRunning(true);
      setTerminal((prev) => [...prev, { kind: "info", text: `⏱ Profiling ${p.fileName ?? ""} ×${p.iterations} (by ${p.by})…` }]);
    });
    s.on(SOCKET_EVENTS.PERF_DONE, (r: any) => {
      setRunning(false);
      setTerminal((prev) => {
        const out = [...prev];
        if (r.error) out.push({ kind: "stderr", text: r.error });
        if (r.stderr) out.push({ kind: "stderr", text: String(r.stderr).replace(/\n$/, "") });
        if (!r.iterations) return out;

        if (r.stdout) out.push({ kind: "stdout", text: String(r.stdout).replace(/\n$/, "") });
        out.push({ kind: "perf", text: `⏱ ${r.fileName ?? "file"} — ${r.iterations} iteration${r.iterations === 1 ? "" : "s"}` });
        out.push({ kind: "perf", text: `   median ${fmtMs(r.medianMs)} · best ${fmtMs(r.bestMs)} · worst ${fmtMs(r.worstMs)} · σ ${fmtMs(r.stdDevMs)}` });

        const mem = r.memoryAvailable && r.maxRssKb ? ` · peak mem ${fmtKb(r.maxRssKb)}` : "";
        const cpu = r.cpuPct !== null ? `${r.cpuPct}% cpu · ` : "";
        out.push({ kind: "perf", text: `   ${cpu}user ${fmtMs(r.userMs)} · sys ${fmtMs(r.sysMs)}${mem}` });

        if (r.compileMs) out.push({ kind: "exit", text: `   compiled in ${fmtMs(r.compileMs)} (excluded from timings)` });
        if (!r.memoryAvailable) out.push({ kind: "exit", text: "   peak memory unavailable for this runtime image" });
        // A slow first iteration is warmup (JIT, page cache), not a regression.
        if (r.iterations > 2 && r.worstMs > r.medianMs * 3) {
          out.push({ kind: "exit", text: "   first iteration includes warmup — median is the figure to trust" });
        }

        const key = `${r.fileName ?? ""}:${r.language ?? ""}`;
        const prevMedian = perfHistory.current.get(key);
        if (prevMedian !== undefined) {
          const d = fmtDelta(r.medianMs, prevMedian);
          if (d) out.push({ kind: d.kind, text: `   ${d.text}` });
        }
        perfHistory.current.set(key, r.medianMs);
        return out;
      });
    });
    s.on(SOCKET_EVENTS.DEBUG_STATE, ({ state }: { state: DebugState }) => {
      setDebugBusy(false);
      setDebugState(state);
      setRightTab("debug");
      if (state.status === "exited") setLocalBreakpoints(state.breakpoints);
    });
    s.on(SOCKET_EVENTS.DEBUG_EVALUATED, (e: { expression: string; value: string }) =>
      setDebugEvals((prev) => [...prev.slice(-20), e]));
    s.on(SOCKET_EVENTS.DEBUG_ERROR, (e: any) => {
      setDebugBusy(false);
      notify(e.error ?? "Debugger error", "error");
    });
    s.on(SOCKET_EVENTS.ERROR, (e: any) => {
      // The gateway refuses a cross-region join with the same payload the REST
      // side uses, so it gets the same screen rather than a toast that leaves
      // the editor sitting there looking merely broken.
      if (e?.code === REGION_MISMATCH_CODE) { setRegionBlock(e as RegionMismatch); return; }
      notify(e.error ?? "Session error", "error");
    });
    return () => {
      s.removeAllListeners();
      s.disconnect();
      socketRef.current = null;
      setSocket(null);
    };
  }, [projectId]);

  useEffect(() => {
    if (!socket) return;
    const id = setInterval(() => socket.emit("heartbeat"), 20_000);
    return () => clearInterval(id);
  }, [socket]);

  useEffect(() => { termEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [terminal]);

  // Global keyboard shortcuts (ignored while typing in the editor/inputs).
  useShortcuts({
    run: () => { if (hasCode && tab === "code" && activeFile && isRunnable(activeFile.language) && editable) runCode(); },
    test: () => { if (hasCode && tab === "code" && activeFile && isTestable(activeFile.language) && editable) runTests(); },
    perf: () => { if (hasCode && tab === "code" && activeFile && isProfilable(activeFile.language) && editable) runPerf(); },
    terminal: () => { if (hasCode) setShowTerminal((v) => !v); },
    chat: () => setRightTab("chat"),
    ai: () => setRightTab("ai"),
    activity: () => setRightTab("activity"),
    debug: () => { if (hasCode) setRightTab("debug"); },
    sidebar: () => setLayout((l) => ({ ...l, sidebar: !l.sidebar })),
    rightPanel: () => setLayout((l) => ({ ...l, rightPanel: !l.rightPanel })),
    focus: () => setLayout((l) => (l.sidebar || l.rightPanel ? { sidebar: false, rightPanel: false } : { sidebar: true, rightPanel: true })),
    preview: () => { if (hasCode && tab === "code" && activeFile?.language === "html") setPreviewOn((v) => !v); },
    replay: () => { if (activeFile) setShowReplay(true); },
    github: () => { if (hasCode) setShowGithub(true); },
    figma: () => { if (hasCanvas) setShowFigma(true); },
    slack: () => setShowSlack(true),
    help: () => setShowShortcuts((v) => !v),
  }, keymap);

  function applySnapshot(s: LayoutSnapshot) {
    setLayout(s.layout);
    setRightTab(s.rightTab);
    setShowTerminal(s.showTerminal);
    setShowShortcuts(false);
  }

  function runCode() {
    if (!activeFile || !socketRef.current) return;
    const code = codeContentRef.current?.() ?? "";
    setShowTerminal(true);
    socketRef.current.emit(SOCKET_EVENTS.RUN_START, {
      language: activeFile.language, code, fileName: activeFile.path,
    });
  }

  function runTests() {
    if (!activeFile || !socketRef.current) return;
    const code = codeContentRef.current?.() ?? "";
    setShowTerminal(true);
    socketRef.current.emit(SOCKET_EVENTS.TEST_START, {
      language: activeFile.language, code, fileName: activeFile.path,
    });
  }

  const debugBreakpoints = debugState && debugState.status !== "exited" ? debugState.breakpoints : localBreakpoints;

  function toggleBreakpoint(line: number) {
    if (!editable) return;
    if (debugState && debugState.status !== "exited") {
      const has = debugState.breakpoints.includes(line);
      socketRef.current?.emit(SOCKET_EVENTS.DEBUG_COMMAND, {
        cmd: has ? "clearBreakpoint" : "setBreakpoint", arg: line,
      });
      return;
    }
    setLocalBreakpoints((prev) =>
      prev.includes(line) ? prev.filter((l) => l !== line) : [...prev, line].sort((a, b) => a - b));
  }

  function startDebug() {
    if (!activeFile || !socketRef.current) return;
    setDebugBusy(true);
    setDebugEvals([]);
    setRightTab("debug");
    socketRef.current.emit(SOCKET_EVENTS.DEBUG_START, {
      language: activeFile.language,
      code: codeContentRef.current?.() ?? "",
      fileName: activeFile.path,
      breakpoints: localBreakpoints,
    });
  }

  function runPerf() {
    if (!activeFile || !socketRef.current) return;
    const code = codeContentRef.current?.() ?? "";
    setShowTerminal(true);
    socketRef.current.emit(SOCKET_EVENTS.PERF_START, {
      language: activeFile.language, code, fileName: activeFile.path, iterations: perfIters,
    });
  }

  async function changeLanguage(lang: string) {
    if (!activeFile) return;
    setFiles((prev) => prev.map((f) => (f._id === activeFile._id ? { ...f, language: lang } : f)));
    await api.updateFile(projectId!, activeFile._id, { language: lang });
    socketRef.current?.emit(SOCKET_EVENTS.FILES_CHANGED);
  }

  async function createFile(e: React.FormEvent) {
    e.preventDefault();
    const langMeta = LANGUAGES.find((l) => l.value === newLang)!;
    let name = newName.trim();
    if (!name) return;
    if (!name.includes(".")) name = `${name}.${langMeta.ext}`;
    try {
      const { file } = await api.createFile(projectId!, name, newLang);
      setNewName(""); await refetchFiles(); setActiveFileId(file._id); setTab("code");
      socketRef.current?.emit(SOCKET_EVENTS.FILES_CHANGED);
      notify(`Created ${name}`, "success");
    } catch (err: any) { notify(err.message, "error"); }
  }

  async function renameFile(f: any) {
    const next = window.prompt("Rename file:", f.path);
    if (!next || next === f.path) return;
    try {
      await api.updateFile(projectId!, f._id, { path: next });
      await refetchFiles(); socketRef.current?.emit(SOCKET_EVENTS.FILES_CHANGED);
    } catch (err: any) { notify(err.message, "error"); }
  }

  async function deleteFile(f: any) {
    if (!window.confirm(`Delete ${f.path}? This cannot be undone.`)) return;
    try {
      await api.deleteFile(projectId!, f._id);
      await refetchFiles(); socketRef.current?.emit(SOCKET_EVENTS.FILES_CHANGED);
      notify(`Deleted ${f.path}`, "info");
    } catch (err: any) { notify(err.message, "error"); }
  }

  async function joinCall() {
    try { await rtc.joinCall(); } catch (e: any) { notify(e.message, "error"); }
  }

  async function toggleRecord() {
    if (rtc.recording) { rtc.stopRecording(); notify("Recording saved — downloading .webm", "info"); return; }
    try { await rtc.startRecording(); notify("Recording started", "info"); }
    catch (e: any) { notify(e.message, "error"); }
  }

  // Checked before "loading": a cross-region refusal never resolves into a
  // project, so the loading state would otherwise be where the user is left.
  if (regionBlock) return <RegionNotice detail={regionBlock} />;
  if (!project || !user) return <div className="center-screen">Loading session…</div>;

  // Nothing can be rendered without the key — the documents are ciphertext, and
  // opening the editor anyway would show an empty file and invite someone to
  // "fix" it by typing over content they simply cannot see.
  if (keyMissing) {
    return (
      <E2eeKeyGate projectName={project.name} workspaceId={project.workspaceId} onSubmit={acceptKey} />
    );
  }
  if (e2ee && !cryptoKey) return <div className="center-screen">Unlocking…</div>;

  const showFilePane = hasCode && tab === "code" && layout.sidebar;
  const showRightPane = layout.rightPanel;
  const columns = [showFilePane ? "220px" : "", "1fr", showRightPane ? "320px" : ""].filter(Boolean).join(" ");
  const canRunActive = hasCode && tab === "code" && activeFile && isRunnable(activeFile.language) && editable;
  const canTestActive = hasCode && tab === "code" && activeFile && isTestable(activeFile.language) && editable;
  const canPerfActive = hasCode && tab === "code" && activeFile && isProfilable(activeFile.language) && editable;
  const canDebugActive = hasCode && tab === "code" && activeFile && isDebuggable(activeFile.language);
  const canPreview = hasCode && tab === "code" && activeFile?.language === "html";

  return (
    <div className="session">
      <div className="topbar">
        <Link to={`/w/${project.workspaceId}`} className="meta">← {project.name}</Link>
        <span className="chip chip-role">{role}</span>
        {e2ee && (
          <span className="chip" title="Encrypted in your browser — the server stores only ciphertext. Running, testing or debugging a file still sends it to the sandbox in the clear.">
            🔒 end-to-end encrypted
          </span>
        )}
        <div className="spacer" />
        <span className="meta" style={{ color: connected ? "var(--success)" : "var(--ink-muted)" }}>
          {connected ? "● live" : "○ connecting"}
        </span>
        <div className="avstack">
          {presence.map((p) => (
            <div key={p.userId} className="avatar" style={{ background: p.avatarColor }} title={`${p.displayName} (${p.role})`}>
              {p.displayName[0]}
            </div>
          ))}
        </div>
        {hasCode && (
          <button className="btn btn-secondary btn-sm" onClick={() => setShowGithub(true)} title="GitHub: browse history & import files">⑂ GitHub</button>
        )}
        {hasCanvas && (
          <button className="btn btn-secondary btn-sm" onClick={() => setShowFigma(true)} title="Figma: browse frames & place them on the canvas">◈ Figma</button>
        )}
        <button className="btn btn-secondary btn-sm" onClick={() => setShowSlack(true)} title="Slack: notify a channel about this project">✳ Slack</button>
        <button className="btn btn-secondary btn-sm" onClick={() => setShowShortcuts(true)} title="Keyboard shortcuts & layouts (?)">⌘</button>
        <ThemeToggle />
      </div>

      <div className="session-body" style={{ gridTemplateColumns: columns }}>
        {/* File tree — only for code-bearing projects, and only on the Code tab */}
        {showFilePane && (
          <div className="pane pane-left">
            <div className="pane-head meta">Files</div>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {files.map((f) => (
                <div key={f._id} className={`file-item ${activeFileId === f._id ? "active" : ""}`}
                  onClick={() => { setActiveFileId(f._id); setTab("code"); }}>
                  <span className="file-name">{f.path}</span>
                  {editable && (
                    <span className="file-actions">
                      <button title="Rename" onClick={(e) => { e.stopPropagation(); renameFile(f); }}>✎</button>
                      <button title="Delete" onClick={(e) => { e.stopPropagation(); deleteFile(f); }}>🗑</button>
                    </span>
                  )}
                </div>
              ))}
              {files.length === 0 && <div style={{ padding: 14, color: "var(--ink-muted)", fontSize: 13 }}>No files yet</div>}
            </div>
            {editable && (
              <form className="new-file-row" onSubmit={createFile}>
                <input className="input" placeholder="new file" value={newName} onChange={(e) => setNewName(e.target.value)} />
                <select className="lang-select" value={newLang} onChange={(e) => setNewLang(e.target.value)}>
                  {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                </select>
                <button className="btn btn-primary btn-sm" title="Create file">+</button>
              </form>
            )}
          </div>
        )}

        {/* Center: tabs + code/canvas + terminal */}
        <div className="pane">
          {hasCode && hasCanvas && (
            <div className="pane-tabs">
              <button className={`tab ${tab === "code" ? "active" : ""}`} onClick={() => setTab("code")}>Code</button>
              <button className={`tab ${tab === "canvas" ? "active" : ""}`} onClick={() => setTab("canvas")}>Canvas</button>
            </div>
          )}

          <div className="center-main">
            {tab === "code" && hasCode ? (
              activeFile && socket && connected ? (
                <div className={`editor-and-preview ${previewOn && canPreview ? "split" : ""}`}>
                  <div className="editor-col">
                    <div className="editor-header">
                      <span className="mono" style={{ fontSize: 12, color: "var(--ink-muted)" }}>{activeFile.path}</span>
                      <div className="spacer" />
                      {canPreview && (
                        <button className={`btn btn-sm ${previewOn ? "btn-primary" : "btn-secondary"}`}
                          onClick={() => setPreviewOn((v) => !v)} title="Toggle live preview">◱ Preview</button>
                      )}
                      {canRunActive && (
                        <button className="btn btn-primary btn-sm" onClick={runCode} disabled={running} title="Compile & run">
                          {running ? "Running…" : "▶ Run"}
                        </button>
                      )}
                      {canTestActive && (
                        <button className="btn btn-secondary btn-sm" onClick={runTests} disabled={running}
                          title="Run the file's tests (node --test / unittest / go test / cargo test)">✓ Test</button>
                      )}
                      {canPerfActive && (
                        <>
                          <button className="btn btn-secondary btn-sm" onClick={runPerf} disabled={running}
                            title="Profile: run repeatedly and measure time, CPU and peak memory">⏱ Perf</button>
                          <select className="lang-select" value={perfIters} disabled={running}
                            onChange={(e) => setPerfIters(Number(e.target.value))}
                            title="Timed iterations per perf run">
                            {[1, 3, 5, 10, 20].map((n) => <option key={n} value={n}>×{n}</option>)}
                          </select>
                        </>
                      )}
                      {!e2ee && (
                        <button className="btn btn-secondary btn-sm" onClick={() => setShowReplay(true)} title="Replay edit history">⏱ Replay</button>
                      )}
                      <span className="meta">Language</span>
                      <select className="lang-select" value={activeFile.language}
                        onChange={(e) => changeLanguage(e.target.value)} disabled={!editable}>
                        {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                      </select>
                    </div>
                    <CodeEditor
                      key={`${activeFile._id}:${activeFile.language}`}
                      socket={socket} docId={activeFile.docId} user={user}
                      editable={editable} language={activeFile.language} contentRef={codeContentRef}
                      cryptoKey={cryptoKey}
                      debuggable={isDebuggable(activeFile.language)}
                      breakpoints={debugBreakpoints}
                      // Only highlight when the debugger is stopped in *this* file.
                      debugLine={debugState?.status === "paused" && debugState.file === activeFile.path ? debugState.line : null}
                      onToggleBreakpoint={toggleBreakpoint}
                    />
                  </div>
                  {previewOn && canPreview && <LivePreview getHtml={() => codeContentRef.current?.()} />}
                </div>
              ) : (
                <div className="center-screen">{activeFile ? "Connecting editor…" : "Create a file to start coding"}</div>
              )
            ) : hasCanvas && socket && connected ? (
              <CanvasBoard socket={socket} docId={`canvas:${projectId}`} user={user} editable={editable}
                insertImageRef={canvasInsertImageRef} cryptoKey={cryptoKey} />
            ) : (
              <div className="center-screen">Connecting…</div>
            )}
          </div>

          {/* Shared terminal dock (code tab only) */}
          {hasCode && tab === "code" && showTerminal && (
            <div className="terminal-dock">
              <div className="terminal-head">
                <span className="meta">Terminal {running && "· running"}</span>
                <div className="spacer" />
                <button className="ctool" style={{ width: 26, height: 24 }} title="Clear" onClick={() => setTerminal([])}>⌦</button>
                <button className="ctool" style={{ width: 26, height: 24 }} title="Hide" onClick={() => setShowTerminal(false)}>✕</button>
              </div>
              <div className="terminal-body mono">
                {terminal.length === 0 && <div style={{ color: "var(--ink-muted)" }}>Run a file to see output here.</div>}
                {terminal.map((l, i) => <div key={i} className={`term-${l.kind}`}>{l.text}</div>)}
                <div ref={termEndRef} />
              </div>
            </div>
          )}
        </div>

        {/* Call + Chat + presence */}
        {showRightPane && (
        <div className="pane pane-right">
          <div className="pane-head meta">Call · {callMode === "sfu" ? "SFU (scales to 50)" : "P2P mesh"}</div>
          <CallPanel
            inCall={rtc.inCall} localStream={rtc.localStream} remotePeers={rtc.remotePeers}
            peerNames={peerNames} micOn={rtc.micOn} camOn={rtc.camOn} sharing={rtc.sharing} recording={rtc.recording}
            degradedPeers={rtc.degradedPeers}
            onJoin={joinCall} onLeave={rtc.leaveCall}
            onToggleMic={rtc.toggleMic} onToggleCam={rtc.toggleCam} onShare={rtc.shareScreen}
            onToggleRecord={toggleRecord}
          />
          <div className="pane-tabs" style={{ borderTop: "1px solid var(--border)" }}>
            <button className={`tab ${rightTab === "chat" ? "active" : ""}`} onClick={() => setRightTab("chat")}>
              Chat · {presence.length}
            </button>
            <button className={`tab ${rightTab === "ai" ? "active" : ""}`} onClick={() => setRightTab("ai")}>
              ✦ AI
            </button>
            <button className={`tab ${rightTab === "activity" ? "active" : ""}`} onClick={() => setRightTab("activity")}>
              Activity
            </button>
            {hasCode && (
              <button className={`tab ${rightTab === "debug" ? "active" : ""}`} onClick={() => setRightTab("debug")}>
                🐞{debugState && debugState.status !== "exited" ? " ●" : ""}
              </button>
            )}
          </div>
          {rightTab === "chat" && socket ? (
            <ChatPanel socket={socket} projectId={projectId!} user={user} presence={presence} cryptoKey={cryptoKey} />
          ) : rightTab === "ai" && socket ? (
            <AiPanel socket={socket} getCodeContext={() => codeContentRef.current?.()} />
          ) : rightTab === "debug" ? (
            <DebugPanel
              state={debugState}
              editable={editable}
              canDebug={!!canDebugActive}
              busy={debugBusy}
              evaluations={debugEvals}
              onStart={startDebug}
              onCommand={(cmd) => socketRef.current?.emit(SOCKET_EVENTS.DEBUG_COMMAND, { cmd })}
              onEvaluate={(expr) => socketRef.current?.emit(SOCKET_EVENTS.DEBUG_COMMAND, { cmd: "evaluate", arg: expr })}
              onStop={() => socketRef.current?.emit(SOCKET_EVENTS.DEBUG_STOP)}
            />
          ) : (
            <div className="chat-list">
              {activity.length === 0 && <div style={{ color: "var(--ink-muted)", fontSize: 13 }}>No activity yet.</div>}
              {activity.map((a, i) => (
                <div key={i} className="activity-item">
                  <span className="act-dot" style={{ background: a.actorColor }} />
                  <span><b>{a.actor}</b> {a.action}{a.detail ? ` ${a.detail}` : ""}</span>
                  <span className="act-time">{new Date(a.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        )}
      </div>
      {showReplay && activeFile && (
        <ReplayModal projectId={projectId!} docId={activeFile.docId} fileName={activeFile.path} onClose={() => setShowReplay(false)} />
      )}
      {showGithub && (
        <GithubModal
          projectId={projectId!}
          editable={editable}
          onImported={async () => { await refetchFiles(); socketRef.current?.emit(SOCKET_EVENTS.FILES_CHANGED); }}
          onClose={() => setShowGithub(false)}
        />
      )}
      {showFigma && (
        <FigmaModal
          projectId={projectId!}
          editable={editable}
          // Placing a frame needs the board mounted, which only happens on the Canvas tab.
          canInsert={tab === "canvas" && hasCanvas && !!canvasInsertImageRef.current}
          onInsert={async (dataUrl) => { await canvasInsertImageRef.current?.(dataUrl); }}
          onClose={() => setShowFigma(false)}
        />
      )}
      {showSlack && (
        <SlackModal projectId={projectId!} editable={editable} onClose={() => setShowSlack(false)} />
      )}
      {showShortcuts && (
        <ShortcutsModal
          keymap={keymap}
          onChangeKeymap={setKeymap}
          currentSnapshot={{ layout, rightTab, showTerminal }}
          onApplySnapshot={applySnapshot}
          onClose={() => setShowShortcuts(false)}
        />
      )}
    </div>
  );
}
