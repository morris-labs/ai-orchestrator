# Architecture

AI Orchestrator has four parts: a host server, an engine inside each project
container, two desktop apps, and a CLI. This page describes what each part
owns, how they talk, and how the server keeps vendor usage under its
ceilings with leases.

## Overview

The following diagram shows the parts and their connections:

```
host                                     container (one per project)
+------------------------------+         +------------------------------+
| aio-server (systemd)    | docker  | keeper (PID 1)               |
|  Docker, boxes, projects,    |-------->|  tmux: one session per box   |
|  worktrees, catalog, watcher,|         |  aio-engine :20411      |
|  SQLite, secrets, scheduler, |<--------|   pipeline, adapters, run    |
|  usage, events, terminals,   | :2041x  |   files, port discovery,     |
|  HTTPS REST+WS :21400,       | mapped  |   dev-server proxy           |
|  dev-server proxy :21401     |         |                              |
+-------^----------^-----------+         +------------------------------+
        |          |
  aio (boxes) aio-review        aio CLI
  Electron+xterm   Electron+dashboard     commander
```

## Parts

### Server

The server, `aio-server`, runs as a systemd user service under your
user. It owns everything that touches Docker or host files: projects, boxes,
worktrees, the conversation catalog, the session watcher, secrets, the
usage scheduler, and terminals.

- It listens on `127.0.0.1:21400` and serves, over HTTPS, a REST and
  WebSocket API under `/api/v1/` and the two apps' pages at `/boxes/` and
  `/review/`. A second, plain HTTP listener on `127.0.0.1:21401` serves the
  dev-server proxy for `PORT.BOX.localhost` host names, which the
  certificate can't name.
- The certificate is self-signed and lives in `~/.ai-orchestrator/server.crt`,
  its key in `server.key` (mode `0600`). Every client pins it: the CLI, the
  Electron main processes for their REST calls and WebSockets, and both
  apps' windows for the pages they load. A client checks the certificate
  before it sends the token, so a program that binds the port while the
  server is down never receives the token.
- Every API call needs the bearer token in `~/.ai-orchestrator/server.token`
  (mode `0600`), or the session cookie that the token buys. WebSocket
  upgrades authenticate the same way: the CLI and the Electron main
  processes send `Authorization: Bearer`, and the app pages, whose browser
  WebSockets can't set headers, trade the token for the cookie first and
  then drop it. No route accepts a token in the query string, so tokens
  stay out of URLs.
- A WebSocket upgrade with an `Origin` header must come from the server's
  own origin, `https://127.0.0.1:21400` or the same port on `localhost` or
  `[::1]`, so a page on another port can't open a terminal with the
  user's cookie. Clients without a browser send no `Origin`.
