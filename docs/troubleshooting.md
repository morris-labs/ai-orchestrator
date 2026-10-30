# Troubleshooting

This page lists common problems with Agent Box and how to fix them. Start
with the built-in checks:

```sh
agentbox doctor
```

The command runs the same checks as the setup wizard: Docker, the image, the
engine version, the SSH client and key, 1Password, and the server.

## The apps say they can't reach the server

The server runs as a systemd user service. Check its state and its log:

```sh
systemctl --user status agentbox-server
journalctl --user -u agentbox-server -n 100
```

If the service isn't enabled, enable and start it:

```sh
systemctl --user enable --now agentbox-server
```

If the log says the port is in use, another process holds `127.0.0.1:21400`.
Stop that process, or change `serverPort` in `~/.claude-box/config.json`
and restart the service.

If the CLI or an app says the server presented a certificate other than the
one in `server.crt`, another program answered on the server port, or the
server runs with another data directory than the client. Check what holds
the port with `ss -ltnp 'sport = :21400'`, and set the same
`AGENTBOX_DATA_DIR` for the server and its clients. The client sent no
token to that program.

If the CLI says there is no server certificate, the server has never started
with that data directory. Start it once; it creates `server.crt` and
`server.key`.

If the CLI reports `401 Unauthorized`, the token in
`~/.claude-box/server.token` doesn't match the running server. Restart the
service, which rereads the file.

If a script or an older client gets `401 Unauthorized` on a WebSocket such
as `/api/v1/events`, check how it sends the token. The server accepts only
the `Authorization: Bearer TOKEN` header or the session cookie on an
upgrade, never a `token` query parameter. With `websocat`, for example,
pass `-H "Authorization: Bearer TOKEN"`, where `TOKEN` is the content of
`~/.claude-box/server.token`.

If a project's engine never becomes healthy and the container log says
`The engine token file /run/claude-box/engine.token can't be read`, the
container started without the token file the server writes to
`~/.claude-box/state/CONTAINER/engine.token`. Stop the container and let the
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

An `image_missing` error means there's no `claude-code` image. An
`engine_mismatch` error means the image carries an engine version other
than the server's, which happens after a package upgrade. In both cases,
rebuild the image from the setup wizard, or run the following command:

```sh
/usr/share/agentbox/scripts/build-image.sh
```

The image records its versions in `/etc/agentbox-engine-version`,
`/etc/claude-code-version`, `/etc/codex-version`, and `/etc/copilot-version`.
To read them, run
`docker run --rm claude-code cat /etc/agentbox-engine-version`.

## A box won't start because of secrets

A `secrets_locked` error means 1Password is locked, or the service account
token is missing or expired. A `secrets_unavailable` error means `op` isn't
installed or a reference can't be read. For each case, see
[Secrets](secrets.md#when-1password-is-locked-or-missing).

## A container shows as unhealthy

The image's health check calls the engine's health route inside the
container. A container is unhealthy when the engine didn't start or
stopped. Read the engine's output in the container log:

```sh
docker logs CONTAINER
```

Replace `CONTAINER` with the project container's name, which starts with
`claude-agent-proj-`. If the log shows a version mismatch, rebuild the
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

## A review run doesn't start

The following errors can stop a run before its first stage:

- `dirty_tree`: the box's worktree has uncommitted changes. Commit them, or
  start the run with **Include uncommitted changes**.
- A vendor isn't signed in: sign in to the Codex or Copilot CLI on the host.
  The containers mount `~/.codex` and `~/.copilot`.
- The policy file doesn't parse: the preflight stage names the field. For the
  format, see [Policy file](policy.md).

## The Electron apps don't open on Ubuntu 24.04 or later

Ubuntu restricts unprivileged user namespaces, which the apps' sandbox
needs. The package installs AppArmor profiles that allow it, at
`/etc/apparmor.d/agentbox-boxes` and `/etc/apparmor.d/agentbox-review`. If
the apps still fail with a sandbox error, reload the profiles:

```sh
sudo apparmor_parser -r /etc/apparmor.d/agentbox-boxes /etc/apparmor.d/agentbox-review
```

## Collect information for a bug report

Include the output of the following commands:

```sh
agentbox doctor
systemctl --user status agentbox-server
journalctl --user -u agentbox-server -n 200
docker ps --filter name=^claude-agent-
```

Check the output for secrets before you share it. Agent Box never logs
secret values, but your own commands might.
