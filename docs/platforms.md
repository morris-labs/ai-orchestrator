# macOS and Windows

This page describes how AI Orchestrator runs on macOS and Windows, what
differs from Linux, and what still needs testing on those hosts. Linux on
x86-64, from the `.deb` package, is the supported and tested platform. The
macOS and Windows support on this page is built and unit-tested on Linux,
but nobody has run it on a Mac or a Windows PC yet.

## Support status

The following table summarizes each part on each host:

| Part | Linux | macOS | Windows |
|---|---|---|---|
| Server service | systemd user unit | launchd LaunchAgent | Task Scheduler logon task |
| Package | `.deb` with system Node.js 22 | dmg and zip, Node.js bundled | Per-user NSIS installer, Node.js bundled |
| Docker | Docker Engine socket | Docker Desktop, Colima, OrbStack, or Rancher Desktop socket | Docker Desktop named pipe, WSL 2 backend |
| Image build | `build-image.sh` | `build-image.sh` with the system bash 3.2 | `build-image.sh` under Git for Windows' bash |
| Secrets broker | Unix socket | TCP (other branch) | TCP (other branch) |
| Host paths in containers | Same path | Same path | Mapped (other branch) |
| Multi-host hub or node | Yes | Untested | Untested |
| Tested on the host | Yes | No | No |

## How AI Orchestrator runs on each host

The following sections describe the parts that differ between hosts.

### Data and configuration directories

The data directory is `~/.ai-orchestrator` on every host
(`C:\Users\NAME\.ai-orchestrator` on Windows, where `NAME` is your account
name). It stays in the home directory, rather than in `~/Library/Application
Support` or `%LOCALAPPDATA%`, for these reasons:

- The CLI, both apps, and the server find it with one rule, and
  `AIO_DATA_DIR` and `--data-dir` work the same way everywhere.
- Containers bind-mount folders inside it. Docker Desktop shares the home
  directory by default, and a path without spaces avoids quoting problems
  in mount specifications.
- The Claude transcript store must sit at the same path inside a container
  as on the host, and a short path keeps that mapping simple.

The configuration directory holds files that you write and the server only
reads, such as `op.env`:

- Linux: `~/.config/aio`, or `$XDG_CONFIG_HOME/aio`.
- macOS: `~/.config/aio`, as `op` and `gh` use on macOS.
- Windows: `%APPDATA%\aio`.

### The server service

The `aio-server install-service` command writes the service for your host,
then enables and starts it. Every service runs the server as you, with your
home directory, your Docker access, and your 1Password sign-in.

- **Linux**: the `~/.config/systemd/user/aio-server.service` unit, as
  before.
- **macOS**: the `~/Library/LaunchAgents/dev.aio.server.plist` agent,
  loaded with `launchctl bootstrap gui/UID`. It starts at login, restarts
  the server 5 seconds after it exits with an error, keeps the umask 077 of
  the systemd unit, and logs to `~/Library/Logs/aio-server.log`. Its `PATH`
  adds Homebrew, `/usr/local/bin`, and Docker Desktop's `bin` folder, since
  launchd starts agents with only the system folders.
- **Windows**: the `aio-server` task in the Task Scheduler library root,
  which starts the server at your logon and again every 5 minutes. A start
  while the server runs is ignored, so a server that exited comes back
  within 5 minutes. The task has no time limit, keeps running on battery,
  and runs without elevation. It runs `aio-serverw.exe`, a copy of Node.js
  without a console window, and the server appends its log to
  `~\.ai-orchestrator\server.log` (`--log-file`).

A Windows service isn't used, because a service runs in session 0 as
LocalSystem or as an account whose password Windows stores. The server
needs your profile, your membership in the `docker-users` group, and your
1Password CLI sign-in. A logon task with your own token has all three, and
you can create it without administrator rights. A Startup folder shortcut
or a `Run` registry value also needs no rights, but neither restarts a
server that exits.

The following table lists the commands that manage the service on each
host:

| Task | Linux | macOS | Windows (PowerShell) |
|---|---|---|---|
| Check that it runs | `systemctl --user status aio-server` | `launchctl print gui/$(id -u)/dev.aio.server` | `schtasks /Query /TN aio-server /V /FO LIST` |
| Read the log | `journalctl --user -u aio-server -n 100` | `tail -n 100 ~/Library/Logs/aio-server.log` | `Get-Content ~\.ai-orchestrator\server.log -Tail 100` |
| Restart | `systemctl --user restart aio-server` | `launchctl kickstart -k gui/$(id -u)/dev.aio.server` | `schtasks /End /TN aio-server; schtasks /Run /TN aio-server` |
| Stop until the next login | `systemctl --user stop aio-server` | `launchctl bootout gui/$(id -u)/dev.aio.server` | `schtasks /End /TN aio-server` |
| Remove | `systemctl --user disable --now aio-server` | `launchctl bootout gui/$(id -u)/dev.aio.server`, then delete the plist file | `schtasks /Delete /TN aio-server /F` |

