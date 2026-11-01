import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ContainerPathError,
  containerToHost,
  defaultContainerPath,
  guessHostOs,
  hostOsFrom,
  hostPathProblem,
  hostToContainer,
  isAbsoluteHostPath,
  isUncPath,
  joinMountSpec,
  normalizeHostPath,
  normalizeWindowsPath,
  splitMountSpec,
} from "../src/index.js";

const POSIX_SAMPLES = [
  "/",
  "/home/dev/project",
  "/home/dev/project/",
  "/home//dev///project",
  "/home/dev/./project/../project",
  "/home/dev/my project",
  "/tmp/claude-1000/a.b-c_d",
  "/../etc",
  "/Users/Dev/Project",
  "/home/dev/é/😀",
];

describe("hostOsFrom", () => {
  it("maps Node.js platforms", () => {
    expect(hostOsFrom("win32")).toBe("win32");
    expect(hostOsFrom("darwin")).toBe("darwin");
    expect(hostOsFrom("linux")).toBe("linux");
    expect(hostOsFrom("freebsd")).toBe("linux");
  });
});

describe("hostToContainer on Linux and macOS", () => {
  it.each(["linux", "darwin"] as const)("is the identity of path.posix.resolve on %s", (os) => {
    for (const p of POSIX_SAMPLES) {
      expect(hostToContainer(p, os)).toBe(path.posix.resolve(p));
    }
  });

  it("leaves a normalized path byte for byte unchanged", () => {
    for (const p of ["/home/dev/project", "/srv/repo with spaces", "/a/B/c"]) {
      expect(hostToContainer(p, "linux")).toBe(p);
    }
  });

  it("refuses a relative path", () => {
    expect(() => hostToContainer("relative/dir", "linux")).toThrow(ContainerPathError);
  });

  it("maps container paths back unchanged", () => {
    expect(containerToHost("/home/dev/project/", "linux")).toBe("/home/dev/project");
    expect(containerToHost("/Users/dev/project", "darwin")).toBe("/Users/dev/project");
    expect(containerToHost("relative", "linux")).toBeNull();
  });
});

describe("hostToContainer on Windows", () => {
  it.each([
    ["C:\\Users\\dev\\project", "/mnt/host/c/Users/dev/project"],
    ["c:\\Users\\dev\\project", "/mnt/host/c/Users/dev/project"],
    ["C:/Users/dev/project", "/mnt/host/c/Users/dev/project"],
    ["C:\\Users/dev\\project\\", "/mnt/host/c/Users/dev/project"],
    ["D:\\", "/mnt/host/d"],
    ["D:", "/mnt/host/d"],
    ["C:\\Users\\dev\\My Project", "/mnt/host/c/Users/dev/My Project"],
    ["C:\\Users\\dev\\.\\a\\..\\b", "/mnt/host/c/Users/dev/b"],
    ["C:\\..\\x", "/mnt/host/c/x"],
    ["\\\\?\\C:\\Users\\dev\\project", "/mnt/host/c/Users/dev/project"],
    ["//?/e:/data", "/mnt/host/e/data"],
  ])("maps %s to %s", (host, container) => {
    expect(hostToContainer(host, "win32")).toBe(container);
  });

  it("keeps the case of everything but the drive letter", () => {
    expect(hostToContainer("Z:\\Repo\\SRC", "win32")).toBe("/mnt/host/z/Repo/SRC");
  });

  it.each([
    ["\\\\server\\share\\dir", /UNC/],
    ["//server/share", /UNC/],
    ["\\\\?\\UNC\\server\\share", /UNC/],
    ["\\\\.\\pipe\\docker_engine", /device/],
    ["\\Users\\dev", /drive letter/],
    ["/home/dev", /drive letter/],
    ["relative\\dir", /drive letter/],
    ["C:project", /relative to the current folder/],
  ])("refuses %s", (host, message) => {
    expect(() => hostToContainer(host, "win32")).toThrow(ContainerPathError);
    expect(() => hostToContainer(host, "win32")).toThrow(message);
  });

  it("maps container paths back to the stored host form", () => {
    expect(containerToHost("/mnt/host/c/Users/dev/project", "win32")).toBe("C:/Users/dev/project");
    expect(containerToHost("/mnt/host/d", "win32")).toBe("D:/");
    expect(containerToHost("/home/dev/.claude", "win32")).toBeNull();
    expect(containerToHost("/mnt/hostile/c", "win32")).toBeNull();
  });

  it("round-trips", () => {
    for (const p of ["C:/Users/dev/project", "D:/", "E:/a b/c.d"]) {
      expect(containerToHost(hostToContainer(p, "win32"), "win32")).toBe(p);
    }
  });
});

