/**
 * Code runner — executes user code in an isolated, ephemeral Docker container.
 * Isolation: --network none, memory/cpu/pids caps, dropped caps, no-new-privileges,
 * hard timeout, forced removal. See rules.md §3.5 (sandbox is hostile-by-default).
 * Supports JS, TS, Python, Java, C/C++, Go, Rust.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

interface Runtime {
  image: string;
  file: string;
  cmd: string[];
  memory?: string;   // default 256m
  timeoutMs?: number; // default 10s
}

const RUNTIMES: Record<string, Runtime> = {
  javascript: { image: "node:22-alpine", file: "main.js", cmd: ["node", "main.js"] },
  typescript: { image: "node:22-alpine", file: "main.ts", cmd: ["node", "--experimental-strip-types", "main.ts"] },
  python: { image: "python:3.12-alpine", file: "main.py", cmd: ["python", "main.py"] },
  java: {
    image: "eclipse-temurin:21-jdk-alpine", file: "Main.java", cmd: ["java", "Main.java"],
    memory: "512m", timeoutMs: 25_000,
  },
  cpp: {
    image: "gcc:14", file: "main.cpp",
    cmd: ["sh", "-c", "g++ -O2 -std=c++20 main.cpp -o app 2>&1 && ./app"],
    memory: "512m", timeoutMs: 25_000,
  },
  go: {
    image: "golang:1.23-alpine", file: "main.go",
    cmd: ["sh", "-c", "go mod init app >/dev/null 2>&1; go run ."],
    memory: "512m", timeoutMs: 25_000,
  },
  rust: {
    image: "rust:1-alpine", file: "main.rs",
    cmd: ["sh", "-c", "rustc -O main.rs -o app 2>&1 && ./app"],
    memory: "512m", timeoutMs: 25_000,
  },
};

const OUTPUT_CAP = 100_000; // 100 KB

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}

export function canRun(language: string): boolean {
  return language in RUNTIMES;
}

/** Whether the runtime image is already pulled locally (avoids a slow first-run pull). */
function imageReady(image: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("docker", ["image", "inspect", image], { stdio: "ignore" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

/** Run `code` as file `rt.file` in an isolated container with `rt.cmd`. */
async function execInContainer(rt: Runtime, code: string, prefix: string): Promise<RunResult> {
  const timeoutMs = rt.timeoutMs ?? 10_000;
  const memory = rt.memory ?? "256m";
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const name = `${prefix}${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(path.join(dir, rt.file), code, "utf8");

    const args = [
      "run", "--rm", "--name", name,
      "--network", "none",
      "--memory", memory, "--cpus", "1", "--pids-limit", "256",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "-v", `${dir}:/work`, "-w", "/work",
      rt.image, ...rt.cmd,
    ];

    return await new Promise<RunResult>((resolve) => {
      const proc = spawn("docker", args);
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        spawn("docker", ["rm", "-f", name]);
        proc.kill("SIGKILL");
      }, timeoutMs);

      proc.stdout.on("data", (d) => { if (stdout.length < OUTPUT_CAP) stdout += d.toString(); });
      proc.stderr.on("data", (d) => { if (stderr.length < OUTPUT_CAP) stderr += d.toString(); });

      proc.on("close", (exitCode) => {
        clearTimeout(timer);
        if (stdout.length >= OUTPUT_CAP) stdout = stdout.slice(0, OUTPUT_CAP) + "\n…[output truncated]";
        if (stderr.length >= OUTPUT_CAP) stderr = stderr.slice(0, OUTPUT_CAP) + "\n…[output truncated]";
        resolve({ ok: exitCode === 0 && !timedOut, stdout, stderr, exitCode, timedOut });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, stdout, stderr, exitCode: null, timedOut, error: err.message });
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runCode(language: string, code: string): Promise<RunResult> {
  const rt = RUNTIMES[language];
  if (!rt) return { ok: false, stdout: "", stderr: "", exitCode: null, timedOut: false, error: `Cannot run "${language}"` };
  if (!(await imageReady(rt.image))) {
    return {
      ok: false, stdout: "", stderr: "", exitCode: null, timedOut: false,
      error: `The ${language} runtime is still being prepared (downloading ${rt.image}). Try again in a moment.`,
    };
  }
  return execInContainer(rt, code, "yumi-run-");
}

/* ------------------------------- Tests ---------------------------------- */

/**
 * Test runtimes use each language's built-in / zero-dependency test runner so a
 * single self-contained file (code + inline tests) can be verified in the same
 * sandbox as runCode. `parse` best-effort extracts pass/fail counts; the exit
 * code is the source of truth for overall pass/fail.
 */
interface TestRuntime extends Runtime {
  parse: (out: string) => { passed: number; failed: number; total: number };
}

const num = (re: RegExp, s: string): number | null => { const m = s.match(re); return m ? Number(m[1]) : null; };

const TEST_RUNTIMES: Record<string, TestRuntime> = {
  javascript: {
    image: "node:22-alpine", file: "main.test.mjs", cmd: ["node", "--test", "main.test.mjs"],
    parse: (o) => { const p = num(/^# pass (\d+)/m, o) ?? 0, f = num(/^# fail (\d+)/m, o) ?? 0; return { passed: p, failed: f, total: num(/^# tests (\d+)/m, o) ?? p + f }; },
  },
  typescript: {
    image: "node:22-alpine", file: "main.test.mts", cmd: ["node", "--experimental-strip-types", "--test", "main.test.mts"],
    parse: (o) => { const p = num(/^# pass (\d+)/m, o) ?? 0, f = num(/^# fail (\d+)/m, o) ?? 0; return { passed: p, failed: f, total: num(/^# tests (\d+)/m, o) ?? p + f }; },
  },
  python: {
    image: "python:3.12-alpine", file: "test_main.py", cmd: ["python", "-m", "unittest", "test_main", "-v"],
    parse: (o) => {
      const total = num(/Ran (\d+) test/m, o) ?? 0;
      const failed = (num(/failures=(\d+)/, o) ?? 0) + (num(/errors=(\d+)/, o) ?? 0);
      return { passed: Math.max(0, total - failed), failed, total };
    },
  },
  go: {
    image: "golang:1.23-alpine", file: "main_test.go",
    cmd: ["sh", "-c", "go mod init app >/dev/null 2>&1; go test -v ./..."],
    memory: "512m", timeoutMs: 25_000,
    parse: (o) => { const passed = (o.match(/--- PASS:/g) ?? []).length, failed = (o.match(/--- FAIL:/g) ?? []).length; return { passed, failed, total: passed + failed }; },
  },
  rust: {
    image: "rust:1-alpine", file: "main.rs",
    cmd: ["sh", "-c", "rustc --test -O main.rs -o app 2>&1 && ./app"],
    memory: "512m", timeoutMs: 25_000,
    parse: (o) => { const passed = num(/(\d+) passed/, o) ?? 0, failed = num(/(\d+) failed/, o) ?? 0; return { passed, failed, total: passed + failed }; },
  },
};

export function canTest(language: string): boolean {
  return language in TEST_RUNTIMES;
}

export interface TestResult extends RunResult {
  passed: number;
  failed: number;
  total: number;
}

export async function runTests(language: string, code: string): Promise<TestResult> {
  const rt = TEST_RUNTIMES[language];
  if (!rt) return { ok: false, stdout: "", stderr: "", exitCode: null, timedOut: false, passed: 0, failed: 0, total: 0, error: `Cannot test "${language}"` };
  if (!(await imageReady(rt.image))) {
    return {
      ok: false, stdout: "", stderr: "", exitCode: null, timedOut: false, passed: 0, failed: 0, total: 0,
      error: `The ${language} runtime is still being prepared (downloading ${rt.image}). Try again in a moment.`,
    };
  }
  const r = await execInContainer(rt, code, "yumi-test-");
  const counts = rt.parse(`${r.stdout}\n${r.stderr}`);
  return { ...r, ...counts };
}

/* ---------------------------- Perf profiling ----------------------------- */

/**
 * Perf runs the file N times inside ONE container and measures each execution.
 * Compilation happens once and is timed separately, so compiled languages are
 * measured on their runtime cost rather than their build cost. Reusing a single
 * container also keeps container-startup latency (~200-500ms) out of the samples.
 *
 * Metrics come from whatever the image already ships — nothing is installed
 * (the sandbox has --network none):
 *   "busybox" — alpine images; `time -v` reports wall/user/sys/CPU%/max-RSS.
 *   "bash"    — Debian images (gcc:14) have no `time` binary and dash has no
 *               `time` builtin, so we use bash's `time` keyword + TIMEFORMAT.
 *               It reports wall/user/sys but NO max-RSS (memoryAvailable=false).
 */
interface PerfRuntime {
  image: string;
  file: string;
  compile?: string;   // run once, timed separately, excluded from samples
  exec: string;       // run once per iteration, this is what gets measured
  metrics: "busybox" | "bash";
  memory?: string;
  baseMs?: number;    // time allowance for startup + compile
  perIterMs?: number; // time allowance per measured iteration
}

const PERF_RUNTIMES: Record<string, PerfRuntime> = {
  javascript: {
    image: "node:22-alpine", file: "main.js", exec: "node main.js", metrics: "busybox",
  },
  typescript: {
    image: "node:22-alpine", file: "main.ts",
    exec: "node --experimental-strip-types main.ts", metrics: "busybox",
  },
  python: {
    image: "python:3.12-alpine", file: "main.py", exec: "python main.py", metrics: "busybox",
  },
  java: {
    image: "eclipse-temurin:21-jdk-alpine", file: "Main.java",
    compile: "javac Main.java", exec: "java Main", metrics: "busybox",
    memory: "512m", baseMs: 40_000, perIterMs: 8_000,
  },
  cpp: {
    image: "gcc:14", file: "main.cpp",
    compile: "g++ -O2 -std=c++20 main.cpp -o app", exec: "./app", metrics: "bash",
    memory: "512m", baseMs: 40_000, perIterMs: 8_000,
  },
  go: {
    image: "golang:1.23-alpine", file: "main.go",
    compile: "go mod init app >/dev/null 2>&1; go build -o app .", exec: "./app",
    metrics: "busybox", memory: "512m", baseMs: 45_000, perIterMs: 8_000,
  },
  rust: {
    image: "rust:1-alpine", file: "main.rs",
    compile: "rustc -O main.rs -o app", exec: "./app", metrics: "busybox",
    memory: "512m", baseMs: 45_000, perIterMs: 8_000,
  },
};

export function canProfile(language: string): boolean {
  return language in PERF_RUNTIMES;
}

export interface PerfSample {
  wallMs: number;
  userMs: number;
  sysMs: number;
  cpuPct: number | null;
  maxRssKb: number | null;
}

export interface PerfResult extends RunResult {
  samples: PerfSample[];
  iterations: number;
  bestMs: number;
  medianMs: number;
  meanMs: number;
  worstMs: number;
  stdDevMs: number;
  userMs: number;
  sysMs: number;
  cpuPct: number | null;
  maxRssKb: number | null;
  memoryAvailable: boolean;
  compileMs: number | null;
}

// Markers keep the timing reports, program output and build log unambiguous even
// when the program itself prints marker-like text (its output is captured to a
// file and only replayed after the last iteration).
const M = { iter: "@@Y_ITER@@", compile: "@@Y_COMPILE@@", buildFail: "@@Y_BUILDFAIL@@", out: "@@Y_OUT@@", err: "@@Y_ERR@@", time: "@@Y_T@@", exit: "@@Y_EXIT@@" };

/** Heredoc-wrap a command so no quoting/escaping of user-facing commands is needed. */
function scriptFile(pathname: string, redirect: string, body: string): string {
  return `cat > ${pathname} <<'YUMIEOF'\nexec ${redirect}\n${body}\nYUMIEOF\n`;
}

function buildPerfScript(rt: PerfRuntime, iterations: number): string {
  const busybox = rt.metrics === "busybox";
  // The measured unit is `sh <script>`; a lone command is exec'd by sh, so no
  // extra process survives to distort max-RSS.
  const timed = (target: string) =>
    busybox ? `time -v sh ${target}` : `time sh ${target}`;

  let s = "";
  if (!busybox) s += `TIMEFORMAT='${M.time} %3R %3U %3S'\n`;

  if (rt.compile) {
    s += scriptFile("/work/.build.sh", ">/work/.build 2>&1", rt.compile);
    s += `echo '${M.compile}' >&2\n`;
    s += `${timed("/work/.build.sh")}\n`;
    s += `if [ $? -ne 0 ]; then echo '${M.buildFail}'; cat /work/.build; exit 90; fi\n`;
  }

  s += scriptFile("/work/.exec.sh", ">/work/.out 2>/work/.err", rt.exec);
  s += `last=0\ni=0\nwhile [ $i -lt ${iterations} ]; do\n`;
  s += `  echo '${M.iter}' >&2\n`;
  s += `  ${timed("/work/.exec.sh")}\n`;
  s += `  last=$?\n`;
  s += `  if [ $last -ne 0 ]; then break; fi\n`;
  s += `  i=$((i+1))\n`;
  s += `done\n`;
  s += `echo "${M.exit} $last" >&2\n`;
  // Replay the final iteration's own output after all measurements are done.
  s += `echo '${M.out}'\ncat /work/.out 2>/dev/null\necho '${M.err}'\ncat /work/.err 2>/dev/null\n`;
  return s;
}

const numAfter = (re: RegExp, s: string): number | null => {
  const m = s.match(re);
  return m ? Number(m[1]) : null;
};

/**
 * Strip our markers and the `time` report itself out of a stderr stream, so a
 * fallback error never shows the user scaffolding they didn't write.
 */
function stripPerfScaffolding(s: string): string {
  const markers = Object.values(M);
  return s
    .split("\n")
    .filter((line) => !line.startsWith("\t")
      && !/^Command (exited with|being timed)/.test(line)
      && !markers.some((m) => line.trimStart().startsWith(m)))
    .join("\n")
    .trim();
}

/**
 * busybox/GNU `time -v` elapsed field. Seen as "0m 0.04s" (busybox) and
 * "0:00.04" / "1:02:03" (GNU); accept all three.
 */
function parseElapsedMs(s: string): number | null {
  let m = s.match(/(\d+)m\s*([\d.]+)s/);
  if (m) return (Number(m[1]) * 60 + Number(m[2])) * 1000;
  m = s.match(/(?:(\d+):)?(\d+):([\d.]+)/);
  if (m) {
    const h = m[1] ? Number(m[1]) : 0;
    return (h * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
  }
  return null;
}

function parseBusyboxBlock(block: string): PerfSample | null {
  const wallMs = parseElapsedMs((block.match(/Elapsed \(wall clock\)[^:]*:\s*(.+)/) ?? [])[1] ?? "");
  const user = numAfter(/User time \(seconds\):\s*([\d.]+)/, block);
  const sys = numAfter(/System time \(seconds\):\s*([\d.]+)/, block);
  if (wallMs === null && user === null) return null;
  return {
    wallMs: wallMs ?? 0,
    userMs: (user ?? 0) * 1000,
    sysMs: (sys ?? 0) * 1000,
    cpuPct: numAfter(/Percent of CPU this job got:\s*(\d+)%/, block),
    maxRssKb: numAfter(/Maximum resident set size \(kbytes\):\s*(\d+)/, block),
  };
}

function parseBashBlock(block: string): PerfSample | null {
  const m = block.match(new RegExp(`${M.time}\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)`));
  if (!m) return null;
  const wallMs = Number(m[1]) * 1000, userMs = Number(m[2]) * 1000, sysMs = Number(m[3]) * 1000;
  return {
    wallMs, userMs, sysMs,
    cpuPct: wallMs > 0 ? Math.round(((userMs + sysMs) / wallMs) * 100) : null,
    maxRssKb: null, // bash's `time` keyword has no getrusage max-RSS
  };
}

function summarize(samples: PerfSample[]) {
  const w = samples.map((s) => s.wallMs).sort((a, b) => a - b);
  const mean = w.reduce((a, b) => a + b, 0) / w.length;
  const mid = Math.floor(w.length / 2);
  const median = w.length % 2 ? w[mid] : (w[mid - 1] + w[mid]) / 2;
  const variance = w.reduce((a, b) => a + (b - mean) ** 2, 0) / w.length;
  return {
    bestMs: w[0], worstMs: w[w.length - 1], medianMs: median, meanMs: mean,
    stdDevMs: Math.sqrt(variance),
  };
}

const emptyPerf = (error: string): PerfResult => ({
  ok: false, stdout: "", stderr: "", exitCode: null, timedOut: false, error,
  samples: [], iterations: 0, bestMs: 0, medianMs: 0, meanMs: 0, worstMs: 0, stdDevMs: 0,
  userMs: 0, sysMs: 0, cpuPct: null, maxRssKb: null, memoryAvailable: false, compileMs: null,
});

export async function runPerf(language: string, code: string, iterations = 5): Promise<PerfResult> {
  const rt = PERF_RUNTIMES[language];
  if (!rt) return emptyPerf(`Cannot profile "${language}"`);
  if (!(await imageReady(rt.image))) {
    return emptyPerf(`The ${language} runtime is still being prepared (downloading ${rt.image}). Try again in a moment.`);
  }
  const n = Math.max(1, Math.min(20, Math.floor(iterations) || 5));
  const timeoutMs = Math.min(120_000, (rt.baseMs ?? 15_000) + n * (rt.perIterMs ?? 6_000));

  const r = await execInContainer(
    {
      image: rt.image,
      file: rt.file,
      cmd: [rt.metrics === "busybox" ? "sh" : "bash", "-c", buildPerfScript(rt, n)],
      memory: rt.memory,
      timeoutMs,
    },
    code,
    "yumi-perf-",
  );

  // Split the program's replayed output back out of the marker stream.
  const outIdx = r.stdout.indexOf(M.out);
  const errIdx = r.stdout.indexOf(M.err);
  const buildFailed = r.stdout.includes(M.buildFail);
  const progStdout = outIdx >= 0 && errIdx > outIdx ? r.stdout.slice(outIdx + M.out.length, errIdx).replace(/^\n/, "") : "";
  const progStderr = errIdx >= 0 ? r.stdout.slice(errIdx + M.err.length).replace(/^\n/, "") : "";
  const buildLog = buildFailed ? r.stdout.slice(r.stdout.indexOf(M.buildFail) + M.buildFail.length).trim() : "";

  if (buildFailed) {
    return { ...emptyPerf("Compilation failed"), stderr: buildLog, exitCode: 90, stdout: "" };
  }
  if (r.timedOut) {
    return { ...emptyPerf(`Timed out after ${Math.round(timeoutMs / 1000)}s — try fewer iterations or lighter work.`), timedOut: true };
  }

  const parse = rt.metrics === "busybox" ? parseBusyboxBlock : parseBashBlock;
  const blocks = r.stderr.split(M.iter);
  const compileMs = rt.compile && blocks[0]?.includes(M.compile)
    ? (parse(blocks[0].split(M.compile)[1] ?? "")?.wallMs ?? null)
    : null;
  const samples = blocks.slice(1).map(parse).filter((s): s is PerfSample => s !== null);
  const exitCode = numAfter(new RegExp(`${M.exit} (-?\\d+)`), r.stderr) ?? r.exitCode;

  // A crashed iteration is still timed by `time`, but timings for a run that
  // didn't complete would be misleading — report the failure, not a median.
  if (exitCode !== 0) {
    return {
      ...emptyPerf(`The program exited with code ${exitCode} — perf needs a successful run.`),
      stdout: progStdout, stderr: progStderr || stripPerfScaffolding(r.stderr).slice(0, 4000), exitCode, compileMs,
    };
  }
  if (samples.length === 0) {
    return {
      ...emptyPerf("Could not parse timing output."),
      stdout: progStdout, stderr: progStderr || stripPerfScaffolding(r.stderr).slice(0, 4000), exitCode, compileMs,
    };
  }

  const agg = summarize(samples);
  const rss = samples.map((s) => s.maxRssKb).filter((v): v is number => v !== null);
  return {
    ok: exitCode === 0,
    stdout: progStdout,
    stderr: progStderr,
    exitCode,
    timedOut: false,
    samples,
    iterations: samples.length,
    ...agg,
    userMs: samples.reduce((a, s) => a + s.userMs, 0) / samples.length,
    sysMs: samples.reduce((a, s) => a + s.sysMs, 0) / samples.length,
    cpuPct: samples[0].cpuPct !== null
      ? Math.round(samples.reduce((a, s) => a + (s.cpuPct ?? 0), 0) / samples.length)
      : null,
    maxRssKb: rss.length ? Math.max(...rss) : null,
    memoryAvailable: rss.length > 0,
    compileMs,
  };
}
