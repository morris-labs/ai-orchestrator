# Agent Box server

The `agentbox-server` package is the host server: it manages Docker, boxes,
projects, and worktrees, serves the REST and WebSocket API on 127.0.0.1,
subscribes to the engine in each project container, and runs the lease
scheduler. Run `agentbox-server --help` for its commands.

## Data directory

The server keeps its data in `~/.claude-box`: the `agentbox.db` database,
the `server.token` bearer token, `config.json`, the keeper state in `state/`,
the per-container `sessions/` directories, and the 3.x records that the
one-time import reads.

To use another directory, pass `--data-dir PATH` or set `AGENTBOX_DATA_DIR`.
The flag wins when you give both, and a relative path resolves against the
working directory. The server still reads your Claude Code files in
`~/.claude` and `~/.claude.json`, so a test server can run against a copy of
your data without writing to `~/.claude-box`:

```sh
cp -a ~/.claude-box /tmp/agentbox-data
agentbox-server --data-dir /tmp/agentbox-data
```

The `agentbox` CLI and the two apps read `AGENTBOX_DATA_DIR` too, to find
`server.token` and the server port in `config.json`. Set it in their
environment when the server runs with another data directory:

```sh
AGENTBOX_DATA_DIR=/tmp/agentbox-data agentbox doctor
```

`agentbox-server install-service` writes a non-default data directory into
the unit's `ExecStart=` line as `--data-dir`.

## Environment

| Variable | Meaning |
|---|---|
| `AGENTBOX_DATA_DIR` | The data directory, when `--data-dir` isn't given. Default: `~/.claude-box`. |
| `AGENTBOX_HOME` | The home directory to use in place of yours. Without a data directory option, the server keeps its data in `AGENTBOX_HOME/.claude-box`. |
| `AGENTBOX_ENGINE_VERSION` | The engine version to expect. Default: this package's version. |
| `AGENTBOX_IMAGE_CONTEXT` | The image build context. Default: `image/` in the repository. |
| `AGENTBOX_BOXES_DIR` | The built Boxes app to serve at `/boxes/`. |
| `AGENTBOX_REVIEW_DIR` | The built Review app to serve at `/review/`. |
| `AGENTBOX_DEV_ENGINES` | Development only. Engines for projects without a container; see the next section. |

## Development engines

`AGENTBOX_DEV_ENGINES` registers engines that run as local processes instead
of in a project container, so you can run review runs without Docker. The
end-to-end tests in `tools/e2e` use it.

The value is a comma-separated list of entries:

```text
PROJECT_ID=HOST:PORT:TOKEN[,PROJECT_ID=HOST:PORT:TOKEN...]
```

Replace the following:

- `PROJECT_ID`: the project's id, such as `repo-1e4b6202`. The server derives
  it from the project root, so you can register the engine before you create
  the project with `POST /api/v1/projects`.
- `HOST`: a loopback host, such as `127.0.0.1`. The server always connects
  to the engine on 127.0.0.1.
- `PORT`: the engine's port, its `AGENTBOX_ENGINE_PORT`.
- `TOKEN`: the engine's token, the content of its `AGENTBOX_ENGINE_TOKEN_FILE`,
  at least 16 characters.

Start each engine with `AGENTBOX_CONTAINER` set to the project's container
name, `claude-agent-proj-PROJECT_ID`. The server finds the engine that holds a
run by the run's container, and the engine stamps its runs with that name.

The server subscribes to each development engine like to a container's
engine: it relays the engine's events, answers its lease requests with the
scheduler, and sends the project's run routes to it. A project whose
container runs keeps its container's engine.

The server refuses to start when `AGENTBOX_DEV_ENGINES` names a host that
isn't loopback, or when the server itself binds to an address that isn't
loopback. The server never logs the tokens.

For example, to run the built engine with mock vendors next to a server in a
scratch home directory:

```sh
mkdir -p /tmp/engine-state
(umask 077 && echo TOKEN > /tmp/engine-state/engine.token)
AGENTBOX_ENGINE_TOKEN_FILE=/tmp/engine-state/engine.token AGENTBOX_ENGINE_PORT=20599 \
  AGENTBOX_PROJECT_ROOT=/path/to/repo AGENTBOX_CONTAINER=claude-agent-proj-PROJECT_ID \
  AGENTBOX_ENGINE_VERSION=4.0.0-dev AGENTBOX_STATE_DIR=/tmp/engine-state \
  AGENTBOX_MOCK_VENDORS=1 node packages/engine/dist/main.js &
AGENTBOX_HOME=/tmp/agentbox-home \
  AGENTBOX_DEV_ENGINES=PROJECT_ID=127.0.0.1:20599:TOKEN \
  node packages/server/dist/main.js
```
