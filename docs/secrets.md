# Secrets

Agent Box gives containers secrets from 1Password and from nowhere else. You
store 1Password references in the global settings and in project settings;
the server resolves them with the 1Password CLI (`op`) each time it starts a
project container and passes the values to the container as environment
variables.

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

## Migrate from `agent.env`

The 3.x import doesn't read `agent.env` files and never copies their values.
For each value in a project's `agent.env` file, follow these steps:

1. Store the value in a 1Password item.
1. Add a reference for it in the project settings, with the same name as the
   `agent.env` key.
1. Delete the `agent.env` file when every value has a reference.
