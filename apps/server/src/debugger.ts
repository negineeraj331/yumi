/**
 * Collaborative debugging — a shared, stepped execution that every participant
 * in a session watches at once.
 *
 * A debug session is a long-lived container (unlike runner.ts, which is
 * one-shot) holding a stdio debugger. Commands are written to its stdin and
 * responses are read back by waiting for the debugger's prompt, so exactly one
 * command is ever in flight. Isolation matches the runner: --network none,
 * capped memory/cpu/pids, dropped caps, no-new-privileges, forced removal.
 *
 * Two backends, one wire protocol:
 *   Python, Java  — stdlib `pdb` / the JDK's `jdb`, driven over the container's
 *                   stdio (Adapter below).
 *   JS/TypeScript — a harness inside the container speaking CDP to V8's
 *                   inspector over loopback (CdpDebugSession + debugHarness.mjs).
 * Neither installs anything and neither needs network access. That constraint is
 * also why C++, Go and Rust are missing: their images ship no debugger, and one
 * cannot be fetched into a sandbox that has no network.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** Hard ceiling on a debug session, so an abandoned one can't hold a container forever. */
const SESSION_TTL_MS = 20 * 60 * 1000;
/** A single command should never take this long; if it does, the session is wedged. */
const COMMAND_TIMEOUT_MS = 20_000;
const OUTPUT_CAP = 20_000;

export interface StackFrame { file: string; line: number; func: string; source: string }

export interface DebugState {
  status: "starting" | "paused" | "running" | "exited";
  file: string | null;
  line: number | null;
  source: string | null;
  stack: StackFrame[];
  locals: string;
  breakpoints: number[];
  /** Program stdout/stderr produced since the session started. */
  output: string;
  exitMessage?: string;
}

/** Where a debugger's prompt sits in the stream: `[start, end)`. */
interface PromptMatch { start: number; end: number }

interface Adapter {
  image: string;
  file: string;
  cmd: string[];
  memory: string;
  /** Longer than a command timeout where the debugger has to compile first. */
  startupTimeoutMs?: number;
  /**
   * Commands that bring the program to its first stop, run after the initial
   * breakpoints are set. pdb halts on its own; jdb has to be told to start.
   */
  begin?: { cmd: string; executes: boolean }[];
  /**
   * Find the prompt that means "this command is done" — the whole reason a
   * stdio debugger can be driven one command at a time. `executing` is true for
   * commands that run user code, which some debuggers acknowledge with an idle
   * prompt *before* the program actually comes to rest; those must keep waiting
   * for the prompt that means suspended.
   */
  findPrompt(buf: string, executing: boolean): PromptMatch | null;
  /** Translate a protocol command into debugger-native syntax. */
  translate(cmd: string, arg?: string | number): string | null;
  /** True once the program is no longer executing. */
  isFinished(chunk: string): boolean;
  /** Remove the debugger's own status lines, leaving the debuggee's output. */
  stripDebuggerChatter(chunk: string): string;
  /** Both return locations already named as the project sees them. */
  parseLocation(chunk: string): { file: string; line: number; func: string; source: string } | null;
  parseStack(chunk: string): StackFrame[];
}

/* --------------------------------- Python -------------------------------- */

