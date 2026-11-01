import { describe, expect, it } from "vitest";
import { describeExit, secondInstanceCommand } from "../src/testing/node";

describe("secondInstanceCommand", () => {
  it("starts the second instance without the sandbox on Linux, as Playwright starts the first", () => {
    const { args } = secondInstanceCommand(["/app"], {}, "linux");
    expect(args).toEqual(["--no-sandbox", "/app"]);
    expect(secondInstanceCommand(["--no-sandbox", "/app"], {}, "linux").args).toEqual([
      "--no-sandbox",
      "/app",
    ]);
    expect(secondInstanceCommand(["/app"], {}, "darwin").args).toEqual(["/app"]);
  });

  it("drops NODE_OPTIONS and unset variables, and keeps the rest", () => {
    const { env } = secondInstanceCommand(
      ["/app"],
      { NODE_OPTIONS: "--import loader.mjs", AIO_DATA_DIR: "/d", UNSET: undefined },
      "linux",
    );
    expect(env).toEqual({ AIO_DATA_DIR: "/d" });
  });
});

describe("describeExit", () => {
  it("names the signal when a process has no status", () => {
    expect(describeExit({ status: null, signal: "SIGTRAP", stderr: Buffer.from("FATAL\n") })).toBe(
      "The second instance was killed by SIGTRAP. Its stderr:\nFATAL",
    );
    expect(describeExit({ status: 1, signal: null })).toBe(
      "The second instance exited with status 1.",
    );
  });
});
