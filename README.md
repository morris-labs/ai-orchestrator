# AI Orchestrator

AI Orchestrator runs coding agents (Claude Code, Codex, and GitHub Copilot) in
sandboxed Docker containers, one container per project, and reviews their
work with a multi-vendor code review pipeline before you push.

You create a box for a piece of work, and AI Orchestrator gives it its own git
worktree and branch, starts its agent in a tmux session in the project's
container, and opens a terminal on it. When the work is ready, you start a
review: Codex and Copilot review the branch, another vendor disproves what
it can, Claude fixes what's left, and the run repeats until the branch is
clean. You decide when to push and when to merge.

## Features

- **Boxes**: one conversation per box, in its own worktree, with the same
  transcript across restarts. Create, adopt an existing conversation, fork,
  restart, move, and purge from the **AI Orchestrator** app or the `aio` CLI.
- **Terminals**: xterm.js tabs attached to each box's tmux session, with
  scrollback and selection, plus an external terminal on request.
- **Dev servers without port juggling**: the engine finds listening ports in
  the container and the server proxies them at
  `http://PORT.BOX.localhost:21401/`.
- **Review pipeline**: profiles that decide how much Claude reviews, a
  coverage ledger per diff hunk, cross-vendor verification, a test and lint
  gate, oscillation detection, and a post-push loop on the pull request.
- **Usage ceilings**: one scheduler for every container keeps each vendor
  under its ceiling and moves work between vendors.
- **Dashboard**: **AI Orchestrator Review** shows the fleet, the data flow between
  stages, every agent call, usage against ceilings, and run health, live.
- **Secrets from 1Password**: `op://` references checked at launch and
  served on request through a per-container socket and the `aio-secret`
  command, never through the container's environment. Values never reach a
  log or the apps.
- **Desktop integration**: tray icons and notifications for decisions,
  finished runs, and boxes that end unexpectedly.

## Requirements

- Ubuntu 24.04 or later on x86-64, with systemd.
- Node.js 22 and Docker Engine.
- Claude Code signed in on the host. Codex, Copilot, and the 1Password CLI
  are optional.

macOS and Windows packages are deferred.

## Install

Download the `.deb` from the
[releases page](https://github.com/morris-labs/ai-orchestrator/releases), install
it, and start the server as your user:

```sh
sudo apt install ./ai-orchestrator_VERSION_amd64.deb
systemctl --user enable --now aio-server
```

Replace `VERSION` with the release you downloaded. Then open **AI Orchestrator**
from your applications menu; the setup wizard builds the container image.
For the details, see [Install AI Orchestrator](docs/install.md).

## Documentation

- [Install AI Orchestrator](docs/install.md)
- [Daily flow](docs/daily-flow.md)
- [Review pipeline](docs/review-pipeline.md)
- [Policy file](docs/policy.md)
- [Secrets](docs/secrets.md)
- [Accounts](docs/accounts.md)
- [Multi-host](docs/multi-host.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Migrate from Claude Box 3.x](docs/migration-3x.md)
- [Architecture](docs/architecture.md)
- [Host paths in containers](docs/host-paths.md)
- [Changelog](CHANGELOG.md)

## Migrating from 3.x

AI Orchestrator 1.0.0 replaces the Qt app, Claude Box 3.x. Your boxes, their
transcripts, and their worktrees carry over:

1. Stop every box in the 3.x app and close it.
1. Back up `~/.claude-box`.
1. Install AI Orchestrator and start the server.
1. Run the one-time import from the setup wizard, or with `aio migrate`.

The import reads `~/.claude-box`, renames boxes to the `aio-agent-` prefix,
and stores AI Orchestrator's data in `~/.ai-orchestrator`. Classic boxes, which had their own containers, move into
their project's shared container the first time you start them. The port
pool and `agent.env` files are gone: dev servers are proxied, and secrets
come from 1Password. For the full list of what changes, see
[Migrate from Claude Box 3.x](docs/migration-3x.md).

The Qt app and the bash launcher scripts stay available at the tag
`v3.3.5`.

## Development

The repository is a pnpm workspace on Node.js 22 and TypeScript:

```sh
corepack enable
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

The `pnpm-workspace.yaml` file pins the pnpm store to `.pnpm-store` at the
workspace root, so pnpm on the host and pnpm in a box that mounts the
checkout use one store. Without the setting, pnpm picks a store on the
checkout's file system, and the host and a box can disagree about where that
is. A checkout installed with another store needs a one-time reinstall:
`pnpm install` stops with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` when
it runs without a terminal. To reinstall, delete `node_modules` and run
`pnpm install` again, or run `pnpm install --config.confirmModulesPurge=false`.
That reinstall can leave Electron without its binary; run
`scripts/ensure-electron.sh` to check for that and download it.
Each git worktree gets its own store, at its own root.

To build the image from a checkout, run `scripts/build-image.sh`. To build
the `.deb`, run `scripts/build-deb.sh`. For the layout of the repository,
see [Architecture](docs/architecture.md#repository-layout).