### 1Password service account token

On Linux, the systemd unit loads `~/.config/aio/op.env` with
`EnvironmentFile=`. launchd and Task Scheduler have no such setting, so on
macOS and Windows the server reads `op.env` in the configuration directory
itself when it starts. It takes only `OP_*` variables, such as
`OP_SERVICE_ACCOUNT_TOKEN`, that its environment doesn't set already.
Protect the file: on macOS run `chmod 600 ~/.config/aio/op.env`; on Windows
the file inherits your profile's access control list.

For more information about the token, see [Secrets](secrets.md).

### Docker

On Linux and whenever `DOCKER_HOST` is set, the server uses dockerode's
default endpoint. On Windows it uses the Docker Desktop pipe,
`//./pipe/docker_engine`. On macOS it uses the first of these sockets that
exists:

1. `/var/run/docker.sock`, which Docker Desktop creates when **Allow the
   default Docker socket to be used** is on.
1. `~/.docker/run/docker.sock` (Docker Desktop).
1. `~/.colima/default/docker.sock` (Colima).
1. `~/.orbstack/run/docker.sock` (OrbStack).
1. `~/.rd/docker.sock` (Rancher Desktop).

The server doesn't read Docker contexts. To use another endpoint, set
`DOCKER_HOST` for the service.

### The container user

Every container runs as one user, which the image build creates. On Linux
that user is your account name, as before. On macOS and Windows the server
lowercases your account name, and when the result isn't a valid Linux user
name, such as a Windows name with a space, it uses `user`. The server
passes the same name to `build-image.sh --user`, so the image build and the
containers always agree.

### Image build

The setup wizard runs `scripts/build-image.sh`. The script runs with the
macOS system bash 3.2 and its BSD tools. On Windows the server runs it with
Git for Windows' `bash.exe` from `C:\Program Files\Git` or your user's
`AppData\Local\Programs\Git`. To use another bash, set `AIO_BASH` for the
server. Without one, the image build fails with a message that says so.

### The apps

The following changes apply to the Boxes and Review apps on macOS and
Windows:

- The `--class` switch, `gsettings`, and AppArmor apply only on Linux.
  `chrome-sandbox` and its setuid bit exist only in the Linux package.
- On macOS the Boxes app has the standard app, Edit, and Window menus,
  because Command+C, Command+V, and Command+Q need them, and clicking the
  Dock icon shows its window.
- On Windows each app sets its AppUserModelID to its `appId`, so
  notifications belong to the Start menu shortcut.
- External terminals open in Terminal.app on macOS. On Windows they open
  the `aio` CLI in Windows Terminal, or in a console window when Windows
  Terminal isn't installed.
- The Boxes app starts the Review app through its `aio-review://` link on
  macOS and Windows.
- The open-path guard accepts Windows drive paths, such as `C:\src\app`,
  and refuses UNC paths.

### Multi-host

A hub on any host listens for node links on TCP port `21402`; for the
roles and the enrollment steps, see [Multi-host](multi-host.md). No package
opens the port in a firewall:

