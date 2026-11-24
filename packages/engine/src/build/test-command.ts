// How the engine runs a per-test command, such as one that the Test engineer
// lists and the test lock keeps. The plan's test commands can start with
// `NAME=value` assignments that set up the environment the tests need, such
// as `PATH=/usr/bin:$PATH` for a Node.js that matches the native modules. A
// per-test command runs in that same environment: the engine puts the plan's
// assignments in front of it. Every place that runs a per-test command goes
// through `listedTestCommand()`.
import type { BuildCommands, PolicyCommand } from "@aio/contracts";

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
 * The command that runs a per-test `command`: the plan's test assignments,
 * other than the names that `command` assigns itself, then `command`.
 */
export function listedTestCommand(
  command: string,
  commands: Pick<BuildCommands, "test">,
): PolicyCommand {
  const own = new Set(leadingAssignments(command).map(nameOf));
  const prefix = testAssignments(commands).filter((a) => !own.has(nameOf(a)));
  return { command: prefix.length > 0 ? `${prefix.join(" ")} ${command.trimStart()}` : command };
}
