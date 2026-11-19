# Changelog

This file lists the notable changes in each AI Orchestrator release. The release
workflow copies a version's section into its GitHub release, so each
section's heading must have the form `## [X.Y.Z]`.

## [Unreleased]

### Breaking changes

- Boxes no longer use host vendor folders. An installation still configured
  with `accountsMode: host` refuses box creation and starts. Set up vendor
  accounts, run `aio accounts relink` to copy old linked host configuration
  into the accounts, select `aio accounts mode accounts`, and restart project
  containers. Relink leaves host files unchanged. See [Accounts](docs/accounts.md).
- Multi-host sign-in grants use account keys only. Replace legacy `host/…`
  grants with `account/claude/NAME/.credentials.json` or
  `account/codex/NAME/auth.json`.

### Added

- The Review app launcher has a **Group confirmed findings by root cause**
  option. The Findings screen shows a run's root causes in fix order, with
  links to their findings, and the JSON, Markdown, and HTML exports include
  them.
- Global and account instruction layers with include lines. Claude follows
  imports directly; Codex and Copilot receive generated instructions at each
  start from editable `instructions.md` files. Missing imports are reported,
  and expansion stops at depth 3.
- `aio claude`, `aio codex`, and `aio copilot` run host CLIs with the selected
  account folder and pass vendor arguments after `--` unchanged.
- `aio accounts seed --copy-host-setup` optionally copies Claude instructions,
  settings, skills, and plugins once. The option is off by default.
- Shared contributor guidance in `AGENTS.md`; personal `CLAUDE.md` files remain
  ignored.

### Fixed

- `aio accounts relink` lists the entries it copied from the host and any it
  couldn't copy, instead of reporting host links and listing every file in the
  account as a local override.

## [2.0.0] - Unreleased

### Added

- One-step upgrade: installing the `.deb` package performs the whole
  upgrade. For each user with `aio-server` enabled, the install records the
  open boxes and review runs, restarts the server, builds the image with the
  latest agent CLIs, recreates every project container, and reopens the boxes
  and runs. It prints progress and a summary, and waits about 5 minutes at
  most. If the image can't be built, the configure step fails; run
  `sudo dpkg --configure -a` to retry. See `docs/install.md`.
- When the latest agent CLIs fail to build, the image build falls back to the
  pins in `image/versions.env` and reports it. The upgrade keeps one previous
  image for rollback.
- `scripts/upgrade.sh` builds a checkout, builds the `.deb` package, and
  installs it. It doesn't run `git pull`.
- A startup check for servers started without the package install, such as
  on macOS and Windows: on an engine mismatch the server rebuilds the image,
  the apps show an **Upgrading** bar, and box starts wait for the build.
- A **CLI update** button that rebuilds the image with the latest agent CLIs
  after a dialog that lists the boxes and runs it stops, then brings them back.
- The Boxes and Review apps reload update, image, and machine status when they
  reconnect to the server, and show a relaunch bar when the installed app is
  newer than the running one.
- Saved review runs carry a state version. A run saved by an older version
  resumes through State adaptations; a run saved by a newer version stays
  paused with a notice. See `docs/run-state-compatibility.md`.
- GUI enrollment: the Boxes and Review apps on another PC can control a hub and
  its nodes. `aio gui code` or **Add GUI App** on the hub issues a one-time code,
  the app generates its own key and gets a client certificate, and a new listener
  on TCP port `21403` accepts only that certificate. Use `aio gui list` and
  `aio gui revoke` on the hub. See `docs/multi-host.md`.
- Multi-host support. A machine runs as a `hub`, a `node`, or `both`, set
  with the `role` setting, `aio-server --role`, or `AIO_ROLE`. A hub has its
  own certificate authority, issues one-time enrollment codes, and links to
  each node over mutual TLS. The hub keeps a machine registry, relays
  1Password reads to its nodes, and copies agent sign-ins from the hub to the nodes you grant,
  limited to what the `nodeGrants` setting gives each machine. A node
  controls only its own boxes and can only read other machines' boxes, projects, and runs.
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

- The server runs only from the installed package, at `/usr/bin/aio-server`.
  The package install and `scripts/install-server-unit.sh` replace a checkout
  service with the packaged command and keep custom arguments such as
  `--data-dir`, `--role`, and `--log-file`.
- Agent sign-ins flow only from the hub to the nodes that a grant's `signInCopies`
  lists. The `signInUpdates` grant is gone; stored settings that hold it still
  load. A copy doesn't replace a file that the node signed in or refreshed itself.
- The database schema is at version 7. Migration 6 adds the broker port to
  `engine_endpoints`, and migration 7 adds the `machines` and
  `enrollment_codes` tables. The server applies both at its next start, after
  migration 5, the usage index, on a database that doesn't have it.

## [1.0.0] - Unreleased

AI Orchestrator 1.0.0 replaces Claude Box 3.x, the Qt app, with a TypeScript host
server, an engine in the container image, two Electron apps, and a CLI. For
the upgrade steps, see `docs/migration-3x.md`.

### Added

- A whole-project review scope, as **Whole project** in the launcher and
  `--whole-project` on `aio review start`. The run reviews the tip from Git's empty
  tree, counts every finding as introduced, and adds no branch, tag, or other ref.
- `excludePaths` globs in the policy file, and per-run exclusions in the launcher and
  as `--exclude`. A whole-project run also leaves out lockfiles and minified,
  vendored, and generated files. The preview counts and lists excluded files.
- A faster group preview on large diffs: grouping reads files in parallel and no
  longer compares every file with every other file.
- A `depth` setting for review runs, on the launcher and as `--depth`. The default
  `standard` asks for P1 and P2 findings, with coarser groups, one reviewer pass per
  group, batched verification, and at most 2 rounds, with round 2 on the fixer's diff.
  `thorough` keeps the full pipeline, and stored runs with no depth stay `thorough`.
- At `standard`: higher reasoning effort for batched disprover calls, compact
  findings between agents, and one triage call that can send below-floor P3 findings
  to the fixer.
- A separate cap of 25 rounds for a pre-push run that continues after a push.
- A rough token estimate in the launcher's group preview, computed with no model
  call.
- The Codex medium tier maps to `gpt-6.1-terra`.
- Retry for a failed review run, with **Retry** in the run view and
  `aio review retry RUN_ID`. It resumes at the failed stage from saved state,
  reuses saved calls, and can change roles and the verification floor.
- A verification floor for review runs, on the launcher and as `--verify-floor`.
  Findings below it stay labeled and away from the fixer and the sweep, even when
  already confirmed; unchecked ones stay pending. A run with
  such findings stops with `clean_above_floor` instead of `clean`.
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

- A vendor's limit no longer fails a review run. The engine stops calling that
  vendor, tells the server not to redirect calls to it, moves the role, and pauses
  or asks for a decision when no vendor can take it.
- A role assignment and a profile switch work on a failed run, ahead of a retry.
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
