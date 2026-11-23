// Shared scenario handling for the mock CLIs. A scenario file lists scripted
// responses; each call takes the first one whose `match` fits the prompt and
// whose `times` isn't used up. Use counts persist in a state file, so a
// sequence of separate CLI invocations walks through the script.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** Reads all of stdin as text. */
export function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Loads the scenario for `cli` from `MOCK_CLI_SCENARIO`, or a default that answers `{"findings":[]}`. */
export function loadScenario(cli) {
  const path = process.env.MOCK_CLI_SCENARIO;
  if (!path) return { path: null, responses: [{ output: { findings: [] } }] };
  const data = JSON.parse(readFileSync(path, "utf8"));
  const section = data[cli] ?? data;
  return { path, responses: Array.isArray(section.responses) ? section.responses : [] };
}

/**
 * Picks the response for `prompt` and records its use. Returns `null` when
 * nothing matches.
 */
export function pickResponse(cli, scenario, prompt) {
  return withLock(scenario.path, () => {
    const statePath = statePathFor(scenario.path);
    const state =
      statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
    const used = state[cli] ?? {};
    const index = scenario.responses.findIndex(
      (r, i) =>
        (r.match === undefined || new RegExp(r.match).test(prompt)) &&
        (r.times === undefined || (used[i] ?? 0) < r.times),
    );
    if (index >= 0 && statePath) {
      used[index] = (used[index] ?? 0) + 1;
      state[cli] = used;
      const tmp = `${statePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, statePath);
    }
    return index >= 0 ? { index, response: scenario.responses[index] } : null;
  });
}

/** Appends one line describing this invocation to `MOCK_CLI_LOG`, when set. */
export function logCall(cli, entry) {
  const path = process.env.MOCK_CLI_LOG;
  if (!path) return;
  appendFileSync(path, `${JSON.stringify({ cli, cwd: process.cwd(), ...entry })}\n`);
}

/** The answer text: `text` verbatim, or `output` as JSON. */
export function answerText(response) {
  if (typeof response.text === "string") return response.text;
  return JSON.stringify(response.output ?? { findings: [] });
}

/**
 * Writes `response.writeFiles` ({ relative path: content }) under the working
 * directory. With `response.commit`, commits every change in the working
 * directory with that message afterward, as an agent that commits does. A
 * clean working directory gets no commit.
 */
export function writeFiles(response) {
  for (const [file, content] of Object.entries(response.writeFiles ?? {})) {
    const target = isAbsolute(file) ? file : join(process.cwd(), file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const changed =
    response.commit &&
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
  if (changed) {
    execFileSync("git", ["add", "-A"], { stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Mock Agent",
        "-c",
        "user.email=mock-agent@example.com",
        "commit",
        "-q",
        "-m",
        response.commit,
      ],
      { stdio: "ignore" },
    );
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function newId() {
  return randomUUID();
}

function statePathFor(scenarioPath) {
  if (process.env.MOCK_CLI_STATE) return process.env.MOCK_CLI_STATE;
  return scenarioPath ? `${scenarioPath}.state.json` : null;
}

// How long a lock without an owner pid file may stand before it counts as
// left behind: the owner writes the file right after mkdir.
const LOCK_PIDLESS_STALE_MS = 2_000;

// Whether process PID is gone. EPERM means it exists under another user.
function processGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err?.code === "ESRCH";
  }
}

// Whether LOCK was left by a mock that died while holding it: its pid file
// names a process that is gone, or it has no pid file and is old.
function lockIsStale(lock) {
  try {
    const pid = Number.parseInt(readFileSync(join(lock, "pid"), "utf8"), 10);
    if (Number.isInteger(pid) && pid > 0) return processGone(pid);
  } catch {
    // No pid file yet, or the lock is already gone: fall back to its age.
  }
  try {
    return Date.now() - statSync(lock).mtimeMs > LOCK_PIDLESS_STALE_MS;
  } catch {
    return false;
  }
}

// A directory lock: mkdir is atomic, so parallel invocations take turns.
// The holder writes its pid into the directory, so a later invocation can
// break a lock that a killed mock left behind instead of waiting it out.
function withLock(scenarioPath, fn) {
  const statePath = statePathFor(scenarioPath);
  if (!statePath) return fn();
  const lock = `${statePath}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      if (lockIsStale(lock)) {
        // Renaming first means only one waiter breaks a given stale lock.
        const aside = `${lock}.stale-${process.pid}-${randomUUID()}`;
        try {
          renameSync(lock, aside);
          rmSync(aside, { recursive: true, force: true });
        } catch {
          // Another waiter broke it first.
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`mock CLI: timed out waiting for ${lock}`, { cause: err });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
