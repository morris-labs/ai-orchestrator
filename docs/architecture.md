# Architecture

Agent Box has four parts: a host server, an engine inside each project
container, two desktop apps, and a CLI. This page describes what each part
owns, how they talk, and how the server keeps vendor usage under its
ceilings with leases.

## Overview

The following diagram shows the parts and their connections:

```
host                                     container (one per project)
+------------------------------+         +------------------------------+
| agentbox-server (systemd)    | docker  | keeper (PID 1)               |
|  Docker, boxes, projects,    |-------->|  tmux: one session per box   |
|  worktrees, catalog, watcher,|         |  agentbox-engine :20411      |
|  SQLite, secrets, scheduler, |<--------|   pipeline, adapters, run    |
|  usage, events, terminals,   | :2041x  |   files, port discovery,     |
|  REST+WS on 127.0.0.1:21400  | mapped  |   dev-server proxy           |
+-------^----------^-----------+         +------------------------------+
        |          |
  agentbox (boxes) agentbox-review        agentbox CLI
  Electron+xterm   Electron+dashboard     commander
```

## Parts

### Server

The server, `agentbox-server`, runs as a systemd user service under your
user. It owns everything that touches Docker or host files: projects, boxes,
worktrees, the conversation catalog, the session watcher, secrets, the
usage scheduler, and terminals.

- It listens on `127.0.0.1:21400` and serves a REST and WebSocket API under
  `/api/v1/`, the two apps' pages at `/boxes/` and `/review/`, and the
  dev-server proxy for `PORT.BOX.localhost` host names.
- Every API call needs the bearer token in `~/.claude-box/server.token`
  (mode `0600`), or the session cookie that the token buys. WebSocket
  upgrades authenticate the same way: the CLI and the Electron main
  processes send `Authorization: Bearer`, and the app pages, whose browser
  WebSockets can't set headers, trade the token for the cookie first. No
  route accepts a token in the query string, so tokens stay out of URLs.
- It stores its state in SQLite at `~/.claude-box/agentbox.db` and its
  settings in `~/.claude-box/config.json`.
- It's the only client of each engine.

### Engine

The engine, `agentbox-engine`, ships in the container image and runs in each
project container next to the repositories and the signed-in CLIs. The
keeper script, the container's first process, starts it.

- It binds `0.0.0.0:20411` inside the container. Docker maps that port to a
  free port on the host's loopback address, so only the host can reach it.
- Every call, WebSocket upgrades included, needs the token that the server
  generates for each container, in `Authorization: Bearer`. The health
  route, `/api/v1/health`, needs no token; the image's health check calls
  it.
- The server writes the token to `engine.token` (mode `0600`) in the
  container's state directory, `~/.claude-box/state/CONTAINER/` on the host
  and `/run/claude-box/` in the container, before the container starts. The
  engine reads it from `AGENTBOX_ENGINE_TOKEN_FILE`. The token isn't in the
  container's environment, so the tmux sessions, shells, and agent CLIs
  that `docker exec` starts don't inherit it, and the engine withholds every
  `AGENTBOX_` variable from the processes it starts. At startup the engine
  also executes itself again without its credentials in the environment and
  keeps them in memory, so its own `/proc/PID/environ` holds none.
- These measures control what a process inherits; they aren't isolation.
  Every process in the container runs as one user, so repository code that
  the review runs, such as a test command or a reproduction script, can
  still read the token file, the keeper's `/proc/1/environ` with the
  project's secrets, and a vendor CLI's environment. With the token it can
  call the engine API. Run reviews only on code you would run in the box
  yourself.
- The dev-server proxy sends the engine token in its own header,
  `X-Agentbox-Engine-Token`, on HTTP requests and WebSocket upgrades alike,
  so the browser's `Authorization` header reaches the dev server unchanged.
- It runs the review pipeline and its vendor adapters, writes each run's
  files, discovers listening ports with `ss`, and proxies HTTP to them.
- It refuses to start when its version differs from
  `AGENTBOX_ENGINE_VERSION`, the version the server expects. The image
  records its engine version in `/etc/agentbox-engine-version`.

### Apps

**Agent Box** manages boxes and terminals, and **Agent Box Review** runs and
watches reviews. Both are React single-page apps that the server serves.
Electron wraps each one for the tray icon, desktop notifications, the
external terminal, and the desktop entry.

