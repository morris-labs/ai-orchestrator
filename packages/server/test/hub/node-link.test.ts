// The node's link when the hub answers the upgrade with something other than
// 101, tested on a bare `NodeAgent` against a TLS listener that plays the hub.
import path from "node:path";
import type { AddressInfo } from "node:net";
import tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import {
  issueNodeCertificate,
  loadOrCreateHubIdentity,
  newNodeKey,
  writeNodeLinkFiles,
} from "../../src/hub/ca.js";
import { NodeAgent } from "../../src/hub/node.js";
import { LINK_CAPABILITIES, LINK_PROTOCOL } from "../../src/hub/protocol.js";
import { waitFor } from "../events/fake-engine.js";
import { tempDir } from "../tmp.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * Starts a listener that sends `answer` to every request, ending the
 * connection afterward, and a `NodeAgent` that has joined it.
 */
async function nodeOfFakeHub(answer: string, backoffMs: number) {
  const home = tempDir("aio-node-link-");
  const identity = await loadOrCreateHubIdentity(path.join(home, "hub"));
  let requests = 0;
  const server = tls.createServer(
    { key: identity.link.key, cert: identity.link.cert },
    (socket) => {
      socket.on("error", () => undefined);
      socket.once("data", () => {
        requests += 1;
        socket.write(answer, () => socket.destroy());
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const nodeKey = newNodeKey();
  const dir = path.join(home, "link");
  await writeNodeLinkFiles(dir, {
    config: {
      hubUrl: `https://127.0.0.1:${port}`,
      machineId: "m0000000000000001",
      name: "node-test",
      hubFingerprint: identity.linkFingerprint,
      joinedAt: "2026-11-01T10:00:00.000Z",
    },
    clientKey: nodeKey.key,
    clientCert: issueNodeCertificate(identity.ca, "m0000000000000001", nodeKey.publicKey),
    hubCa: identity.ca.cert,
    hubCert: identity.link.cert,
  });
  const agent = new NodeAgent({
    dir,
    mayLink: () => true,
    hello: () => ({
      type: "hello",
      protocol: LINK_PROTOCOL,
      capabilities: [...LINK_CAPABILITIES],
      serverVersion: "1.0.0-test",
      platform: "linux",
      name: "node-test",
      role: "node",
    }),
    token: "synthetic-token",
    api: () => null,
    internal: new Map(),
    timing: { backoffMinMs: backoffMs, backoffMaxMs: backoffMs },
    log: () => undefined,
  });
  cleanups.push(async () => {
    await agent.close();
    server.close();
  });
  await agent.start();
  return {
    agent,
    requests: () => requests,
    retrying: () => (agent as unknown as { retryTimer: unknown }).retryTimer !== null,
  };
}

describe("a non-101 answer to the link upgrade", () => {
  const LONG_BACKOFF_MS = 60_000;

  it("keeps the advice to join again after a 401", async () => {
    const body = "Unknown certificate.";
    const { agent, retrying } = await nodeOfFakeHub(
      `HTTP/1.1 401 Unauthorized\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      LONG_BACKOFF_MS,
    );
    // The retry timer starts once the socket has closed, after any late error.
    await waitFor(retrying);
    expect(agent.status().link).toBe("refused");
    expect(agent.status().error).toMatch(/Unknown certificate\. Join the hub again\./);
  });

  it("keeps the hub's message after another status", async () => {
    const body = "Upgrade failed.";
    const { agent, retrying } = await nodeOfFakeHub(
      `HTTP/1.1 500 Internal Server Error\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      LONG_BACKOFF_MS,
    );
    await waitFor(retrying);
    expect(agent.status().link).toBe("disconnected");
    expect(agent.status().error).toMatch(/answered the link with Upgrade failed\./);
  });

  it("retries when the connection cuts the answer off", async () => {
    const { agent, requests } = await nodeOfFakeHub(
      "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 100\r\n\r\nx",
      10,
    );
    await waitFor(() => requests() >= 2);
    expect(agent.status().link).not.toBe("connected");
    expect(agent.status().error).toMatch(/answered the link with x\./);
  });
});
