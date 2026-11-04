// The hub's timers call these methods without awaiting them, so a failure must
// not reject: that stops the server, and later calls chain onto the rejection.
import { describe, expect, it } from "vitest";
import { GuiListener } from "../../src/hub/gui.js";
import { Hub } from "../../src/hub/hub.js";
import { MultiHost } from "../../src/hub/multihost.js";

const sqliteBusy = () => {
  throw new Error("SQLITE_BUSY");
};

describe("hub timer callbacks", () => {
  it.each([
    ["Hub", Hub.prototype.reconcile, "count"],
    ["GuiListener", GuiListener.prototype.reconcile, "liveCount"],
  ] as const)("%s.reconcile logs a read error and runs again", async (_name, reconcile, read) => {
    const logs: string[] = [];
    let fail = true;
    const self = {
      closed: false,
      reconciling: Promise.resolve(),
      listenError: "stale",
      server: null,
      opts: { isHub: () => true, log: (line: string) => logs.push(line) },
      registry: {
        [read]: () => (fail ? sqliteBusy() : 0),
        liveCodeKeys: () => [],
      },
    };
    await expect(reconcile.call(self as never)).resolves.toBeUndefined();
    expect(logs.join()).toContain("SQLITE_BUSY");
    fail = false;
    await reconcile.call(self as never);
    expect(self.listenError).toBeNull();
  });

  it("MultiHost.syncCredentials logs a failure and syncs again", async () => {
    const logs: string[] = [];
    let changes = 0;
    const self = {
      credentialSync: Promise.resolve(),
      node: { joined: false },
      role: () => "hub",
      hub: { list: () => ["node"] },
      retryUndelivered: async () => undefined,
      credentials: {
        changes: async () => {
          changes += 1;
          if (changes === 1) sqliteBusy();
          return [];
        },
      },
      opts: { log: (line: string) => logs.push(line) },
    };
    const sync = MultiHost.prototype.syncCredentials;
    await expect(sync.call(self as never)).resolves.toBeUndefined();
    expect(logs.join()).toContain("SQLITE_BUSY");
    await sync.call(self as never);
    expect(changes).toBe(2);
  });
});