### CLI

The `agentbox` command calls the same server API as the apps. It has `box`
and `review` command groups, plus `migrate`, `setup`, and `doctor`.

## Files as handoffs

Every pipeline stage writes its result as JSON under
`PROJECT/.claude-box/runs/RUN_ID/`. A run resumes from the last complete
stage after a crash or a container restart. The engine records the process
groups it starts in `engine-children.json` in the keeper's state directory,
and an engine that the keeper restarts first kills the groups that the
crashed engine left running, so a resumed stage never runs beside an
orphaned agent. The engine streams events about
each stage, agent call, and finding; the server tails that stream and
mirrors runs, findings, and usage into SQLite for the apps and the CLI.

## Lease flow

Usage limits belong to an account, not a container, so the scheduler and
the ceilings live in the server. Before every model call, the engine asks
the server for a lease. The engine can't open a connection to the server,
so the lease messages travel as control frames on the engine's event
WebSocket, which the server holds open.

The following diagram shows one call:

```
engine                                          server
  |  lease.request {leaseId, runId, vendor,       |
  |                 role, estimate.tokens}        |
  |---------------------------------------------->|  checks the vendor's usage
  |                                               |  against its ceiling
  |  lease.response                               |
  |<----------------------------------------------|
  |   granted {vendor, redirectedFrom, expiresAt} |
  |   or pause {resumeAt, reason}                 |
  |   or deny {reason, action}                    |
  |                                               |
  |  (model call on the granted vendor)           |
  |                                               |
  |  event lease.settled {tokens, premium         |
  |                       requests, cost}         |
  |---------------------------------------------->|  records the usage
```

The protocol follows these rules:

1. The engine sends a `lease.request` frame. Control frames carry no
   sequence number and are never replayed.
1. The server answers with a `lease.response` frame on the same socket.
1. When a client subscribes, the engine resends every request that has no
   answer. The server answers a repeated `leaseId` with the same response.
1. A grant is valid until its `expiresAt` time. If the socket drops, the
   engine keeps using the grant until then, and asks again for the next
   call after it expires.
1. A `granted` response can name a different vendor than the request did,
   when the requested vendor is over its ceiling. `redirectedFrom` then
   names the requested vendor.
1. On `pause`, the engine asks again at `resumeAt`. On `deny`, the engine
   pauses the run with a ceiling decision, or fails that role's call when
   `action` is `fail_role`.
1. After the call, the engine emits a `lease.settled` event with the actual
   usage, which the server records against the vendor's account.

The schemas for these frames are in `packages/contracts/src/lease.ts`.

## Container image

The image, `claude-code` by default, is built on the host from
`image/Dockerfile`. It holds the following:

- Ubuntu 26.04, pinned by digest, with the C, C++, Java, Python, and
  Node.js toolchains.
- The Claude Code, Codex, and GitHub Copilot CLIs at the versions pinned in
  `image/versions.env`, with their versions in `/etc/claude-code-version`,
  `/etc/codex-version`, and `/etc/copilot-version`.
- The engine, installed from the workspace's packed tarballs into
  `/usr/local/lib/agentbox/engine`, and started through
  `/usr/local/bin/agentbox-engine` on the system Node.js 22.
- The keeper scripts in `/usr/local/lib/agentbox/`: `keeper.sh`, the
  container's first process, and `start-session.sh`, which starts one box's
  tmux session.

The server creates each container with the keeper as its command, the
project root mounted at the same path, the engine's port and the project's
secrets in its environment, and the engine token in a file in the mounted
state directory. The image has no default command.

## Repository layout

The repository is a pnpm workspace:

| Path | Contents |
|---|---|
| `packages/contracts` | Zod schemas and types shared by every package |
| `packages/server` | `agentbox-server` |
| `packages/engine` | `agentbox-engine` |
| `packages/cli` | `agentbox` |
| `packages/ui` | Shared React components, theme, and API client |
| `apps/boxes`, `apps/review` | The two Electron apps |
| `image/` | The Dockerfile, the version pins, and the keeper scripts |
| `packaging/` | The `.deb` layout, the systemd unit, desktop entries, and icons |
| `scripts/` | Build, version, and release scripts |
| `tools/` | Mock CLIs and a sample repository for tests |
| `docs/` | This documentation |
