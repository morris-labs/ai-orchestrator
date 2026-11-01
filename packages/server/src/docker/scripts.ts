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
 * The sudoers file that holds the container user's sudo rule. Images built
 * before 4.0.0 put a `NOPASSWD` rule here; the root setup step replaces or
 * removes it in every container it starts.
 */
export const SUDOERS_FILE = "/etc/sudoers.d/claude-box";

/**
 * The container's root setup step, which the server runs once with
 * `docker exec --user root` right after it starts a project container,
 * before any session. It never calls sudo. Arguments: `$1` is the container
 * user, `$2` the user's home directory, `$3` the sudoers file, and the rest
 * the container paths of the bind mounts. Standard input carries one line:
 * the SHA-512 crypt hash of the sudo password, or an empty line for sudo
 * off.
 *
 * First, it gives the user the directories docker created as root above a
 * bind mount. Docker creates every missing parent of a mount's container
 * path as root, so a project under `/tmp/claude-1000/...` leaves
 * `/tmp/claude-1000` owned by root, and Claude Code then refuses to start
 * ("Temp directory /tmp/claude-1000 is owned by uid 0"). For each mount
 * path, the script walks up its parents and, for a root-owned one under
 * `/tmp` or the home directory, changes its owner to the user. It never
 * touches `/tmp`, the home directory or any of its parents (which matters
 * when the home sits under `/tmp`), or the mount point itself, never
 * recurses, skips any path with a symbolic link in it, and ignores every
 * failure.
 *
 * Then it sets the sudo policy. It always removes the sudoers file first,
 * so an older image's passwordless rule never survives. With a hash, it
 * installs the hash in `/etc/shadow` with `chpasswd -e` and writes a rule
 * that asks for that password on every use (`timestamp_timeout=0`). With
 * no hash, it locks the user's password, so sudo can't succeed. Exits 10
 * through 12 when a policy step fails; the server then removes the
 * container.
 */
export const ROOT_SETUP_SCRIPT = `U="$1"; H="$2"; F="$3"; shift 3
for p in "$@"; do
  d=$(dirname -- "$p")
  while [ "$d" != / ] && [ "$d" != . ]; do
    case "$d" in
      /tmp/*|"$H"/*)
        case "$H/" in
          "$d"/*) ;;
          *)
            if [ -d "$d" ] && [ "$(realpath -e -- "$d" 2>/dev/null)" = "$d" ] &&
               [ "$(stat -c %u -- "$d" 2>/dev/null)" = 0 ]; then
              chown -h -- "$U:" "$d" 2>/dev/null
            fi ;;
        esac ;;
    esac
    d=$(dirname -- "$d")
  done
done
HASH=
IFS= read -r HASH || :
rm -f -- "$F" "$F.tmp" || { echo "can't remove $F" >&2; exit 12; }
if [ -z "$HASH" ]; then
  usermod -p '!' -- "$U" || { echo "can't lock the password of $U" >&2; exit 12; }
  exit 0
fi
printf '%s:%s\\n' "$U" "$HASH" | chpasswd -e || { echo "can't set the sudo password of $U" >&2; exit 10; }
printf '%s ALL=(ALL:ALL) ALL\\nDefaults:%s timestamp_timeout=0\\n' "$U" "$U" > "$F.tmp" &&
  chmod 0440 "$F.tmp" && visudo -cqf "$F.tmp" && mv -f -- "$F.tmp" "$F" ||
  { rm -f -- "$F.tmp"; echo "can't install the sudo rule for $U" >&2; exit 11; }
`;

/**
 * The environment of the root setup step. Docker gives an exec the
 * container's environment, whose `PATH` starts with directories the
 * container user can write (the nvm and SDKMAN ones), so a bare `chown`
 * there could run the user's program as root. This list replaces `PATH`
 * with system directories only and clears the variables that load code
 * into a program or a shell.
 */
export const ROOT_SETUP_ENV = [
  "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
  "HOME=/root",
  "LD_PRELOAD=",
  "LD_LIBRARY_PATH=",
  "LD_AUDIT=",
  "BASH_ENV=",
  "ENV=",
];

/**
 * The `docker exec` options of the root setup step for the container user
 * `user`, whose home is `home`, with `mountPaths` the container paths of the
 * project root and the other bind mounts. `stdin` is the hash line.
 */
export function rootSetupExec(
  user: string,
  home: string,
  mountPaths: readonly string[],
  passwordHash: string | null,
): { cmd: string[]; user: string; env: string[]; workingDir: string; stdin: string } {
  return {
    cmd: ["/bin/sh", "-c", ROOT_SETUP_SCRIPT, "_", user, home, SUDOERS_FILE, ...mountPaths],
    user: "root",
    env: [...ROOT_SETUP_ENV],
    workingDir: "/",
    stdin: `${passwordHash ?? ""}\n`,
  };
}

/**
 * Trusts every directory for git, writing the rule only when the global
 * config lacks it. With a project `gitconfig`, `GIT_CONFIG_GLOBAL` points
 * `--global` at that host file, and an unconditional `--add` appended
 * another `directory = *` line to it at every container start.
 */
export const GIT_SAFE_DIRECTORY_SETUP =
  "git config --global --get-all safe.directory 2>/dev/null | grep -qxF '*' || " +
  "git config --global --add safe.directory '*' 2>/dev/null";

/**
 * The container command: trust every directory for git (worktree boxes need
 * it, see `GIT_SAFE_DIRECTORY_SETUP`), then replace the shell with the keeper, which stays PID 1 so that
 * `docker stop` reaches its SIGTERM trap and stops the engine cleanly. The
 * root-owned mount parents are the root setup step's job
 * (`ROOT_SETUP_SCRIPT`), since the container user has no passwordless sudo.
 */
export function sharedKeeperCommand(graceSec: number = STARTUP_GRACE_SEC): string[] {
  return [
    "bash",
    "-c",
    `${GIT_SAFE_DIRECTORY_SETUP}; exec ${KEEPER_PATH} "$1" "$2"`,
    "_",
    STATE_MOUNT,
    String(graceSec),
  ];
}

/**
 * A program and its arguments as one shell-quoted string; the program stays
 * bare. `vars` become an `env NAME=VALUE` prefix, which is how a session
 * gets its account's config folder (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or
 * `COPILOT_HOME`): a pane takes its environment from the tmux server, which
 * the container's first session started, so only the command line is per
 * session.
 */
export function buildSessionCommand(
  program: string,
  args: readonly string[],
  vars: Readonly<Record<string, string>> = {},
): string {
  const prefix = Object.entries(vars).map(([k, v]) => `${k}=${shellQuote(v)}`);
  return [...(prefix.length > 0 ? ["env", ...prefix] : []), program, ...args.map(shellQuote)].join(
    " ",
  );
}

/**
 * The script that links the container user's home to the default accounts,
 * so a bare `claude` typed in a shell works and absolute paths in user files
 * resolve. Arguments are pairs of TARGET and LINK. It leaves a LINK that is a
 * real file or folder alone.
 */
export const HOME_LINKS_SCRIPT =
  'while [ "$#" -ge 2 ]; do t="$1"; l="$2"; shift 2; ' +
  'if [ -e "$l" ] && [ ! -L "$l" ]; then continue; fi; ln -sfn -- "$t" "$l"; done';

/** The `docker exec` argv that starts session `session` in `workDir` with the image's script. */
export function sessionStartCmd(session: string, workDir: string, command: string): string[] {
  return [START_SESSION_PATH, session, workDir, command];
}