- Every route also answers under `/api/v1/machines/MACHINE/proxy/`, where
  `MACHINE` names the machine that serves the call. `local` always means
  the server that receives it, so `/api/v1/machines/local/proxy/boxes` is
  `/api/v1/boxes`, with the same token check. On a hub, any other name is a
  connected node: the hub forwards the call over that node's link as
  `/api/v1/REST`, keeps the query, drops the hop-by-hop headers and the
  client's credentials, and adds `x-aio-forwarded-by`. On a plain node, the
  call goes to the hub unchanged, and the hub routes it on, for the routes
  that [Multi-host](multi-host.md#what-crosses-the-link) lists. WebSocket routes
  work the same way: the server relays frames, binary flags, and close codes
  in both directions, and on an event stream it tags each event with
  `machine`. An unknown machine answers `not_found` (404), an enrolled one
  without a link `machine_offline` (503), and one that doesn't answer in
  time `machine_timeout` (504). Without links, as on a single PC, only
  `local` resolves.
- It stores its state in SQLite at `~/.ai-orchestrator/aio.db` and its
  settings in `~/.ai-orchestrator/config.json`.
- It runs the secrets broker: one Unix socket per project container, in
  `~/.ai-orchestrator/broker/CONTAINER/`, mounted read-only at
  `/run/aio-broker` in the container. Under Docker Desktop, it listens on
  one `127.0.0.1` port per container instead, with a per-container token
  in the same directory. A process in the container asks the broker for a
  secret by name, and the server resolves it from 1Password on demand, with
  a 5-minute cache. At startup, after each container event, and every 30
  seconds, the server opens a socket or TCP listener for each running
  project container and closes those of containers that are gone. See
  [Secrets](secrets.md#the-secrets-broker).
- It's the only client of each engine.
- In a multi-host setup, a hub also listens for enrolled GUI apps on other PCs on
  port `21403`, once it has issued a GUI code. See `docs/multi-host.md`.
- In a multi-host setup, a hub also listens for node links on port `21402`
  on its LAN address only, over mutual TLS, once it has enrolled a machine or
  issued an enrollment code. Each node dials out to its hub and keeps one
  WebSocket open. See [Multi-host](multi-host.md).

### Engine

The engine, `aio-engine`, ships in the container image and runs in each
project container next to the repositories and the signed-in CLIs. The
keeper script, the container's first process, starts it.

- It binds `0.0.0.0:20411` inside the container. Docker maps that port to a
  free port on the host's loopback address, so only the host can reach it.
- Every call, WebSocket upgrades included, needs the token that the server
  generates for each container, in `Authorization: Bearer`. The health
  route, `/api/v1/health`, needs no token; the image's health check calls
  it.
- The server writes the token to `engine.token` (mode `0600`) in the
  container's state directory, `~/.ai-orchestrator/state/CONTAINER/` on the host
  and `/run/aio/` in the container, before the container starts. The
  engine reads it from `AIO_ENGINE_TOKEN_FILE`. The token isn't in the
  container's environment, so the tmux sessions, shells, and agent CLIs
  that `docker exec` starts don't inherit it, and the engine withholds every
  `AIO_` variable from the processes it starts. At startup the engine
  also executes itself again without its credentials in the environment and
  keeps them in memory, so its own `/proc/PID/environ` holds none.
- `account-dirs.json` names each vendor's default account folder as the
  container sees it. It lives in a server-owned folder outside the state
  directory, which the container mounts read-only at `/run/aio-config`, so
  code in the container can't redirect a vendor CLI by rewriting the file. The
  server writes it before the container starts, and rewrites it when the
  account defaults or the accounts mode change and each time it ensures a
  running container. The engine reads it for every vendor call and sets
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or `COPILOT_HOME` from it. A vendor
  without a valid entry, as in host mode, uses its home folder, and the
  engine logs a warning when the file is missing or an entry isn't valid.
- A running container uses only what it mounts. One launched in host mode stays
  on its home folders when the mode changes to accounts. One launched in
  accounts mode keeps its previous Claude account when the default moves to an
  account made after the launch, because that account has no `sessions` mount
  there. The server logs this. Restart the container to apply the change. When
  a default moves, the server also moves the container's home links, so a bare
  CLI in a shell and the engine use the same account.
- These measures control what a process inherits; they aren't isolation.
  Every process in the container runs as one user, so repository code that
  the review runs, such as a test command or a reproduction script, can
  still read the token file, ask the secrets broker for any secret the
  project lists, read a vendor CLI's environment, and write to the account
  folders it mounts, such as an account's `settings.json`, which a later
  vendor call loads. With the token it can call the engine API. Run reviews only on code you would run in the box
  yourself.
- The engine gets the credentials it hands vendor CLIs, `git`, and `gh` from
  the secrets broker when it starts each one, and gives each program only
  the names its job takes. Repository code it starts gets none.
- The dev-server proxy sends the engine token in its own header,
  `X-Aio-Engine-Token`, on HTTP requests and WebSocket upgrades alike,
  so the browser's `Authorization` header reaches the dev server unchanged.
  It refuses a request whose `Origin` isn't the proxy host itself or whose
  `Sec-Fetch-Site` is other than `same-origin` or `none`, and forwards only
  to the ports the box listens on or the project maps.
- It runs the review pipeline and its vendor adapters, writes each run's
  files, discovers listening ports with `ss`, and proxies HTTP to them.
- It refuses to start when its version differs from
  `AIO_ENGINE_VERSION`, the version the server expects. The image
  records its engine version in `/etc/aio-engine-version`.

### Apps

**AI Orchestrator** manages boxes and terminals, and **AI Orchestrator Review** runs and
watches reviews. Both are React single-page apps that the server serves.
Electron wraps each one for the tray icon, desktop notifications, the
external terminal, and the desktop entry.

### CLI

The `aio` command calls the same server API as the apps. It has `box`
and `review` command groups, plus `migrate`, `setup`, and `doctor`.

## Files as handoffs

Every pipeline stage writes its result as JSON under
`PROJECT/.aio/runs/RUN_ID/`. A run resumes from the last complete
stage after a crash or a container restart. The engine records the process
groups it starts in `engine-children.json` in the keeper's state directory,
and an engine that the keeper restarts first kills the groups that the
crashed engine left running, so a resumed stage never runs beside an
orphaned agent. The engine streams events about
each stage, agent call, and finding; the server tails that stream and
mirrors runs, findings, and usage into SQLite for the apps and the CLI.
The server drops an engine event of a type only the server emits, such as
`box.changed`, and any event about another container, another project, or
a run of another project, so code in one container can't change what the
server knows about another.

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
   `action` is `fail_role`. A failed call fails the run, as a call that
   fails after its retry does; starting the run again retries the stage.
1. After the call, the engine emits a `lease.settled` event with the actual
   usage, which the server records against the vendor's account.

The schemas for these frames are in `packages/contracts/src/lease.ts`.

## Container image

The image, `aio-agent` by default, is built on the host from
`image/Dockerfile`. It holds the following:

- Ubuntu 26.04, pinned by digest, with the C, C++, Java, Python, and
  Node.js toolchains.
- The Claude Code, Codex, and GitHub Copilot CLIs at the versions pinned in
  `image/versions.env`, with their versions in `/etc/claude-code-version`,
  `/etc/codex-version`, and `/etc/copilot-version`.
- The engine, unpacked into `/usr/local/lib/ai-orchestrator/engine` from a
  tarball that carries its dependencies at the versions in
  `pnpm-lock.yaml`, and started through
  `/usr/local/bin/aio-engine` on the system Node.js 22.
- The keeper scripts in `/usr/local/lib/ai-orchestrator/`: `keeper.sh`, the
  container's first process, and `start-session.sh`, which starts one box's
  tmux session.
- `/usr/local/bin/aio-secret`, the client of the secrets broker, from
  the engine package.

The server creates each container with the keeper as its command, the
project root mounted at its container path (the same path on Linux and
macOS; see [Host paths in containers](host-paths.md)), the engine's port and the broker
socket's path, or under Docker Desktop the broker's URL, in its environment, the engine token in a file in the mounted
state directory, and the broker's directory mounted read-only. No secret
value is in the container's configuration or environment. The image has no
default command.

Right after a container starts, and before any box session runs in it, the
server runs a root setup step with `docker exec --user root`. The step
never calls `sudo`. It does the following:

- Gives the container user the directories that Docker created as root
  above a bind mount under `/tmp` or the home directory, such as
  `/tmp/claude-1000` above a project in `/tmp/claude-1000/...`. Claude Code
  refuses to start when its temporary directory is owned by root. The step
  skips any path with a symbolic link in it.
- Sets the `sudo` policy. It removes `/etc/sudoers.d/aio`, where
  images built before 1.0.0 granted passwordless `sudo`. With a sudo
  password reference in the settings, it installs the password's hash and a
  rule that asks for the password every time. Without one, it locks the
  user's password, so `sudo` is off. See
  [The sudo password](secrets.md#the-sudo-password).

The step runs with a fixed `PATH` of system directories and with the
variables that load code into a program cleared, because the container's
own `PATH` starts with directories the container user can write. When the
step fails, the server removes the container and the launch fails, since an
older image's passwordless rule might still be in place.

### Docker Desktop

Docker Desktop on macOS and Windows runs containers in a virtual machine.
The following list describes how each part of a launch behaves there, and
which parts are untested on a real macOS or Windows host:

- **Secrets broker**: uses the TCP transport. See
  [The broker under Docker Desktop](secrets.md#the-broker-under-docker-desktop).
  Untested on a real macOS or Windows host.
- **Engine port**: the server publishes container port `20411` on
  `127.0.0.1` with the same create body as on Linux. Docker Desktop binds
  published ports on the host's own loopback address, so the server, the
  engine supervisor, and the dev-server proxy reach the engine the same
  way. Untested on a real macOS or Windows host.
- **Dev-server proxy**: the proxy connects to the engine's published port,
  and the engine connects to the dev server inside the container, so no
  path crosses the virtual machine other than the published port.
- **State and sessions directories**: the keeper rewrites
  `/run/aio/sessions` every second, and the server counts a file older than
  6 seconds as empty. File sharing adds latency to that rewrite, and file
  change events from the container might not reach the host; the session
  watcher's 3-second poll covers missed events. Untested on a real macOS or
  Windows host.
- **SSH agent**: the server doesn't forward an SSH agent into containers,
  so there's no host socket to mount. SSH remotes run their tunnels on the
  host. Docker Desktop for macOS offers its agent at
  `/run/host-services/ssh-auth.sock` if agent forwarding is added later.
- **`host.docker.internal`**: Docker Desktop defines it. The server adds
  `host.docker.internal:host-gateway` only for the TCP transport on Docker
  Engine on Linux.
- **File ownership**: the image keeps the container user at uid 1000. Docker
  Desktop maps ownership on bind mounts itself, so the uid doesn't need to
  match a macOS uid such as 501, and file modes such as `0600` on the token
  files might read differently inside the container. Untested on a real
  macOS or Windows host.
- **Image user name**: `scripts/build-image.sh` names the container user
  after `id -un`, and the server runs containers as `USER`, `LOGNAME`, or
  `USERNAME`, falling back to `user` for a name with whitespace. The two
  must match. A Windows user name with uppercase letters or spaces isn't a
  valid Linux user name, so the build fails or the names differ; building
  and running on Windows needs one sanitized name on both sides.

### Container boundaries

- **Published ports.** The engine port and each project TCP map listen on
  the host's loopback address, `127.0.0.1`. A TCP map whose `allInterfaces`
  field is `true` listens on every host interface instead, and anything on
  the host's network can reach it. The Boxes app doesn't show that field yet,
  so you set it through the API, and saving TCP maps from the app clears it.
  A container created before loopback became the default shows its TCP maps
  as stale until it restarts.
- **Secrets.** Secret values aren't in the container's configuration or
  environment, so `docker inspect` shows only their names. Any process in
  the container can still ask the broker socket for any secret the project
  lists, without a prompt, and every request is logged with names only.
  The socket's directory is mounted read-only, and the container user can't
  become root, so a process in the container can't remove or replace the
  socket or the `aio-secret` command. See [Secrets](secrets.md).
- **Vendor sign-ins.** Every container mounts your `~/.claude`,
  `~/.claude.json`, `~/.codex`, and `~/.copilot`, so any process in any
  project container can read and change the Claude, Codex, and Copilot
  sign-ins stored there.
- **Root in the container.** Docker runs without a user namespace, so
  container root is host root on every bind mount: the project root,
  `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.copilot`, and every project
  and global mount. Container root could leave a setuid-root file there, or a
  root-owned one you can't change. Docker has no `nosuid` option for bind
  mounts, and a capability drop doesn't help, because root owns the files it
  creates and needs no capability to set the setuid bit on them. For that
  reason, the container user has no passwordless `sudo`, and an agent can't
  become root:
  - Without a sudo password reference in the settings, `sudo` is off: the
    container has no `sudo` rule for the user, and the user's password is
    locked.
  - With a reference, `sudo` asks for the password on every use, with no
    cached credentials. You type it from 1Password. The container gets only
    a SHA-512 crypt hash of it, in `/etc/shadow`, which only root can read or
    write. See [The sudo password](secrets.md#the-sudo-password).

  The server drops the `MKNOD` and `SETFCAP` capabilities, which `sudo`
  doesn't need, so even root that you start with `sudo` can't leave a device
  node or a binary with file capabilities on a mount. A container that a
  server older than this change created still has passwordless `sudo`; it
  shows as stale with `sudo passwordless -> off` until it restarts. Rootless
  Docker or `userns-remap` closes the setuid risk for root you start too, but
  both change which host user owns the files a box writes, so check
  ownership on the mounts before you switch. Don't run host binaries from a
  mounted directory that a box can write.

## Repository layout

The repository is a pnpm workspace:

| Path | Contents |
|---|---|
| `packages/contracts` | Zod schemas and types shared by every package |
| `packages/server` | `aio-server` |
| `packages/engine` | `aio-engine` |
| `packages/cli` | `aio` |
| `packages/ui` | Shared React components, theme, and API client |
| `apps/boxes`, `apps/review` | The two Electron apps |
| `image/` | The Dockerfile, the version pins, and the keeper scripts |
| `packaging/` | The `.deb` layout, the systemd unit, desktop entries, and icons |
| `scripts/` | Build, version, and release scripts |
| `tools/` | Mock CLIs and a sample repository for tests |
| `docs/` | This documentation |
