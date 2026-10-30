# Agent Box contracts

The `@agentbox/contracts` package holds the zod schemas and TypeScript types
that every Agent Box 4.0.0 package shares: the server, the engine, the CLI,
the UI library, and both apps. Each module exports a `...Schema` constant for
runtime validation and a type of the same name inferred from it.

Records and responses follow two rules:

- A read schema (`BoxSchema`, `ProjectSchema`, `FindingSchema`,
  `GlobalSettingsSchema`) has no defaults, so a stored or returned document
  carries every field. Its input schema (`BoxInputSchema`,
  `ProjectInputSchema`, `FindingInputSchema`, `GlobalSettingsInputSchema`)
  fills the defaults and outputs the read type. Use input schemas for the
  import, for creation, and for files that people edit.
- Stored records leave a missing optional field absent. API responses and
  event payloads use `null` instead.

| Module | Contents |
|---|---|
| `records.ts` | `Project`, `ProjectSettings`, `Box`, `SshRemote`, `SshForward`, `GlobalSettings`, and the settings patch, with the mapping from the 3.3.5 record keys and the import rules |
| `common.ts` | Ports, ISO times, ULID run ids, commit SHAs, vendors, and the `ApiErrorCode` list |
| `prompts.ts` | The four default prompt templates, `expandTemplate()`, and the secrets hint (`SECRETS_PROMPT_HINT`, `withSecretsHint()`) |
| `findings.ts` | `Finding`, the vendor JSON form, and its converter |
| `runs.ts` | `RunRequest`, `RunState`, `FileGroup`, `RoundSummary`, and decisions |
| `lease.ts` | Lease requests, responses, their stream frames, and settlements, with the lease protocol |
| `events.ts` | The event union, the sequence-number rules, and the stream frames for both event sockets |
| `policy.ts` | `PolicyFile` and its default |
| `config.ts` | `ServerConfig`, `parseConfig()`, home-directory paths, and the engine environment |
| `api.ts` | The route catalog for the server API and the engine API, the authentication rules, and `RouteOf` |

## Use the package

Import from the package root:

```ts
import { BoxSchema, routes, type RouteOf } from "@agentbox/contracts";

const box = BoxSchema.parse(json);
type CreateBox = RouteOf<"boxes.create">;
```

The package exports compiled JavaScript from the `dist` directory. Build it
before another package's tests import it. The root `pnpm test` and
`pnpm typecheck` scripts build every package first.

To register handlers or build a client, iterate the `serverRoutes` or
`engineRoutes` table. Each entry gives the method, the path, and the schemas
for the query, the body, and the response, or for a WebSocket route, the
client and server messages. Fill path parameters with `buildPath()`.

## Change a contract

Contracts freeze at integration checkpoint C1. After that, any change to a
schema, a default, a route, or an event is a plan change: it goes through an
integration checkpoint, as `plan-agentbox-v4.md` describes, and every
consuming workstream must pull it and pass its own contract tests before the
change counts as done. Don't change a contract from inside another
workstream's branch.

The prompt template defaults must stay byte for byte equal to
`docs/v4/inventory-gui.md` section 4.7. The `test/prompts.test.ts` file holds
the expected text and fails on any difference. The secrets hint isn't a
template: the server adds it after the opening prompt, so the templates
stay unchanged.

## Develop

From the repository root, run the package's checks:

```sh
corepack pnpm --filter @agentbox/contracts build
corepack pnpm --filter @agentbox/contracts test
corepack pnpm --filter @agentbox/contracts typecheck
```

## Changelog

### C2

Consumers must update for the changes marked **breaking**.

- **Breaking:** `UsageSample.source` is `sampleSource`. The `usage.sample`
  event spreads the sample's fields, so the old name replaced the event's
  stream `source`. `TimedUsageSample` follows.
- **Breaking:** `sshRemotes.test` is `POST /api/v1/ssh-remotes/test` and takes
  a required `SshRemoteInput` body for an unsaved remote. The by-name route,
  `POST /api/v1/ssh-remotes/:name/test`, is `sshRemotes.testSaved`.
- **Breaking:** `EngineHealth.versionMatches` and `BoxView.targetDirExists`
  are required booleans, `PurgeResult` has a required `dryRun`, and
  `GlobalSettings` has a required `vendorDefaults` and
  `notifications.readyToPush`. `GlobalSettingsInputSchema` fills both, so a
  stored settings document or a `config.json` without them still parses
  through it.
- `PolicyFile.commentAuthors` (optional list of GitHub logins) names extra
  authors whose pull request comments the post-push loop imports.
- `ApiErrorCode` adds `unauthorized` (401) and `internal` (500).
- `ENGINE_ENV.stateDir` (`AGENTBOX_STATE_DIR`, default `/run/claude-box`). On
  a version mismatch the engine starts, logs a warning, and reports
  `versionMatches: false`.
- Server routes: `import.run` (`POST /api/v1/import`, `ImportReport`),
  `projects.repos.list` and `projects.repos.refs` (the engine's schemas),
  `boxes.convertToWorktree.plan`, and `fs.dirs`.
- `boxes.start` takes `{ force }` to start despite stale mounts, and
  `boxes.purge` takes `{ dryRun }`. Both bodies are optional.
- `GlobalSettings.vendorDefaults` (Copilot's model defaults to `auto`) and its
  patch, in which `null` clears a Claude or Codex model or effort.
- `Finding.symbol` and `VendorFinding.symbol`, optional; `fromVendorFinding()`
  copies it.
- `aiCredits`, optional, on `agent.finished` and `VendorRoundStats`.
- The `GlobalSettingsSchema` comment says where settings live: in the
  database, seeded once from `~/.claude-box/config.json`.
