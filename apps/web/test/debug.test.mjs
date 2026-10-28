/**
 * Collaborative debugging, end-to-end against real Docker — all seven languages
 * the sandbox can run.
 *
 * Each language gets the same program (a `main` that computes `add(x, y)` and
 * prints), so the same assertions apply to all of them: pause on the first line,
 * run to a breakpoint on a known line, read the stack and locals, evaluate an
 * expression, step, then run to completion and see the program's own output.
 *
 * Two clients join every session, because the feature is a debugger the whole
 * room watches rather than one each: the second socket must receive the same
 * state without having sent a command.
 *
 * Needs Mongo + Redis (pnpm infra:up), Docker, and the debug images:
 *   pnpm --filter @yumi/server sandbox:build
 *   node apps/web/test/debug.test.mjs [language …]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { io } from "socket.io-client";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../server");
const PORT = 4121;
const BASE = `http://localhost:${PORT}`;
const uid = Date.now();

let pass = 0, fail = 0;
const check = (ok, label, extra = "") => {
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------- programs -------------------------------- */

/**
 * `bp` is the line calling add(); `stepTo` is where a single `next` from there
 * lands. Both are counted from 1 in the source below.
 */
const PROGRAMS = {
  python: {
    file: "main.py", bp: 9, stepTo: 10, func: "main",
    code: `def add(a, b):
    s = a + b
    return s

def main():
    x = 2
    y = 40
    print("hello")
    z = add(x, y)
    print("z=", z)

main()
`,
  },
  javascript: {
    file: "main.js", bp: 10, stepTo: 11, func: "main",
    code: `function add(a, b) {
  const s = a + b;
  return s;
}

function main() {
  const x = 2;
  const y = 40;
  console.log("hello");
  const z = add(x, y);
  console.log("z=", z);
}

main();
`,
  },
  typescript: {
    file: "main.ts", bp: 10, stepTo: 11, func: "main",
    code: `function add(a: number, b: number): number {
  const s: number = a + b;
  return s;
}

function main(): void {
  const x: number = 2;
  const y: number = 40;
  console.log("hello");
  const z: number = add(x, y);
  console.log("z=", z);
}

main();
`,
  },
  java: {
    file: "Main.java", bp: 10, stepTo: 11, func: "main",
    code: `public class Main {
  static int add(int a, int b) {
    int s = a + b;
    return s;
  }
  public static void main(String[] args) {
    int x = 2;
    int y = 40;
    System.out.println("hello");
    int z = add(x, y);
    System.out.println("z=" + z);
  }
}
`,
  },
  cpp: {
    file: "main.cpp", bp: 12, stepTo: 13, func: "main",
    code: `#include <cstdio>

int add(int a, int b) {
  int s = a + b;
  return s;
}

int main() {
  int x = 2;
  int y = 40;
  printf("hello\\n");
  int z = add(x, y);
  printf("z=%d\\n", z);
  return 0;
}
`,
  },
  go: {
    file: "main.go", bp: 14, stepTo: 15, func: "main.main",
    code: `package main

import "fmt"

func add(a int, b int) int {
	s := a + b
	return s
}

func main() {
	x := 2
	y := 40
	fmt.Println("hello")
	z := add(x, y)
	fmt.Println("z=", z)
}
`,
  },
  rust: {
    file: "main.rs", bp: 10, stepTo: 11, func: "main::main",
    code: `fn add(a: i32, b: i32) -> i32 {
    let s = a + b;
    s
}

fn main() {
    let x = 2;
    let y = 40;
    println!("hello");
    let z = add(x, y);
    println!("z={}", z);
}
`,
  },
};

/* -------------------------------- server --------------------------------- */

let child = null;
let serverLog = "";

async function startServer() {
  child = spawn("node", ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT), CALL_MODE: "mesh", REGION: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { serverLog += d.toString(); });
  child.stderr.on("data", (d) => { serverLog += d.toString(); });
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${serverLog}`);
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not up */ }
    await wait(200);
  }
  throw new Error(`server did not start:\n${serverLog}`);
}
const stopServer = () => { try { child?.kill("SIGKILL"); } catch { /* gone */ } };

const req = async (method, p, body, token) => {
  const r = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${await r.text()}`);
  return r.json();
};

/* -------------------------------- clients -------------------------------- */

function connect(token, projectId) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, forceNew: true, transports: ["websocket"] });
    const states = [];
    s.on("debug:state", (m) => states.push(m.state));
    s.on("connect", () => s.emit("join", { projectId }));
    s.on("joined", () => resolve({ s, states, last: () => states[states.length - 1] }));
    s.on("connect_error", reject);
    setTimeout(() => reject(new Error("join timed out")), 10_000);
  });
}

