# Multi-host

AI Orchestrator can manage boxes on several machines. One machine runs the
*hub*: the machine registry, the certificate authority, and the link that
every other machine keeps open to it. Each other machine runs a *node*,
which owns its own Docker, containers, transcripts, and accounts. The apps
and the CLI on any machine talk only to the server on that machine.

This page describes roles, how to set up a hub and add a machine to it,
review runs on other machines, the hub's link port, and what crosses the
link.

## Roles

Every `aio-server` has one of the following roles:

| Role | Does | Use it on |
|---|---|---|
| `both` | Runs boxes and can act as a hub. The default, which behaves like a single machine until you issue an enrollment code. | A single machine, or the machine that hosts the hub |
| `hub` | Acts as a hub and never joins another hub. | An always-on machine that serves only as the hub |
| `node` | Runs boxes and links to a hub. | Every other machine |

The server stores the role in its settings. To change it for one run, start
the server with `--role ROLE` or set `AIO_ROLE=ROLE`, where `ROLE` is `hub`,
`node`, or `both`. A machine that joins a hub stores the `node` role.

To see a machine's role and its link, run the following command:

```bash
aio node status
```

## Set up a hub

Multi-host is tested on Linux machines. For macOS and Windows, see
[macOS and Windows](platforms.md#multi-host).

To set up the hub, do the following on the machine that hosts it:

1.  Install the package and start the server, as
    [Install AI Orchestrator](install.md) describes. Run the setup wizard
    and keep **Single machine** selected. A single machine has the role
    `both`, so it runs its own boxes and acts as the hub.

1.  Optional: To make the machine a hub only, with no boxes of its own,
    store the role `hub`:

    ```bash
    curl --cacert ~/.ai-orchestrator/server.crt \
        -H "Authorization: Bearer $(cat ~/.ai-orchestrator/server.token)" \
        -H "Content-Type: application/json" \
        -X PATCH -d '{"role": "hub"}' \
        https://127.0.0.1:21400/api/v1/settings
    systemctl --user restart aio-server

    ```

    A role change in the settings applies at the next server start. To pin
    the role in the service instead, run `systemctl --user edit aio-server`,
    add the following lines, and restart the server:

    ```ini
    [Service]
    Environment=AIO_ROLE=hub
    ```

1.  If nodes reach the hub by another name than its host name, such as a
    Tailscale name, set the `linkAddress` setting. For more information,
    see [Add a machine to a hub](#add-a-machine-to-a-hub).

1.  If the hub runs a firewall, allow the link port. For more information,
    see [Open the link port in a firewall](#open-the-link-port-in-a-firewall).

## Add a machine to a hub

To add a machine, issue a one-time code on the hub and use it on the
machine:

1.  On the hub, issue an enrollment code. In AI Orchestrator, open the
    **Machines** tab (Ctrl+Shift+M) and click **Add Machine**, or run the
    following command:

    ```bash
    aio machines enroll
    ```

    The output is similar to the following:

    ```
    Enrollment code: 7K2Q-M9XD-4HPA-R3TB
    It works once, until 2026-11-01T10:10:00.000Z. On the machine to add, run:

      aio node join https://hub.example.com:21402 7K2Q-M9XD-4HPA-R3TB
    ```

    The code works once and expires after 10 minutes. Issuing the first code
    creates the hub's certificate authority and starts the link listener.

1.  On the machine to add, install the package and start the server, as
    [Install AI Orchestrator](install.md) describes. Then join the hub in
    one of the following ways:

    - In the setup wizard, choose **Node: join a hub with an enrollment
      code**. Paste the `aio node join` command from the hub into **Hub
      URL**, which fills in **Enrollment code** too. Optionally, enter a
      **Machine name**, then click **Done**.
    - In a terminal, run the following command:

      ```bash
      aio node join HUB_URL CODE --name NAME

      ```

    Replace the following:

    - `HUB_URL`: the hub URL from the enrollment code
    - `CODE`: the enrollment code
    - `NAME`: the name the machine shows under, such as `build-server`.
      Optional; the default is the machine's host name. Names are unique
      among the hub's machines.

    The machine creates its own key, which never leaves it, and receives a
    client certificate that the hub's authority signs. It pins the hub's
    certificate and connects.

1.  On either machine, list the machines:

    ```bash
    aio machines list
    ```

    The machine you run the command on comes first, with the ID `local`. On
    a node, the hub has the ID `hub`.

The hub puts its host name in the hub URL. If nodes reach the hub by another
name or address, such as a Tailscale name, set the `linkAddress` setting on
the hub:

```bash
curl --cacert ~/.ai-orchestrator/server.crt \
    -H "Authorization: Bearer $(cat ~/.ai-orchestrator/server.token)" \
    -H "Content-Type: application/json" \
    -X PATCH -d '{"linkAddress": "hub.example.com"}' \
    https://127.0.0.1:21400/api/v1/settings
```

### How enrollment stays safe

The node connects to the hub before it knows the hub's certificate. To keep
a program between the two from posing as the hub, the node proves that it
knows the code with a keyed hash over the certificate it sees, and the hub
proves that it knows the code too. A program in the middle presents another
certificate, so the hub refuses the proof, and it can't make a new proof
without the code. Each code is 80 random bits and works once.

## Check a machine's health

To see each machine's health, open the **Machines** page in the Boxes app.
For every machine, the page shows the following:

- The status (online, offline, enrolling, or revoked) and when the hub last
  saw it.
- The server version, the link protocol, and the capabilities.
- The engine version in the machine's image, and the image state: ready,
  not built, engine mismatch, or unknown when Docker doesn't answer. Hold
  the pointer over the state to see the expected engine version.
- The free disk space where the machine keeps its data directory.

Each machine measures its own health. The hub asks each linked node for its
health at most every 30 seconds. While a machine is offline, the hub shows
the last health it heard since its own server started. A machine whose server lacks the `health.v1`
capability shows a dash.

To read a machine's own health, call `GET /api/v1/node/health` on that
machine.

## Work with another machine's boxes

The apps and the CLI on any machine reach another machine's boxes through
the server on their own machine, which relays each call through the hub.

In the Boxes app, each other machine has its own tab, with that machine's
boxes, projects, events, and terminals. On another machine's tab,
**Browse** lists that machine's directories, and the box dialogs use that
machine's projects.

In the CLI, the `--machine` option sends a command to another machine. It
takes a machine ID or name from `aio machines list`:

```bash
aio --machine build-server box list
aio --machine build-server box start BOX_ID
aio --machine build-server events

```

Replace `BOX_ID` with the box ID from the first command.

A box argument of the form `MACHINE/BOX` names its machine too, so the
following command stops the same box:

```bash
aio box stop build-server/BOX_ID

```

To see the boxes or the events of every online machine at once, add the
`--all-machines` option:

```bash
aio box list --all-machines
aio events --all-machines

```

The box list shows another machine's boxes as `MACHINE/BOX`, and it warns
about each machine that is offline. Each event from another machine carries
that machine's ID in its `machine` field.

The following rules apply to the CLI on another machine:

- A path, such as the directory of `aio box new`, must be absolute on that
  machine, because the current directory exists only on this machine.
- `aio box attach`, `aio box shell`, and `aio box open` refuse another
  machine's box, because they run the terminal on this machine. Open the
  box's terminal in the Boxes app instead.
- `aio machines`, `aio node`, and `aio doctor` work on this machine only.

## Remove a machine

To revoke a machine, run the following command on the hub:

```bash
aio machines revoke MACHINE_ID
```

Replace `MACHINE_ID` with the machine's ID from `aio machines list`.

The hub closes the machine's link and refuses its certificate from then on.
The node shows the link as `revoked` and stops reconnecting. To add the
machine again, issue a code and join again.

## Review runs on other machines

A review run executes on the machine that holds the box or repository it
reviews, and stays in that machine's records. From any machine, the Review
app and the CLI reach another machine's runs through the hub.

In the Review app:

- The **Machine** list in the navigation picks the machine that the
  screens show: its runs, findings, launcher, policy, and settings. A run's
  view follows the run live over that machine's event stream.
- The **Dashboard** lists the runs of every machine, with a **Machine**
  column. A machine that the hub reports offline, or that doesn't answer,
  shows as offline with the runs it last listed; the other machines'
  runs still show. Click a run to open it on its machine.
- In the Boxes app, **Start Review** on another machine's tab opens the
  Review app on that machine, with the box filled in.

In the CLI, the global `--machine MACHINE` option sends any `aio review`
command, and `aio events`, to another machine, as it does for the other
commands. Replace `MACHINE` with the machine's ID or name from
`aio machines list`. A `MACHINE/BOX` value for `--box` names the machine
too. For example, to start a review of a box on another machine and follow
its events, run the following commands:

```bash
aio review start --machine MACHINE --box BOX_ID
aio events --machine MACHINE --types run.changed,stage.changed

```

Replace `BOX_ID` with the box's ID on that machine. With `--machine`, give
`--repo` as an absolute path on that machine, or give `--box`. On a Windows
machine, give the host path, such as `C:\src\example`, or its container
path under `/mnt/host`.

To list the runs of every machine, run the following command:

```bash
aio review status --all-machines

```

The output is a table with a `MACHINE` column, followed by a line for each
machine that has no current list, such as `laptop: offline`. The command
succeeds while any machine is offline.

## The link port

A hub listens for node links on port `21402`, on every network interface,
over TLS. Nodes dial out to the hub, so only the hub needs a reachable port.
The local API stays on `127.0.0.1:21400` on every machine.

The hub opens the port only when its role is `hub` or `both` and it has
enrolled a machine or issued a code. A machine on its own never opens it.
To use another port, set the `linkPort` setting on the hub; the change
applies the next time the listener starts.

**Warning**: Keep the hub on your LAN or on a VPN such as Tailscale. Don't
expose the link port to the internet.

### Open the link port in a firewall

The packages don't change a firewall, because most machines never become a
hub. Nodes need no inbound rule. On a hub that runs a firewall, allow TCP
port `21402` only from the networks your nodes are on.

With `ufw` on Ubuntu, run one of the following commands:

- To allow a LAN, where `192.0.2.0/24` stands for your LAN's range:

  ```bash
  sudo ufw allow from 192.0.2.0/24 to any port 21402 proto tcp

  ```

- To allow Tailscale only:

  ```bash
  sudo ufw allow in on tailscale0 to any port 21402 proto tcp

  ```

If you set the `linkPort` setting, use that port instead.

The link uses mutual TLS. The hub serves a certificate that its authority
signs, and every node pins that exact certificate. Each node presents a
client certificate that the same authority signs, and the hub accepts it
only for a machine that it enrolled and didn't revoke.

When both ends connect, they exchange the link protocol version and a list
of capabilities. The ends must speak the same protocol major version; the
hub refuses a link otherwise, and the node's `aio node status` command says
which machine to update. A feature that needs the other end's help checks
its capabilities first, so an older machine keeps working without that
feature. A node reconnects on its own when the link drops, waiting longer
between attempts, up to one minute.

## What crosses the link

Each machine keeps its own database, transcripts, accounts, image, and
secrets broker. The following data crosses the link:

- **Machine information**: names, versions, platforms, and capabilities.
- **Requests between machines**: the hub can call a node's API, and a node
  can call only the hub's machine list and the routes that relay to other
  machines.
- **Secret values**: only the hub holds the 1Password service account
  token. A node's secrets broker asks the hub for each value and keeps it in
  memory for the same 5 minutes as on a hub. While the hub is unreachable, a
  node can't read a secret that it hasn't cached.
- **Agent sign-ins**: the hub's Claude and Codex sign-in files, from the host
  folders (`~/.claude/.credentials.json` and `~/.codex/auth.json`) and from
  account folders. A node copies them from the hub when its link comes up.
  When an agent CLI on a node refreshes its sign-in, the node sends the file
  to the hub, which sends it to every other node. A file arrives only where
  its folder exists, so create the same accounts on each node. GitHub
  Copilot keeps its token beside its settings, so its sign-in isn't copied.

If copied sign-ins keep signing machines out, sign in on each node instead.

## Terminals on other machines

A terminal on a box that runs on another machine travels through the hub:
the server on your machine relays it to the hub, and the hub relays it to
the machine that runs the box. Keys, output, and terminal size changes
cross the link; the box's container never leaves its machine.

- **Boxes app**: open the machine's tab and attach to the box as you do on
  your own machine. **Open Shell in Container** and the side session
  commands open a tab instead of an external terminal, because a terminal
  on your machine can't reach a container on another one.
- **CLI**: name the box as `MACHINE/BOX`:

  ```bash
  aio box attach MACHINE/BOX
  ```

  Replace the following:

  - `MACHINE`: the machine's ID or name, from `aio machines list`
  - `BOX`: the box ID on that machine

  `aio box shell MACHINE/BOX` and `aio box attach MACHINE/BOX --side
  PLATFORM` work the same way. To detach and leave the box running, press
  **Ctrl+]** twice. In a session, the tmux detach key, **Ctrl+B** then
  **D**, also works.

Each terminal can have up to 1 MiB in flight on the link. When your
terminal reads more slowly than the box prints, the hub holds the box's
machine back, which pauses the box's output instead of dropping your
terminal, and other calls on the link keep going.

If the link to the box's machine drops, the terminal closes with the
WebSocket close code `1014` and a reason that names the machine. The box
keeps running; attach again once the machine is back online.

## Files

The hub keeps its certificate authority in `DATA_DIR/hub/`, where
`DATA_DIR` is the data directory, `~/.ai-orchestrator` by default:

- `ca.key` and `ca.crt`: the authority. The key has mode `0600`.
- `link.key` and `link.crt`: the certificate the link listener serves.

A node keeps its side in `DATA_DIR/link/`:

- `client.key` and `client.crt`: the node's client certificate. The key has
  mode `0600`.
- `hub-ca.crt` and `hub.crt`: the hub's authority and its pinned
  certificate.
- `node.json`: the hub URL, the machine ID, and the name.

The hub's database holds the machine registry and a key derived from each
enrollment code, never the code itself.
