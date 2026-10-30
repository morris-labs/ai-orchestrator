import type Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { failureOf } from "../../src/api/server.js";
import { DockerodeClient } from "../../src/docker/dockerode.js";
import { DockerApiError, DockerUnavailableError, isContainerGone } from "../../src/docker/types.js";

/** A dockerode stand-in whose container calls fail with `err`. */
function failingDocker(err: unknown): Docker {
  const fail = async () => {
    throw err;
  };
  return {
    getContainer: () => ({ exec: fail, start: fail, inspect: fail }),
    listContainers: fail,
  } as unknown as Docker;
}

function daemonError(statusCode: number, message: string): Error {
  return Object.assign(new Error(`(HTTP code ${statusCode}) unexpected - ${message}`), {
    statusCode,
    json: { message },
  });
}

describe("DockerodeClient errors", () => {
  it("throws a 409 from exec as a conflict the session start can retry", async () => {
    const client = new DockerodeClient(
      failingDocker(daemonError(409, "Container abc is not running")),
    );
    const err = await client.exec("box", { cmd: ["true"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DockerApiError);
    expect(err).toMatchObject({
      code: "conflict",
      dockerStatus: 409,
      message: "Docker: Container abc is not running",
    });
    expect(isContainerGone(err)).toBe(true);
    expect(failureOf(err)).toMatchObject({ code: "conflict", status: 409 });
  });

  it("treats a removal already in progress as removed", async () => {
    const inProgress = daemonError(409, "removal of container abc is already in progress");
    const docker = { getContainer: () => ({ remove: async () => Promise.reject(inProgress) }) };
    const client = new DockerodeClient(docker as unknown as Docker);
    await expect(client.removeContainer("abc", { force: true })).resolves.toBeUndefined();
    const other = daemonError(409, "You cannot remove a running container abc");
    const refusing = { getContainer: () => ({ remove: async () => Promise.reject(other) }) };
    await expect(
      new DockerodeClient(refusing as unknown as Docker).removeContainer("abc"),
    ).rejects.toMatchObject({ dockerStatus: 409 });
  });

  it("throws a 404 as not_found", async () => {
    const client = new DockerodeClient(failingDocker(daemonError(404, "No such container: x")));
    const err = await client.exec("x", { cmd: ["true"] }).catch((e: unknown) => e);
    expect(failureOf(err)).toMatchObject({ code: "not_found", status: 404 });
  });

  it("throws an unreachable daemon as docker_unavailable", async () => {
    const client = new DockerodeClient(
      failingDocker(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
    );
    const err = await client.listContainers().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DockerUnavailableError);
    expect(failureOf(err)).toMatchObject({ code: "docker_unavailable", status: 503 });
  });

  it("maps Fastify's own 4xx errors by status code", () => {
    const fastify = Object.assign(new Error("Body is too large"), {
      statusCode: 413,
      code: "FST_ERR_CTP_BODY_TOO_LARGE",
    });
    expect(failureOf(fastify)).toMatchObject({ code: "validation", status: 413 });
    const coded = Object.assign(new Error("gone"), { statusCode: 400, code: "not_found" });
    expect(failureOf(coded)).toMatchObject({ code: "not_found", status: 404 });
  });
});
