# Migrate from Claude Box 3.x

Agent Box 4.0.0 replaces the Qt app (Claude Box 3.x) with a host server, two
Electron apps, and a CLI. It keeps your boxes, their transcripts, and their
worktrees. This page describes what the one-time import does, what changes
for classic boxes, and what 4.0.0 drops or defers.

## What stays the same

- Container names keep the `claude-agent-` prefix, and a project's shared
  container is still `claude-agent-proj-PROJECT_ID`.
- Your data stays in `~/.claude-box`. The import reads the 3.x files and
  leaves them in place.
- Transcripts stay in `~/.claude/projects`. Each box keeps its session ID, so
  it resumes the same conversation.
- Worktrees stay at `PRIMARY_REPO/.worktrees/SLUG` on `claude/SLUG`
  branches, with their notes in `WORKTREE/.claude-box/`.
- Mounts work as before: the project root at the same path, `~/.claude`,
  `~/.claude.json`, `~/.codex`, `~/.copilot`, the global mounts, and each
  project's mounts.

## Before you migrate

1. Stop every running box in the 3.x app, and close the app.
1. Back up your data directory:

   ```sh
   cp -a ~/.claude-box ~/.claude-box.3x-backup
   ```

1. Install Agent Box 4 and start its server. For more information, see
   [Install Agent Box](install.md).

## Run the import

The import runs once. Start it from the setup wizard, which offers it when it
finds 3.x records, or from a terminal:

```sh
agentbox migrate
```

The import reads the following sources into the database at
`~/.claude-box/agentbox.db`:

| 3.x source | Becomes |
|---|---|
| `~/.claude-box/known/BOX` | A box |
| `~/.claude-box/projects/PROJECT_ID` | A project |
| `~/.claude-box/global` | The global mounts |
| `~/.claude-box/ssh_remotes/REMOTE` | An SSH remote |
| QSettings, in `~/.config/claude-box/claude-box.conf` | Global settings: prompt templates, setup state, the default directory, the SSH identity, the model list cache, and the New Box defaults |

A box that refers to a directory with no project record gets a project, as
in 3.x. The import reports every record it converts and every value it
drops or changes, and doesn't change the 3.x files. After the import,
4.0.0 reads only the database.

The server runs the import by itself on its first start when it finds 3.x
records. The first import writes its report to
`~/.claude-box/import-report.json`. A later `agentbox migrate` adds only
records created since then, says when the first import ran, and writes its
own report to `~/.claude-box/import-report-TIMESTAMP.json`, where
`TIMESTAMP` is the time the run started, in UTC. It never replaces the first
import's report.

### Ports and mounts

- A box's `port=HOST:CONTAINER` entry that isn't in its project's 10-port
  pool becomes an explicit TCP map on the project. Ports from the pool are
  dropped: the engine proxies dev servers without them.
- TCP maps listen on `127.0.0.1` only. 3.x published them on every host
  interface. To reach one from another machine, set the map's
  `allInterfaces` field to `true` through the API.
- A box's `dir=` mounts merge into its project's mounts. When two mounts name
  the same container path, the first one wins, project mounts first, and
  the import reports each mount it skipped.

## Classic boxes

4.0.0 drops classic mode, in which each box had its own container. Every box
runs as a tmux session in its project's shared container.

The import keeps a classic box as it is, with the same name, session, and
transcript. The first time you start it in 4.0.0, the server moves it into
its project's container, the same move as the 3.x **Move existing boxes**
command, and starts it there. The box keeps its name in the box list, and
its tmux session takes the box's name.

A 3.x project that had opted out of the shared container
(`shared_container=0`) gets one too.

## What 4.0.0 drops

The following 3.x features and files have no 4.0.0 equivalent:

- **Classic one-container-per-box mode**: every project runs one shared
  container.
- **The port pool and the port hint prompt**: dev servers are found and
  proxied at `http://PORT.BOX.localhost:21401/`. Use a project TCP map when
  you need a fixed host port.
- **`agent.env` files**: secrets come from 1Password references only. For
  more information, see [Secrets](secrets.md#migrate-from-agentenv).
- **The `rc=` record key**: it was already ignored.
- **Window layout and update-checker state in QSettings**: the `ui/*`,
  `updateChecker/*`, `claudeCodeUpdateChecker/*`, and `portAllocator/*`
  keys aren't imported. The apps keep their own window state.
- **The Qt app and the bash launcher scripts**: the tag `v3.3.5` keeps them
  in the repository history.

## What 4.0.0 defers

- **macOS and Windows packages**: 4.0.0 ships a `.deb` for Linux on x86-64
  only.

## Roll back

To go back to 3.x, stop the Agent Box service, then reinstall Claude Box
3.3.5. The import didn't change the 3.x files, so 3.x reads them as before.
Boxes that 4.0.0 moved into a shared container have `container=` and
`session=` keys only in the 4.0.0 database; in 3.x they stay classic. To
undo every change, restore `~/.claude-box.3x-backup`.