/** Send a debug command and wait for the state that answers it. */
function drive(client, event, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const before = client.states.length;
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeoutMs);
    const tick = setInterval(() => {
      if (client.states.length > before) {
        clearInterval(tick); clearTimeout(timer);
        resolve(client.last());
      }
    }, 100);
    client.s.once("debug:error", (e) => {
      clearInterval(tick); clearTimeout(timer);
      reject(new Error(e.error));
    });
    client.s.emit(event, payload);
  });
}

function evaluate(client, expression, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("evaluate timed out")), timeoutMs);
    client.s.once("debug:evaluated", (m) => { clearTimeout(timer); resolve(m.value); });
    client.s.emit("debug:command", { cmd: "evaluate", arg: expression });
  });
}

/** Wait until a predicate holds over the room's shared state, or give up. */
async function until(client, pred, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = client.last();
    if (s && pred(s)) return s;
    await wait(150);
  }
  throw new Error(`${label}: gave up after ${timeoutMs}ms (last: ${JSON.stringify(client.last())?.slice(0, 300)})`);
}

/* --------------------------------- suite --------------------------------- */

/**
 * Clear the sandbox run budget between languages.
 *
 * Starting a debug session costs 5 of the 15-per-minute budget a user has for
 * running code, because it holds a container for as long as it lives. Three
 * languages therefore exhaust it, and the fourth is refused — which is the rate
 * limiter working. Resetting keeps the suite measuring debuggers.
 */
async function clearRunBudget() {
  const { default: Redis } = await import(path.join(SERVER_DIR, "node_modules/ioredis/built/index.js"));
  const r = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  const keys = await r.keys("ratelimit:run:*");
  if (keys.length) await r.del(...keys);
  await r.quit();
}

let isolationChecked = false;

/** The live debug container's docker config, for the isolation assertions. */
async function inspectDebugContainer() {
  const names = await new Promise((resolve) => {
    const ps = spawn("docker", ["ps", "--filter", "name=yumi-dbg-", "--format", "{{.Names}}"]);
    let out = ""; ps.stdout.on("data", (d) => { out += d.toString(); });
    ps.on("close", () => resolve(out.trim().split("\n").filter(Boolean)));
  });
  if (!names.length) return null;
  return new Promise((resolve) => {
    const insp = spawn("docker", ["inspect", names[0]]);
    let out = ""; insp.stdout.on("data", (d) => { out += d.toString(); });
    insp.on("close", () => { try { resolve(JSON.parse(out)[0]); } catch { resolve(null); } });
  });
}

