/**
 * In-container debug harness for JavaScript/TypeScript.
 *
 * This file is copied into the sandbox and run *beside* the debuggee. It talks
 * to V8's inspector over the container's loopback interface, which exists even
 * under `--network none`, so nothing leaves the sandbox and nothing has to be
 * installed: node 22 ships `fetch` and `WebSocket` as globals.
 *
 * It exists because `node inspect` (the built-in REPL client) prints its prompt
 * before the debuggee actually pauses, which makes responses arrive shifted by
 * one command. Speaking CDP directly is both robust and gives structured data.
 *
 * TypeScript needs nothing extra here: `--experimental-strip-types` erases types
 * in place, so every line keeps its original position and V8's line numbers are
 * already the ones shown in the editor. Only the URL match had to change.
 *
 * Protocol — one JSON object per line, both directions.
 *   in : {"id":1,"cmd":"continue"|"next"|"step"|"out"|"setBreakpoint"|"clearBreakpoint"|"evaluate","arg":…}
 *   out: {"id":1,"state":{…}} | {"id":1,"evaluated":"…"} | {"event":"state","state":{…}}
 *        {"event":"exited","message":"…"} | {"event":"ready","state":{…}}
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const FILE_NAME = process.env.YUMI_FILE || "main.js";
const OUT_FILE = "/work/.out";
const INSPECTOR = "http://127.0.0.1:9229";

/**
 * Breakpoints are matched by a *regex* on the script URL rather than a literal
 * `file:///work/<file>`, because V8 does not register both languages the same
 * way: `main.js` parses as `file:///work/main.js`, but a type-stripped
 * `main.ts` parses as the bare path `/work/main.ts`. A literal URL therefore
 * bound for JavaScript and silently resolved to zero locations for TypeScript —
 * a breakpoint the UI showed but execution ran straight past. A regex anchored
 * on the file name matches either form, and works before the script is parsed.
 */