- **Linux**: the `.deb` package changes no firewall. Allow the port with
  `ufw` or your firewall's own tool, as
  [Multi-host](multi-host.md#open-the-link-port-in-a-firewall) describes.
- **macOS**: when the application firewall is on, macOS asks the first time
  the hub listens whether the bundled `node` may accept incoming
  connections. Allow it.
- **Windows**: Windows Defender Firewall asks the first time the hub
  listens whether `aio-serverw.exe` may communicate on your networks.
  Allowing it needs administrator rights, because the per-user installer
  runs without them. Allow private networks only.

A node dials out to the hub, so it needs no inbound rule on any host. A
node on macOS or Windows also needs the secrets broker's TCP transport and
the host path mapping from the table, which other branches carry.

### Packages

The macOS and Windows packages bundle Node.js 22 instead of requiring it,
for these reasons:

- macOS ships no Node.js, and few Windows PCs have Node.js 22.
- The server's SQLite module is compiled for one Node.js major version.
- launchd and Task Scheduler start the server with a minimal `PATH`, so the
  service needs an absolute program path that an app update keeps stable.

The Boxes app carries the runtime in its resources folder:
`AI Orchestrator.app/Contents/Resources/runtime` on macOS and
`resources\runtime` in the install folder on Windows. The runtime holds
Node.js, the server, the CLI, the image build context, and the web bundles.
Its `bin` folder holds the `aio` and `aio-server` launchers (`aio.cmd` and
`aio-server.cmd` on Windows).

To build the packages, run `scripts/build-mac.sh` on a Mac, or
`scripts\build-win.ps1` on Windows. Each one builds for its own host's
architecture, because the SQLite module is built on the machine that runs
`pnpm install`. Both run `scripts/stage-runtime.mjs`, which downloads the
Node.js release in `packaging/runtime/node-version` and checks it against
the release's `SHASUMS256.txt` file.

## Install on macOS or Windows

These steps aren't tested on either host yet.

1. Install Docker Desktop, start it, and sign in to Claude Code on the
   host.
1. Install the AI Orchestrator and AI Orchestrator Review apps. On macOS,
   drag both into the `/Applications` folder before you open them: macOS
   runs an app from a dmg or the Downloads folder at a random path, and the
   service would record that path.
1. Install the service with the bundled server:

   - macOS:

     ```sh
     "/Applications/AI Orchestrator.app/Contents/Resources/runtime/bin/aio-server" install-service
     ```

   - Windows (PowerShell):

     ```powershell
     & "INSTALL_DIR\resources\runtime\bin\aio-server.cmd" install-service
     ```

     Replace `INSTALL_DIR` with the folder the installer installed AI
     Orchestrator in. The installer shows it, and the default is under
     `%LOCALAPPDATA%\Programs`.

1. Open AI Orchestrator. The setup wizard builds the container image.
1. Optional: To run `aio` from a terminal, add the runtime's `bin` folder to
   your `PATH`, or on macOS link the launcher into a folder on your `PATH`:

   ```sh
   ln -s "/Applications/AI Orchestrator.app/Contents/Resources/runtime/bin/aio" /usr/local/bin/aio
   ```

## Linux assumptions in the code

The following list is the full needs analysis: every place where the code
assumed Linux, and how it's handled. Items marked *other branch* belong to
the `claude/win-paths` or `claude/docker-desktop-broker` work.

- **Data directory and `~`**: `~/.ai-orchestrator` and `os.homedir()` work
  on all three hosts. The server's `~/` expansion in folder pickers and the
  3.x import is POSIX-only (*other branch*: `claude/win-paths`).
- **Host and container paths**: the server mounts projects, the transcript
  store, and the data directory at the same path inside containers. A
  Windows path can't be a container path (*other branch*:
  `claude/win-paths`, which maps `C:\...` to a container path).
- **Transcript store encoding**: Claude Code encodes the container's working
  directory, not the host path (*other branch*: `claude/win-paths`).
- **systemd**: the only service manager. Handled: launchd and Task
  Scheduler behind `aio-server install-service`.
- **AppArmor and `chrome-sandbox`**: Linux packaging only. Handled: no
  macOS or Windows code path touches them.
- **File modes**: `0600` keys, `0700` directories, and the setup wizard's
  `~/.ssh` mode check. macOS has POSIX modes. Windows reports every file as
  `666` or `444`, so the `chmod` calls do nothing harmful there, and the
  setup wizard skips the `~/.ssh` check and fix. The token and key files
  rely on the profile's access control list.
- **Unix sockets the server opens**: the secrets broker listens on a Unix
  socket that containers mount. Docker Desktop can't pass a host Unix
  socket into a Linux container (*other branch*:
  `claude/docker-desktop-broker`, which adds the `brokerTransport` setting,
  where `auto` picks TCP on macOS and Windows). Handled here: the socket
  path limit is 103 bytes on macOS and 107 on Linux and Windows.
- **Signals**: Windows delivers no `SIGTERM`. Handled: the server also
  stops on `SIGBREAK`. Task Scheduler's **End** command terminates the
  process without a signal, so a Windows server doesn't close its database
  cleanly when the task ends.
- **The `op` CLI**: found on `PATH`. The launchd agent's `PATH` includes
  Homebrew's folders, and the Windows task inherits your `PATH`. The token
  file is handled through `op.env`.