async function runLanguage(language, token, workspaceId) {
  const p = PROGRAMS[language];
  console.log(`\n── ${language} ──`);
  await clearRunBudget();
  const { project } = await req("POST", "/api/projects",
    { workspaceId, name: `dbg-${language}`, type: "code" }, token);
  const driver = await connect(token, project._id);
  const watcher = await connect(token, project._id);

  try {
    // Start paused on the first line, with one breakpoint already set.
    const started = await drive(driver, "debug:start", {
      language, code: p.code, fileName: p.file, breakpoints: [p.bp],
    }, 180_000);
    check(started.status === "paused" && typeof started.line === "number",
      "starts paused before the first line runs", JSON.stringify(started).slice(0, 200));
    check(started.breakpoints.includes(p.bp),
      "the breakpoint set at start is listed", JSON.stringify(started.breakpoints));

    // Run to the breakpoint.
    await drive(driver, "debug:command", { cmd: "continue" }, 60_000);
    const atBp = await until(driver, (s) => s.line === p.bp, 30_000, "run to breakpoint");
    check(atBp.line === p.bp, `stops on the breakpoint (line ${p.bp})`, `line=${atBp.line}`);
    check(typeof atBp.source === "string" && atBp.source.includes("add"),
      "and reports the source of the paused line", JSON.stringify(atBp.source));

    check(atBp.stack.length > 0 && atBp.stack[0].file === p.file,
      "the call stack names the project's own file", JSON.stringify(atBp.stack).slice(0, 200));
    check(atBp.stack[0].line === p.bp && atBp.stack[0].func.includes(p.func.split(".").pop()),
      "and its innermost frame is where execution is", JSON.stringify(atBp.stack[0]));

    check(/\bx\b/.test(atBp.locals) && /\b2\b/.test(atBp.locals),
      "locals show the variables in scope", JSON.stringify(atBp.locals).slice(0, 200));

    // rules.md §6.4 — a sandbox change needs an isolation test. The debug images
    // are new (they carry a debugger the stock images do not), so confirm once,
    // against a live session, that they are still confined exactly as the runner
    // confines everything else. Checked while paused, because that is the only
    // moment the container is guaranteed to exist.
    if (!isolationChecked) {
      isolationChecked = true;
      const cfg = await inspectDebugContainer();
      check(cfg?.HostConfig?.NetworkMode === "none",
        "the debug container has no network", JSON.stringify(cfg?.HostConfig?.NetworkMode));
      check(Array.isArray(cfg?.HostConfig?.CapDrop) && cfg.HostConfig.CapDrop.includes("ALL"),
        "all capabilities are dropped", JSON.stringify(cfg?.HostConfig?.CapDrop));
      check((cfg?.HostConfig?.SecurityOpt ?? []).includes("no-new-privileges"),
        "privileges cannot be escalated", JSON.stringify(cfg?.HostConfig?.SecurityOpt));
      check(cfg?.HostConfig?.Memory > 0 && cfg?.HostConfig?.PidsLimit > 0,
        "memory and pid ceilings are set",
        `mem=${cfg?.HostConfig?.Memory} pids=${cfg?.HostConfig?.PidsLimit}`);
    }

    // The whole room sees the same thing without having asked.
    const seen = watcher.last();
    check(seen?.line === p.bp && seen?.status === "paused",
      "the second client sees the same paused state", JSON.stringify(seen)?.slice(0, 160));

    // An evaluation goes only to the asker.
    const watcherEvals = [];
    watcher.s.on("debug:evaluated", (m) => watcherEvals.push(m));
    const value = await evaluate(driver, "x");
    check(/\b2\b/.test(value), "an expression evaluates in the paused frame", JSON.stringify(value));
    await wait(300);
    check(watcherEvals.length === 0,
      "and the answer is private to whoever asked", JSON.stringify(watcherEvals));

    // Step over one line.
    await drive(driver, "debug:command", { cmd: "next" }, 60_000);
    const stepped = await until(driver, (s) => s.line !== p.bp || s.status === "exited", 30_000, "step");
    check(stepped.line === p.stepTo,
      `stepping over lands on the next line (${p.stepTo})`, `line=${stepped.line}`);

    // Clearing a breakpoint must actually stop it firing — the program passes
    // this line only once, so removal is checked by running to completion.
    await drive(driver, "debug:command", { cmd: "clearBreakpoint", arg: p.bp }, 30_000);
    check(!driver.last().breakpoints.includes(p.bp), "a cleared breakpoint leaves the list");

    // Run to the end and collect the program's own output.
    await drive(driver, "debug:command", { cmd: "continue" }, 60_000);
    const done = await until(driver, (s) => s.status === "exited", 60_000, "run to completion");
    check(done.status === "exited", "the session ends when the program does", done.status);
    check(/hello/.test(done.output) && /z=\s*42/.test(done.output),
      "the program's own output reached the room", JSON.stringify(done.output).slice(0, 200));
  } finally {
    driver.s.close();
    watcher.s.close();
  }
}

async function main() {
  const only = process.argv.slice(2);
  const languages = only.length ? only : Object.keys(PROGRAMS);

  await startServer();
  const reg = await req("POST", "/api/auth/register", {
    email: `dbg${uid}@yumi.dev`, password: "password123", displayName: "Debugger",
  });
  const token = reg.accessToken;
  const { workspace } = await req("POST", "/api/workspaces", { name: "Debug" }, token);

  for (const language of languages) {
    try {
      await runLanguage(language, token, workspace._id);
    } catch (e) {
      fail++;
      console.log(`  ❌ ${language} failed outright — ${e.message}`);
    }
  }

  // Nothing may be left holding a container: a debug session lives as long as
  // the room, so a leak here is a machine slowly filling up.
  await wait(2000);
  const leaked = await new Promise((resolve) => {
    const ps = spawn("docker", ["ps", "--filter", "name=yumi-dbg-", "--format", "{{.Names}}"]);
    let out = ""; ps.stdout.on("data", (d) => { out += d.toString(); });
    ps.on("close", () => resolve(out.trim()));
  });
  console.log("");
  check(leaked === "", "no debug container is left running", leaked);

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail === 0;
}

main()
  .then((good) => { stopServer(); process.exit(good ? 0 : 1); })
  .catch((e) => { console.error(e); console.error(serverLog.slice(-1500)); stopServer(); process.exit(1); });