const FILE_URL_REGEX = `[/\\\\]${FILE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;

const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

/** Source lines of the debuggee, so a paused location can show its own line. */
let sourceLines = [];
try { sourceLines = readFileSync(`/work/${FILE_NAME}`, "utf8").split("\n"); } catch { /* unreadable */ }
const sourceAt = (line) => (sourceLines[line - 1] ?? "").trim();

/** Node's inspector banner goes to the debuggee's stderr — it isn't program output. */
const INSPECTOR_NOISE = /^(Debugger listening on |Debugger ending on |For help, see: https:\/\/nodejs\.org|Debugger attached\.|Waiting for the debugger to disconnect)/;
/** Node's own frames in a crash trace say nothing about the user's program. */
const INTERNAL_FRAME = /^\s+at .*\(?node:internal/;

const readOutput = () => {
  try {
    return readFileSync(OUT_FILE, "utf8")
      .split("\n")
      .filter((l) => !INSPECTOR_NOISE.test(l) && !INTERNAL_FRAME.test(l))
      .join("\n")
      .replace(/\n{2,}/g, "\n")
      .trimStart()
      .slice(-20_000);
  } catch { return ""; }
};

/** Names Node injects into every module's scope — noise, not the user's locals. */
const MODULE_WRAPPER = new Set(["exports", "require", "module", "__filename", "__dirname"]);

/* ------------------------- inspector connection -------------------------- */

/**
 * A debuggee that never starts — a syntax error, or TypeScript that
 * `--experimental-strip-types` refuses (enum, namespace, parameter properties)
 * — writes its error and dies without ever opening the inspector port. Node
 * announces the port before it loads the module, so output that does not begin
 * with that banner means startup failed and waiting out the poll is pointless.
 */
const startupFailure = () => {
  let raw = "";
  try { raw = readFileSync(OUT_FILE, "utf8"); } catch { return null; }
  if (!raw.trim() || /^Debugger listening on /m.test(raw)) return null;
  return raw.trim().split("\n").slice(0, 12).join("\n");
};

async function connect() {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await fetch(`${INSPECTOR}/json/list`).then((r) => r.json());
      const url = list[0]?.webSocketDebuggerUrl;
      if (url) {
        const ws = new WebSocket(url);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        return ws;
      }
    } catch { /* inspector not listening yet */ }
    // Give the debuggee a moment to write anything at all before judging it.
    if (i > 3) {
      const failed = startupFailure();
      if (failed) throw new Error(failed);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the debugger did not start in time");
}

let ws;
try {
  ws = await connect();
} catch (e) {
  // Report it on the protocol rather than dying silently, so the room is told
  // *why* the debugger never came up instead of waiting for a timeout.
  process.stdout.write(JSON.stringify({ event: "exited", message: e?.message ?? "the debugger could not start", output: readOutput() }) + "\n");
  setTimeout(() => process.exit(1), 50);
  await new Promise(() => {});
}

let msgId = 0;
const pending = new Map();
let pauseWaiter = null;
let lastPause = null;
let exited = false;
/**
 * CallFrame.url is empty in practice, so the debuggee's frames are identified
 * by the scriptId reported when V8 parses it.
 */
let userScriptId = null;

ws.onmessage = (m) => {
  let msg;
  try { msg = JSON.parse(m.data); } catch { return; }
  if (msg.id !== undefined) {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message ?? "CDP error")) : p.res(msg.result); }
    return;
  }
  // Match by suffix: the exact URL scheme/prefix varies (notably for
  // type-stripped TypeScript), but the file name is stable.
  if (msg.method === "Debugger.scriptParsed" && msg.params?.url?.endsWith(`/${FILE_NAME}`)) {
    userScriptId = msg.params.scriptId;
  } else if (msg.method === "Debugger.paused") {
    lastPause = msg.params;
    if (pauseWaiter) { const f = pauseWaiter; pauseWaiter = null; f(msg.params); }
  } else if (msg.method === "Runtime.executionContextDestroyed") {
    finish("Program finished");
  }
};
ws.onclose = () => finish("Program finished");

function finish(message) {
  if (exited) return;
  exited = true;
  // Node keeps a dying process alive while an inspector is attached ("Waiting
  // for the debugger to disconnect...") and only writes an uncaught error once
  // it detaches. So let go of the socket first and give the output file a
  // moment to settle — otherwise a program that failed to compile reports the
  // fact that it stopped but never the reason.
  try { ws?.close(); } catch { /* already closing */ }
  setTimeout(() => {
    // Never having paused means the module never executed a line.
    say({ event: "exited", message: lastPause ? message : "The program exited before it could start", output: readOutput() });
    setTimeout(() => process.exit(0), 50);
  }, 300);
}

const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.delete(id)) rej(new Error(`${method} timed out`)); }, 15_000);
});

const nextPause = () => new Promise((res) => {
  if (lastPause) return res(lastPause);
  pauseWaiter = res;
});

/* --------------------------------- state --------------------------------- */

/** line → breakpointId, so a breakpoint can be cleared by line number. */
const breakpoints = new Map();

async function buildState() {
  if (exited) return { status: "exited", file: null, line: null, source: null, stack: [], locals: "", breakpoints: [...breakpoints.keys()].sort((a, b) => a - b), output: readOutput() };
  const frames = (lastPause?.callFrames ?? []).filter((f) => f.location?.scriptId === userScriptId);
  const top = frames[0] ?? lastPause?.callFrames?.[0];
  const line = top ? top.location.lineNumber + 1 : null;

  let locals = "";
  if (top) {
    const scope = top.scopeChain?.find((s) => s.type === "local");
    if (scope?.object?.objectId) {
      try {
        const props = await send("Runtime.getProperties", { objectId: scope.object.objectId, ownProperties: true });
        locals = (props.result ?? [])
          .filter((p) => p.value !== undefined && !MODULE_WRAPPER.has(p.name))
          // Collapse function bodies to a single line so the panel stays readable.
          .map((p) => {
            const v = p.value.description ?? JSON.stringify(p.value.value);
            return `${p.name} = ${p.value.type === "function" ? `function ${p.name}()` : String(v).split("\n")[0]}`;
          })
          .join("\n");
      } catch { /* scope vanished */ }
    }
  }

  return {
    status: "paused",
    file: FILE_NAME,
    line,
    source: line ? sourceAt(line) : null,
    stack: frames.map((f) => ({
      file: FILE_NAME,
      line: f.location.lineNumber + 1,
      func: f.functionName || "<module>",
      source: sourceAt(f.location.lineNumber + 1),
    })),
    locals,
    breakpoints: [...breakpoints.keys()].sort((a, b) => a - b),
    output: readOutput(),
  };
}

/** Run a stepping command and wait for the debuggee to come to rest again. */
async function stepAnd(method) {
  lastPause = null;
  const wait = nextPause();
  await send(method);
  // Either it pauses again, or the program ran to completion.
  const settled = await Promise.race([wait, new Promise((r) => setTimeout(() => r(null), 15_000))]);
  if (!settled && !exited) return { status: "running", file: null, line: null, source: null, stack: [], locals: "", breakpoints: [...breakpoints.keys()], output: readOutput() };
  return buildState();
}

/* --------------------------------- setup --------------------------------- */

await send("Runtime.enable");
await send("Debugger.enable");

const initial = (process.env.YUMI_BREAKPOINTS ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
for (const line of initial) {
  try {
    const r = await send("Debugger.setBreakpointByUrl", { urlRegex: FILE_URL_REGEX, lineNumber: line - 1 });
    breakpoints.set(line, r.breakpointId);
  } catch { /* unresolvable line */ }
}

// --inspect-brk holds the debuggee before its first statement; let it go and
// wait for the resulting "break on start" pause.
const firstPause = nextPause();
await send("Runtime.runIfWaitingForDebugger");
await Promise.race([firstPause, new Promise((r) => setTimeout(r, 10_000))]);
say({ event: "ready", state: await buildState() });

/* ------------------------------ command loop ----------------------------- */

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  let req;
  try { req = JSON.parse(line); } catch { continue; }
  const { id, cmd, arg } = req;
  try {
    if (exited) { say({ id, state: await buildState() }); continue; }
    switch (cmd) {
      case "continue": say({ id, state: await stepAnd("Debugger.resume") }); break;
      case "next": say({ id, state: await stepAnd("Debugger.stepOver") }); break;
      case "step": say({ id, state: await stepAnd("Debugger.stepInto") }); break;
      case "out": say({ id, state: await stepAnd("Debugger.stepOut") }); break;
      case "setBreakpoint": {
        const n = Number(arg);
        if (!breakpoints.has(n)) {
          const r = await send("Debugger.setBreakpointByUrl", { urlRegex: FILE_URL_REGEX, lineNumber: n - 1 });
          breakpoints.set(n, r.breakpointId);
        }
        say({ id, state: await buildState() });
        break;
      }
      case "clearBreakpoint": {
        const n = Number(arg);
        const bpId = breakpoints.get(n);
        if (bpId) { await send("Debugger.removeBreakpoint", { breakpointId: bpId }); breakpoints.delete(n); }
        say({ id, state: await buildState() });
        break;
      }
      case "evaluate": {
        const top = lastPause?.callFrames?.[0];
        if (!top) { say({ id, evaluated: "(not paused)" }); break; }
        const r = await send("Debugger.evaluateOnCallFrame", {
          callFrameId: top.callFrameId, expression: String(arg), silent: true, returnByValue: false,
        });
        const v = r.exceptionDetails
          ? (r.exceptionDetails.exception?.description ?? "error").split("\n")[0]
          : (r.result.description ?? JSON.stringify(r.result.value) ?? "undefined");
        say({ id, evaluated: v });
        break;
      }
      default: say({ id, state: await buildState() });
    }
  } catch (e) {
    say({ id, error: e?.message ?? "command failed" });
  }
}
