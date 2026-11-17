# Contribute to AI Orchestrator

AI Orchestrator is a Node.js 22 and TypeScript pnpm workspace. Use the pnpm
version pinned in `package.json` through Corepack.

## Find the code

- `packages/contracts`: shared Zod schemas, API routes, and types.
- `packages/server`: host API, accounts, boxes, containers, and persistence.
- `packages/engine`: review pipeline and vendor execution inside containers.
- `packages/cli`: the `aio` command and its injectable client and executor.
- `packages/ui`: shared React components and API client.
- `apps/boxes` and `apps/review`: Electron apps.
- `image`, `packaging`, and `scripts`: container and release tooling.

For account or session changes, read [Accounts](docs/accounts.md). For service
boundaries, authentication, and container mounts, read
[Architecture](docs/architecture.md). For persisted review state changes, read
[Run state compatibility](docs/run-state-compatibility.md).

## Build and check

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm format:check
python3 -m unittest discover -s packaging/test
```

Run focused package tests while developing, for example
`corepack pnpm --filter @aio/server test`. Before handing off a change, run the
checks affected by it and report any failures or skipped checks.

## Work at public boundaries

Keep API schemas in `packages/contracts` and update their consumers together.
Test behavior through the server core harness, API routes, or injectable CLI
executor. Use temporary homes and environment objects supplied by the test
harness; keep ambient `HOME` and other process environment variables unchanged.
Unset `TMUX` in a child process environment when a test launches tmux.

Account folders own vendor settings and instructions. Treat host vendor folders
as explicit seed or migration inputs, rather than runtime configuration. Keep
server tokens out of vendor subprocess environments and logs.

Use synthetic paths, account names, and credentials in tests and documentation.
Keep personal setup notes in the ignored `INFRA.md`; `CLAUDE.md` remains ignored
for contributors who keep a personal file.
