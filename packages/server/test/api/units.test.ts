import { mkdtemp, readFile, stat, writeFile, mkdir, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunIdSchema } from "@agentbox/contracts";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  isAuthorized,
  loadOrCreateToken,
  readCookie,
  sessionCookieHeader,
  sessionValue,
} from "../../src/api/auth.js";
import { ApiFailure, toApiFailure } from "../../src/api/errors.js";
import { ulid } from "../../src/api/ulid.js";
import { JobManager, processJob } from "../../src/jobs/jobs.js";
import { NodeProcessRunner, commandLine, shellQuote } from "../../src/jobs/process.js";

describe("token file", () => {
  it("creates the token with mode 0600 and reads it back", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agentbox-"));
    const token = await loadOrCreateToken(home);
    const file = path.join(home, ".claude-box", "server.token");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await loadOrCreateToken(home)).toBe(token);
  });

  it("tightens an existing file's mode", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agentbox-"));
    await mkdir(path.join(home, ".claude-box"));
    const file = path.join(home, ".claude-box", "server.token");
    await writeFile(file, `${"a".repeat(64)}\n`);
    await chmod(file, 0o644);
    expect(await loadOrCreateToken(home)).toBe("a".repeat(64));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toContain("a");
  });
});

describe("auth checks", () => {
  const token = "x".repeat(64);
  it("accepts the bearer header, the cookie, and the query token", () => {
    expect(isAuthorized({ authorization: `Bearer ${token}` }, token)).toBe(true);
    expect(isAuthorized({ cookie: `a=1; agentbox_session=${sessionValue(token)}` }, token)).toBe(true);
    expect(isAuthorized({ queryToken: token }, token)).toBe(true);
    expect(isAuthorized({ authorization: "Bearer y" }, token)).toBe(false);
    expect(isAuthorized({ cookie: "agentbox_session=nope" }, token)).toBe(false);
    expect(isAuthorized({}, token)).toBe(false);
  });

  it("reads cookies and builds the session header", () => {
    expect(readCookie("a=1; b=2", "b")).toBe("2");
    expect(readCookie(undefined, "b")).toBeUndefined();
    expect(sessionCookieHeader(token)).toBe(
      `agentbox_session=${sessionValue(token)}; HttpOnly; SameSite=Strict; Path=/`,
    );
  });
});

describe("errors", () => {
  it("maps codes to statuses and keeps details", () => {
    const f = new ApiFailure("session_tracked", "Held.", { holders: ["b"] });
    expect(f.status).toBe(409);
    expect(f.toBody()).toEqual({ error: { code: "session_tracked", message: "Held.", details: { holders: ["b"] } } });
    expect(new ApiFailure("secrets_locked", "x").status).toBe(503);
    expect(new ApiFailure("run_not_found", "x").status).toBe(404);
  });

  it("converts foreign errors", () => {
    expect(toApiFailure(Object.assign(new Error("gone"), { code: "not_found" })).status).toBe(404);
    expect(toApiFailure(new Error("bug"))).toMatchObject({ code: "conflict", status: 500 });
    expect(toApiFailure(new ZodError([])).code).toBe("validation");
    expect(toApiFailure("text").status).toBe(500);
  });
});

describe("ulid", () => {
  it("makes contract-valid ids that sort by time", () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    expect(RunIdSchema.safeParse(a).success).toBe(true);
    expect(a < b).toBe(true);
  });
});

describe("process helpers", () => {
  it("quotes arguments for a shell", () => {
    expect(shellQuote("plain")).toBe("plain");
    expect(shellQuote("it's here")).toBe(`'it'\\''s here'`);
    expect(commandLine(["docker", "build", "-t", "a b"])).toBe("docker build -t 'a b'");
  });

  it("runs a real process and reports a missing program", async () => {
    const runner = new NodeProcessRunner();
    const ok = await runner.run("sh", ["-c", "cat; echo err >&2; exit 3"], { input: "in" });
    expect(ok).toMatchObject({ code: 3, stdout: "in", stderr: "err\n", failedToStart: false });
    const missing = await runner.run("agentbox-no-such-program", []);
    expect(missing.failedToStart).toBe(true);
    const slow = await runner.run("sleep", ["5"], { timeoutMs: 50 });
    expect(slow.timedOut).toBe(true);
  });
});

describe("JobManager", () => {
  it("streams output, keeps a backlog, and records the result", async () => {
    const finished: string[] = [];
    const jobs = new JobManager({ onFinished: (j) => finished.push(j.status) });
    const job = jobs.start({ kind: "image_build", command: "build" }, async (io) => {
      io.write("one ");
      await new Promise((r) => setTimeout(r, 10));
      io.write("two");
      return { exitCode: 0, result: { ok: 1 } };
    });
    expect(job.status).toBe("running");
    await new Promise((r) => setTimeout(r, 5));
    const att = jobs.attach(job.id)!;
    const live: string[] = [];
    att.onData((c) => live.push(c.toString()));
    const done = await new Promise<{ status: string }>((r) => att.onDone(r));
    expect(att.backlog.toString()).toBe("one ");
    expect(live).toEqual(["two"]);
    expect(done.status).toBe("finished");
    expect(jobs.get(job.id)).toMatchObject({ exitCode: 0, result: { ok: 1 } });
    expect(finished).toEqual(["finished"]);
    expect(jobs.attach("nope")).toBeUndefined();
  });

  it("fails a job that throws, with the error code", async () => {
    const jobs = new JobManager();
    const job = jobs.start({ kind: "box_create", command: "create" }, async () => {
      throw new ApiFailure("secrets_locked", "Sign in to 1Password.");
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(jobs.get(job.id)).toMatchObject({ status: "failed", error: { code: "secrets_locked" } });
  });

  it("runs a spawned process as a job", async () => {
    const jobs = new JobManager();
    const runner = new NodeProcessRunner();
    const job = jobs.start({ kind: "setup_fix", command: "x" }, (io) =>
      processJob(io, runner.spawn("sh", ["-c", "read a; echo got:$a; exit 2"])),
    );
    await new Promise((r) => setTimeout(r, 20));
    const att = jobs.attach(job.id)!;
    att.write(Buffer.from("hi\n"));
    const done = await new Promise<{ status: string; exitCode: number | null }>((r) => att.onDone(r));
    expect(done).toMatchObject({ status: "failed", exitCode: 2 });
    expect(jobs.attach(job.id)!.backlog.toString()).toContain("got:hi");
  });
});
