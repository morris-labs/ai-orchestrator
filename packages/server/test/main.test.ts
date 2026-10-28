import os from "node:os";
import { describe, expect, it } from "vitest";
import { main, serverHome } from "../src/main.js";

describe("main", () => {
  it("uses AGENTBOX_HOME when set, else the home directory", () => {
    expect(serverHome({ AGENTBOX_HOME: "/tmp/agentbox-test/../scratch" })).toBe("/tmp/scratch");
    expect(serverHome({})).toBe(os.homedir());
    expect(serverHome({ AGENTBOX_HOME: "" })).toBe(os.homedir());
  });

  it("refuses an unknown command", async () => {
    expect(await main(["bogus"])).toBe(2);
  });
});
