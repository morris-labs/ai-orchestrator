#!/usr/bin/env node
// Assembles the runtime that the macOS and Windows packages ship inside the
// AI Orchestrator (Boxes) app: Node.js, the server, the CLI, the image build
// context, and the web bundles. electron-builder copies the result into the
// app's resources/runtime folder (see apps/boxes/electron-builder.yml).
//
// Layout of OUT (packaging/build/runtime/OS-ARCH by default):
//
//   node/bin/node         Node.js (macOS, Linux)
//   node/node.exe         Node.js (Windows)
//   node/aio-serverw.exe  The same Node.js without a console (Windows)
//   server/               @aio/server with production dependencies
//   cli/                  @aio/cli with production dependencies
//   bin/aio, aio-server   Launchers (aio.cmd and aio-server.cmd on Windows)
//   share/image/          The image build context, as /usr/share/ai-orchestrator/image
//   share/scripts/        build-image.sh and its library
//   share/web/APP/        The web bundles the server serves
//   runtime.json          What was staged, for bug reports
//
// The server's native SQLite module is built for the OS and CPU that run
// `pnpm install`, so stage on the OS and architecture you ship for. The
// script refuses another OS; it allows another architecture only with
// --allow-cross, because the result then needs a matching native module.
//
// Run the workspace build and `scripts/build-image.sh --pack-only` first;
// scripts/build-mac.sh and scripts/build-win.ps1 do.
//
// Usage:
//   node scripts/stage-runtime.mjs [--os mac|win|linux] [--arch x64|arm64]
//     [--out DIR] [--node-version VERSION] [--node-archive FILE]
//     [--allow-cross]
//
// --node-archive uses a Node.js archive you downloaded already, instead of
// downloading it; its SHA-256 is still checked against SHASUMS256.txt when
// --shasums FILE is given, and the script warns when it isn't.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUBSYSTEM_GUI, withSubsystem } from "./lib/pe-subsystem.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OS_NAMES = { darwin: "mac", win32: "win", linux: "linux" };

function die(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stderr.write(`==> ${message}\n`);
}

/** Parses the command line into options. */
export function parseArgs(argv) {
  const opts = {
    os: OS_NAMES[process.platform] ?? "linux",
    arch: process.arch === "arm64" ? "arm64" : "x64",
    out: undefined,
    nodeVersion: undefined,
    nodeArchive: undefined,
    shasums: undefined,
    allowCross: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i] ?? die(`${arg} needs a value`);
    if (arg === "--os") opts.os = value();
    else if (arg === "--arch") opts.arch = value();
    else if (arg === "--out") opts.out = path.resolve(value());
    else if (arg === "--node-version") opts.nodeVersion = value();
    else if (arg === "--node-archive") opts.nodeArchive = path.resolve(value());
    else if (arg === "--shasums") opts.shasums = path.resolve(value());
    else if (arg === "--allow-cross") opts.allowCross = true;
    else die(`unknown option: ${arg}`);
  }
  if (!["mac", "win", "linux"].includes(opts.os)) die(`--os must be mac, win, or linux`);
  if (!["x64", "arm64"].includes(opts.arch)) die(`--arch must be x64 or arm64`);
  opts.out ??= path.join(ROOT, "packaging", "build", "runtime", `${opts.os}-${opts.arch}`);
  return opts;
}

/** The pinned Node.js version: the last non-comment line of packaging/runtime/node-version. */
export function pinnedNodeVersion(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  const version = lines.at(-1)?.trim();
  if (!version || !/^22\.\d+\.\d+$/.test(version)) {
    die(`packaging/runtime/node-version must name a Node.js 22 release, not ${version}`);
  }
  return version;
}

/** The nodejs.org archive name for a target. */
export function nodeArchiveName(version, targetOs, arch) {
  if (targetOs === "win") return `node-v${version}-win-${arch}.zip`;
  if (targetOs === "mac") return `node-v${version}-darwin-${arch}.tar.gz`;
  return `node-v${version}-linux-${arch}.tar.xz`;
}

/** The SHA-256 that SHASUMS256.txt lists for `name`, or `null`. */
export function expectedSha(shasums, name) {
  for (const line of shasums.split(/\r?\n/)) {
    const [hash, file] = line.trim().split(/\s+/);
    if (file === name) return hash;
  }
  return null;
}

