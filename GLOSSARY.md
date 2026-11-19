# AI Orchestrator

AI Orchestrator (aio, also written ai-o) runs coding agents in Docker containers and manages them from
a host server, desktop apps, and a CLI.

## Install and update

**Upgrade**:
Moving the host to a different AI Orchestrator version: the server, the apps,
the image with the latest agent CLIs, and every project container, all at
once. Open sessions and runs stop, as with any package upgrade, and come
back afterward.
_Avoid_: Update, deploy, rebuild

**CLI update**:
Rebuilding the image with the latest agent CLIs (Claude Code, Codex,
Copilot) without changing the AI Orchestrator version.
_Avoid_: Image rebuild, Claude Code update

**State adaptation**:
One step that moves a saved review run from one state version to the next,
so a run saved by an older version can resume.
_Avoid_: Migration (reserved for the server database), upgrade step

**Project container**:
The one container that holds every box and review run of a project.
_Avoid_: Box container, agent container

## Accounts

**Account**:
One sign-in to one agent vendor, with its own folder under
`~/.ai-orchestrator/accounts/VENDOR/NAME` that holds everything that vendor's
CLI uses: sign-in, settings, skills, plugins, and instructions. Boxes and
`aio` commands use the account folder and never the host user's own vendor
folders.
_Avoid_: Profile, config dir, home

**Global instructions**:
The owner's working rules that apply to every account, kept in one
`AGENTS.md` at the top of the accounts folder.
_Avoid_: Global CLAUDE.md, user memory

**Account instructions**:
The rules for one account only, kept in that account's own `AGENTS.md`.
They add to the global instructions and can be stricter, such as a work
account that never touches GitHub.
_Avoid_: Profile rules

**Include line**:
A line `@path` in an instructions file that pulls in another file, such as
another account's instructions. Claude Code follows it itself; AI
Orchestrator expands it for Codex and Copilot.
_Avoid_: Link, symlink, import (for the file-level mechanism)

## Review runs

**Named base**:
The commit the owner asks a review run to compare against, such as the tip
of `main` when the run starts.
_Avoid_: Base (on its own)

**Change base**:
The commit a round's diff starts from: where the branch left the named
base in round 1, or the tip before the last fix in a round that reviews
only the fix.
_Avoid_: Base (on its own), diff base

**Branch point**:
The commit a change grew from: where the branch left the named base, or
the named base itself when the owner asks for an exact base. A finding
counts as introduced when its flaw is absent at the branch point.
_Avoid_: Base (on its own), merge base (for the concept)

**Review range**:
What one round of a review run looks at: its change base, its tip, and the
files that changed between them.
_Avoid_: Range (on its own), diff
