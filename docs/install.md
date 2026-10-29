# Install Agent Box

This page describes how to install Agent Box 4 on Ubuntu from the `.deb`
package, start its server, and build the container image. To build the
package yourself, see [Build from source](#build-from-source).

Agent Box 4 supports Linux on x86-64. macOS and Windows packages are
deferred.

## Before you begin

You need the following:

- Ubuntu 24.04 or later, or another Debian-based distribution with
  systemd.
- Node.js 22. Ubuntu's own `nodejs` package is older than 22 on Ubuntu
  24.04, so install Node.js 22 from
  [NodeSource](https://github.com/nodesource/distributions). The package
  depends on Node.js 22 exactly: the server's SQLite module is compiled for
  that version.
- Docker Engine, from the `docker.io` or `docker-ce` package, with your user
  in the `docker` group.
- A Claude account signed in to Claude Code on the host, so that
  `~/.claude` and `~/.claude.json` exist. Every container mounts them.
- Optional: the 1Password CLI (`op`), if your projects use secrets. For more
  information, see [Secrets](secrets.md).

To add your user to the `docker` group, run the following command, then log
out and log back in:

```sh
sudo usermod -aG docker "$USER"
```

## Install the package

1. Download `agentbox_VERSION_amd64.deb` from the
   [releases page](https://github.com/morris-labs/Claude-Box/releases).
   Replace `VERSION` with the release you want, for example `4.0.0`.

1. Install the package with `apt`, which also installs the dependencies:

   ```sh
   sudo apt install ./agentbox_VERSION_amd64.deb
   ```

The package installs the following:

| Path | Contents |
|---|---|
| `/usr/bin/agentbox` | The command-line client |
| `/usr/bin/agentbox-server` | The host server |
| `/usr/bin/agentbox-boxes`, `/usr/bin/agentbox-review` | The two desktop apps |
| `/usr/lib/agentbox/` | The server, the CLI, and both apps |
| `/usr/lib/systemd/user/agentbox-server.service` | The systemd user unit |
| `/usr/share/agentbox/image/` | The Dockerfile, the keeper scripts, and the engine tarballs |
| `/usr/share/applications/` | The **Agent Box** and **Agent Box Review** desktop entries |

## Start the server

The server runs as your user, under your systemd user manager. It never
runs as root: it reads and writes your `~/.claude-box` directory and talks to
Docker with your permissions. The package doesn't start it for you, because
a package installs for every user and the server belongs to one.

1. As the user who runs your boxes, enable and start the service:

   ```sh
   systemctl --user enable --now agentbox-server
   ```

1. Optional: To keep the server running while you're logged out, turn on
   lingering for your user:

   ```sh
   sudo loginctl enable-linger "$USER"
   ```

1. Check that the server is healthy:

   ```sh
   agentbox doctor
   ```

The server listens on `127.0.0.1:21400` only. On its first start it writes a
bearer token to `~/.claude-box/server.token` with mode `0600`. The apps and
the CLI read that file; anything else that calls the API must send the token.

The server keeps all its data in `~/.claude-box` unless you start it with
`--data-dir PATH` or set `AGENTBOX_DATA_DIR`. When you move it, set
`AGENTBOX_DATA_DIR` for the CLI and the apps as well, so they find the token.
For details, see the server's `packages/server/README.md` file.

## Build the container image

Every project runs in one container from the `claude-code` image. The image
carries the toolchain, the Claude Code, Codex, and GitHub Copilot CLIs at the
versions pinned in `image/versions.env`, and the Agent Box engine.

To build the image, open **Agent Box** from your applications menu. The setup
wizard checks Docker, the image, the engine version, SSH, 1Password, and the
server, and offers **Build image** when the image is missing.

To build the image from a terminal instead, run the script that ships with
the package:

```sh
/usr/share/agentbox/scripts/build-image.sh
```

The script builds the image with your user name, so file ownership in the
bind mounts matches your host user. The first build takes several minutes.

To build a test image without retagging the image that running boxes launch
from, set the `IMAGE_TAG` environment variable. The `--tag` option overrides
it.

```sh
IMAGE_TAG=claude-code:v4test /usr/share/agentbox/scripts/build-image.sh
```

The server refuses to start a container whose engine version differs from
its own, and offers a rebuild. After you upgrade the package, rebuild the
image.

## Sign in to the other CLIs

Every container mounts your host's `~/.codex` and `~/.copilot` directories,
so one sign-in on the host serves every box. To use Codex or Copilot as a
box's platform or as a reviewer, sign in to each on the host. Until you do,
the review pipeline uses only the vendors that are signed in.

## Upgrade

1. Install the new package with `sudo apt install ./agentbox_VERSION_amd64.deb`.
1. Restart the server: `systemctl --user restart agentbox-server`.
1. Rebuild the image from the setup wizard or with `build-image.sh`.

## Uninstall

1. Stop and disable the service:

   ```sh
   systemctl --user disable --now agentbox-server
   ```

1. Remove the package:

   ```sh
   sudo apt remove agentbox
   ```

Your data in `~/.claude-box`, your transcripts in `~/.claude`, and the
`claude-code` image stay in place.

## Build from source

To build the package from a checkout, you need Node.js 22, pnpm through
corepack, [nfpm](https://nfpm.goreleaser.com/install/), and `dpkg-deb`.
electron-builder comes in as a dev dependency of the two apps.

1. Install the workspace and run its checks:

   ```sh
   corepack enable
   pnpm install
   pnpm test
   ```

   `corepack enable` writes its shims next to the `node` binary, which needs
   root when Node.js lives in `/usr/bin`. To install the `pnpm` shim for
   your user only, without `sudo`, run this instead and make sure
   `~/.local/bin` is on your `PATH`:

   ```sh
   corepack enable --install-directory ~/.local/bin pnpm
   ```

1. Build the package:

   ```sh
   scripts/build-deb.sh
   ```

   The script checks for every tool before it starts and names any that are
   missing. It writes `dist/agentbox_VERSION_amd64.deb` and packs the engine
   tarballs into `image/dist/`.

1. Optional: Build the image from the checkout:

   ```sh
   scripts/build-image.sh
   ```

### Release scripts

The `scripts/` directory holds the following release tools:

- `scripts/set-version.sh VERSION`: sets `VERSION` in every workspace
  `package.json` file and in the `AGENTBOX_ENGINE_VERSION` pin. CI runs
  `scripts/set-version.sh --check` and fails when they disagree.
- `scripts/bump-versions.sh`: refreshes the Claude Code, Codex, Copilot, and
  nvm pins in `image/versions.env`. With `--base`, it also moves the base
  image digest in `image/Dockerfile`.
- `scripts/build-image.sh --print`: prints the `docker build` command
  without running it.

To release, set the version, commit, and push a `vVERSION` tag. The release
workflow builds the `.deb`, checks that the tag matches the version, and
attaches the package and the engine tarballs to a GitHub release. The image
isn't pushed to a registry.
