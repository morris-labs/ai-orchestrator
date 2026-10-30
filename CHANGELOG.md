# Changelog

This file lists the notable changes in each Agent Box release. The release
workflow copies a version's section into its GitHub release, so each
section's heading must have the form `## [X.Y.Z]`.

## [4.0.0] - Unreleased

Agent Box 4.0.0 replaces the Qt app, Claude Box 3.x, with a TypeScript host
server, an engine in the container image, two Electron apps, and a CLI. For
the upgrade steps, see `docs/migration-3x.md`.

### Added

- `agentbox-server`, a systemd user service that owns Docker, boxes,
  projects, worktrees, secrets, usage, and terminals, with a REST and
  WebSocket API on `127.0.0.1:21400`.
- The Agent Box engine, baked into the image, which runs the review pipeline
  inside each project container.
- A multi-vendor review pipeline with the `offload`, `balanced`, and `fast`
  profiles, cross-vendor verification, a test and lint gate, stop
  conditions, human decisions, and a post-push loop on the pull request.
- Usage ceilings per vendor account, with leases that move work between
  vendors or pause a run until a window resets.
- **Agent Box Review**, an app with a run launcher, a findings browser, a
  policy editor, and a live infrastructure dashboard.
- The `agentbox` CLI with `box` and `review` commands, plus `migrate`,
  `setup`, and `doctor`.
- Dev servers proxied at `http://PORT.BOX.localhost:21400/`, found
  automatically, with optional explicit TCP maps per project.
- Secrets from 1Password references, served on request by a per-container
  broker socket and the `agentbox-secret` command in the image, never put
  in a container's environment.
- A repository policy file, `.claude-box/policy.yaml`.
- Tray icons and desktop notifications.
- A one-time import of 3.x records and settings into SQLite.
- A `.deb` package with the server, the CLI, both apps, desktop entries, the
  systemd user unit, and the image build context.
- An image with a digest-pinned base, pinned CLI versions in
  `image/versions.env`, and a health check on the engine.
- Continuous integration on every push and pull request.

### Changed

- The product name is Agent Box, and the command is `agentbox`. Container
  names keep the `claude-agent-` prefix, and data stays in `~/.claude-box`.
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
