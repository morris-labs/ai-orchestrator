// How the engine runs a per-test command, such as one that the Test engineer
// lists and the test lock keeps. The plan's test commands can start with
// `NAME=value` assignments that set up the environment the tests need, such
// as `PATH=/usr/bin:$PATH` for a Node.js that matches the native modules. A
// per-test command runs in that same environment: the engine puts the plan's
// assignments in front of it, and runs it in the plan's test directory when
// every test command sets the same one. A per-test command that passes
// without running a test fails. Every place that runs a per-test command goes
// through `runListedTest()`. The plan's setup commands get the same
// assignments, so dependencies install for the Node.js that the tests use.
import type { BuildCommands, PolicyCommand } from "@aio/contracts";
import { runGateCommand, type GateCommandResult, type GateOptions } from "../gate/gate.js";
import { ranNoTests } from "./red-check.js";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Characters that end a word and start a shell operator. */
const OPERATORS = new Set([";", "&", "|", "<", ">", "(", ")"]);

/**
 * The end of the shell word that starts at `start`, or `null` when the word
 * has an unclosed quote or ends on an operator, so it isn't a plain word.
 */
function wordEnd(text: string, start: number): number | null {
  let i = start;
  while (i < text.length) {
    const ch = text[i] as string;
    if (/\s/.test(ch)) return i;
    if (OPERATORS.has(ch)) return null;
    if (ch === "\\") {
      i += 2;
    } else if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) return null;
      i = close + 1;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) return null;
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return i > text.length ? null : i;
}

/**
 * The `NAME=value` assignments that `command` starts with, as written. An
 * assignment counts only when a command follows it on the same line, so
 * `A=1; run`, `A=1 && run`, and a lone `A=1` have none.
 */
export function leadingAssignments(command: string): string[] {
  const found: string[] = [];
  let i = command.length - command.trimStart().length;
  while (i < command.length && NAME_RE.test(command.slice(i))) {
    const end = wordEnd(command, i);
    if (end === null || end >= command.length) return [];
    found.push(command.slice(i, end));
    i = end;
    while (i < command.length && /\s/.test(command[i] as string)) i += 1;
  }
  if (i >= command.length || OPERATORS.has(command[i] as string)) return [];
  return found;
}

function nameOf(assignment: string): string {
  return assignment.slice(0, assignment.indexOf("="));
}

/**
 * The environment of the plan's test commands: each leading assignment of
 * each test command, in order. When two test commands assign the same name,
 * the first one's value counts.
 */
export function testAssignments(commands: Pick<BuildCommands, "test">): string[] {
  const byName = new Map<string, string>();
  for (const cmd of commands.test) {
    for (const assignment of leadingAssignments(cmd.command)) {
      if (!byName.has(nameOf(assignment))) byName.set(nameOf(assignment), assignment);
    }
  }
  return [...byName.values()];
}

/**
 * The directory of the plan's test commands, relative to the repository:
 * the `cwd` that every test command sets, or `null` (the repository root)
 * when they set different ones or one sets none.
 */
export function testDirectory(commands: Pick<BuildCommands, "test">): string | null {
  const dirs = new Set(commands.test.map((cmd) => cmd.cwd ?? ""));
  const [only] = dirs;
  return dirs.size === 1 && only ? only : null;
}

/**
 * `command` in the environment of the plan's test commands: the plan's test
 * assignments, other than the names that `command` assigns itself, then
 * `command`. Per-test commands and the plan's setup commands run this way.
 */
export function inTestEnvironment(command: string, commands: Pick<BuildCommands, "test">): string {
  const own = new Set(leadingAssignments(command).map(nameOf));
  const prefix = testAssignments(commands).filter((a) => !own.has(nameOf(a)));
  return prefix.length > 0 ? `${prefix.join(" ")} ${command.trimStart()}` : command;
}

/**
 * The command that runs a per-test `command`: `command` in the test
 * environment (see `inTestEnvironment()`), in the plan's test directory when
 * it has one.
 */
export function listedTestCommand(
  command: string,
  commands: Pick<BuildCommands, "test">,
): PolicyCommand {
  const line = inTestEnvironment(command, commands);
  const cwd = testDirectory(commands);
  return cwd ? { command: line, cwd } : { command: line };
}

/** The failure line of a per-test command that passed without running a test. */
export const NO_TESTS_FAILURE = "the command ran no tests";

/**
 * A per-test command's result, with a run that exited 0 but ran no tests
 * (see `ranNoTests()`) turned into a failure: such a run proves nothing.
 */
export function requireTests(result: GateCommandResult): GateCommandResult {
  if (!result.passed || !ranNoTests(result.outputTail)) return result;
  return {
    ...result,
    passed: false,
    noTests: true,
    failures: [...new Set([...result.failures, NO_TESTS_FAILURE])].sort(),
  };
}

/**
 * Runs a per-test `command` the way every step must: through
 * `listedTestCommand()`, and failing a run that ran no tests.
 */
export async function runListedTest(
  command: string,
  commands: Pick<BuildCommands, "test">,
  options: GateOptions,
): Promise<GateCommandResult> {
  return requireTests(await runGateCommand("test", listedTestCommand(command, commands), options));
}

/**
 * A sentence for the Test engineer's prompt that says how the engine runs
 * its per-test commands, or an empty string when the plan's test commands
 * set no assignments and no directory.
 */
export function testEnvironmentNote(commands: Pick<BuildCommands, "test">): string {
  const assignments = testAssignments(commands);
  const cwd = testDirectory(commands);
  if (assignments.length === 0 && !cwd) return "";
  const where = cwd ? `in \`${cwd}\`` : "from the repository root";
  const prefix = assignments.length > 0 ? ` with \`${assignments.join(" ")}\` in front` : "";
  const list = [
    cwd ? `write each command to run from \`${cwd}\`` : "",
    assignments.length > 0 ? "list each command without those assignments" : "",
  ].filter(Boolean);
  return `The engine runs each test's command ${where}${prefix}, as the plan's test commands do. Run your tests the same way, and ${list.join(", and ")}.`;
}

/**
 * A sentence for the Developer's and the Test engineer's prompts that says
 * the plan's setup commands, as the engine ran them, already installed the
 * dependencies, and that the agent must not install or rebuild anything.
 */
export function setupNote(commands: Pick<BuildCommands, "setup" | "test">): string {
  const rule =
    "Don't install dependencies or rebuild native modules yourself, and don't run a package manager's install under another Node.js or interpreter.";
  if (commands.setup.length === 0) {
    return `The plan has no setup commands. ${rule} When a test can't load a dependency, say so in your report.`;
  }
  const list = commands.setup
    .map((cmd) => {
      const line = `\`${inTestEnvironment(cmd.command, commands)}\``;
      return cmd.cwd ? `${line} in \`${cmd.cwd}\`` : line;
    })
    .join(", then ");
  return `Before the first task, the engine ran the plan's setup commands in the worktree, so the dependencies are already installed: ${list}. ${rule} When your task changes the dependencies, rerun those setup commands exactly as written.`;
}