describe("normalizeWindowsPath", () => {
  it("produces the stored form", () => {
    expect(normalizeWindowsPath("c:\\Users\\dev\\")).toBe("C:/Users/dev");
    expect(normalizeWindowsPath("C:\\")).toBe("C:/");
    expect(normalizeHostPath("C:\\a\\\\b", "win32")).toBe("C:/a/b");
    expect(normalizeHostPath("/a//b/", "linux")).toBe("/a/b");
  });
});

describe("splitMountSpec and joinMountSpec", () => {
  it("splits at the first colon on Linux, as before", () => {
    expect(splitMountSpec("/a:/b", "linux")).toEqual({ host: "/a", container: "/b" });
    expect(splitMountSpec("/a", "linux")).toEqual({ host: "/a", container: "" });
    expect(splitMountSpec("/a:/b:ro", "linux")).toEqual({
      host: "/a",
      container: "/b",
      options: "ro",
    });
  });

  it("skips a drive letter's colon on Windows", () => {
    expect(splitMountSpec("C:\\Users\\dev:/data", "win32")).toEqual({
      host: "C:\\Users\\dev",
      container: "/data",
    });
    expect(splitMountSpec("C:/Users/dev", "win32")).toEqual({
      host: "C:/Users/dev",
      container: "",
    });
    expect(splitMountSpec("C:/x y:/mnt/host/c/x y:ro", "win32")).toEqual({
      host: "C:/x y",
      container: "/mnt/host/c/x y",
      options: "ro",
    });
    expect(splitMountSpec("\\\\?\\C:\\dev:/dev", "win32")).toEqual({
      host: "\\\\?\\C:\\dev",
      container: "/dev",
    });
  });

  it("joins what it splits", () => {
    for (const [spec, os] of [
      ["/a:/b", "linux"],
      ["/a:/b:ro", "darwin"],
      ["C:/Users/dev:/mnt/host/c/Users/dev", "win32"],
      ["C:\\data:/data:ro", "win32"],
    ] as const) {
      expect(joinMountSpec(splitMountSpec(spec, os))).toBe(spec);
    }
  });
});

describe("path shapes", () => {
  it("guesses the OS from a path", () => {
    expect(guessHostOs("C:\\Users")).toBe("win32");
    expect(guessHostOs("\\\\server\\share")).toBe("win32");
    expect(guessHostOs("/home/dev")).toBe("linux");
  });

  it("recognizes UNC paths", () => {
    expect(isUncPath("\\\\server\\share")).toBe(true);
    expect(isUncPath("\\\\?\\UNC\\server\\share")).toBe(true);
    expect(isUncPath("\\\\?\\C:\\x")).toBe(false);
    expect(isUncPath("C:\\x")).toBe(false);
  });

  it("defaults a mount's container path by its host path's shape", () => {
    expect(defaultContainerPath("/data")).toBe("/data");
    expect(defaultContainerPath("C:\\data")).toBe("/mnt/host/c/data");
    expect(defaultContainerPath("\\\\server\\share")).toBe("\\\\server\\share");
  });

  it("tells absolute paths per OS", () => {
    expect(isAbsoluteHostPath("C:\\x", "win32")).toBe(true);
    expect(isAbsoluteHostPath("C:x", "win32")).toBe(false);
    expect(isAbsoluteHostPath("/x", "linux")).toBe(true);
    expect(isAbsoluteHostPath("C:\\x", "linux")).toBe(false);
  });
});

describe("hostPathProblem with Windows paths", () => {
  it("refuses UNC paths with a clear message", () => {
    expect(hostPathProblem("\\\\server\\share")).toMatch(/UNC/);
    expect(hostPathProblem("//server/share", "win32")).toMatch(/UNC/);
  });

  it("keeps //data a valid POSIX path", () => {
    expect(hostPathProblem("//data")).toBeNull();
  });

  it("accepts a \\\\?\\ prefix", () => {
    expect(hostPathProblem("\\\\?\\C:\\Users\\dev")).toBeNull();
  });

  it("checks the form for the given OS", () => {
    expect(hostPathProblem("/home/dev", "win32")).toMatch(/drive letter/);
    expect(hostPathProblem("C:\\Users\\dev", "linux")).toMatch(/not an absolute path/);
    expect(hostPathProblem("C:/Users/dev", "win32")).toBeNull();
    expect(hostPathProblem("C:/Users/a:b", "win32")).toMatch(/colon/);
  });
});