/** The text of the POSIX launcher that runs `entry` with the bundled Node.js. */
export function posixLauncher(entry) {
  return [
    "#!/bin/sh",
    "# Runs an AI Orchestrator entry point with the Node.js in this runtime.",
    "# Follows symbolic links, so a link in /usr/local/bin works.",
    'self="$0"',
    'while [ -L "$self" ]; do',
    '  target="$(readlink "$self")"',
    '  case "$target" in',
    '    /*) self="$target" ;;',
    '    *) self="$(dirname "$self")/$target" ;;',
    "  esac",
    "done",
    'root="$(cd "$(dirname "$self")/.." && pwd -P)"',
    `exec "$root/node/bin/node" "$root/${entry}" "$@"`,
    "",
  ].join("\n");
}

/** The text of the Windows launcher that runs `entry` with the bundled Node.js. */
export function windowsLauncher(entry) {
  return [
    "@echo off",
    "rem Runs an AI Orchestrator entry point with the Node.js in this runtime.",
    `"%~dp0..\\node\\node.exe" "%~dp0..\\${entry.replace(/\//g, "\\")}" %*`,
    "",
  ].join("\r\n");
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: ["ignore", "inherit", "inherit"], cwd: ROOT, ...options });
}

function pnpm(args) {
  // corepack.cmd on Windows; spawning it needs a shell there.
  const win = process.platform === "win32";
  run(win ? "corepack.cmd" : "corepack", ["pnpm", ...args], { shell: win });
}

function copyDir(from, to) {
  if (!fs.existsSync(from))
    die(`${path.relative(ROOT, from)} is missing; build the workspace first`);
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

/** Removes every `.bin` folder under `dir`. */
function removeBinDirs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === ".bin") fs.rmSync(full, { recursive: true, force: true });
    else removeBinDirs(full);
  }
}

/** Deploys a workspace package with a flat node_modules that holds no symbolic links. */
function deploy(pkg, dir) {
  log(`Deploying ${pkg}`);
  // A hoisted node_modules has real directories instead of links into
  // .pnpm, which the Windows installer and app bundles can't hold.
  pnpm(["--config.node-linker=hoisted", "--filter", pkg, "deploy", "--legacy", "--prod", dir]);
  // Every .bin folder holds links (or .cmd shims) to package binaries that
  // nothing in the runtime runs.
  removeBinDirs(path.join(dir, "node_modules"));
}

async function download(url, file) {
  log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) die(`${url} answered ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

async function stageNode(opts, version, out, work) {
  const name = nodeArchiveName(version, opts.os, opts.arch);
  const base = `https://nodejs.org/dist/v${version}`;
  let archive = opts.nodeArchive;
  let shasums = opts.shasums ? fs.readFileSync(opts.shasums, "utf8") : null;
  if (!archive) {
    archive = path.join(work, name);
    await download(`${base}/${name}`, archive);
    if (!shasums) {
      const sums = path.join(work, "SHASUMS256.txt");
      await download(`${base}/SHASUMS256.txt`, sums);
      shasums = fs.readFileSync(sums, "utf8");
    }
  }
  if (shasums) {
    const want = expectedSha(shasums, path.basename(archive));
    if (!want) die(`SHASUMS256.txt doesn't list ${path.basename(archive)}`);
    const got = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    if (got !== want) die(`${path.basename(archive)} has SHA-256 ${got}, expected ${want}`);
    log(`Checked the SHA-256 of ${path.basename(archive)}`);
  } else {
    log(`warning: not checking ${archive}; pass --shasums SHASUMS256.txt`);
  }
  // TODO(signing): also verify SHASUMS256.txt.asc against the Node.js
  // release keys before a public release.
  const extract = path.join(work, "node");
  fs.mkdirSync(extract, { recursive: true });
  // bsdtar on macOS and Windows reads .zip and .tar.gz; GNU tar reads .tar.xz.
  run("tar", ["-xf", archive, "-C", extract]);
  const top = path.join(extract, name.replace(/\.(zip|tar\.gz|tar\.xz)$/, ""));
  const nodeDir = path.join(out, "node");
  if (opts.os === "win") {
    fs.mkdirSync(nodeDir, { recursive: true });
    fs.copyFileSync(path.join(top, "node.exe"), path.join(nodeDir, "node.exe"));
    const exe = fs.readFileSync(path.join(nodeDir, "node.exe"));
    fs.writeFileSync(path.join(nodeDir, "aio-serverw.exe"), withSubsystem(exe, SUBSYSTEM_GUI));
  } else {
    fs.mkdirSync(path.join(nodeDir, "bin"), { recursive: true });
    fs.copyFileSync(path.join(top, "bin", "node"), path.join(nodeDir, "bin", "node"));
    fs.chmodSync(path.join(nodeDir, "bin", "node"), 0o755);
  }
  fs.copyFileSync(path.join(top, "LICENSE"), path.join(nodeDir, "LICENSE"));
}

