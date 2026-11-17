# Install AI Orchestrator

This page describes how to install AI Orchestrator on Ubuntu from the `.deb`
package, start its server, and build the container image. To build the
package yourself, see [Build from source](#build-from-source).

AI Orchestrator supports Linux on x86-64. macOS and Windows builds exist but
are untested; for more information, see [macOS and Windows](platforms.md).

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
  in the `docker` group, and BuildKit, from the `docker-buildx` or
  `docker-buildx-plugin` package. The package depends on both.
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

1. Download `ai-orchestrator_VERSION_amd64.deb` from the
   [releases page](https://github.com/morris-labs/ai-orchestrator/releases).
   Replace `VERSION` with the release you want, for example `1.0.0`.

1. Install the package with `apt`, which also installs the dependencies:

   ```sh
   sudo apt install ./ai-orchestrator_VERSION_amd64.deb
   ```

The package installs the following:

| Path | Contents |
|---|---|
| `/usr/bin/aio` | The command-line client |
| `/usr/bin/aio-server` | The host server |
| `/usr/bin/aio-boxes`, `/usr/bin/aio-review` | The two desktop apps |
| `/usr/lib/ai-orchestrator/` | The server, the CLI, and both apps |
| `/usr/lib/systemd/user/aio-server.service` | The systemd user unit |
| `/usr/share/ai-orchestrator/image/` | The Dockerfile, the keeper scripts, and the engine tarball |
| `/usr/share/applications/` | The **AI Orchestrator** and **AI Orchestrator Review** desktop entries |

## Start the server

The server runs as your user, under your systemd user manager. It never
runs as root: it reads and writes your `~/.ai-orchestrator` directory and talks to
Docker with your permissions. The package doesn't start it for you, because
a package installs for every user and the server belongs to one.

1. As the user who runs your boxes, enable and start the service:

   ```sh
   systemctl --user enable --now aio-server
   ```

1. Optional: To keep the server running while you're logged out, turn on
   lingering for your user:

   ```sh
   sudo loginctl enable-linger "$USER"
   ```

1. Check that the server is healthy:

   ```sh
   aio doctor
   ```

The server serves its API over HTTPS on `127.0.0.1:21400` only. On its first
start it writes the following files to `~/.ai-orchestrator`, which it keeps at
mode `0700`:

- `server.token`, the bearer token, with mode `0600`.
- `server.key`, the private key of the server's certificate, with mode
  `0600`.
- `server.crt`, a self-signed certificate for `127.0.0.1`, `::1`, and
  `localhost`. The server replaces it when it is within 30 days of its end,
  which is 10 years after it was made, or when it no longer matches the key.

The apps and the CLI read `server.token` and trust `server.crt` and no other
certificate: before they send the token, the server must prove that it holds
`server.key`. A program that takes the port while the server is down gets
nothing. Anything else that calls the API must send the token, and must
trust `server.crt` rather than skip the certificate check. With `curl`, for
example, pass `--cacert ~/.ai-orchestrator/server.crt`.

The dev-server proxy has its own plain HTTP listener on the port after the
server's, `127.0.0.1:21401`, because a certificate can't name every
`PORT.BOX.localhost` host. The proxy carries no token.

The server keeps all its data in `~/.ai-orchestrator` unless you start it with
`--data-dir PATH` or set `AIO_DATA_DIR`. When you move it, set
`AIO_DATA_DIR` for the CLI and the apps as well, so they find the token
and the certificate. For details, see the server's `packages/server/README.md`
file.

### Open the apps in a browser

The server also serves the two apps' pages at
`https://127.0.0.1:21400/boxes/` and `https://127.0.0.1:21400/review/`. A
browser doesn't know the server's self-signed certificate, so trust it once
before you open them:

- **Chrome or Chromium on Linux:** install the `libnss3-tools` package, then
  add the certificate to your NSS database as a trusted server certificate:

  ```sh
  certutil -d sql:"$HOME/.pki/nssdb" -A -t "P,," -n "AI Orchestrator server" \
    -i ~/.ai-orchestrator/server.crt
  ```

  Restart the browser.

- **Firefox:** open `https://127.0.0.1:21400/boxes/`, click **Advanced**, and
  check that the certificate's SHA-256 fingerprint matches the output of the
  following command before you click **Accept the Risk and Continue**:

  ```sh
  openssl x509 -in ~/.ai-orchestrator/server.crt -noout -fingerprint -sha256
  ```

To sign the page in, open it once with the token in the address's fragment,
`https://127.0.0.1:21400/boxes/#token=TOKEN`, where `TOKEN` is the content of
`~/.ai-orchestrator/server.token`. The page trades the token for a session
cookie and removes it from the address bar.

When the server replaces its certificate, trust the new one the same way.
In Chrome, first remove the old entry with
`certutil -d sql:"$HOME/.pki/nssdb" -D -n "AI Orchestrator server"`.

## Build the container image

Every project runs in one container from the `aio-agent` image. The image
carries the toolchain, the Claude Code, Codex, and GitHub Copilot CLIs at the
versions pinned in `image/versions.env`, and the AI Orchestrator engine.

To build the image, open **AI Orchestrator** from your applications menu. The setup
wizard checks Docker, the image, the engine version, SSH, 1Password, `sudo`
in containers, and the server, and offers **Build image** when the image is
missing.

The image gives the container user no passwordless `sudo`. Unless you set a
sudo password reference in the setup wizard, `sudo` is off in every
container. See [The sudo password](secrets.md#the-sudo-password).

To build the image from a terminal instead, run the script that ships with
the package:

```sh
/usr/share/ai-orchestrator/scripts/build-image.sh
```

The script builds the image with your user name, so file ownership in the
bind mounts matches your host user. The first build takes several minutes.

To build a test image without retagging the image that running boxes launch
from, set the `IMAGE_TAG` environment variable. The `--tag` option overrides
it.

```sh
IMAGE_TAG=aio-agent:v4test /usr/share/ai-orchestrator/scripts/build-image.sh
```

The server refuses to start a container whose engine version differs from
its own, and offers a rebuild. The package upgrade rebuilds the
image.

The engine version includes a content hash of the built engine, as in
`1.0.0-dev+0123456789ab`. A rebuild after any engine change therefore changes
the version, and an image built from older engine code reads as stale although
the package version stays the same.

The build uses the agent CLI versions pinned in `image/versions.env`. To
update Claude Code, Codex, and Copilot, run the script with `--update-cli`.
The script resolves the latest versions from npm, writes them to
`image/versions.env`, and builds with them. When that file isn't writable, as
in the installed package, the build still uses the new versions and the script
tells you it couldn't save them.

```sh
/usr/share/ai-orchestrator/scripts/build-image.sh --update-cli
```

## Sign in to the other CLIs

Every container mounts your host's `~/.codex` and `~/.copilot` directories,
so one sign-in on the host serves every box. To use Codex or Copilot as a
box's platform or as a reviewer, sign in to each on the host. Until you do,
the review pipeline uses only the vendors that are signed in.

## Add machines to a hub

One install manages the boxes on its own machine. To manage boxes on
several Linux machines from one place, make one machine the hub and join
the others to it as nodes. Install the package and start the server on each
machine as this page describes, then do the following:

1. On the hub, open AI Orchestrator, open the **Machines** tab
   (Ctrl+Shift+M), and click **Add Machine**, or run the following command:

   ```sh
   aio machines enroll
   ```

   The first code starts the hub's link listener on TCP port `21402`, on the
   hub's LAN address. The package doesn't open the port. If the hub runs
   `ufw`, allow your LAN through the package's `aio-hub` application
   profile, where `LAN_CIDR` is your LAN's range, such as `192.0.2.0/24`:

   ```sh
   sudo ufw allow from LAN_CIDR to any app aio-hub

   ```

1. On the machine to add, open the setup wizard, choose **Node: join a hub
   with an enrollment code**, paste the `aio node join` command from the hub
   into **Hub URL**, enter the code, and click **Done**. Or run that command in
   a terminal, and enter the code when the command asks for it.

For the roles, the firewall rules, and what crosses the link, see
[Multi-host](multi-host.md).

## Upgrade

Install the new package with `sudo apt install ./ai-orchestrator_VERSION_amd64.deb`.
For every user with `aio-server` enabled, the package records open work,
restarts the server, builds the image with the latest agent CLIs (falling
back to pins if needed), recreates project containers, and reopens boxes
and review runs. Running work stops immediately. Progress and a per-item
summary appear in the terminal; the wait is limited to about five minutes.
One previous image is retained for rollback.

A failed configure step can be retried with `sudo dpkg --configure -a`.
Desktop apps show a relaunch bar when their installed version is newer.
Remote machines must be upgraded separately.

From a checkout, run `scripts/upgrade.sh`. It builds the workspace and the
`.deb`, migrates the former checkout service to the installed command, and
installs the package with `sudo apt install --reinstall`. It builds the revision you checked out;
it never runs `git pull`. The server runs from the installed package.

## Uninstall

1. Stop and disable the service:

   ```sh
   systemctl --user disable --now aio-server
   ```

1. Remove the package:

   ```sh
   sudo apt remove ai-orchestrator
   ```

Your data in `~/.ai-orchestrator`, your transcripts in `~/.claude`, and the
`aio-agent` image stay in place.

## Build from source

To build the package from a checkout, you need Node.js 22, pnpm through
corepack, nfpm, and `dpkg-deb`. The two apps list electron-builder as a dev
dependency, so `pnpm install` provides it and you install nothing else for it.
The first build downloads the Electron binary, so it needs network access.

1. Install `dpkg-deb`, which the `dpkg-dev` package provides on Debian and
   Ubuntu:

   ```sh
   sudo apt-get install dpkg-dev
   ```

1. Install nfpm. Debian and Ubuntu don't package it, so download the release
   that the CI workflow uses, check its checksum, and put the binary on your
   `PATH`. The `NFPM_SHA256` value is in `.github/workflows/ci.yml`; copy it
   from there when you change the version:

   ```sh
   NFPM_VERSION=2.48.0
   NFPM_SHA256=6d7f9a28b2f397934403950fcbba83f598b08d02edbe79a0815b3b4897341750
   cd "$(mktemp -d)"
   curl -fsSL -o nfpm.tar.gz \
     "https://github.com/goreleaser/nfpm/releases/download/v${NFPM_VERSION}/nfpm_${NFPM_VERSION}_Linux_x86_64.tar.gz"
   echo "$NFPM_SHA256  nfpm.tar.gz" | sha256sum -c -
   mkdir -p ~/.local/bin
   tar -xzf nfpm.tar.gz -C ~/.local/bin nfpm
   nfpm --version
   ```

   Make sure `~/.local/bin` is on your `PATH`.

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
   missing. It writes `dist/ai-orchestrator_VERSION_amd64.deb` and packs the engine,
   with its dependencies at the versions in `pnpm-lock.yaml`, into
   `image/dist/`.

1. Optional: Build the image from the checkout:

   ```sh
   scripts/build-image.sh
   ```

### Use the installed server while developing

Run `scripts/upgrade.sh` to build and install the checked-out revision.
The live server uses `/usr/bin/aio-server` from the package, so rebuilding
the checkout cannot change the running server's files.

To migrate an existing checkout service, after installing the package run:

```sh
scripts/install-server-unit.sh
systemctl --user restart aio-server
```

The migration replaces the checkout's Node.js command with `/usr/bin/aio-server`,
preserving custom arguments such as `--data-dir`, `--role`, and `--log-file`.
A service with no custom arguments uses the packaged unit. It removes
`aio-server.service.d/source-checkout.conf`, reloads systemd, and enables the
service. Other drop-ins, including credentials, remain. Package upgrades
perform this migration automatically and use the same custom data directory
for recording and restoring open work. Use `--print` to inspect the paths
first. Inspect the resulting unit
with `systemctl --user cat aio-server`.

### Run the Electron apps from the checkout

On Ubuntu 24.04 and later, the boxes and review apps don't start from a
checkout: the kernel restricts the unprivileged user namespaces that
Chromium's sandbox needs, and the `chrome-sandbox` helper that pnpm installs
isn't owned by root with mode 4755. The package solves this with AppArmor
profiles. To install the same profiles for the Electron binary in your
checkout's `node_modules` directory, run the
`scripts/install-dev-apparmor.sh` script:

```sh
scripts/install-dev-apparmor.sh
```

The script first runs `scripts/ensure-electron.sh`, which downloads a missing
Electron binary. It then resolves the real path of each app's Electron binary in the pnpm
store, builds a profile for it from the templates in
`packaging/deb/apparmor/`, and runs `sudo` to write the profile to
`/etc/apparmor.d/` and load it. Both apps usually share one binary, and
then they share one profile. Each profile is named `aio-dev-HASH`,
where `HASH` is taken from the binary's path, and carries a comment that
names the checkout. Checkouts and worktrees that share a pnpm store share
the binary, so its profile names each of them.

- To see the profiles without loading them, run
  `scripts/install-dev-apparmor.sh --print`.
- To unload and delete the profiles for this checkout, run
  `scripts/install-dev-apparmor.sh --remove`. A profile that another
  checkout still names stays loaded, without this checkout's comment.

The profiles attach to paths in the pnpm store, which your user can write
to, so any program that your user puts at those paths can create user
namespaces. Electron's download can extract `dist/electron` and
`dist/chrome-sandbox` with mode 0777, which would let any local user replace
the binary. The `scripts/ensure-electron.sh` script removes group and other
write permission from `dist/`, and the profile script runs it. If you
download Electron another way, run `chmod -R go-w` on the `dist/` directory
before you load the profile.

A profile keeps working when `pnpm install` reinstalls the same Electron
version, because the binary's path in the store doesn't change. When pnpm
installs a different Electron version, run the script again. It replaces
the profiles that it wrote for this checkout.

The alternative is to make the helper setuid root with
`sudo chown root:root PATH` and `sudo chmod 4755 PATH`, where `PATH` is the
`dist/chrome-sandbox` file next to the Electron binary. Every reinstall of
the Electron package undoes that change, so you have to repeat it.

### Release scripts

The `scripts/` directory holds the following release tools:

- `scripts/set-version.sh VERSION`: sets `VERSION` in every workspace
  `package.json` file and in the `AIO_ENGINE_VERSION` pin. CI runs
  `scripts/set-version.sh --check` and fails when they disagree.
- `scripts/bump-versions.sh`: refreshes the Claude Code, Codex, Copilot, and
  nvm pins in `image/versions.env`. With `--base`, it also moves the base
  image digest in `image/Dockerfile`.
- `scripts/build-image.sh --update-cli`: resolves the latest CLI versions from
  npm, writes them to `image/versions.env`, and builds the image with them.
  Without the option, the build uses the pinned versions.
- `scripts/build-image.sh --print`: prints the `docker build` command
  without running it.

To release, set the version, commit, and push a `vVERSION` tag. The release
workflow builds the `.deb`, checks that the tag matches the version, and
attaches the package and the engine tarball to a GitHub release. The image
isn't pushed to a registry.
