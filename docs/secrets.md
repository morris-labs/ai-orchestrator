# Secrets

AI Orchestrator gives containers secrets from 1Password and from nowhere else. You
store 1Password references in the global settings and in project settings.
The server keeps the values out of every container's configuration and
environment: a process in a project container asks the server's secrets
broker for a value when it needs one, through a socket mounted into the
container, or under Docker Desktop, through a loopback port with a token. One reference is different: the container user's `sudo`
password, which reaches a container only as a hash. See
[The sudo password](#the-sudo-password).

## How secrets work

A secret reference has two parts:

- `name`: the name a process asks for, and the environment variable that
  `aio-secret run` sets, for example `DATABASE_URL`.
- `ref`: a 1Password secret reference in the form
  `op://VAULT/ITEM/FIELD`.

Replace the following:

- `VAULT`: the 1Password vault that holds the item
- `ITEM`: the item's name or ID
- `FIELD`: the field's name, optionally with a section, as in
  `SECTION/FIELD`

Global references apply to every project container. A project reference
with the same `name` as a global one wins for that project.

Global references have their own API route, not `PATCH /api/v1/settings`,
which rejects a `secretRefs` field. To replace the global list through the
API, send `PUT /api/v1/secrets` with the whole list, for example
`{"refs": [{"name": "GH_TOKEN", "ref": "op://VAULT/ITEM/FIELD"}]}`. A
project's references go in `PATCH /api/v1/projects/PROJECT_ID` as
`secretRefs`, where `PROJECT_ID` is the project's ID.

The following example sets two references on a project:

| Name | Reference |
|---|---|
| `DATABASE_URL` | `op://Development/orders-db/connection-string` |
| `STRIPE_API_KEY` | `op://Development/stripe-test/credential` |

### Pick secrets from 1Password

You can pick the references from a list instead of typing them. The list
comes from your 1Password vaults, and it never holds a value.

To pick secrets in the Boxes app, follow these steps:

1. Open the New Box, Edit Box, or Fork Conversation dialog, and expand
   **Secrets (project)**.
1. Filter the list, and tick the fields the project needs. The list groups
   fields by 1Password item. Each ticked field gets an environment variable
   name, which you can edit. The app proposes an upper snake case name from
   the item and the field, for example `TOKEN_GITHUB_CREDENTIAL`.
1. Click **Create**, **Save**, or **Fork**. The app saves the ticked list as
   the project's references.

The ticks edit the project's references, not the box's. A project's boxes
share one container and one secrets broker, so the server can't limit a
secret to one box. The section says that it applies to every box in the
project. A box with its own classic container has a project too, and the
section edits that project's list. Global references show as ticked and
locked, because you edit them in the global settings. A reference that
1Password no longer lists stays in the project, marked missing, until you
untick it. A change takes effect at once, without a container restart.

The server builds the list with the `op` CLI, using
`op item list --vault VAULT` and `op item get ITEM`. It keeps only each
field's label, section, and type, and the `op://VAULT/ITEM/FIELD`
reference. It drops every value before the data leaves the `op` wrapper,
and skips empty fields and one-time password fields. The server caches the
list for 30 seconds. The **Refresh** button, and the `--refresh` flag of the
CLI, skip the cache.

The server searches these vaults, in this order:

1. The vaults in the `secretVaults` setting, set with
   `PATCH /api/v1/settings` and `{"secretVaults": ["VAULT"]}`.
1. The vaults that existing global and project references name.
1. The `Aio` vault.

A service account reads only its own vaults, whatever the setting says. A
vault that can't be read appears as a note under the list, and the other
vaults still show. When 1Password is locked or `op` is missing, the section
shows the same `secrets_locked` or `secrets_unavailable` message as a launch.

To list the candidates from a terminal, run `aio secrets available`.
The API route is `GET /api/v1/secrets/available`, with `refresh=true` to
skip the cache.

### The secrets broker

For each project container, the server listens on a Unix socket,
`~/.ai-orchestrator/broker/CONTAINER/broker.sock`, readable only by you. It
mounts the socket's directory read-only at `/run/aio-broker` in the
container, and sets `AIO_BROKER_SOCKET` to the socket's path there. Any
process in the container can ask the socket for a secret that the project
lists, at any time, without a prompt.

When a process asks, the server checks the name against the current global
and project references and resolves the value with `op read`. It keeps each
value in its own memory for 5 minutes, so that repeated requests don't reach
1Password each time. Because the server checks the references on every
request, a reference you add or remove takes effect at once, without a
container restart. A value that a process already received stays with that
process.

### The broker under Docker Desktop

Docker Desktop runs containers in a virtual machine, and a Unix socket on
the host can't be mounted into it. The server then uses the broker's TCP
transport instead:

- The broker listens on `127.0.0.1` only, on one port per container. The
  server picks the port like the engine port and stores it with it, so a
  restarted server listens on the same port again.
- Each time the server creates the container, it writes a random token to
  `broker.token`, mode `0600`, in the same broker directory. The container
  mounts that directory read-only at `/run/aio-broker`, as with the socket.
- The container gets `AIO_BROKER_URL=http://host.docker.internal:PORT` in
  place of `AIO_BROKER_SOCKET`, and the directory holds the same URL in
  `broker.url`. The engine withholds every `AIO_` variable from the
  programs it starts, so `aio-secret` finds the broker through that file
  when its environment names none.
- `aio-secret` and the engine send the token in an `Authorization: Bearer`
  header. The broker compares it in constant time, and answers a request
  without the right token with a `401` status code. The server logs the
  refusal with the container and the route, never the header or the body.

Any program on your computer can connect to a loopback port, so the token,
not the port, identifies the container. Anything that can read your files
can read the token, just as it can reach the socket, so the TCP transport
is as strong as the socket and no stronger.

The `brokerTransport` global setting chooses the transport for containers
that the server creates afterward. Set it in the
`~/.ai-orchestrator/config.json` file before the first start, or with
`PATCH /api/v1/settings`:

| Value | Transport |
|---|---|
| `auto` (default) | The Unix socket with Docker Engine on Linux. TCP when the engine's `/info` names Docker Desktop, when `DOCKER_HOST` points at a Docker Desktop endpoint, or when the server runs on macOS or Windows. |
| `unix` | Always the Unix socket. |
| `tcp` | Always TCP. |

A running container keeps the transport it was created with. When the
setting resolves to the other transport, the project shows the container as
stale with `broker unix -> tcp` or `broker tcp -> unix` until it restarts.

With `tcp` and Docker Engine on Linux, the server adds
`host.docker.internal:host-gateway` to the container's hosts file, since
only Docker Desktop defines that name. A container on Docker Engine on
Linux reaches the host through the bridge address, not `127.0.0.1`, so it
can't reach the loopback listener: use `tcp` with Docker Desktop only. The
server logs a warning when it resolves to that combination.

The server logs every request to its journal with the container, the
secret names, the asking program's name, and the outcome. A log line never
holds a value. To read the log, run `journalctl --user -u aio-server`. On
macOS the log is `~/Library/Logs/aio-server.log`, and on Windows
`~\.ai-orchestrator\server.log`.

Values never appear in a record, an API response, an event, a log, the
review app, or the container's configuration. `docker inspect` shows only
the names, in the `aio.secret-names` label.

### Use a secret in a container

The image includes the `aio-secret` command. In a box, use it as
follows:

- To print one value, for a tool that reads a secret from a command, run
  `aio-secret NAME`. The value has no trailing newline.
- To run a command with secrets in its environment, run
  `aio-secret run NAME[,NAME...] -- COMMAND [ARGS...]`. Only that
  command and its children get the values. For example, to start a dev
  server that reads `DATABASE_URL`, run
  `aio-secret run DATABASE_URL -- npm run dev`.
- To see which names the container can ask for, run `aio-secret list`.

`aio-secret` exits with status 3 when the server can't be reached or
refuses the container's token, 4
for a name the project doesn't list, and 5 when 1Password is locked or a
reference doesn't resolve.

When a project has at least one global or project reference, the server
ends the opening prompt of each new conversation in that project with the
following paragraph:

> Secrets come from the AI Orchestrator secrets broker: run `aio-secret list`
> to see their names and `aio-secret run NAME[,NAME...] -- COMMAND [ARGS...]`
> to give them to one command, and never print a value or write one to a
> file, a log, or your replies. Variables such as `GH_TOKEN` also come from
> the broker where the project configures them, so pass them the same way,
> for example `aio-secret run GH_TOKEN -- gh pr list`.

The paragraph follows whichever prompt template the box uses, including one
you edited, and isn't part of the templates, so you can't edit or remove it
there. A box that adopts an existing conversation gets no opening prompt and
no paragraph, and neither does a box whose template you set to empty.

The paragraph names only the command. To tell agents which secrets a project
uses and how to start the tools that need them, write that in the project's
`CLAUDE.md` file.

### Credentials for the engine

The engine asks the broker for the credentials it hands the programs it
starts, and gives each program only its own:

- A vendor CLI gets the names it signs in with, for example
  `ANTHROPIC_API_KEY` for Claude, `OPENAI_API_KEY` for Codex, and
  `COPILOT_GITHUB_TOKEN` for Copilot.
- `gh` and the git commands that talk to a remote (`push`, `fetch`,
  `ls-remote`) get `GH_TOKEN`, `GITHUB_TOKEN`, their enterprise forms, and
  `SSH_AUTH_SOCK`. Local git commands get nothing, and no git command the
  engine runs uses the repository's hooks.
- Test and lint commands and other repository code get nothing. A policy
  test command that needs a secret must ask for it, for example with
  `aio-secret run DATABASE_URL -- npm test`.

When the broker can't answer, the engine logs a warning and starts the
program without the values. A vendor CLI signed in with its own account
keeps working; one that needs a key reports a sign-in error.

### What the broker doesn't protect

Every process in a project container runs as the same user. Any process
there, including repository code that a test command or a review runs, can
ask the broker for any secret the project lists, and can read a value from
the environment of a process that received it. The broker keeps values out
of `docker inspect`, out of every session's environment, and out of
processes that don't ask, and it logs who asked. It doesn't hide a listed
secret from the agent or from repository code. List only the secrets a
project needs.

The vendor sign-ins aren't 1Password secrets and don't go through the
broker. Every container mounts your `~/.claude`, `~/.codex`, and `~/.copilot`
directories, so any process in any project container can read and change
the Claude, Codex, and Copilot sign-ins stored there, such as
`~/.claude/.credentials.json` and `~/.codex/auth.json`.

## Connect 1Password

The server uses one of the following ways to reach 1Password, in this
order:

1. **Service account**: when the server's environment holds
   `OP_SERVICE_ACCOUNT_TOKEN`, `op` uses that service account. This works
   without a desktop session and suits a server that runs while you're
   logged out. Give the service account read access to the vaults your
   references name. To set the variable for the user service, run
   `systemctl --user edit aio-server` and add an
   `Environment=OP_SERVICE_ACCOUNT_TOKEN=TOKEN` line under `[Service]`,
   where `TOKEN` is the service account token. Keep that file readable only
   by you. To keep the token out of the drop-in, put the
   `OP_SERVICE_ACCOUNT_TOKEN=TOKEN` line in a file with mode `0600`, such as
   `~/.config/aio/op.env`, and add
   `EnvironmentFile=%h/.config/aio/op.env` under `[Service]` instead.
   Drop-ins stay in place when you reinstall the unit. On macOS and
   Windows, put the line in `op.env` in the configuration directory
   instead (`~/.config/aio` on macOS, `%APPDATA%\aio` on Windows); the
   server reads it at start. For more information, see
   [macOS and Windows](platforms.md#1password-service-account-token).
1. **Desktop app integration**: when the 1Password desktop app runs with
   **Integrate with 1Password CLI** turned on, `op` asks the app, which can
   prompt you to unlock.

To see which mode the server uses and whether it's signed in, open the setup
wizard and look at the **1Password** check, or run `aio doctor`. To try
every reference without starting a container, click **Check secrets** in the
settings. The check reports each reference as resolved or failed, with the
reason, and never shows a value.

## When 1Password is locked or missing

AI Orchestrator has no fallback. In 3.x, a project could hold an `agent.env` file
of plain values; 1.0.0 doesn't read it.

Before the server creates a project container, it runs a pre-start check:
it resolves every reference with a fresh `op read`. If the server can't
resolve every reference, the container doesn't start:

| Situation | Result |
|---|---|
| `op` isn't installed | The launch fails with `secrets_unavailable` and a message that names the missing CLI. |
| The desktop app is locked, or the service account token is missing or expired | The launch fails with `secrets_locked`. Unlock 1Password, or fix the token, and start the box again. |
| A reference names a vault, item, or field that doesn't exist, or one the account can't read | The launch fails with `secrets_unavailable` and names the reference, not its value. |

A project that has no references, globally or in its settings, starts
without `op`.

After the container starts, a request for a value that isn't in the cache
can fail the same way, for example when 1Password locks while a box runs.
`aio-secret` then exits with status 5 and the same message. In desktop
mode, the server's `op` call can show the unlock prompt on your desktop; in
service account mode, fix the token.

A container that a server from before the broker created has its secret
values in its environment. It shows as stale, with
`secrets environment -> broker`, until it restarts.

## The sudo password

The container user has no passwordless `sudo`. Docker runs without a user
namespace, so root in a container is root on the host's bind mounts, and an
agent with root could leave a setuid-root file in your project or in
`~/.claude`. For details, see "Container boundaries" in
[Architecture](architecture.md#container-boundaries).

By default, `sudo` is off in every container: the container has no `sudo`
rule for the user, and the user's password is locked. There is no
passwordless fallback.

To allow `sudo` with a password that you keep in 1Password, follow these
steps:

1. Store a password in a 1Password item. Use a password you don't use
   anywhere else, on a single line.
1. In the Boxes app, open the setup wizard, enter the reference in
   **Sudo password reference (1Password)**, and click **Done**. Through the
   API, send `PATCH /api/v1/settings` with
   `{"sudoPasswordRef": "op://VAULT/ITEM/FIELD"}`.
1. Restart each running project container. A container keeps the `sudo`
   policy it started with, and shows as stale until it restarts.

To turn `sudo` off again, clear the field, or send `{"sudoPasswordRef": null}`.

With a reference set, `sudo` in a container asks for the password on every
use and keeps no cached credentials, so a password you type in one terminal
doesn't unlock `sudo` for an agent that shares it. Type the password from
1Password in a shell you open in the box. An agent can't answer the prompt,
because it doesn't know the password.

### How the password reaches the container

The plaintext never enters a container. When the server creates a project
container, it does the following:

1. It runs `op read` for the reference. The password never goes through the
   secrets broker or its cache.
1. It hashes the value with SHA-512 crypt (`$6$`), with a random salt and
   100,000 rounds, in its own memory, and drops the plaintext. The value
   never appears in a record, an API response, an event, or a log.
1. It starts the container and runs a root setup step with
   `docker exec --user root`. The hash travels on the step's standard input,
   so it's in no command line, environment variable, `docker inspect`
   output, or container log.
1. The step installs the hash with `chpasswd -e` and writes a `sudo` rule to
   `/etc/sudoers.d/aio`.

The agent can't read or replace the hash. `/etc/shadow` is readable only by
root and the `shadow` group, which the container user isn't in, and only
root can write it. Changing the password with `passwd` asks for the current
one. The root setup step runs before any box session starts, with a fixed
`PATH` of system directories, so nothing the container user writes runs as
root.

When a reference is set and the server can't resolve it, the container
doesn't start, with the same `secrets_locked` and `secrets_unavailable`
errors as other secrets. The **sudo in containers** check in the setup
wizard, and `aio doctor`, report whether the reference resolves.

## Migrate from `agent.env`

The 3.x import doesn't read `agent.env` files and never copies their values.
For each value in a project's `agent.env` file, follow these steps:

1. Store the value in a 1Password item.
1. Add a reference for it in the project settings, with the same name as the
   `agent.env` key.
1. Delete the `agent.env` file when every value has a reference.