function stageShare(out) {
  const share = path.join(out, "share");
  const image = path.join(share, "image");
  log("Staging the image build context");
  const versions = fs.readFileSync(path.join(ROOT, "image", "versions.env"), "utf8");
  const engine = /^AIO_ENGINE_VERSION=(.+)$/m.exec(versions)?.[1];
  const tarball = path.join(ROOT, "image", "dist", `aio-engine-${engine}.tgz`);
  if (!fs.existsSync(tarball)) {
    die(`${path.relative(ROOT, tarball)} is missing; run scripts/build-image.sh --pack-only first`);
  }
  fs.mkdirSync(path.join(image, "dist"), { recursive: true });
  for (const f of ["Dockerfile", "versions.env", ".dockerignore"]) {
    fs.copyFileSync(path.join(ROOT, "image", f), path.join(image, f));
  }
  copyDir(path.join(ROOT, "image", "keeper"), path.join(image, "keeper"));
  fs.rmSync(path.join(image, "keeper", "test-keeper.sh"), { force: true });
  fs.copyFileSync(tarball, path.join(image, "dist", path.basename(tarball)));
  fs.copyFileSync(
    path.join(ROOT, "image", "dist", "engine-identity"),
    path.join(image, "dist", "engine-identity"),
  );
  fs.mkdirSync(path.join(share, "scripts", "lib"), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, "scripts", "build-image.sh"),
    path.join(share, "scripts", "build-image.sh"),
  );
  fs.chmodSync(path.join(share, "scripts", "build-image.sh"), 0o755);
  fs.copyFileSync(
    path.join(ROOT, "scripts", "lib", "common.sh"),
    path.join(share, "scripts", "lib", "common.sh"),
  );
  for (const app of ["boxes", "review"]) {
    copyDir(path.join(ROOT, "apps", app, "dist", "renderer"), path.join(share, "web", app));
  }
}

function stageLaunchers(opts, out) {
  const bin = path.join(out, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const entries = { aio: "cli/dist/main.js", "aio-server": "server/dist/main.js" };
  for (const [name, entry] of Object.entries(entries)) {
    if (opts.os === "win") {
      fs.writeFileSync(path.join(bin, `${name}.cmd`), windowsLauncher(entry));
    } else {
      fs.writeFileSync(path.join(bin, name), posixLauncher(entry), { mode: 0o755 });
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const hostOs = OS_NAMES[process.platform] ?? "linux";
  if (opts.os !== hostOs) {
    die(
      `staging for ${opts.os} needs a ${opts.os} host, since the server's native module is built for the host; this is ${hostOs}`,
    );
  }
  const hostArch = process.arch === "arm64" ? "arm64" : "x64";
  if (opts.arch !== hostArch && !opts.allowCross) {
    die(
      `staging for ${opts.arch} on ${hostArch} needs --allow-cross and a matching better-sqlite3 build`,
    );
  }
  const version =
    opts.nodeVersion ??
    pinnedNodeVersion(
      fs.readFileSync(path.join(ROOT, "packaging", "runtime", "node-version"), "utf8"),
    );
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

  fs.rmSync(opts.out, { recursive: true, force: true });
  fs.mkdirSync(opts.out, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "aio-stage-"));
  try {
    deploy("@aio/server", path.join(opts.out, "server"));
    deploy("@aio/cli", path.join(opts.out, "cli"));
    await stageNode(opts, version, opts.out, work);
    stageShare(opts.out);
    stageLaunchers(opts, opts.out);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  fs.writeFileSync(
    path.join(opts.out, "runtime.json"),
    `${JSON.stringify({ version: pkg.version, node: version, os: opts.os, arch: opts.arch }, null, 2)}\n`,
  );
  log(`Staged the runtime in ${opts.out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => die(err.message));
}
