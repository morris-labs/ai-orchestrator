# Troubleshooting

This page lists common problems with AI Orchestrator and how to fix them. Start
with the built-in checks:

```sh
aio doctor
```

The command runs the same checks as the setup wizard: Docker, the image, the
engine version, the SSH client and key, 1Password, `sudo` in containers,
and the server.

## The apps say they can't reach the server

The server runs as a systemd user service. Check its state and its log:

```sh
systemctl --user status aio-server
journalctl --user -u aio-server -n 100
```

If the service isn't enabled, enable and start it:

```sh
systemctl --user enable --now aio-server
```

On macOS the server runs as a launchd agent, and on Windows as a Task
Scheduler task. For the commands that check, restart, and read the log of
each, see [The server service](platforms.md#the-server-service).

If the log says the port is in use, another process holds `127.0.0.1:21400`.
Stop that process, or change `serverPort` in `~/.ai-orchestrator/config.json`
and restart the service.

If the CLI or an app says the server presented a certificate other than the
one in `server.crt`, another program answered on the server port, or the
server runs with another data directory than the client. Check what holds
the port with `ss -ltnp 'sport = :21400'`, and set the same
`AIO_DATA_DIR` for the server and its clients. The client sent no
token to that program.

If the CLI says there is no server certificate, the server has never started
with that data directory. Start it once; it creates `server.crt` and
`server.key`.

If the CLI reports `401 Unauthorized`, the token in
`~/.ai-orchestrator/server.token` doesn't match the running server. Restart the
service, which rereads the file.

If a script or an older client gets `401 Unauthorized` on a WebSocket such
as `/api/v1/events`, check how it sends the token. The server accepts only
the `Authorization: Bearer TOKEN` header or the session cookie on an
upgrade, never a `token` query parameter. With `websocat`, for example,
pass `-H "Authorization: Bearer TOKEN"`, where `TOKEN` is the content of
`~/.ai-orchestrator/server.token`.

If a project's engine never becomes healthy and the container log says
`The engine token file /run/aio/engine.token can't be read`, the
container started without the token file the server writes to
`~/.ai-orchestrator/state/CONTAINER/engine.token`. Stop the container and let the
server create it again; check that the state directory is writable by your
user.

## Docker is unavailable

A `docker_unavailable` error means the server can't reach the Docker socket
as your user. Check the following:

- The Docker daemon runs: `systemctl status docker`.
- Your user is in the `docker` group: `id -nG`. After you add yourself, log
  out and back in, then restart the service, because the service keeps the
  groups it started with.

## The image is missing or the engine version doesn't match

An `image_missing` error means there's no `aio-agent` image. An
`engine_mismatch` error means the image carries an engine version other
than the server's, which happens after a package upgrade. In both cases,
rebuild the image from the setup wizard, or run the following command:

```sh
/usr/share/ai-orchestrator/scripts/build-image.sh
```

The engine version has the form `VERSION+HASH`, where `HASH` identifies the
engine code. An image built before the hash existed records only `VERSION` and
reads as stale. To update the agent CLIs as well, add `--update-cli`, which
writes the latest npm versions to `image/versions.env` before it builds.

The image records its versions in `/etc/aio-engine-version`,
`/etc/claude-code-version`, `/etc/codex-version`, and `/etc/copilot-version`.
To read them, run
`docker run --rm aio-agent cat /etc/aio-engine-version`.

## A box won't start because of secrets

A `secrets_locked` error means 1Password is locked, or the service account
token is missing or expired. A `secrets_unavailable` error means `op` isn't
installed or a reference can't be read. For each case, see
[Secrets](secrets.md#when-1password-is-locked-or-missing). The same errors
come from the sudo password reference, when one is set; the message names
it.

## aio-secret fails in a box

The `aio-secret` command exits with a status that names the cause:

| Status | Cause | What to do |
|---|---|---|
| 3 | The secrets broker doesn't answer, or refuses the container's token. | Check that the server runs with `systemctl --user status aio-server`, or the macOS or Windows equivalent in [The server service](platforms.md#the-server-service). The server recreates the socket or TCP listener within 30 seconds of starting. Under Docker Desktop, see [aio-secret fails under Docker Desktop](#aio-secret-fails-under-docker-desktop). |
| 4 | The project doesn't list the name. | Add a reference with that name in the project or global settings. No restart is needed. |
| 5 | 1Password is locked, or the reference doesn't resolve. | Unlock 1Password or fix the reference, then try again. |

The server logs each request with the container, the names, and the
outcome. To read the log, run `journalctl --user -u aio-server` on Linux, or
open `~/Library/Logs/aio-server.log` on macOS or
`~\.ai-orchestrator\server.log` on Windows.

## aio-secret fails under Docker Desktop

Under Docker Desktop, the broker listens on a loopback port of the host and
checks a token; see
[The broker under Docker Desktop](secrets.md#the-broker-under-docker-desktop).
Check the following:

- **The container uses the Unix socket.** In the box, run
  `echo "$AIO_BROKER_URL"; cat /run/aio-broker/broker.url`. When both are
  empty, the container was created with the Unix socket, which can't
  cross the Docker Desktop virtual machine. Restart the project container.
  If the server chose the socket for a Docker Desktop engine, set
  `brokerTransport` to `tcp`.
- **The token was refused.** The server log shows
  `Secrets broker: CONTAINER ROUTE: unauthorized (wrong token)` or
  `(missing token)`. The server writes a new token each time it creates
  the container. If the refusals continue, restart the project container.
- **The port is taken.** The server log shows
  `can't listen on 127.0.0.1:PORT`. Another program took the container's
  broker port while the server was stopped. Stop that program, or restart
  the project container, which picks a free port.
- **`host.docker.internal` doesn't resolve or connect.** In the box, run
  `getent hosts host.docker.internal`. Docker Desktop defines the name.
  With Docker Engine on Linux and `brokerTransport` set to `tcp`, the name
  resolves to the bridge address, where the loopback listener can't be
  reached: set `brokerTransport` back to `auto`.

## sudo fails in a container

`sudo` is off in containers unless the settings name a sudo password
reference. When `sudo` says the user isn't in the sudoers file, or every
password is wrong, set the reference and restart the project container. See
[The sudo password](secrets.md#the-sudo-password).

If a box fails to start with `The container's sudo setup failed`, the root
setup step that sets the `sudo` policy failed, and the server removed the
container rather than run it with an unknown policy. The message gives the
step's error. Rebuild the image if it predates 1.0.0.

## A container shows as unhealthy

The image's health check calls the engine's health route inside the
container. A container is unhealthy when the engine didn't start or
stopped. Read the engine's output in the container log:

```sh
docker logs CONTAINER
```

Replace `CONTAINER` with the project container's name, which starts with
`aio-agent-proj-`. If the log shows a version mismatch, rebuild the
image.

## A dev server link doesn't open

Dev server links have the form `http://PORT.BOX.localhost:21401/`. Check the
following:

- The dev server listens inside the container. The details panel lists only
  ports it found listening.
- The dev server listens on `0.0.0.0` or `127.0.0.1` inside the container.
  The engine proxies both.
- Your browser resolves `*.localhost` names to the loopback address. Most
  browsers do; for a command-line client, pass
  `--resolve PORT.BOX.localhost:21401:127.0.0.1` to `curl`.
- A `403` response means the proxy refused the request. The proxy forwards
  only to ports that the box's own processes listen on, or that the project
  maps as TCP ports. It also refuses requests that a page on another site
  sends, including a page on another `PORT.BOX.localhost` host: open the
  link from the app or type it in the address bar.

## Resume says "No conversation found"

Claude Code looks up a transcript under `~/.claude/projects/` by the
directory the session works in. If `~/.claude/projects` is a symbolic link to
another directory, the server mounts the link's target at the same path in
the container. If you moved the target, restart the project container so it
gets the new mount.

For a worktree box, the transcript lives under the worktree's encoded path,
not the project root's. Purging or moving the worktree by hand breaks the
link between the box and its transcript; use **Remove** or **Purge** in the
app instead.

## A box waits at the folder trust dialog

Claude Code asks whether you trust a folder the first time it runs there,
and a resumed box asks too when its folder was never trusted. Answer the
dialog once in the box's terminal. Claude Code records the answer as
`projects["DIRECTORY"].hasTrustDialogAccepted` in `~/.claude.json`, where
`DIRECTORY` is the box's working directory, and every later box in that
folder starts without the dialog. A worktree box works in its own folder,
so a new worktree can ask once more.

AI Orchestrator doesn't answer the dialog for you. Every box mounts the host's
`~/.claude.json` as a single file, and the host's and every box's Claude
Code write it while they run. A rewrite by the server could race those
writes and lose settings, and an atomic replace swaps the file for a new
one, which running boxes no longer see.

## A review run doesn't start

The following errors can stop a run before its first stage:

- `dirty_tree`: the box's worktree has uncommitted changes. Commit them, or
  start the run with **Include uncommitted changes**.
- A vendor isn't signed in: sign in to the Codex or Copilot CLI on the host.
  The containers mount `~/.codex` and `~/.copilot`.
- The policy file doesn't parse: the preflight stage names the field. For the
  format, see [Policy file](policy.md).

## A reviewer call fails with "Not logged in"

A run stops with an error like `The reviewer call on claude failed: ...
Not logged in · Please run /login`. The vendor CLI that the engine started
found no sign-in in the folder it used. Check the following:

1. In accounts mode, make sure the vendor has a default account that is
   signed in. To check an account, run the following command, where
   `VENDOR/NAME` is the account's id, such as `claude/personal`:

   ```bash
   aio accounts check VENDOR/NAME

   ```

   If the account isn't signed in, run `aio accounts login VENDOR/NAME`,
   which prints the command that signs it in, and run that command in a box
   shell.
1. Make sure the project container runs an image with an engine that reads
   `account-dirs.json`. An older engine runs `claude` with the container
   user's `~/.claude`, which in accounts mode can be a real folder that
   Docker created to hold the shared `CLAUDE.md`, `settings.json`, `skills`,
   and `plugins` mounts, without the account's sign-in. To check, compare the
   engine version that `aio doctor` reports with the server's.

   A server log warning that `~/.claude` is a folder, not a link to the
   default account, doesn't show an older engine. A current engine logs it too
   and its review runs aren't affected, so don't rebuild for that warning
   alone.

   If the engine is older, rebuild the image and restart the project
   container. On a packaged install, run the following:

   ```bash
   /usr/share/ai-orchestrator/scripts/build-image.sh
   aio project restart PROJECT_ID

   ```

   Replace `PROJECT_ID` with the project's id, which `aio project list`
   shows.

   > **Warning:** `aio project restart` stops every running box in the project.

   In a source checkout, run `scripts/build-image.sh` from the repository root
   instead. If the checkout is newer than the running server, restart the
   server first: the server refuses an image whose engine differs from its own,
   and the project stays down with `engine_mismatch` until the versions match.
1. In host mode, sign in on the host. The containers mount `~/.claude`,
   `~/.claude.json`, `~/.codex`, and `~/.copilot`.

## The Electron apps don't open on Ubuntu 24.04 or later

Ubuntu restricts unprivileged user namespaces, which the apps' sandbox
needs. The package installs AppArmor profiles that allow it, at
`/etc/apparmor.d/aio-boxes` and `/etc/apparmor.d/aio-review`. If
the apps still fail with a sandbox error, reload the profiles:

```sh
sudo apparmor_parser -r /etc/apparmor.d/aio-boxes /etc/apparmor.d/aio-review
```

The package's profiles cover only the installed apps in
`/usr/lib/ai-orchestrator`. When you run the apps from a source checkout, they
fail with an error about the namespace sandbox or about `chrome-sandbox`
not being owned by root with mode 4755. To fix it, install profiles for the
checkout's Electron binary:

```sh
scripts/install-dev-apparmor.sh
```

The script downloads a missing Electron binary first, through
`scripts/ensure-electron.sh`. Run it again after pnpm installs a different
Electron version. To see the profiles first, add `--print`; to delete them, add `--remove`.
Making `chrome-sandbox` setuid root also works, but every reinstall of the
Electron package undoes it. For more information, see
[Run the Electron apps from the checkout](install.md#run-the-electron-apps-from-the-checkout).

## Collect information for a bug report

Include the output of the following commands:

```sh
aio doctor
systemctl --user status aio-server
journalctl --user -u aio-server -n 200
docker ps --filter name=^aio-agent-
```

On macOS or Windows, replace the two service commands with that host's
commands from [The server service](platforms.md#the-server-service).
Check the output for secrets before you share it. AI Orchestrator never logs
secret values, but your own commands might.
