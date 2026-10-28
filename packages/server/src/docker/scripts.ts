// How the server runs a project container's scripts. The image installs
// them at `AGENTBOX_LIB` (`image/keeper/` in the repository): `keeper.sh` is
// the container's PID 1, keeps the engine running, and writes the live tmux
// sessions to the state directory; `start-session.sh` starts one box's tmux
// session. The 3.3.5 keeper and session scripts (`SharedContainer.cpp`,
// inventory section 4.2) stay below as the reference those scripts follow.

/** Where the keeper's state directory appears inside the container. */
export const STATE_MOUNT = "/run/claude-box";

/** Seconds the keeper lingers with no sessions before the container exits. */
export const STARTUP_GRACE_SEC = 30;

/** Where the image installs the keeper scripts. */
export const AGENTBOX_LIB = "/usr/local/lib/agentbox";

/** The keeper: `keeper.sh STATE GRACE`. */
export const KEEPER_PATH = `${AGENTBOX_LIB}/keeper.sh`;

/** The session starter: `start-session.sh SESSION WORK_DIR COMMAND`. */
export const START_SESSION_PATH = `${AGENTBOX_LIB}/start-session.sh`;

/**
 * Single-quotes one token for a `bash -c` string. Safe for any byte; only a
 * single quote needs escaping.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The 3.3.5 keeper, for reference: `keeper.sh` does the same and also keeps
 * the engine running. `$1` is the state directory and `$2` the
 * seconds to linger with no sessions. Each second it writes the live tmux
 * session names to `$1/sessions` through a temporary file and a rename.
 */
export const KEEPER_SCRIPT =
  'STATE="$1"; GRACE="$2"; IDLE=$SECONDS\n' +
  "while :; do\n" +
  "  tmux list-sessions -F '#S' > \"$STATE/sessions.tmp\" 2>/dev/null\n" +
  '  mv -f "$STATE/sessions.tmp" "$STATE/sessions"\n' +
  '  if [ -s "$STATE/sessions" ]; then IDLE=$SECONDS\n' +
  '  elif [ $((SECONDS-IDLE)) -gt "$GRACE" ]; then break; fi\n' +
  "  sleep 1\n" +
  "done\n";

/**
 * The 3.3.5 session starter, for reference: `start-session.sh` is the same
 * script. It starts one conversation as a tmux session. `$1` is the session name, `$2`
 * the working directory, and `$3` the whole command as one shell-quoted
 * string, so tmux's re-shelling cannot split a multi-word argument. Exits 3
 * when the session already runs, 1 when tmux fails, and 2 when the program
 * ends within two seconds.
 */
export const SESSION_START_SCRIPT =
  'S="$1"; D="$2"; CMD="$3"\n' +
  'tmux has-session -t "=$S" 2>/dev/null && { echo "session $S is already running" >&2; exit 3; }\n' +
  'tmux new-session -d -s "$S" -c "$D" -- "$CMD" || exit 1\n' +
  "sleep 2\n" +
  'tmux has-session -t "=$S" 2>/dev/null || { echo "$S ended right after starting" >&2; exit 2; }\n';

/**
 * The container command: trust every directory for git (worktree boxes need
 * it), then replace the shell with the keeper, which stays PID 1 so that
 * `docker stop` reaches its SIGTERM trap and stops the engine cleanly.
 */
export function sharedKeeperCommand(graceSec: number = STARTUP_GRACE_SEC): string[] {
  return [
    "bash",
    "-c",
    `git config --global --add safe.directory '*' 2>/dev/null; exec ${KEEPER_PATH} "$1" "$2"`,
    "_",
    STATE_MOUNT,
    String(graceSec),
  ];
}

/** A program and its arguments as one shell-quoted string; the program stays bare. */
export function buildSessionCommand(program: string, args: readonly string[]): string {
  return [program, ...args.map(shellQuote)].join(" ");
}

/** The `docker exec` argv that starts session `session` in `workDir` with the image's script. */
export function sessionStartCmd(session: string, workDir: string, command: string): string[] {
  return [START_SESSION_PATH, session, workDir, command];
}