- **Docker endpoint**: handled, as described in [Docker](#docker).
- **Host programs the server runs**: `git`, `ssh`, `ssh-keygen`,
  `ssh-copy-id`, `op`, `script`, `bash`, and `systemctl`. `tmux` runs only
  inside containers. Handled: `script` takes BSD syntax on macOS and isn't
  used on Windows; `bash` comes from Git for Windows; every child process
  gets `windowsHide`, so a windowless server opens no console windows.
  Windows has no `ssh-copy-id`, so copying a key to an SSH remote fails
  there.
- **Pseudo-terminals on the host**: the server uses `script(1)`, not
  node-pty. Windows jobs run without a terminal, so `docker build` output
  isn't line-buffered and password prompts don't work.
- **Git hooks**: host `git` calls set `core.hooksPath=/dev/null`. Handled:
  `NUL` on Windows.
- **Container user name**: handled, as described in
  [The container user](#the-container-user).
- **Path separators**: the server's own paths use `path`. Paths stored in
  records and compared as strings assume `/` (*other branch*:
  `claude/win-paths`).
- **Line endings**: the server writes LF files. The Windows task
  definition uses CRLF and UTF-16, and the `.cmd` launchers use CRLF. Git
  for Windows' `core.autocrlf` can rewrite the keeper scripts in a checkout
  to CRLF, which breaks them in the container; build Windows packages from a
  checkout with `core.autocrlf=false`.
- **Case-insensitive file systems**: macOS (APFS, by default) and Windows
  compare paths without regard to case. Project roots and box records
  compare paths as exact strings, so `~/Src/app` and `~/src/app` count as
  two projects. The Windows open-path guard ignores case.
- **Symbolic links**: account folders and `~/.claude/projects` link to the
  transcript store. Windows creates symbolic links only with Developer Mode
  on or with administrator rights; junctions would work for folders. Not
  handled yet.
- **`xdg-open`**: the apps use Electron's `shell.openPath` and
  `shell.openExternal`, which work on all three. The server's
  `openerArgv` helper names `open` and `explorer.exe` for code that needs
  one.
- **Notifications**: Electron's `Notification` works on all three. The
  `urgency` option affects only Linux.
- **Tray icons**: both apps draw their tray icons as bitmaps. They work on
  macOS and Windows but aren't template images, so the macOS menu bar
  doesn't recolor them for dark mode.
- **Auto-start of the apps**: no app starts at login on any host; only the
  server does.
- **Window class and desktop entries**: Linux only. Handled.
- **Installed-package paths**: `/usr/share/ai-orchestrator` holds the image
  context and web bundles. Handled: the server also looks in `share/`
  beside a bundled server.

## Not yet tested

None of the following ran on a real Mac or Windows PC:

- `launchctl bootstrap` of the generated plist, and the restart behavior.
- `schtasks /Create /XML` with the generated task, as a standard user, and
  the 5-minute restart.
- `aio-serverw.exe` starting without a console, and the server writing to
  its log file without one.
- The dmg, zip, and NSIS builds. electron-builder produced the macOS and
  Windows app folders on Linux, without signing or the Windows icon and
  version resources, to check the layout.
- `scripts/build-mac.sh` and `scripts/build-win.ps1` beyond their dry runs.
  PowerShell wasn't available to parse the second one.
- The bundled runtime. On Linux, a staged Linux runtime ran `aio --help`
  and `aio-server --help`, loaded the SQLite module, and found its image
  context and web bundles.
- Docker socket discovery against Docker Desktop, Colima, and OrbStack.
- `build-image.sh` under macOS bash 3.2 and bsdtar, and under Git for
  Windows. It ran on Linux.
- Terminal.app and Windows Terminal launches, and the `aio-review://` link.
- `core.hooksPath=NUL` with Git for Windows.
- A hub or a node on either host, and the firewall prompts for the link
  port.

## Signing and notarization

Signing isn't set up. Until it is, the following applies:

- macOS: `scripts/build-mac.sh` builds ad hoc signed apps when `CSC_LINK`
  or `CSC_NAME` isn't set. Gatekeeper refuses them on another Mac. To sign,
  set those variables to a Developer ID Application certificate; to
  notarize, add `notarize` settings and an App Store Connect API key. The
  hardened runtime entitlements are in `packaging/mac/entitlements.plist`.
  The bundled `node` binary must be signed with the app's identity too.
- Windows: the installers and `aio-serverw.exe` are unsigned, and
  SmartScreen warns. Changing the PE subsystem of `node.exe` removes the
  Node.js project's signature from the copy, so the copy needs the app's
  own signature. Set `CSC_LINK` or `WIN_CSC_LINK` to a code signing
  certificate.
- The staging script checks Node.js against `SHASUMS256.txt`, but doesn't
  verify that file's signature yet.

## Work that depends on other branches

- `claude/win-paths`: host path to container path mapping on Windows, for
  mounts, working directories, and transcripts.
- `claude/docker-desktop-broker`: the secrets broker over TCP (the
  `brokerTransport` setting) and other Docker Desktop container issues.
