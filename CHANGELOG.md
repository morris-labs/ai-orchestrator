# Changelog

This file lists the notable changes in each AI Orchestrator release. The release
workflow copies a version's section into its GitHub release, so each
section's heading must have the form `## [X.Y.Z]`.

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