// "> /work/main.py(12)funcname()" followed by "-> source line"
const PDB_LOC = /^> ([^(]+)\((\d+)\)([^(]*)\(\)/m;
const PDB_PROMPT = "(Pdb) ";
/** Frames outside the mounted work directory belong to the debugger, not the user. */
const IN_WORK = /^\/work\//;

const pythonAdapter: Adapter = {
  image: "python:3.12-alpine",
  file: "main.py",
  // -u so the debuggee's own prints aren't buffered behind the prompt.
  cmd: ["python", "-u", "-m", "pdb", "main.py"],
  memory: "256m",
  // pdb prints its prompt only once the program has actually stopped, so an
  // executing command needs no special handling.
  findPrompt(buf) {
    const i = buf.lastIndexOf(PDB_PROMPT);
    return i === -1 ? null : { start: i, end: i + PDB_PROMPT.length };
  },
  translate(cmd, arg) {
    switch (cmd) {
      case "continue": return "continue";
      case "next": return "next";       // step over
      case "step": return "step";       // step into
      case "out": return "return";      // run to end of frame
      case "setBreakpoint": return `break ${arg}`;
      // `clear <n>` means breakpoint *number*; address it by file:line instead.
      case "clearBreakpoint": return `clear ${this.file}:${arg}`;
      case "evaluate": return `p ${arg}`;
      case "locals": return "pp locals()";
      case "stack": return "where";
      default: return null;
    }
  },
  isFinished(chunk) {
    return /The program finished and will be restarted/.test(chunk)
      || /The program exited via sys\.exit/.test(chunk);
  },
  /**
   * The debuggee's prints and pdb's own status lines arrive on the same stream,
   * so strip the pdb-shaped lines to leave just what the program wrote.
   */
  stripDebuggerChatter(chunk) {
    return chunk
      .split("\n")
      .filter((l) => !/^> .*\(\d+\).*\(\)/.test(l)
        && !/^-> /.test(l)
        && !/^\(Pdb\)/.test(l)
        && !/^Breakpoint \d+ at /.test(l)
        && !/^Deleted breakpoint \d+/.test(l)
        && !/^The program (finished and will be restarted|exited via sys\.exit)/.test(l)
        && !/^--\w[\w ]*--$/.test(l)   // --Return--, --Call--, --KeyboardInterrupt--
        && !/^\*\*\* /.test(l))
      .join("\n");
  },
  parseLocation(chunk) {
    const m = chunk.match(PDB_LOC);
    if (!m) return null;
    // The source line follows on the next "-> " line.
    const after = chunk.slice(m.index! + m[0].length);
    const src = after.match(/^\s*\n-> (.*)$/m) ?? after.match(/-> (.*)/);
    // Present the in-container path as the project's file name.
    return { file: m[1].trim().replace(IN_WORK, ""), line: Number(m[2]), func: m[3].trim() || "<module>", source: src ? src[1].trim() : "" };
  },
  parseStack(chunk) {
    const frames: StackFrame[] = [];
    const lines = chunk.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^[> ]\s*([^(]+)\((\d+)\)([^(]*)\(\)/);
      if (!m) continue;
      const file = m[1].trim();
      // `where` includes pdb's own frames (bdb.py and friends) — drop them.
      if (!IN_WORK.test(file)) continue;
      const source = (lines[i + 1] ?? "").startsWith("-> ") ? lines[i + 1].slice(3).trim() : "";
      frames.push({ file: file.replace(IN_WORK, ""), line: Number(m[2]), func: m[3].trim() || "<module>", source });
    }
    // pdb prints outermost first; show the innermost frame at the top.
    return frames.reverse();
  },
};

/* ---------------------------------- Java --------------------------------- */

/**
 * `jdb` ships with the JDK, so Java debugs under the same rules as the rest:
 * nothing installed, no network. It differs from pdb in three ways worth
 * knowing before reading the adapter:
 *
 *  1. Its prompt changes. It is "> " while nothing is suspended and
 *     "<thread>[<frame>] " once the program stops.
 *  2. It acknowledges a command that resumes execution with the *idle* prompt
 *     immediately, and only prints "Breakpoint hit:" when the program actually
 *     stops later. Waiting for "a prompt" would therefore hand back a stale
 *     state — this is the same trap that made `node inspect` unusable. So an
 *     executing command waits specifically for a suspended prompt.
 *  3. It debugs classes, not source files, and needs `javac -g` first —
 *     without -g there are no local variable names to show.
 */
const JAVA_CLASS = "Main";
// "Breakpoint hit: "thread=main", Main.dist(), line=5 bci=10"
const JDB_LOC = /^(?:Breakpoint hit|Step completed): "thread=[^"]*", ([\w.$]+)\(\), line=(\d+)/m;
// "  [1] Main.dist (Main.java:5)"
const JDB_FRAME = /^\s*\[(\d+)\] ([\w.$]+) \(([\w.$]+\.java):(\d+)\)/;
/** "main[1] " — printed only when a thread is suspended. */
const JDB_SUSPENDED = /(?:^|\n)([^\s[\]]+\[\d+\] )$/;
/** Either prompt, at the very end of the buffer, which is the only place jdb writes one. */
const JDB_ANY_PROMPT = /(?:^|\n)([^\s[\]]+\[\d+\] |> )$/;
const JDB_OVER = /The application (exited|has been disconnected)|VM disconnected/;

/** Trailing prompts on a line jdb shares with program output ("main[1] > hello"). */
const stripJdbPrompts = (line: string) => line.replace(/^(?:[^\s[\]]+\[\d+\] |> )+/, "");
const methodName = (qualified: string) => qualified.split(".").pop() || qualified;

const javaAdapter: Adapter = {
  image: "eclipse-temurin:21-jdk-alpine",
  file: `${JAVA_CLASS}.java`,
  // -g keeps local variable names; without it `locals` reports nothing at all.
  cmd: ["sh", "-c", `javac -g ${JAVA_CLASS}.java && exec jdb -classpath . ${JAVA_CLASS}`],
  memory: "768m",
  // Compiling and starting a JVM is far slower than opening a Python file.
  startupTimeoutMs: 90_000,
  // jdb does not stop on its own, so stop it at the entry point to give the
  // same "paused on the first line" start as the other languages. This one is
  // deliberately not added to the user's breakpoint list.
  begin: [
    { cmd: `stop in ${JAVA_CLASS}.main`, executes: false },
    { cmd: "run", executes: true },
  ],
  findPrompt(buf, executing) {
    if (executing) {
      // The program ran to the end: there will be no suspended prompt, ever.
      if (JDB_OVER.test(buf)) return { start: buf.length, end: buf.length };
      const m = buf.match(JDB_SUSPENDED);
      return m ? { start: buf.length - m[1].length, end: buf.length } : null;
    }
    const m = buf.match(JDB_ANY_PROMPT);
    return m ? { start: buf.length - m[1].length, end: buf.length } : null;
  },
  translate(cmd, arg) {
    switch (cmd) {
      case "continue": return "cont";
      case "next": return "next";        // step over
      case "step": return "step";        // step into
      case "out": return "step up";      // run to end of frame
      case "setBreakpoint": return `stop at ${JAVA_CLASS}:${arg}`;
      case "clearBreakpoint": return `clear ${JAVA_CLASS}:${arg}`;
      case "evaluate": return `print ${arg}`;
      case "locals": return "locals";
      case "stack": return "where";
      default: return null;
    }
  },
  isFinished(chunk) { return JDB_OVER.test(chunk); },
  stripDebuggerChatter(chunk) {
    const lines = chunk.split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = stripJdbPrompts(lines[i]);
      // The line after a stop is jdb echoing the source — drop it by position
      // rather than by shape, so program output that merely looks like a
      // numbered line survives.
      if (i > 0 && JDB_LOC.test(stripJdbPrompts(lines[i - 1]))) continue;
      if (JDB_LOC.test(line)) continue;
      if (/^(Initializing jdb|Set uncaught |Set deferred uncaught |VM Started|Deferring breakpoint|It will be set after|Set breakpoint |Removed:|Not found:|Unable to set|The application (exited|has been disconnected)|VM disconnected|run [\w.$]+$)/.test(line)) continue;
      out.push(line);
    }
    return out.join("\n");
  },
  parseLocation(chunk) {
    const m = chunk.match(JDB_LOC);
    if (!m) return null;
    // jdb echoes the stopped line next, as "5        return ...".
    const after = chunk.slice(m.index! + m[0].length);
    const src = after.match(/\n\s*\d+\s{2,}(.*)/);
    return { file: `${JAVA_CLASS}.java`, line: Number(m[2]), func: methodName(m[1]), source: src ? src[1].trim() : "" };
  },
  parseStack(chunk) {
    const frames: StackFrame[] = [];
    for (const raw of chunk.split("\n")) {
      const m = stripJdbPrompts(raw).match(JDB_FRAME);
      // Keep the user's own frames; library frames would point at source we
      // don't have and can't show.
      if (!m || m[3] !== `${JAVA_CLASS}.java`) continue;
      frames.push({ file: m[3], line: Number(m[4]), func: methodName(m[2]), source: "" });
    }
    // jdb already prints the innermost frame first.
    return frames;
  },
};

