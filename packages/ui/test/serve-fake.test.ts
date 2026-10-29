import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeServer } from "../src/testing";
import { serveFake, staticFile, type ServedFake } from "../src/testing/node";

let served: ServedFake | null = null;
let dir: string | null = null;
afterEach(async () => {
  await served?.close();
  served = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("serveFake", () => {
  it("maps static prefixes and refuses paths that leave them", () => {
    expect(staticFile("/boxes/", { "/boxes/": "/d" })).toBe("/d/index.html");
    expect(staticFile("/boxes/assets/a.js", { "/boxes/": "/d" })).toBe("/d/assets/a.js");
    expect(staticFile("/boxes/../x", { "/boxes/": "/d" })).toBe("forbidden");
    expect(staticFile("/other", { "/boxes/": "/d" })).toBeNull();
  });

  it("answers API routes from the fake and serves files", async () => {
    dir = mkdtempSync(join(tmpdir(), "serve-fake-"));
    writeFileSync(join(dir, "index.html"), "<title>x</title>");
    const fake = new FakeServer();
    served = await serveFake(fake, { static: { "/app/": dir } });
    const health = await fetch(`${served.url}/api/v1/health`, {
      headers: { authorization: "Bearer t" },
    });
    expect(await health.json()).toMatchObject({ version: "4.0.0" });
    const patched = await fetch(`${served.url}/api/v1/settings`, {
      method: "PATCH",
      body: JSON.stringify({ notifications: { readyToPush: false } }),
    });
    expect(patched.status).toBe(200);
    expect(fake.state.settings.notifications.readyToPush).toBe(false);
    expect(await (await fetch(`${served.url}/app/`)).text()).toBe("<title>x</title>");
    expect((await fetch(`${served.url}/app/missing.js`)).status).toBe(404);
    expect(served.requests[0]).toBe("GET /api/v1/health Bearer t");
  });
});
