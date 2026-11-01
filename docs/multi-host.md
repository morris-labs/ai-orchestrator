# Multi-host

AI Orchestrator can manage boxes on several machines. One machine runs the
*hub*: the machine registry, the certificate authority, and the link that
every other machine keeps open to it. Each other machine runs a *node*,
which owns its own Docker, containers, transcripts, and accounts. The apps
and the CLI on any machine talk only to the server on that machine.

This page describes roles, how to add a machine to a hub, the hub's link
port, and what crosses the link.

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

## Add a machine to a hub

To add a machine, issue a one-time code on the hub and use it on the
machine:

1.  On the hub, issue an enrollment code:

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

1.  On the machine to add, join the hub:

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

## Remove a machine

To revoke a machine, run the following command on the hub:

```bash
aio machines revoke MACHINE_ID
```

Replace `MACHINE_ID` with the machine's ID from `aio machines list`.

The hub closes the machine's link and refuses its certificate from then on.
The node shows the link as `revoked` and stops reconnecting. To add the
machine again, issue a code and join again.

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