/* ------------------------------ C++ and Rust ----------------------------- */

/**
 * `gdb`, driven the same way as pdb and jdb.
 *
 * The reason this took a separate image rather than a separate adapter: neither
 * `gcc:14` nor `rust:1-alpine` contains a debugger, and `--network none` means
 * one cannot be fetched when a session starts. `rust-gdb` in particular is a
 * wrapper script that execs a gdb which is not installed — the reason Rust
 * looked supported and was not. See `sandbox/Dockerfile.{cpp,rust}`.
 *
 * Three gdb settings do the work that would otherwise need protocol code:
 *
 *  - `print frame-info source-and-location` — by default gdb prints only the
 *    source line when a step stays inside the same frame, so the paused location
 *    would silently go stale after every `next`. With it, every stop announces
 *    "func () at file:line" and there is exactly one thing to parse.
 *  - `exec-wrapper stdbuf -o0 -e0` — the debuggee's stdout is a pipe here, so
 *    libc block-buffers it and the program's entire output would arrive in one
 *    lump when it exits. This is gdb's equivalent of python's `-u`. It is also
 *    why the images install coreutils: pointing exec-wrapper at a stdbuf that
 *    does not exist kills the run before `main` (verified — exit 127).
 *  - `auto-load safe-path /` and `disable-randomization off` — silence two
 *    warnings that are unavoidable in a container with dropped capabilities and
 *    would otherwise be indistinguishable from the program's own output.
 */
const GDB_PROMPT = "(gdb) ";
/** "Breakpoint 1, main () at main.cpp:10" · "main () at main.cpp:8" · "0x… in main::main () at main.rs:9" */
const GDB_LOC = /^(?:(?:Temporary breakpoint|Breakpoint) \d+, )?(?:0x[0-9a-f]+ in )?([A-Za-z_][\w:$<>,]*) \([^)]*\) at ([^\s:]+):(\d+)/;
/** "#1  0x… in main::main () at main.rs:9" */
const GDB_FRAME = /^#(\d+)\s+(?:0x[0-9a-f]+ in )?([A-Za-z_][\w:$<>,]*) \([^)]*\) at ([^\s:]+):(\d+)/;
const GDB_OVER = /\[Inferior \d+ \([^)]*\) exited (?:normally|with code \d+)\]|During startup program exited/;

const GDB_FLAGS = [
  "-q", "-nx",
  "-iex 'set auto-load safe-path /'",
  "-ex 'set disable-randomization off'",
  "-ex 'set pagination off'",
  "-ex 'set confirm off'",
  "-ex 'set print frame-info source-and-location'",
  "-ex 'set exec-wrapper stdbuf -o0 -e0'",
].join(" ");

