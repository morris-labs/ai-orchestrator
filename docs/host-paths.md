# Host paths in containers

Each box runs in a Linux container. The server mounts your project folders
into that container, and the agent, the engine, and Claude Code see them at
a *container path*. This page describes how a host path becomes a container
path on Linux, macOS, and Windows, and what that means for transcripts,
worktrees, and mounts.

Server support for macOS and Windows hosts is in progress. The path mapping
on this page is in place, but it hasn't been tested on a real macOS or
Windows host. For the parts that are known to be incomplete, see
[Known limitations on Windows](#known-limitations-on-windows).

## The mapping

The following table shows how the server maps a host path to a container
path:

| Host OS | Host path | Container path |
|---|---|---|
| Linux | `/home/dana/src/app` | `/home/dana/src/app` |
| macOS | `/Users/dana/src/app` | `/Users/dana/src/app` |
| Windows | `C:\Users\dana\src\app` | `/mnt/host/c/Users/dana/src/app` |

On Linux and macOS, the container path is the host path itself, cleaned of
repeated slashes, `.` and `..` segments, and a trailing slash.

On Windows, the server mounts each drive's folders under `/mnt/host/DRIVE`,
where `DRIVE` is the drive letter in lowercase. Backslashes become forward
slashes, and the rest of the path keeps its case. A path with spaces maps
the same way, spaces included. The `/mnt/host` prefix is distinct from the
WSL `/mnt/c` mounts, so a box's mounts never read as WSL paths.

The mapping applies everywhere a host path reaches a container:

- The bind mounts of the project root, the account folders, the transcript
  store, and project and global mounts.
- The container's working directory and each box's session working
  directory, including terminals and the external attach command.
- The paths in the opening prompts: the workspace or worktree, the notes
  folder, the `INFRA.md` file, and the primary repository.
- The `--add-dir` folder, folder trust entries, the `GIT_CONFIG_GLOBAL`
  file, and the engine's project root.
- The repository path that the CLI and the Review app send for a review.

The box view in the API carries the box's container working directory in
its `containerWorkDir` field.

## Transcripts

Claude Code names each transcript folder after the working directory it
sees, with every character other than an ASCII letter or digit replaced by
`-`. Claude Code runs in the container, so the name comes from the
container path. On Windows, a box that works in `C:\Users\dana\src\app` keeps
its transcripts in the `-mnt-host-c-Users-dana-src-app` folder of the
transcript store. The server looks up transcripts with the same rule.

When the encoded name is longer than 200 characters, Claude Code cuts it to
200 characters and appends a hyphen and the base-36 hash of the unencoded
path. The server applies the same cap and hash.

## Project roots on Windows

The server stores a Windows project root with an uppercase drive letter and
forward slashes, such as `C:/Users/dana/src/app`. You can type the folder as
`c:\Users\dana\src\app\`, and the server finds the same project. A `\\?\`
prefix is removed.

Only the drive letter is case-insensitive. Windows treats
`C:\Users\Dana\Src\App` and `C:\Users\dana\src\app` as one folder, but the
server sees two projects. Type a project folder with the same case each
time.

## Mounts

A mount is written `HOST[:CONTAINER]`. On Windows, the colon of the drive
letter belongs to the host path, so `D:\data:/data` mounts `D:\data` at
`/data`. When you leave out the container path, the mount uses the host
path's container path: `D:\data` alone mounts at `/mnt/host/d/data`.

The server refuses a UNC network path, such as `\\fileserver\share\data`,
for a project root or a mount. To use a network share, map it to a drive
letter, or copy the folder to a local drive.

## Worktrees on Windows

Git writes the path of the main repository into each worktree's `.git` file.
An absolute Windows path, such as `C:/Users/dana/src/app/.git/worktrees/fix`,
means nothing in the container. On Windows, the server creates worktrees
with `git worktree add --relative-paths`, so the link is relative and
resolves on both sides. This option needs Git 2.48 or later on the host;
the image's Git is newer. With an older Git, creating a worktree box fails
with a message that names the version.

A worktree that an older Git created, or that you created yourself without
the option, keeps absolute paths and doesn't work in the container. To fix
it, run `git worktree repair --relative-paths` in the main repository.

## macOS file sharing

Docker Desktop shares `/Users`, `/Volumes`, `/private`, `/tmp`, and
`/var/folders` with containers by default. To use a project or a mount
outside those folders, add its folder in Docker Desktop under
**Settings > Resources > File sharing**.

## Known limitations on Windows

The following parts of a Windows host are untested or incomplete:

- **Symbolic links.** The container reads a symbolic link's target
  literally. A link whose target is a Windows path, such as an account's
  `projects` link to the transcript store, or the `~/.claude/projects` link
  in host mode, dangles in the container even though the server mounts the
  target at its container path.
- **Bind strings.** The server passes Windows bind sources such as
  `C:/Users/dana/src/app` to Docker Desktop, which translates them. If
  Docker reports binds back in another form, a running container can show as
  stale until it restarts.
- **The secrets broker.** The broker listens on a Unix socket, which Docker
  Desktop can't share with a container from a Windows host.
- **Host Git.** Host Git calls set `core.hooksPath` to `NUL` on Windows and
  to `/dev/null` elsewhere.
