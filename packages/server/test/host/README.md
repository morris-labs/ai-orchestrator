# Host tests for the server core

The scripts in this directory run the server core against the real Docker
daemon and the real `~/.claude-box`. The sandbox container that builds the
workspace has neither, so the host peer session runs them. Nothing here runs
in `pnpm test`.

## Before you run them

Build the workspace from the repository root:

```sh
corepack pnpm install
corepack pnpm -r build
```

Run each script from the repository root with Node 22 or later.

## Smoke test against Docker

```sh
node packages/server/test/host/smoke.mjs [--image=BASE_IMAGE] [--claude] [--keep]
```

Replace `BASE_IMAGE` with the image to build on; the default is
`claude-code`.

The script does the following:

1. Builds `agentbox-hosttest` on top of the base image, with a test engine
   version in `/etc/agentbox-engine-version` and the
   `agentbox.engine-version` label.
1. Creates a project in a temporary directory, prints the `docker run`
   equivalent of its launch spec with secrets masked, and starts the project
   container through `ensureContainer()`.
1. Checks the binds, the environment, and the engine port binding on
   `127.0.0.1`.
1. Waits for the keeper's state file, starts a tmux session with the session
   start script, and checks exit codes 0, 3 (already running), and 2 (ended
   right away).
1. Samples stats twice and prints the `container.stats` event.
1. With `--claude`, creates a real Claude box in the project, stops it, and
   purges its transcripts. This uses your Claude sign-in.
1. Kills the session and waits for the idle container to remove itself after
   its 5-second grace period.

Without `--keep`, the script removes the container, the test image, the
temporary directory, and the state and sessions directories it made. It uses a
temporary database, so it never touches `~/.claude-box/agentbox.db`.

## Import check against the real records

```sh
node packages/server/test/host/import-check.mjs
```

The script copies `known/`, `projects/`, `global`, and `ssh_remotes/` from
`~/.claude-box` to a temporary home, imports them into a temporary database
together with `~/.config/claude-box/claude-box.conf`, and prints the import
report. For every box it prints the 3.3.5 container and session, the 4.0
container and session, and whether the box's transcript exists in the real
`~/.claude/projects`. It fails when a record is skipped, when a box's
container is not its project's, or when a second import changes records. It
never writes to `~/.claude-box`.
