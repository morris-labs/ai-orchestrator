# Accounts are self-contained

Status: accepted

AI Orchestrator used to share the host user's own Claude Code setup with
every box. Claude accounts linked `CLAUDE.md`, `settings.json`, `skills`, and
`plugins` to `~/.claude`, and the default `host` mode mounted the whole
`~/.claude`, `~/.claude.json`, `~/.codex`, and `~/.copilot` into each
container. Now each account folder, `~/.ai-orchestrator/accounts/VENDOR/NAME`,
holds everything its CLI uses, and AI Orchestrator never reads, links, or
mounts the host user's own vendor folders. The one exception is a one-time
copy that the owner asks for when seeding an account.

Instructions come in two layers: the global instructions in
`~/.ai-orchestrator/accounts/AGENTS.md`, and each account's own `AGENTS.md`.
A file includes another with an `@path` line. Claude Code follows these
lines itself; for Codex and Copilot, AI Orchestrator builds their
instructions file at each start, with the includes expanded. The wiring uses
no links.

## Considered options

- **Keep `~/.claude` as the hub:** one edit reaches every account and the
  host. Rejected: boxes mount single files by inode, so a save that renames
  over a file leaves running boxes on the old copy; a save through an
  account's link replaces the link and forks the account silently; and new
  shared entries need a relink and a container rebuild before boxes see
  them. It also ties the product to one vendor's folder layout.
- **Sync the account folders with `~/.claude`:** rejected as a second copy
  with conflict rules, for no gain over using the account folder directly.
- **Links between account files for shared instructions:** rejected for the
  same rename problem. `@path` include lines replace them.
- **A third instructions layer, such as one file per side (`personal`,
  `work`) shared by every vendor:** deferred. Include lines cover it.

## Consequences

- `host` mode goes away. An install still set to `host` doesn't start boxes
  until accounts are set up. Converting an install is a manual step,
  `aio accounts relink`, because no other installs exist.
- `aio claude`, `aio codex`, and `aio copilot` run a CLI on the host with an
  account's folder, so the host and the boxes use the same setup.
- Codex and Copilot see instruction edits at their next start, not during a
  running session.
- A setting changed in one account doesn't reach another account. Shared
  instructions go through include lines; other shared settings are copied
  by hand.