/** Lines gdb writes about itself, none of which the program produced. */
const GDB_NOISE = /^(?:Reading symbols from|Starting program:|Continuing\.|Run till exit from|Value returned is|Breakpoint \d+ at |Temporary breakpoint \d+ at |Deleted breakpoint|Note: breakpoint|No breakpoint at|\[Thread debugging|Using host libthread_db|\[Inferior |During startup program exited|warning: |of file |Use `info auto-load|\[New Thread|\[Switching to)/;

function makeGdbAdapter(opts: {
  image: string; file: string; binary: string; compile: string;
  /** How to stop on the user's first line. C++ has `start`; Rust needs the crate-qualified symbol. */
  begin: { cmd: string; executes: boolean }[];
}): Adapter {
  return {
    image: opts.image,
    file: opts.file,
    cmd: ["sh", "-c", `${opts.compile} && exec gdb ${GDB_FLAGS} ./${opts.binary}`],
    memory: "768m",
    // Compiling C++ or Rust from cold is slower than opening a Python file.
    startupTimeoutMs: 90_000,
    begin: opts.begin,
    // gdb prints its prompt only once the target has come to rest, so an
    // executing command needs no special handling — unlike jdb.
    findPrompt(buf) {
      const i = buf.lastIndexOf(GDB_PROMPT);
      return i === -1 ? null : { start: i, end: i + GDB_PROMPT.length };
    },
    translate(cmd, arg) {
      switch (cmd) {
        case "continue": return "continue";
        case "next": return "next";
        case "step": return "step";
        case "out": return "finish";
        case "setBreakpoint": return `break ${this.file}:${arg}`;
        case "clearBreakpoint": return `clear ${this.file}:${arg}`;
        case "evaluate": return `print ${arg}`;
        case "locals": return "info locals";
        case "stack": return "bt";
        default: return null;
      }
    },
    isFinished(chunk) { return GDB_OVER.test(chunk); },
    stripDebuggerChatter(chunk) {
      return chunk
        .split("\n")
        .filter((l) => !GDB_NOISE.test(l)
          && !GDB_LOC.test(l)
          // The source line gdb echoes under a stop: "10\t  int z = add(x, y);".
          && !/^\d+\t/.test(l)
          && !/^\(gdb\)/.test(l))
        .join("\n");
    },
    parseLocation(chunk) {
      const lines = chunk.split("\n");
      // The *last* location wins: `finish` prints the frame it is leaving before
      // the one it returns to, and the second is where execution now sits.
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(GDB_LOC);
        if (!m) continue;
        const line = Number(m[3]);
        // gdb echoes the stopped line next, as "9\t    let z = add(x, y);".
        const echo = (lines[i + 1] ?? "").match(/^(\d+)\t(.*)$/);
        return {
          file: m[2],
          line,
          func: m[1],
          source: echo && Number(echo[1]) === line ? echo[2].trim() : "",
        };
      }
      return null;
    },
    parseStack(chunk) {
      const frames: StackFrame[] = [];
      for (const raw of chunk.split("\n")) {
        const m = raw.match(GDB_FRAME);
        // Library frames have no source we could show; keep the user's own file.
        if (!m || m[3] !== this.file) continue;
        frames.push({ file: m[3], line: Number(m[4]), func: m[2], source: "" });
      }
      // gdb prints the innermost frame (#0) first, which is the order we want.
      return frames;
    },
  };
}

const cppAdapter = makeGdbAdapter({
  image: "yumi-sandbox-cpp:1",
  file: "main.cpp",
  binary: "main",
  // -O0 so the paused line is the line the user wrote; optimised code steps
  // through positions that do not correspond to the source at all.
  compile: "g++ -g -O0 -o main main.cpp",
  // `start` is gdb's "temporary breakpoint at main, then run" — the same
  // "paused on the first line" start every other language gives.
  begin: [{ cmd: "start", executes: true }],
});

const rustAdapter = makeGdbAdapter({
  image: "yumi-sandbox-rust:1",
  file: "main.rs",
  binary: "main",
  compile: "rustc -g -o main main.rs",
  // `start` stops in the C-ABI entry shim rather than the user's fn main, so
  // Rust names the symbol instead: main.rs compiles to a crate called `main`,
  // whose main function is `main::main`. Not added to the user's breakpoint
  // list — like Java's entry stop, it exists to produce the first pause.
  begin: [
    { cmd: "break main::main", executes: false },
    { cmd: "run", executes: true },
  ],
});

/* ----------------------------------- Go ---------------------------------- */

/**
 * Go debugs through Delve rather than gdb: gdb understands goroutines poorly
 * enough that stepping is not really usable. Delve is a Go program, so it is
 * compiled into the image at build time — a session has no network to fetch it.
 *
 * Two details that are not obvious:
 *  - `dlv debug` needs a module, and there is none for a single pasted file, so
 *    the session creates a throwaway one. `go mod init` is offline; nothing is
 *    downloaded, which is why only the standard library is importable here.
 *  - Delve colours its output and prints a ten-line source listing after every
 *    stop. Both are for humans at a terminal; the adapter strips them so what
 *    reaches the room is the program's own output.
 */
const DLV_PROMPT = "(dlv) ";
const ANSI = /\x1b\[[0-9;]*m/g;
/** "> [Breakpoint 1] main.main() ./main.go:10 (hits …)" · "> main.main() ./main.go:11 (PC: …)" */
const DLV_LOC = /^>\s*(?:\[[^\]]*\]\s*)?([\w./*()]+?)\(\)\s+(\S+):(\d+)/;
/** The "=>" line of Delve's source listing is the line it is stopped on. */
const DLV_CURRENT = /^=>\s*\d+:\t?(.*)$/;
/** "0  0x000000000000b3c10 in main.main" followed by "   at ./main.go:10" */
/** Same as DLV_LOC, for testing a whole multi-line chunk rather than one line. */
const DLV_LOC_ANY = /^>\s*(?:\[[^\]]*\]\s*)?[\w./*()]+?\(\)\s+\S+:\d+/m;
const DLV_FRAME = /^\s*(\d+)\s+0x[0-9a-f]+ in (\S+)/;
const DLV_AT = /^\s*at (\S+):(\d+)/;
const DLV_OVER = /Process \d+ has exited with status/;

const stripAnsi = (s: string) => s.replace(ANSI, "");
/** Delve prints "./main.go"; the project calls it "main.go". */
const dlvPath = (p: string) => p.replace(/^\.\//, "");

const goAdapter: Adapter = {
  image: "yumi-sandbox-go:1",
  file: "main.go",
  cmd: ["sh", "-c",
    "go mod init app >/dev/null 2>&1; exec dlv debug --allow-non-terminal-interactive=true ."],
  memory: "1g",
  // Delve compiles the program before it can start.
  startupTimeoutMs: 120_000,
  // Delve starts stopped before the process exists, so it has to be told to run.
  begin: [
    { cmd: "break main.main", executes: false },
    { cmd: "continue", executes: true },
  ],
  /**
   * Delve writes its prompt when it is ready for the next command, so for an
   * ordinary command the prompt alone means "done".
   *
   * A command that *runs* the program is different, and subtly so: when the
   * program produces output and then exits, Delve can emit the prompt before the
   * "Process N has exited" notice. Taking the prompt at face value there left
   * the room showing "paused" on a program that had finished, and the exit
   * notice then turned up as the answer to the next `stack` query (caught by the
   * end-to-end test, which is the only place this was visible). So an executing
   * command waits for Delve to say where execution now is — a new position, or
   * the process exiting. Same discipline the jdb adapter needs, for a different
   * underlying reason.
   */
  findPrompt(buf, executing) {
    const i = buf.lastIndexOf(DLV_PROMPT);
    if (i === -1) return null;
    if (executing) {
      const answered = stripAnsi(buf.slice(0, i));
      if (!DLV_LOC_ANY.test(answered) && !DLV_OVER.test(answered)) return null;
    }
    return { start: i, end: i + DLV_PROMPT.length };
  },
  translate(cmd, arg) {
    switch (cmd) {
      case "continue": return "continue";
      case "next": return "next";
      case "step": return "step";
      case "out": return "stepout";
      case "setBreakpoint": return `break ${this.file}:${arg}`;
      // `clear` takes a breakpoint id or name; `clearall` takes the same
      // linespec `break` did, which is what this protocol addresses them by.
      case "clearBreakpoint": return `clearall ${this.file}:${arg}`;
      case "evaluate": return `print ${arg}`;
      case "locals": return "locals";
      case "stack": return "stack";
      default: return null;
    }
  },
  isFinished(chunk) { return DLV_OVER.test(stripAnsi(chunk)); },
  stripDebuggerChatter(chunk) {
    return stripAnsi(chunk)
      .split("\n")
      .filter((l) => !DLV_LOC.test(l)
        // The source listing Delve prints around every stop.
        && !/^\s*(?:=>)?\s*\d+:\t/.test(l)
        && !/^Breakpoint \d+ (?:set|cleared) at /.test(l)
        && !DLV_OVER.test(l)
        && !/^\(dlv\)/.test(l))
      .join("\n");
  },
  parseLocation(chunk) {
    const lines = stripAnsi(chunk).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(DLV_LOC);
      if (!m) continue;
      const src = lines.slice(i).find((l) => DLV_CURRENT.test(l))?.match(DLV_CURRENT);
      return {
        file: dlvPath(m[2]),
        line: Number(m[3]),
        func: m[1],
        source: src ? src[1].trim() : "",
      };
    }
    return null;
  },
  parseStack(chunk) {
    const frames: StackFrame[] = [];
    const lines = stripAnsi(chunk).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const f = lines[i].match(DLV_FRAME);
      if (!f) continue;
      const at = (lines[i + 1] ?? "").match(DLV_AT);
      if (!at) continue;
      const file = dlvPath(at[1]);
      // Every Go program's stack ends in runtime frames, whose source is not in
      // this project and could not be shown.
      if (file !== this.file) continue;
      frames.push({ file, line: Number(at[2]), func: f[2], source: "" });
    }
    return frames;
  },
};

const ADAPTERS: Record<string, Adapter> = {
  python: pythonAdapter,
  java: javaAdapter,
  cpp: cppAdapter,
  rust: rustAdapter,
  go: goAdapter,
};

/**
 * JavaScript and TypeScript use the CDP harness rather than a stdio adapter.
 * `file` is what the source is written as inside the container; the extension
 * is what tells node to strip types.
 */
const CDP_LANGUAGES: Record<string, { file: string; cmd: string }> = {
  javascript: { file: "main.js", cmd: "node --inspect-brk=127.0.0.1:9229 main.js" },
  // Matches runner.ts: type-stripping only, which erases types in place and so
  // keeps every line at its original number.
  typescript: { file: "main.ts", cmd: "node --experimental-strip-types --inspect-brk=127.0.0.1:9229 main.ts" },
};

export function canDebug(language: string): boolean {
  return language in ADAPTERS || language in CDP_LANGUAGES;
}

/* ------------------------------ DebugSession ----------------------------- */

export class DebugSession {
  readonly projectId: string;
  readonly language: string;
  readonly fileName: string;
  private adapter: Adapter;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private dir: string | null = null;
  private containerName: string;
  private buf = "";
  private waiter: { resolve: (s: string) => void; timer: NodeJS.Timeout; executing: boolean } | null = null;
  private queue: Promise<any> = Promise.resolve();
  private ttlTimer: NodeJS.Timeout | null = null;
  /** False until the debugger has answered once — see start()'s failure path. */
  private promptSeen = false;

  private breakpoints = new Set<number>();
  private programOutput = "";
  private state: DebugState;

  /** Called whenever the shared state changes, so the gateway can broadcast it. */
  onUpdate: (s: DebugState) => void = () => {};
  /** Called once the session is finished, so the registry can drop it. */
  onClosed: () => void = () => {};

  constructor(projectId: string, language: string, fileName: string) {
    this.projectId = projectId;
    this.language = language;
    this.fileName = fileName;
    this.adapter = ADAPTERS[language];
    this.containerName = `yumi-dbg-${randomBytes(6).toString("hex")}`;
    this.state = {
      status: "starting", file: null, line: null, source: null,
      stack: [], locals: "", breakpoints: [], output: "",
    };
  }

  getState(): DebugState { return { ...this.state, breakpoints: [...this.breakpoints].sort((a, b) => a - b) }; }

  /** Boot the container and run to the debugger's first stop. */
  async start(code: string, initialBreakpoints: number[] = []): Promise<DebugState> {
    const a = this.adapter;
    this.dir = await mkdtemp(path.join(os.tmpdir(), "yumi-dbg-"));
    await writeFile(path.join(this.dir, a.file), code, "utf8");

    this.proc = spawn("docker", [
      "run", "--rm", "-i", "--name", this.containerName,
      "--network", "none",
      "--memory", a.memory, "--cpus", "1", "--pids-limit", "256",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "-v", `${this.dir}:/work`, "-w", "/work",
      a.image, ...a.cmd,
    ]) as ChildProcessWithoutNullStreams;

    this.proc.stdout.on("data", (d) => this.absorb(d.toString()));
    this.proc.stderr.on("data", (d) => this.absorb(d.toString()));
    this.proc.on("close", () => this.handleExit("Debugger process ended"));
    this.proc.on("error", (e) => this.handleExit(`Debugger failed to start: ${e.message}`));

    this.ttlTimer = setTimeout(() => void this.stop("Debug session timed out after 20 minutes"), SESSION_TTL_MS);

    let stopped = await this.awaitPrompt(false, a.startupTimeoutMs);
    // No prompt at all means the debugger never came up — a compile error, most
    // likely. Its own output is the only useful thing to say about that.
    if (!this.promptSeen) {
      throw new Error(stopped.trim().split("\n").slice(0, 12).join("\n").slice(0, 600)
        || "the debugger did not start in time");
    }
    for (const line of initialBreakpoints) {
      await this.raw(a.translate("setBreakpoint", line)!);
      this.breakpoints.add(line);
    }
    // Some debuggers need to be told to start; the last of those steps is the
    // one that lands on the first line.
    for (const step of a.begin ?? []) stopped = await this.raw(step.cmd, step.executes);
    await this.applyState(stopped);
    return this.getState();
  }

  /** Run one protocol command and refresh the shared state. Serialised. */
  command(cmd: string, arg?: string | number): Promise<DebugState | { evaluated: string }> {
    this.queue = this.queue.then(() => this.runCommand(cmd, arg)).catch((e) => {
      console.warn(`[debug] ${cmd} failed:`, (e as Error).message);
      return this.getState();
    });
    return this.queue;
  }

  private async runCommand(cmd: string, arg?: string | number): Promise<any> {
    if (this.state.status === "exited" || !this.proc) return this.getState();
    const native = this.adapter.translate(cmd, arg);
    if (!native) return this.getState();

    if (cmd === "evaluate") {
      const out = await this.raw(native);
      return { evaluated: out.trim() || "(no value)" };
    }
    if (cmd === "setBreakpoint" || cmd === "clearBreakpoint") {
      await this.raw(native);
      if (cmd === "setBreakpoint") this.breakpoints.add(Number(arg));
      else this.breakpoints.delete(Number(arg));
      this.emit();
      return this.getState();
    }

    // continue/next/step/out actually execute code, so capture what it prints.
    const out = await this.raw(native, true);
    await this.applyState(out);
    return this.getState();
  }

  /** Refresh location/stack/locals from a debugger response. */
  private async applyState(chunk: string) {
    if (this.adapter.isFinished(chunk)) {
      this.state.status = "exited";
      this.state.exitMessage = "Program finished";
      this.emit();
      await this.stop();
      return;
    }
    const loc = this.adapter.parseLocation(chunk);
    if (loc) {
      this.state.status = "paused";
      this.state.file = loc.file;
      this.state.line = loc.line;
      this.state.source = loc.source;
    }
    const stackOut = await this.raw(this.adapter.translate("stack")!);
    this.state.stack = this.adapter.parseStack(stackOut);
    const localsOut = await this.raw(this.adapter.translate("locals")!);
    this.state.locals = localsOut.trim().slice(0, 4_000);
    this.emit();
  }

  private emit() {
    this.state.output = this.programOutput.slice(-OUTPUT_CAP);
    this.onUpdate(this.getState());
  }

  /**
   * Write a raw debugger command and return everything printed before the next
   * prompt. `capturesOutput` marks the commands that actually run user code —
   * only those can produce program output worth showing.
   */
  private async raw(line: string, capturesOutput = false): Promise<string> {
    if (!this.proc?.stdin.writable) return "";
    this.proc.stdin.write(line + "\n");
    const out = await this.awaitPrompt(capturesOutput);
    if (capturesOutput) {
      const clean = this.adapter.stripDebuggerChatter(out).replace(/\n{2,}/g, "\n").trim();
      if (clean) this.programOutput = (this.programOutput + clean + "\n").slice(-OUTPUT_CAP);
    }
    return out;
  }

  private awaitPrompt(executing = false, timeoutMs = COMMAND_TIMEOUT_MS): Promise<string> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter) { this.waiter = null; resolve(this.buf); this.buf = ""; }
      }, timeoutMs);
      this.waiter = { resolve, timer, executing };
      this.drain();
    });
  }

  private absorb(chunk: string) {
    this.buf += chunk;
    this.drain();
  }

  /**
   * Split the buffer at the debugger prompt. Anything the *program* printed
   * arrives in the same stream, so it is captured as program output too.
   */
  private drain() {
    if (!this.waiter) return;
    const at = this.adapter.findPrompt(this.buf, this.waiter.executing);
    if (!at) return;
    this.promptSeen = true;
    const out = this.buf.slice(0, at.start);
    this.buf = this.buf.slice(at.end);
    const w = this.waiter;
    this.waiter = null;
    clearTimeout(w.timer);
    w.resolve(out);
  }

  private handleExit(message: string) {
    // A debugger that dies mid-command would otherwise leave the caller waiting
    // out the whole timeout for a prompt that can never come.
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      w.resolve(this.buf);
      this.buf = "";
    }
    if (this.state.status === "exited") return;
    this.state.status = "exited";
    this.state.exitMessage = message;
    this.emit();
  }

  /** Kill the container and release everything. Safe to call repeatedly. */
  async stop(message = "Debug session stopped") {
    if (this.ttlTimer) { clearTimeout(this.ttlTimer); this.ttlTimer = null; }
    if (this.waiter) { clearTimeout(this.waiter.timer); this.waiter.resolve(""); this.waiter = null; }
    if (this.state.status !== "exited") {
      this.state.status = "exited";
      this.state.exitMessage = message;
      this.emit();
    }
    try { this.proc?.stdin.end(); } catch { /* already closed */ }
    // --rm plus an explicit kill: the container must not outlive the session.
    spawn("docker", ["rm", "-f", this.containerName], { stdio: "ignore" });
    try { this.proc?.kill("SIGKILL"); } catch { /* already dead */ }
    this.proc = null;
    if (this.dir) { await rm(this.dir, { recursive: true, force: true }).catch(() => {}); this.dir = null; }
    // A finished session must not linger in the registry — otherwise the next
    // command finds a dead session instead of reporting that there is none.
    this.onClosed();
  }
}

/* ------------------------- JavaScript (CDP harness) ----------------------- */

/**
 * JavaScript and TypeScript are debugged by a harness that runs *inside* the
 * container and speaks the Chrome DevTools Protocol to V8's inspector over
 * loopback (which exists even under --network none). See debugHarness.mjs for
 * why `node inspect` was rejected. The harness exposes a JSON-line protocol, so
 * this class is mostly framing and lifecycle.
 */
class CdpDebugSession {
  readonly projectId: string;
  readonly language: string;
  readonly fileName: string;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private dir: string | null = null;
  private containerName: string;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private queue: Promise<any> = Promise.resolve();
  private ttlTimer: NodeJS.Timeout | null = null;
  private state: DebugState;

  onUpdate: (s: DebugState) => void = () => {};
  onClosed: () => void = () => {};

  constructor(projectId: string, language: string, fileName: string) {
    this.projectId = projectId;
    this.language = language;
    this.fileName = fileName;
    this.containerName = `yumi-dbg-${randomBytes(6).toString("hex")}`;
    this.state = { status: "starting", file: null, line: null, source: null, stack: [], locals: "", breakpoints: [], output: "" };
  }

  getState(): DebugState { return this.state; }

  async start(code: string, initialBreakpoints: number[] = []): Promise<DebugState> {
    const target = CDP_LANGUAGES[this.language];
    this.dir = await mkdtemp(path.join(os.tmpdir(), "yumi-dbg-"));
    await writeFile(path.join(this.dir, target.file), code, "utf8");
    // Ship the harness alongside the debuggee.
    const harness = await readFile(new URL("./debugHarness.mjs", import.meta.url), "utf8");
    await writeFile(path.join(this.dir, "harness.mjs"), harness, "utf8");

    this.proc = spawn("docker", [
      "run", "--rm", "-i", "--name", this.containerName,
      "--network", "none",
      "--memory", "512m", "--cpus", "1", "--pids-limit", "256",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "-e", `YUMI_FILE=${target.file}`,
      "-e", `YUMI_BREAKPOINTS=${initialBreakpoints.join(",")}`,
      "-v", `${this.dir}:/work`, "-w", "/work",
      "node:22-alpine",
      // The debuggee's own output goes to a file so it can never be confused
      // with the harness's protocol messages on stdout.
      "sh", "-c", `${target.cmd} >/work/.out 2>&1 & node harness.mjs`,
    ]) as ChildProcessWithoutNullStreams;

    this.proc.stdout.on("data", (d) => this.absorb(d.toString()));
    this.proc.stderr.on("data", (d) => console.warn("[debug:js]", d.toString().trim().slice(0, 300)));
    this.proc.on("close", () => this.handleExit("Debugger process ended"));
    this.proc.on("error", (e) => this.handleExit(`Debugger failed to start: ${e.message}`));

    this.ttlTimer = setTimeout(() => void this.stop("Debug session timed out after 20 minutes"), SESSION_TTL_MS);

    const ready = await new Promise<DebugState | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 45_000);
      this.readyWaiter = (s) => { clearTimeout(timer); resolve(s); };
    });
    if (!ready) throw new Error("the debugger did not become ready in time");
    // The program can die before it ever pauses — a syntax error, or TypeScript
    // that type-stripping refuses. Report what it actually said.
    if (ready.status === "exited") {
      throw new Error([ready.exitMessage, ready.output].filter(Boolean).join("\n").slice(0, 600).trim()
        || "the program exited before the debugger could attach");
    }
    this.state = ready;
    this.onUpdate(this.state);
    return this.state;
  }

  private readyWaiter: ((s: DebugState) => void) | null = null;

  private absorb(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: any) {
    if (msg.event === "ready") {
      const w = this.readyWaiter; this.readyWaiter = null;
      if (w) w(msg.state);
      return;
    }
    if (msg.event === "exited") {
      this.state = { ...this.state, status: "exited", exitMessage: msg.message ?? "Program finished", output: msg.output ?? this.state.output };
      // A command that ended the program never gets its own reply — settle it.
      for (const [, resolve] of this.pending) resolve({ state: this.state });
      this.pending.clear();
      // Dying before the first pause has to settle start() too, or it waits out
      // the full ready timeout for a program that is already gone.
      const w = this.readyWaiter; this.readyWaiter = null;
      if (w) w(this.state);
      this.onUpdate(this.state);
      void this.stop(this.state.exitMessage);
      return;
    }
    if (msg.id !== undefined) {
      const resolve = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (resolve) resolve(msg);
    }
  }

  command(cmd: string, arg?: string | number): Promise<DebugState | { evaluated: string }> {
    this.queue = this.queue.then(() => this.runCommand(cmd, arg)).catch((e) => {
      console.warn(`[debug:js] ${cmd} failed:`, (e as Error).message);
      return this.state;
    });
    return this.queue;
  }

  private runCommand(cmd: string, arg?: string | number): Promise<any> {
    if (this.state.status === "exited" || !this.proc?.stdin.writable) return Promise.resolve(this.state);
    const id = this.nextId++;
    return new Promise<any>((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ state: this.state }); }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.proc!.stdin.write(JSON.stringify({ id, cmd, arg }) + "\n");
    }).then((msg) => {
      if (msg.evaluated !== undefined) return { evaluated: String(msg.evaluated) };
      if (msg.error) return this.state;
      if (msg.state) { this.state = msg.state; this.onUpdate(this.state); }
      return this.state;
    });
  }

  private handleExit(message: string) {
    if (this.state.status === "exited") return;
    this.state = { ...this.state, status: "exited", exitMessage: message };
    const w = this.readyWaiter; this.readyWaiter = null;
    if (w) w(this.state);
    this.onUpdate(this.state);
  }

  async stop(message = "Debug session stopped") {
    if (this.ttlTimer) { clearTimeout(this.ttlTimer); this.ttlTimer = null; }
    const w = this.readyWaiter; this.readyWaiter = null;
    if (w) w(this.state.status === "exited" ? this.state : { ...this.state, status: "exited", exitMessage: message });
    for (const [, resolve] of this.pending) resolve({ state: this.state });
    this.pending.clear();
    if (this.state.status !== "exited") {
      this.state = { ...this.state, status: "exited", exitMessage: message };
      this.onUpdate(this.state);
    }
    try { this.proc?.stdin.end(); } catch { /* already closed */ }
    spawn("docker", ["rm", "-f", this.containerName], { stdio: "ignore" });
    try { this.proc?.kill("SIGKILL"); } catch { /* already dead */ }
    this.proc = null;
    if (this.dir) { await rm(this.dir, { recursive: true, force: true }).catch(() => {}); this.dir = null; }
    this.onClosed();
  }
}

/* ---------------------------- Session registry ---------------------------- */

/** What the gateway needs from a session, whichever backend provides it. */
export interface IDebugSession {
  getState(): DebugState;
  command(cmd: string, arg?: string | number): Promise<DebugState | { evaluated: string }>;
  stop(message?: string): Promise<void>;
  onUpdate: (s: DebugState) => void;
  onClosed: () => void;
}

/** One debug session per project — the whole room shares it. */
const sessions = new Map<string, IDebugSession>();

export function getSession(projectId: string): IDebugSession | undefined {
  return sessions.get(projectId);
}

/** Whether an image exists locally. Mirrors the runner's check. */
function imageReady(image: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("docker", ["image", "inspect", image], { stdio: "ignore" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

/**
 * The debug images for C++, Go and Rust are built from this repo rather than
 * pulled, because they are the stock language images plus a debugger the
 * upstream image does not ship. A deployment that has not built them should be
 * told exactly that — the alternative is docker failing to find an image and the
 * room seeing "the debugger did not start".
 */
const BUILT_IMAGES = new Set(["yumi-sandbox-cpp:1", "yumi-sandbox-go:1", "yumi-sandbox-rust:1"]);

export async function startSession(
  projectId: string, language: string, fileName: string, code: string, breakpoints: number[],
  onUpdate: (s: DebugState) => void,
): Promise<DebugState> {
  const image = ADAPTERS[language]?.image;
  if (image && !(await imageReady(image))) {
    throw new Error(
      BUILT_IMAGES.has(image)
        ? `the ${language} debug image (${image}) has not been built. Run \`pnpm sandbox:build\` on the server host — ${language} needs a debugger that its stock image does not include.`
        : `the ${language} runtime image (${image}) is still being prepared. Try again in a moment.`
    );
  }
  await stopSession(projectId);
  const s = language in CDP_LANGUAGES
    ? new CdpDebugSession(projectId, language, fileName)
    : new DebugSession(projectId, language, fileName);
  s.onUpdate = onUpdate;
  // Only drop the entry if it's still this session (a restart may have replaced it).
  s.onClosed = () => { if (sessions.get(projectId) === s) sessions.delete(projectId); };
  sessions.set(projectId, s);
  try {
    return await s.start(code, breakpoints);
  } catch (e) {
    sessions.delete(projectId);
    await s.stop();
    throw e;
  }
}

export async function stopSession(projectId: string): Promise<void> {
  const s = sessions.get(projectId);
  if (!s) return;
  sessions.delete(projectId);
  await s.stop();
}

/** Kill every session — used on server shutdown so no container is orphaned. */
export async function stopAllSessions(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => stopSession(id)));
}

/*
 * JavaScript and TypeScript are handled by CdpDebugSession + debugHarness.mjs
 * rather than a stdio Adapter. `node inspect` was tried and rejected: it prints
 * its prompt before the debuggee actually pauses, so responses arrive shifted by
 * one command.
 *
 * TypeScript looked unsupportable at first because setBreakpointByUrl accepted a
 * breakpoint that never bound. The cause was not type-stripping but the URL:
 * V8 registers main.js as "file:///work/main.js" and a stripped main.ts as the
 * bare path "/work/main.ts", so the literal URL matched nothing. The harness now
 * matches on a regex over the file name, which binds for both. Type-stripping
 * itself erases types in place, so the line numbers need no mapping.
 *
 * Strip-only means non-erasable TypeScript (enum, namespace, parameter
 * properties) is rejected by node with its own message rather than transformed —
 * transforming would move lines and desync the editor's gutter from the pause.
 */
