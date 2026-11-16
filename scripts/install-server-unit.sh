#!/usr/bin/env bash
# Migrate the former checkout service to the installed package command.
# Keep custom service arguments and unrelated credential/settings drop-ins.
set -euo pipefail
UNIT_HOME="${AIO_HOME:-$HOME}"
UNIT_DIR="$UNIT_HOME/.config/systemd/user"
case "${1:-}" in
  --print)
    printf 'Migrate %s/aio-server.service to /usr/bin/aio-server, preserving arguments; remove %s/aio-server.service.d/source-checkout.conf\n' "$UNIT_DIR" "$UNIT_DIR"
    exit 0 ;;
  --remove-only|--upgrade-prepare|--upgrade-finish|'') ;;
  -h|--help)
    echo 'Usage: install-server-unit.sh [--print|--remove-only|--upgrade-prepare|--upgrade-finish]'
    exit 0 ;;
  *) echo 'Use a systemd drop-in for custom settings. See docs/install.md.' >&2; exit 1 ;;
esac
node - "$UNIT_DIR" "${1:-}" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const [dir, phase] = process.argv.slice(2);
const file = path.join(dir, "aio-server.service");
let dataDir;
if (fs.existsSync(file)) {
  const original = fs.readFileSync(file, "utf8");
  const line = original.match(/^ExecStart=(.+)$/m);
  if (!line) throw new Error(`Cannot migrate ${file}: no ExecStart command`);
  // Generated units quote whole words and escape only quotes/backslashes.
  // Parse these words without evaluating shell code or changing argument text.
  const words = [...line[1].matchAll(/"(?:\\.|[^"\\])*"|\S+/g)];
  const decode = (word) => word.startsWith('"')
    ? word.slice(1, -1).replace(/\\(["\\])/g, "$1") : word;
  const argv = words.map((word) => decode(word[0]));
  let prefix;
  if (argv[0] === "/usr/bin/aio-server") prefix = 1;
  else if (path.basename(argv[0]) === "node" && /\/main\.js$/.test(argv[1] ?? "")) prefix = 2;
  else throw new Error(`Cannot safely migrate the ExecStart command in ${file}`);
  const args = argv.slice(prefix);
  const dataIndex = args.indexOf("--data-dir");
  dataDir = dataIndex >= 0 ? args[dataIndex + 1] : args.find((arg) => arg.startsWith("--data-dir="))?.slice(11);
  if (dataDir) dataDir = dataDir.replace(/%%/g, "%");
  if (args.length) {
    const tail = line[1].slice(words[prefix].index);
    const updated = original.replace(line[0], () => `ExecStart=/usr/bin/aio-server ${tail}`);
    fs.writeFileSync(`${file}.tmp`, updated, { mode: 0o644 });
    fs.renameSync(`${file}.tmp`, file);
  } else {
    fs.unlinkSync(file);
  }
}
fs.rmSync(path.join(dir, "aio-server.service.d/source-checkout.conf"), { force: true });
if (phase === "--upgrade-prepare" || phase === "--upgrade-finish") {
  const args = dataDir ? ["--data-dir", dataDir] : [];
  args.push("upgrade", ...(phase === "--upgrade-prepare" ? ["prepare"] : ["--timeout", "300"]));
  const cli = process.env.AIO_UPGRADE_CLI;
  const result = cli
    ? spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" })
    : spawnSync("aio", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
JS
if [[ "${1:-}" == --upgrade-* ]]; then
  exit 0
fi
systemctl --user daemon-reload
if [[ "${1:-}" != --remove-only ]]; then
  systemctl --user enable --now aio-server.service
fi
