# Multi-host

AI Orchestrator can manage boxes on several machines. One machine runs the
*hub*: the machine registry, the certificate authority, and the link that
every other machine keeps open to it. Each other machine runs a *node*,
which owns its own Docker, containers, transcripts, and accounts. The apps
and the CLI on any machine talk only to the server on that machine.

This page describes roles, how to set up a hub and add a machine to it,
the hub's link port, and what crosses the link.

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

1.  If the hub has more than one LAN address, or nodes reach it by a host
    name, set the `linkHost` or `linkAddress` setting. For more
    information, see [The link port](#the-link-port).

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

The hub puts the address its link listener binds in the hub URL. If nodes
reach the hub by a host name instead, set the `linkAddress` setting on the
hub:

```bash
curl --cacert ~/.ai-orchestrator/server.crt \
    -H "Authorization: Bearer $(cat ~/.ai-orchestrator/server.token)" \
    -H "Content-Type: application/json" \
    -X PATCH -d '{"linkAddress": "hub.example.com"}' \
    https://127.0.0.1:21400/api/v1/settings

```

The name must resolve to the address the hub listens on. For more
information, see [The link port](#the-link-port).

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

A hub listens for node links on port `21402`, over TLS, on its LAN address
only. Nodes dial out to the hub, so only the hub needs a reachable port.
The local API stays on `127.0.0.1:21400` on every machine.

By default, the hub binds its primary LAN IPv4 address: the private
address (in `10.0.0.0/8`, `172.16.0.0/12`, or `192.168.0.0/16`) of the
network interface that holds the default route. Loopback, Docker bridges
(`docker*`, `br-*`, and `veth*` interfaces), and Tailscale (`tailscale*`
interfaces and `100.64.0.0/10`) never count. If the default route has no
LAN address, such as when it goes through a VPN, the hub binds the
machine's only LAN address. The hub never listens on every interface. If it
finds no LAN address, or several and none on the default route, it doesn't
start the link listener, logs why, and refuses to issue enrollment codes.

To choose the address, set the `linkHost` setting on the hub, then restart
the server:

```bash
curl --cacert ~/.ai-orchestrator/server.crt \
    -H "Authorization: Bearer $(cat ~/.ai-orchestrator/server.token)" \
    -H "Content-Type: application/json" \
    -X PATCH -d '{"linkHost": "192.0.2.10"}' \
    https://127.0.0.1:21400/api/v1/settings
systemctl --user restart aio-server

```

Replace `192.0.2.10` with the hub's address on the network your nodes are
on. To go back to the detected address, send `{"linkHost": null}`. The hub
reads the address when the listener starts, so after the LAN address
changes, restart the server.

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
