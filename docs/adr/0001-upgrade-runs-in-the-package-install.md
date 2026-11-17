# The package install performs the whole upgrade

Status: accepted

An upgrade used to need several manual steps after installing the package:
restart the server, rebuild the image, remove old project containers, and
reopen boxes and apps. The `.deb` install now does all of it: it rebuilds the
image with the latest agent CLIs, restarts the server, recreates every project
container, and brings back the boxes and runs that were open. It stops
running work at once instead of waiting for it, the way other packages
restart their services. When `apt` finishes, everything is running again.

## Considered options

- **Drain:** keep busy containers on the old image and recreate each one when
  it goes idle. Rejected: an upgrade then has no clear end, old and new
  engines run side by side, and a box left open keeps the old version
  indefinitely.
- **Ask in the app:** list the busy containers and offer a restart button.
  Rejected: it leaves the upgrade half done until someone clicks.
- **Server startup check only:** let the restarted server rebuild the image on
  its own. Kept as the path for Mac, Windows, and servers started some other
  way, but not for the `.deb`, where the install can report progress and
  failure in the terminal.

## Consequences

- Stopping work is safe only because it comes back. Saved run state carries a
  version, and the engine keeps a forward-only list of adaptations, each with
  a saved example in the tests, so a run from any older version resumes.
  Box records use the server's database migrations.
- A downgrade can't read state that a newer version saved. Those runs stay
  stopped with a notice until the newer version is installed again.
- The install runs the build as each user who has `aio-server` enabled, not
  as root, so images keep that user's name and ID.
- A failed upgrade fails the package's configure step, and
  `sudo dpkg --configure -a` retries it.
