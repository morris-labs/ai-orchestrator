# Changelog

This file lists the notable changes in each AI Orchestrator release. The release
workflow copies a version's section into its GitHub release, so each
section's heading must have the form `## [X.Y.Z]`.

## [Unreleased]

### Added

- Multi-host support. A machine runs as a `hub`, a `node`, or `both`, set
  with the `role` setting, `aio-server --role`, or `AIO_ROLE`. A hub has its
  own certificate authority, issues one-time enrollment codes, and links to
  each node over mutual TLS. The hub keeps a machine registry, relays
  1Password reads to its nodes, and syncs agent sign-ins between machines,
  limited to what the `nodeGrants` setting gives each machine.
  Use `aio machines` on a hub and `aio node` on a node. See
  `docs/multi-host.md`.
- Machine routing: every server route also answers under
  `/api/v1/machines/MACHINE_ID/proxy/`, for HTTP and WebSocket calls, with
  the `machine_offline`, `machine_timeout`, and `hub_unreachable` error
  codes. `MACHINE_ID` is an enrolled machine's ID, `local` for the server
  that gets the call, or `hub` for a node's hub.
- Terminal attach to a box on another machine, through the hub: in a
  machine tab of the Boxes app, and with `aio box attach MACHINE/BOX` and
  `aio box shell MACHINE/BOX` in the CLI, where **Ctrl+]** twice detaches.
  A terminal that reads slowly holds the box's output back over the link
  instead of being closed.
- Machine tabs and a **Machines** page in the Boxes app. On another
  machine, **Browse** lists that machine's directories.
- Machine health on the **Machines** page: each machine's engine version,
  image state, and free disk space, from `GET /api/v1/node/health` and the
  `health.v1` link capability.
- The CLI's `--machine` option and `MACHINE/BOX` box arguments send a
  command, including every `aio review` command, to another machine.
  `aio box list --all-machines`, `aio events --all-machines`, and
  `aio review status --all-machines` show every machine's boxes, events,
  and runs.
- Review runs across machines. The Review app has a **Machine** list that
  shows another machine's runs, findings, launcher, and policy, and the
  dashboard lists every online machine's runs with the machine named. An
  offline machine shows as offline with no runs, unless you select **Show
  offline machines' last runs**. The Review app's tray count and desktop
  notifications cover every online machine, and each notification names
  its machine. **Start Review** on another machine's tab in the
  Boxes app opens the Review app on that machine.
- A machine role step in the setup wizard: keep a single machine, make the
  machine a hub only, or join a hub as a node with its URL and a one-time
  enrollment code. The `.deb`
  package's install message names the hub's link port, TCP `21402`.
- A `ufw` application profile, `aio-hub`, for the hub's link port in the
  `.deb` package. The package doesn't enable it; run
  `sudo ufw allow from LAN_CIDR to any app aio-hub`.
- A **Paste** button beside each **Browse** button for paths in the Boxes
  app.
- Windows host paths: the server maps a path such as
  `C:\Users\user\project` to `/mnt/host/c/Users/user/project` in the
  container. See `docs/host-paths.md`.
- A TCP transport for the secrets broker, for Docker Desktop, which can't
  share a Unix socket with its virtual machine. The `brokerTransport`
  setting chooses `auto`, `unix`, or `tcp`.
- macOS and Windows support: a launchd agent or a Task Scheduler logon task
  for the server, a bundled Node.js runtime, and macOS and Windows builds
  of the apps. See `docs/platforms.md`.

### Changed

- The database schema is at version 7. Migration 6 adds the broker port to
  `engine_endpoints`, and migration 7 adds the `machines` and
  `enrollment_codes` tables. The server applies both at its next start, after
  migration 5, the usage index, on a database that doesn't have it.

## [1.0.0] - Unreleased

AI Orchestrator 1.0.0 replaces Claude Box 3.x, the Qt app, with a TypeScript host
server, an engine in the container image, two Electron apps, and a CLI. For
the upgrade steps, see `docs/migration-3x.md`.

### Added

- Model tiers for review runs: code in the engine picks a small, medium, or
  large model for each group and role, with **Auto** or a fixed tier on the
  launcher and `aio review start --tier`, and `tierModels` and `tierPaths` in
  the policy file.
- A list of models that review runs refuse: Claude models with `fable` in the
  name and Codex models with `astra` in the name.
  The list doesn't cover GitHub Copilot, which keeps automatic model selection.
- `aio-server`, a systemd user service that owns Docker, boxes,
  projects, worktrees, secrets, usage, and terminals, with a REST and
  WebSocket API on `127.0.0.1:21400`.
- The AI Orchestrator engine, baked into the image, which runs the review pipeline
  inside each project container.
- A multi-vendor review pipeline with the `offload`, `balanced`, and `fast`
  profiles, cross-vendor verification, a test and lint gate, stop
  conditions, human decisions, and a post-push loop on the pull request.
- Usage ceilings per vendor account, with leases that move work between
  vendors or pause a run until a window resets.
- **AI Orchestrator Review**, an app with a run launcher, a findings browser, a
  policy editor, and a live infrastructure dashboard.
- The `aio` CLI with `box` and `review` commands, plus `migrate`,
  `setup`, and `doctor`.
- Dev servers proxied at `http://PORT.BOX.localhost:21400/`, found
  automatically, with optional explicit TCP maps per project.
- Secrets from 1Password references, served on request by a per-container
  broker socket and the `aio-secret` command in the image, never put
  in a container's environment. When a project has secret references, the
  opening prompt tells the agent how to use `aio-secret`.
- Starting roles for a review run: the run launcher's **Profile and roles**
  section and `aio review start --role ROLE=VENDOR[,VENDOR]` give roles to
  vendors from round 1 over the profile's defaults, through the run
  request's optional `roles` field.
- A repository policy file, `.aio/policy.yaml`.
- Tray icons and desktop notifications.
- A one-time import of 3.x records and settings into SQLite.
- A `.deb` package with the server, the CLI, both apps, desktop entries, the
  systemd user unit, and the image build context.
- An image with a digest-pinned base, pinned CLI versions in
  `image/versions.env`, and a health check on the engine.
- Continuous integration on every push and pull request.

### Changed

- The **Model usage** panel in the Boxes app shows each usage window
  that a vendor's CLI reports on its own line, with its own percentage, reset
  time, and sample age. A window whose reset time has passed shows **No recent
  data** instead of a percentage, and the panel refreshes every minute.
- The product name is AI Orchestrator, and the command is `aio`. Container
  names use the `aio-agent-` prefix, the image is `aio-agent`, data lives in
  `~/.ai-orchestrator`, and per-project notes live in `.aio/`. The import
  from Claude Box 3.x reads `~/.claude-box` and renames the boxes.
- Every box runs in its project's shared container. Classic boxes move into
  it on their first start.
- Terminals use xterm.js, with scrollback and selection.
- The box filter also matches container names.
- An empty Starter prompt template turns the starter prompt off.
- Project TCP maps listen on `127.0.0.1` unless a map sets
  `allInterfaces`.
- Project containers drop the `MKNOD` and `SETFCAP` capabilities.
- The container user has no passwordless `sudo`. `sudo` is off unless the
  settings name a 1Password reference for a sudo password, which a container
  gets only as a SHA-512 crypt hash and which `sudo` asks for on every use.
  The server runs its root steps with `docker exec --user root`.

### Removed

- Classic one-container-per-box mode.
- The port pool and the port hint prompt.
- `agent.env` files as a source of secrets.
- The Qt app under `gui/` and the bash launcher scripts. The tag `v3.3.5`
  keeps them.

### Deferred

- macOS and Windows packages.
