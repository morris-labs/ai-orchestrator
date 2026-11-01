import { describe, expect, it } from "vitest";
import type { DockerEngineInfo } from "../../src/docker/types.js";
import {
  BrokerTransportResolver,
  decideBrokerTransport,
  isDockerDesktopHost,
  isDockerDesktopInfo,
} from "../../src/secrets/transport.js";

const native: DockerEngineInfo = {
  operatingSystem: "Ubuntu 24.04 LTS",
  osType: "linux",
  name: "build-host",
  labels: [],
};
const desktop: DockerEngineInfo = {
  operatingSystem: "Docker Desktop",
  osType: "linux",
  name: "docker-desktop",
  labels: ["com.docker.desktop.address=unix:///Users/dev/Library/Containers/x/backend.sock"],
};

describe("isDockerDesktopInfo", () => {
  it("knows Docker Desktop by its operating system, name, or labels", () => {
    expect(isDockerDesktopInfo(desktop)).toBe(true);
    expect(isDockerDesktopInfo({ ...native, operatingSystem: "Docker Desktop" })).toBe(true);
    expect(isDockerDesktopInfo({ ...native, name: "docker-desktop" })).toBe(true);
    expect(
      isDockerDesktopInfo({ ...native, labels: ["com.docker.desktop.address=npipe://x"] }),
    ).toBe(true);
    expect(isDockerDesktopInfo(native)).toBe(false);
  });
});

describe("isDockerDesktopHost", () => {
  it("knows the Docker Desktop endpoints", () => {
    expect(isDockerDesktopHost("unix:///Users/dev/.docker/desktop/docker.sock")).toBe(true);
    expect(isDockerDesktopHost("unix:///home/dev/.docker/desktop/docker.sock")).toBe(true);
    expect(isDockerDesktopHost("npipe:////./pipe/dockerDesktopLinuxEngine")).toBe(true);
    expect(isDockerDesktopHost("npipe:////./pipe/docker_engine")).toBe(true);
    expect(isDockerDesktopHost("unix:///var/run/docker.sock")).toBe(false);
    expect(isDockerDesktopHost("tcp://192.0.2.10:2376")).toBe(false);
    expect(isDockerDesktopHost(undefined)).toBe(false);
  });
});

describe("decideBrokerTransport", () => {
  it("keeps the Unix socket for a native Linux engine, or when /info is unknown", () => {
    for (const setting of [undefined, "auto"] as const) {
      expect(decideBrokerTransport({ setting, platform: "linux", info: native })).toMatchObject({
        transport: "unix",
        hostGateway: false,
        dockerDesktop: false,
      });
    }
    expect(decideBrokerTransport({ setting: "auto", platform: "linux", info: null })).toMatchObject(
      { transport: "unix" },
    );
  });

  it("picks TCP for Docker Desktop on any platform, without a host-gateway entry", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(decideBrokerTransport({ setting: "auto", platform, info: desktop })).toMatchObject({
        transport: "tcp",
        hostGateway: false,
        dockerDesktop: true,
        reason: "the Docker engine is Docker Desktop",
      });
    }
    expect(
      decideBrokerTransport({
        setting: undefined,
        platform: "linux",
        info: null,
        dockerHost: "unix:///home/dev/.docker/desktop/docker.sock",
      }),
    ).toMatchObject({ transport: "tcp", dockerDesktop: true, hostGateway: false });
  });

  it("picks TCP on macOS and Windows even when /info can't be read", () => {
    expect(
      decideBrokerTransport({ setting: "auto", platform: "darwin", info: null }),
    ).toMatchObject({ transport: "tcp", hostGateway: false });
    expect(decideBrokerTransport({ setting: "auto", platform: "win32", info: null })).toMatchObject(
      {
        transport: "tcp",
        hostGateway: false,
      },
    );
  });

  it("follows an explicit setting, adding host-gateway only for TCP on native Linux", () => {
    expect(decideBrokerTransport({ setting: "tcp", platform: "linux", info: native })).toEqual({
      transport: "tcp",
      hostGateway: true,
      dockerDesktop: false,
      reason: "the brokerTransport setting is tcp",
    });
    expect(
      decideBrokerTransport({ setting: "tcp", platform: "linux", info: desktop }),
    ).toMatchObject({ transport: "tcp", hostGateway: false });
    expect(
      decideBrokerTransport({ setting: "unix", platform: "darwin", info: desktop }),
    ).toMatchObject({ transport: "unix", hostGateway: false });
  });
});

describe("BrokerTransportResolver", () => {
  it("reads /info once, retries after a failure, and logs only a change away from the default", async () => {
    let calls = 0;
    let fail = true;
    let info = native;
    const log: string[] = [];
    let setting: "auto" | "tcp" | undefined = undefined as "auto" | "tcp" | undefined;
    const resolver = new BrokerTransportResolver({
      info: async () => {
        calls += 1;
        if (fail) throw new Error("daemon down");
        return info;
      },
      setting: () => setting,
      platform: "linux",
      log: (m) => log.push(m),
    });
    expect((await resolver.resolve()).transport).toBe("unix");
    fail = false;
    expect((await resolver.resolve()).transport).toBe("unix");
    info = desktop;
    expect((await resolver.resolve()).transport).toBe("unix");
    expect(calls).toBe(2);
    expect(log).toEqual([]);

    setting = "tcp";
    expect(await resolver.resolve()).toMatchObject({ transport: "tcp", hostGateway: true });
    expect(log).toHaveLength(2);
    expect(log[0]).toContain("tcp transport because the brokerTransport setting is tcp");
    expect(log[1]).toContain("listens on 127.0.0.1 only");
    await resolver.resolve();
    expect(log).toHaveLength(2);
  });

  it("treats a client without /info as native", async () => {
    const resolver = new BrokerTransportResolver({ setting: () => "auto", platform: "linux" });
    expect((await resolver.resolve()).transport).toBe("unix");
  });
});
