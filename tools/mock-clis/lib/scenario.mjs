// Shared scenario handling for the mock CLIs. A scenario file lists scripted
// responses; each call takes the first one whose `match` fits the prompt and
// whose `times` isn't used up. Use counts persist in a state file, so a
// sequence of separate CLI invocations walks through the script.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
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
    const state = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
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

/** Writes `response.writeFiles` ({ relative path: content }) under the working directory. */
export function writeFiles(response) {
  for (const [file, content] of Object.entries(response.writeFiles ?? {})) {
    const target = isAbsolute(file) ? file : join(process.cwd(), file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
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

// A directory lock: mkdir is atomic, so parallel invocations take turns.
function withLock(scenarioPath, fn) {
  const statePath = statePathFor(scenarioPath);
  if (!statePath) return fn();
  const lock = `${statePath}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`mock CLI: timed out waiting for ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(lock);
  }
}
