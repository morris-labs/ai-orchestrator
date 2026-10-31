// Error mapping, token checks, and logging.
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { bearerToken, isAuthorized, redactUrl, tokensEqual } from "../../src/api/auth.js";
import { EngineError } from "../../src/api/core-interface.js";
import { mapError, statusFor } from "../../src/api/errors.js";
import { createLogger, isLogLevel } from "../../src/main/logger.js";

describe("mapError", () => {
  it("keeps an EngineError's code, message, and details", () => {
    expect(mapError(new EngineError("dirty_tree", "Commit first.", { files: 2 }))).toEqual({
      status: 409,
      body: { error: { code: "dirty_tree", message: "Commit first.", details: { files: 2 } } },
    });
  });

  it("maps a ZodError to validation", () => {
    const err = z.object({ a: z.string() }).safeParse({}).error;
    expect(mapError(err)).toMatchObject({ status: 400, body: { error: { code: "validation" } } });
  });

  it("accepts a plain object with a known code", () => {
    expect(mapError({ code: "run_not_found" }).status).toBe(404);
  });

  it("turns anything else into a 500 without leaking the message", () => {
    const mapped = mapError(new Error("secret path /x"));
    expect(mapped.status).toBe(500);
    expect(mapped.body.error.code).toBe("internal");
    expect(JSON.stringify(mapped.body)).not.toContain("secret path");
    expect(mapError({ code: "ENOENT" }).status).toBe(500);
  });

  it("maps only Fastify's own 4xx errors to validation", () => {
    expect(
      mapError({ code: "FST_ERR_CTP_BODY_TOO_LARGE", statusCode: 413, message: "Too large" }),
    ).toEqual({ status: 413, body: { error: { code: "validation", message: "Too large" } } });
    expect(mapError({ code: "FST_ERR_SOMETHING", statusCode: 500 }).status).toBe(500);
    expect(mapError({ code: "ENOTFOUND", statusCode: 404, message: "x" }).status).toBe(500);
  });

  it("gives every code a status", () => {
    expect(statusFor("secrets_locked")).toBe(503);
    expect(statusFor("not_found")).toBe(404);
    expect(statusFor("unauthorized")).toBe(401);
    expect(statusFor("internal")).toBe(500);
  });
});

describe("auth", () => {
  const req = (url: string, authorization?: string) =>
    ({ url, headers: authorization ? { authorization } : {} }) as unknown as IncomingMessage;

  it("compares tokens", () => {
    expect(tokensEqual("abc", "abc")).toBe(true);
    expect(tokensEqual("abc", "abd")).toBe(false);
    expect(tokensEqual("abc", "abcd")).toBe(false);
  });

  it("reads a bearer header", () => {
    expect(bearerToken("Bearer xyz")).toBe("xyz");
    expect(bearerToken("bearer xyz")).toBe("xyz");
    expect(bearerToken("Basic xyz")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it("accepts the bearer header and never a query token", () => {
    expect(isAuthorized(req("/x?token=t1"), "t1")).toBe(false);
    expect(isAuthorized(req("/x", "Bearer t1"), "t1")).toBe(true);
    expect(isAuthorized(req("/x", "Bearer t2"), "t1")).toBe(false);
  });

  it("redacts a token in a URL", () => {
    expect(redactUrl("/a?x=1&token=abc&y=2")).toBe("/a?x=1&token=[redacted]&y=2");
  });
});

describe("createLogger", () => {
  it("drops records below the level and redacts secret-looking fields", () => {
    const lines: string[] = [];
    const log = createLogger(
      "info",
      (l) => lines.push(l),
      () => new Date("2026-10-28T09:00:00Z"),
    );
    log.debug("hidden");
    log.info("shown", { port: 1, token: "abc", authorization: "Bearer abc" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      time: "2026-10-28T09:00:00.000Z",
      level: "info",
      msg: "shown",
      port: 1,
      token: "[redacted]",
      authorization: "[redacted]",
    });
  });

  it("recognizes levels", () => {
    expect(isLogLevel("warn")).toBe(true);
    expect(isLogLevel("trace")).toBe(false);
  });
});
