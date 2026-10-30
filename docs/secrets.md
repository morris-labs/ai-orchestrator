# Secrets

Agent Box gives containers secrets from 1Password and from nowhere else. You
store 1Password references in the global settings and in project settings;
the server resolves them with the 1Password CLI (`op`) each time it starts a
project container and passes the values to the container as environment
variables. One reference is different: the container user's `sudo`
password, which reaches a container only as a hash. See
[The sudo password](#the-sudo-password).

## How secrets work

A secret reference has two parts:

- `name`: the environment variable the container receives, for example
  `DATABASE_URL`.
- `ref`: a 1Password secret reference in the form
  `op://VAULT/ITEM/FIELD`.

Replace the following:

- `VAULT`: the 1Password vault that holds the item
- `ITEM`: the item's name or ID
- `FIELD`: the field's name, optionally with a section, as in
  `SECTION/FIELD`

Global references apply to every project container. A project reference
with the same `name` as a global one wins for that project.

When a container starts, the server runs `op read` for each reference and
caches the values for that launch only. Values never appear in a record, an
API response, an event, a log, or the review app. The API shows only names
and references.

The values are part of the container's configuration, because agents in the
container need them as environment variables. Anyone who can reach the
Docker daemon can read them with `docker inspect` or `docker exec ... env`
for as long as the container exists. On a host where other users are in the
`docker` group, treat every secret you give a project as shared with them.

Inside the container, every process runs as the same user, so any code
there, repository code that a test command or a review runs included, can
read the secrets from the container's environment, for example from
`/proc/1/environ`. The engine keeps credentials out of the environment of
the test commands and scripts it starts, but that doesn't stop such code
from reading them elsewhere.

The following example sets two references on a project:

| Name | Reference |
|---|---|
| `DATABASE_URL` | `op://Development/orders-db/connection-string` |
| `STRIPE_API_KEY` | `op://Development/stripe-test/credential` |

## Connect 1Password

The server uses one of the following ways to reach 1Password, in this
order:

1. **Service account**: when the server's environment holds
   `OP_SERVICE_ACCOUNT_TOKEN`, `op` uses that service account. This works
   without a desktop session and suits a server that runs while you're
   logged out. Give the service account read access to the vaults your
   references name. To set the variable for the user service, run
   `systemctl --user edit agentbox-server` and add an
   `Environment=OP_SERVICE_ACCOUNT_TOKEN=TOKEN` line under `[Service]`,
   where `TOKEN` is the service account token. Keep that file readable only
   by you.
1. **Desktop app integration**: when the 1Password desktop app runs with
   **Integrate with 1Password CLI** turned on, `op` asks the app, which can
   prompt you to unlock.

To see which mode the server uses and whether it's signed in, open the setup
wizard and look at the **1Password** check, or run `agentbox doctor`. To try
every reference without starting a container, click **Check secrets** in the
settings. The check reports each reference as resolved or failed, with the
reason, and never shows a value.

## When 1Password is locked or missing

Agent Box has no fallback. In 3.x, a project could hold an `agent.env` file
of plain values; 4.0.0 doesn't read it. If a container needs secrets and the
server can't resolve every reference, the container doesn't start:

| Situation | Result |
|---|---|
| `op` isn't installed | The launch fails with `secrets_unavailable` and a message that names the missing CLI. |
| The desktop app is locked, or the service account token is missing or expired | The launch fails with `secrets_locked`. Unlock 1Password, or fix the token, and start the box again. |
| A reference names a vault, item, or field that doesn't exist, or one the account can't read | The launch fails with `secrets_unavailable` and names the reference, not its value. |

A project that has no references, globally or in its settings, starts
without `op`.

The server resolves secrets only when it creates a container. A box started
in a container that's already running uses the values the container got at
launch. To pick up a changed secret, restart the project container.

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

1. It runs `op read` for the reference, the same way it resolves secrets.
1. It hashes the value with SHA-512 crypt (`$6$`), with a random salt and
   100,000 rounds, in its own memory, and drops the plaintext. The value
   never appears in a record, an API response, an event, or a log.
1. It starts the container and runs a root setup step with
   `docker exec --user root`. The hash travels on the step's standard input,
   so it's in no command line, environment variable, `docker inspect`
   output, or container log.
1. The step installs the hash with `chpasswd -e` and writes a `sudo` rule to
   `/etc/sudoers.d/claude-box`.

The agent can't read or replace the hash. `/etc/shadow` is readable only by
root and the `shadow` group, which the container user isn't in, and only
root can write it. Changing the password with `passwd` asks for the current
one. The root setup step runs before any box session starts, with a fixed
`PATH` of system directories, so nothing the container user writes runs as
root.

When a reference is set and the server can't resolve it, the container
doesn't start, with the same `secrets_locked` and `secrets_unavailable`
errors as other secrets. The **sudo in containers** check in the setup
wizard, and `agentbox doctor`, report whether the reference resolves.

## Migrate from `agent.env`

The 3.x import doesn't read `agent.env` files and never copies their values.
For each value in a project's `agent.env` file, follow these steps:

1. Store the value in a 1Password item.
1. Add a reference for it in the project settings, with the same name as the
   `agent.env` key.
1. Delete the `agent.env` file when every value has a reference.
