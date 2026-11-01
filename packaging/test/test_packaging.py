"""Packaging checks for AI Orchestrator.

Run from the repository root:

    python3 -m unittest discover -s packaging/test -v

The tests parse the nfpm configuration and the GitHub workflows, check that
the image pins, desktop entries, icons, and scripts agree with each other,
and, when the tools are on PATH, lint with actionlint, shellcheck, and
hadolint and build a placeholder .deb with nfpm. A missing tool skips its
test unless AIO_REQUIRE_TOOLS=1 is set, as CI sets it.
"""

import configparser
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
NFPM = ROOT / "packaging/deb/nfpm.yaml"
WORKFLOWS = ROOT / ".github/workflows"
DOCKERFILE = ROOT / "image/Dockerfile"
VERSIONS = ROOT / "image/versions.env"
APPS = ("boxes", "review")
REQUIRE_TOOLS = os.environ.get("AIO_REQUIRE_TOOLS") == "1"
SHELL_SCRIPTS = [
    ROOT / "scripts/build-image.sh",
    ROOT / "scripts/build-deb.sh",
    ROOT / "scripts/bump-versions.sh",
    ROOT / "scripts/set-version.sh",
    ROOT / "scripts/install-server-unit.sh",
    ROOT / "scripts/install-dev-apparmor.sh",
    ROOT / "scripts/lib/common.sh",
    ROOT / "packaging/deb/scripts/postinst",
    ROOT / "packaging/deb/scripts/prerm",
    ROOT / "packaging/deb/scripts/postrm",
    ROOT / "image/keeper/keeper.sh",
    ROOT / "image/keeper/start-session.sh",
    ROOT / "image/keeper/test-keeper.sh",
]


def tool(name):
    """Returns the path of tool NAME, or skips the test when it's missing."""
    path = shutil.which(name)
    if path is None:
        if REQUIRE_TOOLS:
            raise AssertionError(f"{name} is required (AIO_REQUIRE_TOOLS=1) but not on PATH")
        raise unittest.SkipTest(f"{name} is not on PATH")
    return path


def load_yaml(path):
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def read_versions():
    return read_pins(VERSIONS)


def read_pins(path):
    pairs = {}
    for line in path.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        key, _, value = line.partition("=")
        pairs[key] = value
    return pairs


def workflow_triggers(doc):
    # PyYAML reads the bare key `on` as the boolean True.
    return doc.get("on", doc.get(True))


class NfpmConfigTest(unittest.TestCase):
    def setUp(self):
        self.config = load_yaml(NFPM)

    def test_identity(self):
        self.assertEqual(self.config["name"], "ai-orchestrator")
        self.assertEqual(self.config["arch"], "amd64")
        self.assertEqual(self.config["version"], "${AIO_VERSION}")

    def test_depends(self):
        depends = self.config["depends"]
        for dep in ("nodejs (>= 22)", "docker.io | docker-ce", "tmux", "git", "openssh-client"):
            self.assertIn(dep, depends)

    def test_contents_are_unique_and_staged(self):
        dsts = [c["dst"] for c in self.config["contents"]]
        self.assertEqual(len(dsts), len(set(dsts)), "duplicate destinations")
        for entry in self.config["contents"]:
            if entry.get("type") == "symlink":
                continue
            self.assertTrue(entry["src"].startswith("root/"), entry["src"])
            self.assertEqual(entry["src"], "root" + entry["dst"], "src must mirror dst under root/")

    def test_required_destinations(self):
        dsts = {c["dst"] for c in self.config["contents"]}
        expected = {
            "/usr/lib/ai-orchestrator/server",
            "/usr/lib/ai-orchestrator/cli",
            "/usr/bin/aio",
            "/usr/bin/aio-server",
            "/usr/lib/systemd/user/aio-server.service",
            "/usr/share/ai-orchestrator/image",
        }
        for app in APPS:
            expected |= {
                f"/usr/lib/ai-orchestrator/{app}",
                f"/usr/bin/aio-{app}",
                f"/usr/share/applications/aio-{app}.desktop",
                f"/usr/share/icons/hicolor/scalable/apps/aio-{app}.svg",
            }
        self.assertLessEqual(expected, dsts)

    def test_unit_is_hardened(self):
        parser = configparser.ConfigParser(interpolation=None, strict=False)
        parser.optionxform = str
        parser.read(ROOT / "packaging/systemd/aio-server.service")
        self.assertEqual(parser["Service"]["UMask"], "0077")
        self.assertEqual(parser["Service"]["NoNewPrivileges"], "yes")
        self.assertEqual(parser["Unit"]["StartLimitIntervalSec"], "0")

    def test_maintainer_scripts_exist(self):
        for key, src in self.config["scripts"].items():
            name = pathlib.Path(src).name
            path = ROOT / "packaging/deb/scripts" / name
            self.assertTrue(path.is_file(), f"{key}: {path} missing")
            self.assertTrue(os.access(path, os.X_OK), f"{path} not executable")


class WorkflowTest(unittest.TestCase):
    def test_every_workflow_parses(self):
        files = sorted(WORKFLOWS.glob("*.yml"))
        self.assertEqual([f.name for f in files], ["ci.yml", "release.yml"])
        for f in files:
            doc = load_yaml(f)
            self.assertIn("jobs", doc, f.name)
            self.assertIsNotNone(workflow_triggers(doc), f.name)

    def test_ci_runs_workspace_checks(self):
        doc = load_yaml(WORKFLOWS / "ci.yml")
        triggers = workflow_triggers(doc)
        self.assertIn("push", triggers)
        self.assertIn("pull_request", triggers)
        runs = " ".join(s.get("run", "") for s in doc["jobs"]["workspace"]["steps"])
        for command in ("pnpm install --frozen-lockfile", "pnpm build", "pnpm lint", "pnpm typecheck", "pnpm test"):
            self.assertIn(command, runs)
        packaging = " ".join(s.get("run", "") for s in doc["jobs"]["packaging"]["steps"])
        self.assertIn("scripts/set-version.sh --check", packaging)
        self.assertIn("packaging/test", packaging)

    def test_release_builds_the_deb_only_on_linux(self):
        doc = load_yaml(WORKFLOWS / "release.yml")
        self.assertEqual(workflow_triggers(doc)["push"]["tags"], ["v[0-9]*.[0-9]*.[0-9]*"])
        self.assertEqual(set(doc["jobs"]), {"ci", "deb", "release"})
        # The .deb is built only after the CI workflow passes.
        self.assertEqual(doc["jobs"]["ci"]["uses"], "./.github/workflows/ci.yml")
        self.assertIn("workflow_call", workflow_triggers(load_yaml(WORKFLOWS / "ci.yml")))
        self.assertIn("ci", doc["jobs"]["deb"]["needs"])
        for name in ("deb", "release"):
            runs_on = doc["jobs"][name]["runs-on"]
            self.assertTrue(runs_on.startswith("ubuntu"), runs_on)
        runs = " ".join(s.get("run", "") for s in doc["jobs"]["deb"]["steps"])
        self.assertIn("scripts/build-deb.sh", runs)
        self.assertNotIn("docker push", runs)
        files = next(s for s in doc["jobs"]["release"]["steps"] if "with" in s and "files" in s["with"])
        self.assertIn("dist/*.deb", files["with"]["files"])
        self.assertIn("dist/*.tgz", files["with"]["files"])

    def test_checkouts_do_not_persist_credentials(self):
        for f in sorted(WORKFLOWS.glob("*.yml")):
            for job in load_yaml(f)["jobs"].values():
                for step in job.get("steps", []):
                    if step.get("uses", "").startswith("actions/checkout@"):
                        self.assertIs(step.get("with", {}).get("persist-credentials"), False, f.name)

    def test_actions_are_pinned_by_commit(self):
        # A tag can be moved to other code; a commit SHA can't. A workflow in
        # this repository is called by its path at the same commit.
        for f in sorted(WORKFLOWS.glob("*.yml")):
            uses = re.findall(r"(?m)^\s*-?\s*uses:\s*(.*)$", f.read_text())
            self.assertTrue(uses, f.name)
            for line in uses:
                if line.startswith("./.github/workflows/"):
                    continue
                self.assertRegex(line, r"^[\w.-]+/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$", f"{f.name}: {line}")

    def test_downloads_are_checksummed(self):
        # Every tool a workflow downloads is saved to a file and checked with
        # sha256sum against a pinned *_SHA256 value before it runs.
        for f in sorted(WORKFLOWS.glob("*.yml")):
            doc = load_yaml(f)
            pins = doc.get("env", {})
            for job in doc["jobs"].values():
                for step in job.get("steps", []):
                    run = step.get("run", "")
                    if "curl" not in run:
                        continue
                    self.assertNotRegex(run, r"curl[^\n]*\|", f"{f.name}: a download is piped before its check")
                    self.assertIn("sha256sum -c", run, f"{f.name}: {step.get('name')}")
                    for var in re.findall(r"\$\{?([A-Z_]+_SHA256)\}?", run):
                        self.assertRegex(pins.get(var, ""), r"^[0-9a-f]{64}$", f"{f.name}: {var}")
                    downloads = len(re.findall(r"\bcurl\b", run))
                    self.assertEqual(downloads, len(set(re.findall(r"\$([A-Z_]+_SHA256)", run))), f.name)

    def test_ci_runs_the_keeper_tests(self):
        doc = load_yaml(WORKFLOWS / "ci.yml")
        runs = [s.get("run", "") for s in doc["jobs"]["packaging"]["steps"]]
        self.assertIn("image/keeper/test-keeper.sh", runs)

    def test_actionlint(self):
        actionlint = tool("actionlint")
        subprocess.run([actionlint, *map(str, sorted(WORKFLOWS.glob("*.yml")))], check=True)


class ImageTest(unittest.TestCase):
    def test_base_is_pinned_by_digest(self):
        text = DOCKERFILE.read_text()
        self.assertRegex(text, r"(?m)^FROM ubuntu:26\.04@sha256:[0-9a-f]{64}$")
        self.assertRegex(text, r"(?m)^# Looked up \d{4}-\d{2}-\d{2} from registry-1\.docker\.io")

    def test_every_pin_is_a_build_arg(self):
        args = set(re.findall(r"(?m)^ARG ([A-Z_]+)", DOCKERFILE.read_text()))
        pins = read_versions()
        self.assertEqual(
            set(pins),
            {"AIO_ENGINE_VERSION", "CLAUDE_CODE_VERSION", "CODEX_VERSION", "COPILOT_VERSION", "NVM_VERSION"},
        )
        for key, value in pins.items():
            self.assertIn(key, args)
            self.assertRegex(value, r"^[A-Za-z0-9.+-]+$", key)
        for key in ("USER_NAME", "CACHEBUST", "CACHEBUST_PACKAGES"):
            self.assertIn(key, args)

    def test_image_contract(self):
        text = DOCKERFILE.read_text()
        self.assertIn("/etc/aio-engine-version", text)
        self.assertIn("/etc/claude-code-version", text)
        self.assertIn("/etc/codex-version", text)
        self.assertIn("/etc/copilot-version", text)
        self.assertIn("/usr/local/lib/ai-orchestrator/", text)
        self.assertIn("keeper/keeper.sh keeper/start-session.sh", text)
        self.assertRegex(text, r"(?m)^HEALTHCHECK .*\n.*/api/v1/health")
        self.assertNotRegex(text, r"(?m)^CMD ")
        # The CLI layer comes after the package layer, and the engine after both.
        order = [text.index(s) for s in ("ARG CACHEBUST_PACKAGES", "ARG CACHEBUST=", "COPY dist/")]
        self.assertEqual(order, sorted(order))

    def test_no_passwordless_sudo(self):
        # Container root is host root on the bind mounts, so the image must
        # not let the container user become root without a password. The
        # server's root setup step installs any sudo rule at start.
        text = DOCKERFILE.read_text()
        self.assertNotIn("NOPASSWD", text)
        self.assertNotRegex(text, r"> */etc/sudoers")
        self.assertIn("rm -f /etc/sudoers.d/aio", text)
        self.assertIn("usermod -p '!' \"${USER_NAME}\"", text)

    def test_secret_client_in_image(self):
        # The image installs the secrets broker client from the engine's own
        # package.json bin, on the system Node.js, in a root-owned directory.
        text = DOCKERFILE.read_text()
        engine_step = text[text.index("COPY dist/"):text.index("COPY --chmod=0755 keeper/")]
        self.assertIn("bin['aio-secret']", engine_step)
        self.assertIn("> /usr/local/bin/aio-secret", engine_step)
        self.assertIn("chmod 0755 /usr/local/bin/aio-secret", engine_step)
        self.assertIn("exec /usr/bin/node", engine_step)
        package = json.loads((ROOT / "packages/engine/package.json").read_text())
        self.assertEqual(package["bin"]["aio-secret"], "./dist/secret-main.js")
        self.assertTrue((ROOT / "packages/engine/src/secret-main.ts").is_file())

    def test_engine_wrappers_check_their_bin_entries(self):
        # Runs the Dockerfile's bin lookups against a package without the
        # bins: each lookup must fail the build rather than write a wrapper
        # that runs `.../engine/undefined`.
        if not os.access("/usr/bin/node", os.X_OK):
            self.skipTest("/usr/bin/node is missing")
        text = DOCKERFILE.read_text()
        engine_step = text[text.index("COPY dist/"):text.index("COPY --chmod=0755 keeper/")]
        lines = [line.strip() for line in engine_step.splitlines()]

        def lookup(var):
            start = next(i for i, line in enumerate(lines) if line.startswith(f"{var}="))
            end = next(i for i in range(start, len(lines)) if lines[i].startswith("printf "))
            body = [line.removesuffix("\\").strip().removesuffix("&&").strip() for line in lines[start:end]]
            return " && ".join(body)

        cases = {
            "engine_bin": [{"bin": {"other": "./x.js"}}, {"bin": {"aio-engine": "./missing.js"}}],
            "secret_bin": [{"bin": {"other": "./x.js"}}, {"bin": {"aio-secret": "./missing.js"}}],
        }
        with tempfile.TemporaryDirectory() as tmp:
            pkg = pathlib.Path(tmp)
            (pkg / "dist").mkdir()
            (pkg / "dist/main.js").write_text("")
            for var, packages in cases.items():
                script = f"engine_pkg={pkg} && {lookup(var)}"
                for package in packages:
                    (pkg / "package.json").write_text(json.dumps(package))
                    result = subprocess.run(["sh", "-c", script], capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0, f"{var}: {package}")
                    self.assertIn("bin", result.stderr)
                good = "aio-engine" if var == "engine_bin" else "aio-secret"
                (pkg / "package.json").write_text(json.dumps({"bin": {good: "./dist/main.js"}}))
                subprocess.run(["sh", "-c", script], check=True, capture_output=True)

    def test_engine_dependencies_are_locked(self):
        # The engine's dependencies must come from pnpm-lock.yaml at pack
        # time, never from a fresh registry resolve during the image build.
        text = DOCKERFILE.read_text()
        engine_step = text[text.index("COPY dist/"):text.index("COPY --chmod=0755 keeper/")]
        self.assertNotIn("npm install", engine_step)
        self.assertNotIn("--no-package-lock", engine_step)
        self.assertIn('tar -xzf "/tmp/aio-dist/aio-engine-${AIO_ENGINE_VERSION}.tgz"', engine_step)
        self.assertIn("node_modules", engine_step)
        script = (ROOT / "scripts/build-image.sh").read_text()
        self.assertRegex(script, r"--filter @aio/engine deploy --legacy --prod --frozen-lockfile")
        self.assertNotIn(" pack --pack-destination", script)

    def test_hadolint(self):
        hadolint = tool("hadolint")
        subprocess.run(
            [hadolint, "--config", str(ROOT / "image/.hadolint.yaml"), str(DOCKERFILE)], check=True
        )

    def test_build_image_print_in_installed_layout(self):
        # Mimics /usr/share/ai-orchestrator: scripts/ and image/ side by side, no
        # workspace, the engine tarball already in image/dist/.
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            shutil.copytree(ROOT / "scripts", tmp / "scripts")
            (tmp / "image/keeper").mkdir(parents=True)
            (tmp / "image/dist").mkdir()
            shutil.copy(DOCKERFILE, tmp / "image")
            shutil.copy(VERSIONS, tmp / "image")
            for name in ("keeper.sh", "start-session.sh"):
                (tmp / "image/keeper" / name).write_text("#!/bin/sh\n")
            version = read_versions()["AIO_ENGINE_VERSION"]
            (tmp / f"image/dist/aio-engine-{version}.tgz").write_bytes(b"")
            out = subprocess.run(
                [str(tmp / "scripts/build-image.sh"), "--print", "--tag", "aio-test"],
                check=True, capture_output=True, text=True,
            ).stdout
            self.assertIn("docker build -t aio-test", out)
            self.assertIn("USER_NAME=", out)
            for key, value in read_versions().items():
                self.assertIn(f"--build-arg {key}={value}", out)

            (tmp / f"image/dist/aio-engine-{version}.tgz").unlink()
            failed = subprocess.run(
                [str(tmp / "scripts/build-image.sh"), "--print"], capture_output=True, text=True
            )
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("is missing", failed.stderr)


class VersionTest(unittest.TestCase):
    def test_versions_agree(self):
        subprocess.run([str(ROOT / "scripts/set-version.sh"), "--check"], check=True)

    def test_set_version_updates_every_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            (tmp / "image").mkdir()
            shutil.copy(VERSIONS, tmp / "image")
            (tmp / "package.json").write_text('{\n  "name": "aio-workspace",\n  "version": "0.9.0"\n}\n')
            for rel, name in (("packages/server", "@aio/server"), ("tools/sample-repo", "fixture")):
                (tmp / rel).mkdir(parents=True)
                (tmp / rel / "package.json").write_text(
                    f'{{\n  "name": "{name}",\n  "version": "0.9.0",\n'
                    f'  "engines": {{\n    "version": "keep"\n  }}\n}}\n'
                )
            env = {**os.environ, "AIO_ROOT": str(tmp)}
            script = str(ROOT / "scripts/set-version.sh")

            mismatch = subprocess.run([script, "--check"], env=env, capture_output=True, text=True)
            self.assertNotEqual(mismatch.returncode, 0)
            self.assertIn("version mismatch", mismatch.stderr)

            bad = subprocess.run([script, "1.0"], env=env, capture_output=True, text=True)
            self.assertNotEqual(bad.returncode, 0)

            subprocess.run([script, "1.1.0-rc.1"], env=env, check=True, capture_output=True)
            subprocess.run([script, "--check"], env=env, check=True, capture_output=True)
            self.assertIn('"version": "1.1.0-rc.1"', (tmp / "packages/server/package.json").read_text())
            self.assertIn('"version": "keep"', (tmp / "packages/server/package.json").read_text())
            self.assertIn('"version": "0.9.0"', (tmp / "tools/sample-repo/package.json").read_text())
            self.assertIn("AIO_ENGINE_VERSION=1.1.0-rc.1", (tmp / "image/versions.env").read_text())


class DocsTest(unittest.TestCase):
    def test_changelog_has_the_release_section(self):
        version = read_versions()["AIO_ENGINE_VERSION"].split("-")[0]
        text = (ROOT / "CHANGELOG.md").read_text()
        self.assertRegex(text, rf"(?m)^## \[{re.escape(version)}\]")

    def test_user_docs_exist_and_links_resolve(self):
        names = (
            "install", "daily-flow", "review-pipeline", "policy", "secrets",
            "troubleshooting", "migration-3x", "architecture",
        )
        pages = [ROOT / "README.md", ROOT / "CHANGELOG.md"] + [ROOT / f"docs/{n}.md" for n in names]
        for page in pages:
            self.assertTrue(page.is_file(), page)
            for target in re.findall(r"\]\(([^)#]+\.md)(?:#[^)]*)?\)", page.read_text()):
                self.assertTrue((page.parent / target).is_file(), f"{page.name} links to missing {target}")
        self.assertIn("## Migrating from 3.x", (ROOT / "README.md").read_text())

    def test_committed_logs_hold_no_host_paths(self):
        # A log copied from a real host lists its home directory and real
        # project names. Commit redacted excerpts with /home/USER instead.
        if not (ROOT / ".git").exists():
            self.skipTest("not a git checkout")
        files = subprocess.run(
            ["git", "-C", str(ROOT), "ls-files", "-z", "--", "*.log"],
            check=True, capture_output=True, text=True,
        ).stdout.split("\0")
        for name in filter(None, files):
            text = (ROOT / name).read_text(errors="replace")
            self.assertNotRegex(text, r"/home/(?!USER/)[A-Za-z_][\w.-]*/", name)

    def test_policy_example_parses(self):
        text = (ROOT / "docs/policy.md").read_text()
        example = re.search(r"```yaml\n(.*?)```", text, re.S).group(1)
        policy = yaml.safe_load(example)
        allowed = {"version", "riskPaths", "rules", "tests", "lint", "environmentLimits", "groupSizeLimit"}
        self.assertEqual(policy["version"], 1)
        self.assertLessEqual(set(policy), allowed)
        for rule in policy["rules"]:
            self.assertLessEqual(set(rule), {"id", "text", "appliesTo"})


class DesktopTest(unittest.TestCase):
    def test_entries_match_launchers_and_icons(self):
        config = load_yaml(NFPM)
        symlinks = {c["dst"]: c["src"] for c in config["contents"] if c.get("type") == "symlink"}
        for app in APPS:
            parser = configparser.ConfigParser(interpolation=None)
            parser.optionxform = str
            parser.read(ROOT / f"packaging/desktop/aio-{app}.desktop")
            entry = parser["Desktop Entry"]
            launcher = entry["Exec"].split()[0]
            self.assertEqual(launcher, f"/usr/bin/aio-{app}")
            self.assertEqual(symlinks[launcher], f"/usr/lib/ai-orchestrator/{app}/aio-{app}")
            self.assertEqual(entry["Icon"], f"aio-{app}")
            self.assertEqual(entry["StartupWMClass"], f"aio-{app}")
            self.assertEqual(entry["Type"], "Application")

    def test_window_class_matches_entry_and_desktop_name(self):
        for app in APPS:
            name = f"aio-{app}"
            parser = configparser.ConfigParser(interpolation=None)
            parser.optionxform = str
            parser.read(ROOT / f"packaging/desktop/{name}.desktop")
            wm_class = parser["Desktop Entry"]["StartupWMClass"]
            package = json.loads((ROOT / f"apps/{app}/package.json").read_text())
            self.assertEqual(package["desktopName"], f"{wm_class}.desktop")
            main = (ROOT / f"apps/{app}/electron/main.ts").read_text()
            match = re.search(r'commandLine\.appendSwitch\("class", "([^"]+)"\)', main)
            self.assertIsNotNone(match, f"apps/{app}/electron/main.ts must set the class switch")
            self.assertEqual(match.group(1), wm_class)
            builder = load_yaml(ROOT / f"apps/{app}/electron-builder.yml")
            self.assertEqual(builder["linux"].get("executableName", wm_class), wm_class)

    def test_icons_are_well_formed(self):
        for app in APPS:
            path = ROOT / f"packaging/icons/aio-{app}.svg"
            text = path.read_text()
            self.assertTrue(text.startswith("<svg"), f"{path.name}: the root element must come first")
            ET.fromstring(text)
            for comment in re.findall(r"<!--(.*?)-->", text, re.S):
                self.assertNotIn("--", comment, f"{path.name}: '--' inside a comment")

    def test_icons_are_generated(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = pathlib.Path(tmp) / "make-icons.py"
            shutil.copy(ROOT / "packaging/icons/make-icons.py", script)
            subprocess.run(["python3", "-I", str(script)], check=True, capture_output=True)
            for app in APPS:
                self.assertEqual(
                    (pathlib.Path(tmp) / f"aio-{app}.svg").read_text(),
                    (ROOT / f"packaging/icons/aio-{app}.svg").read_text(),
                    "run packaging/icons/make-icons.py and commit the SVG files",
                )

    def test_apparmor_profiles_name_the_app_binaries(self):
        for app in APPS:
            text = (ROOT / f"packaging/deb/apparmor/aio-{app}").read_text()
            self.assertIn(f"profile aio-{app} /usr/lib/ai-orchestrator/{app}/aio-{app}", text)
            self.assertIn("userns,", text)


class ScriptsTest(unittest.TestCase):
    def test_scripts_are_executable(self):
        for path in SHELL_SCRIPTS:
            if path.name == "common.sh":
                continue
            self.assertTrue(os.access(path, os.X_OK), path)

    def test_shellcheck(self):
        shellcheck = tool("shellcheck")
        subprocess.run([shellcheck, "-x", *map(str, SHELL_SCRIPTS)], check=True, cwd=ROOT)

    def test_build_deb_resolves_a_relative_out_dir(self):
        # nfpm runs from the staging directory, so a relative --out such as
        # the release workflow's `--out dist` must be made absolute first.
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(
                [str(ROOT / "scripts/build-deb.sh"), "--out", "dist", "--help"],
                cwd=tmp, check=True, capture_output=True, text=True,
            )
            self.assertIn(f"into {os.path.realpath(tmp)}/dist.", result.stdout)

    def test_host_checks_keep_the_token_out_of_argv(self):
        # Other local users can read every process's argument list with ps,
        # so the server token must reach curl and the WebSocket client
        # through files only.
        token = "SYNTHETIC_TOKEN_0123456789abcdef"
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            (tmp / "data").mkdir()
            (tmp / "data/server.token").write_text(token + "\n")
            (tmp / "bin").mkdir()
            argv_log = tmp / "argv.log"
            for name in ("curl", "node"):
                fake = tmp / "bin" / name
                fake.write_text(
                    "#!/bin/sh\n"
                    f'printf "%s\\n" "$*" >> "{argv_log}"\n'
                    'for a in "$@"; do case $a in @*) cat "${a#@}" >> "$HEADERS_LOG" ;; esac; done\n'
                )
                fake.chmod(0o755)
            env = {
                **os.environ,
                "PATH": f"{tmp / 'bin'}:{os.environ['PATH']}",
                "AIO_DATA_DIR": str(tmp / "data"),
                "BOX_ID": "aio-agent-SYNTHETIC",
                "PROJECT": "SYNTHETIC_PROJECT",
                "HEADERS_LOG": str(tmp / "headers.log"),
            }
            script = str(ROOT / "packages/server/test/host/host-checks.sh")
            for step in ("routes", "events", "terminal", "secrets"):
                subprocess.run([script, step], env=env, check=True, capture_output=True)
            argv = argv_log.read_text()
            self.assertIn("ws-client.mjs", argv)
            self.assertIn(str(tmp / "data/server.token"), argv)
            self.assertNotIn(token, argv)
            self.assertIn(f"Authorization: Bearer {token}", (tmp / "headers.log").read_text())

    def test_build_image_removes_its_deploy_directory_on_failure(self):
        # A pnpm deploy that fails after writing node_modules must not leave
        # the temporary directory behind.
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            shutil.copytree(ROOT / "scripts", tmp / "scripts")
            (tmp / "image").mkdir()
            shutil.copy(DOCKERFILE, tmp / "image")
            shutil.copy(VERSIONS, tmp / "image")
            (tmp / "pnpm-workspace.yaml").write_text("packages: []\n")
            (tmp / "packages/engine").mkdir(parents=True)
            (tmp / "packages/engine/package.json").write_text("{}\n")
            (tmp / "bin").mkdir()
            fake = tmp / "bin/pnpm"
            fake.write_text(
                "#!/bin/sh\n"
                'case " $* " in *" deploy "*) ;; *) exit 0 ;; esac\n'
                'for a in "$@"; do last=$a; done\n'
                'mkdir -p "$last/node_modules/left-behind"\n'
                "exit 1\n"
            )
            fake.chmod(0o755)
            scratch = tmp / "tmpdir"
            scratch.mkdir()
            env = {**os.environ, "PATH": f"{tmp / 'bin'}:{os.environ['PATH']}", "TMPDIR": str(scratch)}
            result = subprocess.run(
                [str(tmp / "scripts/build-image.sh"), "--pack-only"], env=env, capture_output=True, text=True
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(list(scratch.iterdir()), [])

    def test_pnpm_build_allowlist_is_in_one_place(self):
        # pnpm 10 reads onlyBuiltDependencies from pnpm-workspace.yaml; a copy
        # in package.json could drift from it unnoticed.
        package = json.loads((ROOT / "package.json").read_text())
        self.assertNotIn("onlyBuiltDependencies", package.get("pnpm", {}))
        workspace = load_yaml(ROOT / "pnpm-workspace.yaml")
        self.assertIn("better-sqlite3", workspace["onlyBuiltDependencies"])

    def _installed_layout(self, tmp):
        """Mimics /usr/share/ai-orchestrator in TMP and returns the engine version."""
        shutil.copytree(ROOT / "scripts", tmp / "scripts")
        (tmp / "image/keeper").mkdir(parents=True)
        (tmp / "image/dist").mkdir()
        shutil.copy(DOCKERFILE, tmp / "image")
        shutil.copy(VERSIONS, tmp / "image")
        for name in ("keeper.sh", "start-session.sh"):
            (tmp / "image/keeper" / name).write_text("#!/bin/sh\n")
        version = read_versions()["AIO_ENGINE_VERSION"]
        (tmp / f"image/dist/aio-engine-{version}.tgz").write_bytes(b"")
        return version

    def _fake_npm(self, tmp):
        bin_dir = tmp / "bin"
        bin_dir.mkdir()
        fake = bin_dir / "npm"
        fake.write_text(
            "#!/bin/sh\n"
            'case "$2" in\n'
            "  @anthropic-ai/claude-code) echo 9.1.0 ;;\n"
            "  @openai/codex) echo 9.2.0 ;;\n"
            "  @github/copilot) echo 9.3.0 ;;\n"
            "  *) exit 1 ;;\n"
            "esac\n"
        )
        fake.chmod(0o755)
        return {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}"}

    def test_build_image_update_cli_writes_the_latest_versions(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            self._installed_layout(tmp)
            env = self._fake_npm(tmp)
            # Without the flag, the build keeps the pinned versions.
            plain = subprocess.run(
                [str(tmp / "scripts/build-image.sh"), "--print"],
                check=True, capture_output=True, text=True, env=env,
            ).stdout
            self.assertIn(f"CLAUDE_CODE_VERSION={read_versions()['CLAUDE_CODE_VERSION']}", plain)
            self.assertNotIn("9.1.0", plain)
            # With the flag, the script resolves from npm, writes the pins, and builds with them.
            out = subprocess.run(
                [str(tmp / "scripts/build-image.sh"), "--update-cli", "--print"],
                check=True, capture_output=True, text=True, env=env,
            ).stdout
            for arg in ("CLAUDE_CODE_VERSION=9.1.0", "CODEX_VERSION=9.2.0", "COPILOT_VERSION=9.3.0"):
                self.assertIn(f"--build-arg {arg}", out)
            self.assertIn("--build-arg CACHEBUST=", out)
            # --print leaves the pins alone.
            self.assertEqual((tmp / "image/versions.env").read_text(), VERSIONS.read_text())

    def test_build_image_update_cli_saves_pins_and_survives_a_read_only_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            self._installed_layout(tmp)
            env = self._fake_npm(tmp)
            # A fake docker lets the script finish its build step.
            (tmp / "bin/docker").write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
            (tmp / "bin/docker").chmod(0o755)
            saved = subprocess.run(
                [str(tmp / "scripts/build-image.sh"), "--update-cli"],
                check=True, capture_output=True, text=True, env=env,
            ).stdout
            self.assertIn("CODEX_VERSION=9.2.0", saved)
            pins = read_pins(tmp / "image/versions.env")
            self.assertEqual(pins["CLAUDE_CODE_VERSION"], "9.1.0")
            self.assertEqual(pins["COPILOT_VERSION"], "9.3.0")
            self.assertEqual(pins["NVM_VERSION"], read_versions()["NVM_VERSION"])

            shutil.copy(VERSIONS, tmp / "image/versions.env")
            (tmp / "image/versions.env").chmod(0o444)
            if os.access(tmp / "image/versions.env", os.W_OK):
                self.skipTest("the file stays writable, as for root")
            result = subprocess.run(
                [str(tmp / "scripts/build-image.sh"), "--update-cli"],
                check=True, capture_output=True, text=True, env=env,
            )
            self.assertIn("CLAUDE_CODE_VERSION=9.1.0", result.stdout)
            self.assertIn("isn't writable", result.stderr)
            self.assertEqual((tmp / "image/versions.env").read_text(), VERSIONS.read_text())

    def test_build_image_update_cli_is_documented_in_help(self):
        out = subprocess.run(
            [str(ROOT / "scripts/build-image.sh"), "--help"], check=True, capture_output=True, text=True
        ).stdout
        self.assertIn("--update-cli", out)
        self.assertIn("latest", out)
        self.assertIn("versions.env", out)

    def test_image_records_the_engine_content_hash(self):
        text = DOCKERFILE.read_text()
        self.assertIn("dist/identity", text)
        self.assertIn("/etc/aio-engine-version", text)
        self.assertIn("engine_ver}\" \"${engine_hash", text)

    def test_bump_versions_keeps_the_registry_token_out_of_argv(self):
        script = (ROOT / "scripts/bump-versions.sh").read_text()
        self.assertNotRegex(script, r'-H "Authorization: Bearer')
        self.assertIn("-H @-", script)

    def test_postinst_asks_for_a_restart_on_upgrade(self):
        # PATH holds only cat, so the script skips AppArmor and the desktop
        # caches; no chrome-sandbox helper exists outside an installed host.
        if pathlib.Path("/usr/lib/ai-orchestrator").exists():
            self.skipTest("aio is installed on this host")
        restart = "systemctl --user daemon-reload && systemctl --user restart aio-server"
        with tempfile.TemporaryDirectory() as tmp:
            (pathlib.Path(tmp) / "cat").symlink_to(shutil.which("cat"))
            env = {"PATH": tmp}
            postinst = str(ROOT / "packaging/deb/scripts/postinst")
            upgrade = subprocess.run(
                [postinst, "configure", "1.0.0"], env=env, check=True, capture_output=True, text=True
            ).stdout
            self.assertIn(restart, upgrade)
            self.assertNotIn("enable --now", upgrade)
            fresh = subprocess.run(
                [postinst, "configure", ""], env=env, check=True, capture_output=True, text=True
            ).stdout
            self.assertIn("systemctl --user enable --now aio-server", fresh)
            self.assertNotIn(restart, fresh)

    def test_postrm_clears_the_apparmor_cache_on_purge(self):
        config = load_yaml(NFPM)
        self.assertEqual(config["scripts"]["postremove"], "maint/postrm")
        self.assertIn('"$ROOT/packaging/deb/scripts/postrm"', (ROOT / "scripts/build-deb.sh").read_text())
        text = (ROOT / "packaging/deb/scripts/postrm").read_text()
        purge = text[text.index("purge)"):text.index(";;")]
        self.assertIn('rm -f /var/cache/apparmor/*/"aio-$app"', purge)
        if pathlib.Path("/usr/lib/ai-orchestrator").exists():
            self.skipTest("aio is installed on this host")
        with tempfile.TemporaryDirectory() as tmp:
            for name in ("rm",):
                (pathlib.Path(tmp) / name).symlink_to(shutil.which(name))
            for action in ("remove", "purge", "upgrade"):
                subprocess.run(
                    [str(ROOT / "packaging/deb/scripts/postrm"), action], env={"PATH": tmp}, check=True
                )

    def test_postinst_sets_the_setuid_bit_only_without_a_profile(self):
        text = (ROOT / "packaging/deb/scripts/postinst").read_text()
        self.assertEqual(text.count("chmod 4755"), 1)
        setuid = text.index("chmod 4755")
        branch = text.rindex("if ", 0, setuid)
        self.assertIn('"$loaded" = 1', text[branch:setuid])
        self.assertIn('"$userns_off" = 0', text[branch:setuid])
        self.assertNotIn("apparmor_parser -r -T -W \"/etc/apparmor.d/aio-$app\" || true", text)

    def test_build_deb_fails_clearly_without_tools(self):
        # With an empty PATH apart from bash and coreutils, the script must
        # stop at the first missing tool with a message that names it.
        with tempfile.TemporaryDirectory() as tmp:
            bindir = pathlib.Path(tmp)
            for name in ("bash", "dirname", "env"):
                (bindir / name).symlink_to(shutil.which(name))
            result = subprocess.run(
                [str(ROOT / "scripts/build-deb.sh")],
                env={"PATH": str(bindir), "HOME": os.environ.get("HOME", "/")},
                capture_output=True, text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("node is not installed", result.stderr)


class SourceUnitTest(unittest.TestCase):
    """scripts/install-server-unit.sh, which installs the unit for a checkout."""

    SCRIPT = ROOT / "scripts/install-server-unit.sh"
    MAIN = ROOT / "packages/server/dist/main.js"

    def setUp(self):
        self.node = tool("node")
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = pathlib.Path(tmp.name)
        self.home = self.tmp / "home"
        self.unit_dir = self.home / ".config/systemd/user"
        self.dropin_dir = self.unit_dir / "aio-server.service.d"
        # systemctl is a fake that logs its arguments, first on PATH, so
        # nothing reaches the real user manager.
        bindir = self.tmp / "bin"
        bindir.mkdir()
        self.systemctl_log = self.tmp / "systemctl.log"
        fake = bindir / "systemctl"
        fake.write_text(f'#!/bin/sh\nprintf "%s\\n" "$*" >> "{self.systemctl_log}"\n')
        fake.chmod(0o755)
        self.env = {
            **{k: v for k, v in os.environ.items() if not k.startswith("AIO_")},
            "PATH": f"{bindir}:{os.path.dirname(self.node)}:/usr/bin:/bin",
            "AIO_HOME": str(self.home),
        }

    def run_script(self, *args):
        return subprocess.run(
            [str(self.SCRIPT), *args], env=self.env, check=True, capture_output=True, text=True
        )

    def test_print_changes_nothing(self):
        out = self.run_script("--print", "--data-dir", "/srv/data").stdout
        node = subprocess.run(
            [self.node, "-p", "process.execPath"], check=True, capture_output=True, text=True
        ).stdout.strip()
        self.assertIn(f"# {self.dropin_dir}/source-checkout.conf\n", out)
        self.assertIn(f'Environment="PATH={os.path.dirname(node)}:%h/.local/bin:', out)
        self.assertIn(f"{self.MAIN} --data-dir /srv/data install-service", out)
        self.assertFalse(self.home.exists())
        self.assertFalse(self.systemctl_log.exists())

    def test_install_keeps_an_existing_drop_in(self):
        # The workspace build makes dist/, and the packaging job doesn't run
        # it, so this test needs no tool and skips even in CI.
        if not self.MAIN.exists():
            self.skipTest("packages/server/dist is missing; run corepack pnpm -r build")
        self.dropin_dir.mkdir(parents=True)
        op_conf = "[Service]\nEnvironmentFile=%h/.config/aio/op.env\n"
        (self.dropin_dir / "op.conf").write_text(op_conf)

        self.run_script()

        self.assertEqual((self.dropin_dir / "op.conf").read_text(), op_conf)
        self.assertEqual(
            self.systemctl_log.read_text().splitlines(),
            ["--user daemon-reload", "--user enable --now aio-server.service"],
        )
        unit = (self.unit_dir / "aio-server.service").read_text().splitlines()
        exec_start = [line.split("=", 1)[1] for line in unit if line.startswith("ExecStart=")]
        self.assertEqual(len(exec_start), 1)
        node, main, *rest = exec_start[0].split(" ")
        self.assertTrue(os.path.samefile(node, self.node), node)
        self.assertEqual(main, str(self.MAIN))
        self.assertEqual(rest, [])
        # The unit sets no environment file and no PATH, so the drop-ins'
        # settings are the only ones.
        self.assertFalse([line for line in unit if line.startswith("EnvironmentFile=")])
        self.assertEqual(
            [line for line in unit if line.startswith("Environment=")], ["Environment=NODE_ENV=production"]
        )
        path_conf = (self.dropin_dir / "source-checkout.conf").read_text()
        self.assertIn(f'Environment="PATH={os.path.dirname(node)}:', path_conf)


class DevAppArmorTest(unittest.TestCase):
    """scripts/install-dev-apparmor.sh, which writes profiles for a checkout."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        # The space and the @ check the quoting of the attachment path; pnpm
        # store directories always hold an @.
        self.tmp = pathlib.Path(tmp.name)
        self.make_checkout("check out")
        # sudo and apparmor_parser are fakes that log their arguments, so
        # nothing reaches the host even if --print runs either.
        bindir = self.tmp / "bin"
        bindir.mkdir()
        self.log = self.tmp / "calls.log"
        # The fake sudo runs its command as the current user, so writes land
        # in the temporary profile directory below.
        for name, tail in (("sudo", 'exec "$@"\n'), ("apparmor_parser", "")):
            fake = bindir / name
            fake.write_text(f'#!/bin/sh\nprintf "{name} %s\\n" "$*" >> "{self.log}"\n{tail}')
            fake.chmod(0o755)
        self.profile_dir = self.tmp / "apparmor.d"
        self.profile_dir.mkdir()
        self.env = {
            **os.environ,
            "PATH": f"{bindir}:{os.environ['PATH']}",
            "AIO_APPARMOR_DIR": str(self.profile_dir),
        }

    def make_checkout(self, dirname):
        """Copies the script, its helpers, and the templates to a checkout."""
        self.root = self.tmp / dirname
        for rel in (
            "scripts/install-dev-apparmor.sh",
            "scripts/ensure-electron.sh",
            "scripts/lib/common.sh",
        ):
            (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / rel, self.root / rel)
        shutil.copytree(ROOT / "packaging/deb/apparmor", self.root / "packaging/deb/apparmor")

    def add_electron(self, app, version):
        """Links apps/APP/node_modules/electron to a fake pnpm store entry."""
        pkg = self.root / f"node_modules/.pnpm/electron@{version}/node_modules/electron"
        (pkg / "dist").mkdir(parents=True, exist_ok=True)
        (pkg / "path.txt").write_text("electron")
        (pkg / "dist/electron").write_text("placeholder\n")
        link = self.root / f"apps/{app}/node_modules/electron"
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(os.path.relpath(pkg, link.parent))
        return pkg / "dist/electron"

    def run_script(self, *args, check=True):
        return subprocess.run(
            [str(self.root / "scripts/install-dev-apparmor.sh"), *args],
            env=self.env, check=check, capture_output=True, text=True,
        )

    def profiles(self, out):
        """Splits --print output into {file: profile text}."""
        result = {}
        prefix = f"# {self.profile_dir}/"
        for block in out.split(f"\n\n{prefix}"):
            header, _, body = block.removeprefix(prefix).partition("\n")
            result[header] = body
        return result

    def link_electron(self, app, binary):
        """Links apps/APP/node_modules/electron to the store entry of BINARY."""
        pkg = binary.parent.parent
        link = self.root / f"apps/{app}/node_modules/electron"
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(pkg)

    def test_checkouts_that_share_a_binary_share_its_profile(self):
        # Two checkouts that use one pnpm store get one profile, which names
        # both, and removing it from one checkout leaves it for the other.
        binary = self.add_electron("boxes", "45.1.0")
        self.add_electron("review", "45.1.0")
        first = self.root
        (name, text), = self.profiles(self.run_script("--print").stdout).items()
        (self.profile_dir / name).write_text(text)

        self.make_checkout("second")
        second = self.root
        for app in APPS:
            self.link_electron(app, binary)
        shared = self.profiles(self.run_script("--print").stdout)[name]
        first_mark = f"# aio-dev checkout: {os.path.realpath(first)}\n"
        second_mark = f"# aio-dev checkout: {os.path.realpath(second)}\n"
        self.assertTrue(shared.startswith(second_mark + first_mark), shared)
        (self.profile_dir / name).write_text(shared)

        self.run_script("--remove")
        left = (self.profile_dir / name).read_text()
        self.assertIn(first_mark, left)
        self.assertNotIn(second_mark, left)

        self.root = first
        self.run_script("--remove")
        self.assertFalse((self.profile_dir / name).exists())

    def test_print_shares_one_profile_between_the_apps(self):
        binary = self.add_electron("boxes", "45.1.0")
        self.add_electron("review", "45.1.0")
        out = self.run_script("--print").stdout
        profiles = self.profiles(out)
        self.assertEqual(len(profiles), 1, out)
        (name, text), = profiles.items()
        self.assertRegex(name, r"^aio-dev-[0-9a-f]{12}$")
        self.assertIn(f"# aio-dev checkout: {os.path.realpath(self.root)}\n", text)
        self.assertIn(f'profile {name} "{binary}" flags=(unconfined) {{\n', text)
        self.assertIn("  userns,\n", text)
        self.assertIn(f"include if exists <local/{name}>", text)
        self.assertIn("abi <abi/4.0>,\n", text)
        self.assertNotIn("/usr/lib/ai-orchestrator", text)
        self.assertFalse(self.log.exists(), "--print must not run sudo or apparmor_parser")

    def test_print_gives_each_binary_its_own_profile(self):
        boxes = self.add_electron("boxes", "45.1.0")
        review = self.add_electron("review", "46.0.0")
        profiles = self.profiles(self.run_script("--print").stdout)
        self.assertEqual(len(profiles), 2)
        attached = sorted(re.search(r'^profile \S+ "([^"]+)"', t, re.M).group(1) for t in profiles.values())
        self.assertEqual(attached, sorted([str(boxes), str(review)]))

    def test_print_escapes_glob_characters(self):
        self.make_checkout("check{out}")
        binary = self.add_electron("boxes", "45.1.0")
        self.add_electron("review", "45.1.0")
        text = next(iter(self.profiles(self.run_script("--print").stdout).values()))
        escaped = str(binary).replace("{", "\\{").replace("}", "\\}")
        self.assertIn(f'"{escaped}" flags=', text)

    def test_missing_install_fails_clearly(self):
        result = self.run_script("--print", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("pnpm install", result.stderr)


class FileModeTest(unittest.TestCase):
    def test_build_script_clears_write_bits_before_nfpm(self):
        text = (ROOT / "scripts/build-deb.sh").read_text()
        chmod = text.index('chmod -R go-w "$R"')
        self.assertLess(chmod, text.index("nfpm package"))
        # Every file staged under $R must exist before the chmod runs.
        self.assertGreater(chmod, text.rindex('"$R/usr/share/ai-orchestrator/scripts/'))

    def test_sandbox_helper_policy_is_consistent(self):
        # The package ships chrome-sandbox as 0755 root-owned, and postinst
        # adds the setuid bit only when the AppArmor profile isn't in use.
        postinst = (ROOT / "packaging/deb/scripts/postinst").read_text()
        self.assertIn("chmod 4755", postinst)
        self.assertIn("chmod 0755", postinst)
        for app in APPS:
            profile = (ROOT / f"packaging/deb/apparmor/aio-{app}").read_text()
            self.assertIn(f"/usr/lib/ai-orchestrator/{app}/aio-{app}", profile)

    def test_no_group_or_other_writable_entries_after_normalizing(self):
        # Mirrors the build script: a tree made under umask 002 has no
        # group- or other-writable entries after chmod -R go-w.
        old = os.umask(0o002)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                root = pathlib.Path(tmp)
                (root / "a/b").mkdir(parents=True)
                (root / "a/b/f").write_text("x")
                (root / "a/chrome-sandbox").write_text("x")
                os.chmod(root / "a/chrome-sandbox", 0o775)
                subprocess.run(["chmod", "-R", "go-w", str(root)], check=True)
                bad = [
                    str(p) for p in [root, *root.rglob("*")]
                    if not p.is_symlink() and p.stat().st_mode & 0o022
                ]
                self.assertEqual(bad, [])
        finally:
            os.umask(old)


class NfpmBuildTest(unittest.TestCase):
    """Builds a placeholder package from nfpm.yaml with real nfpm."""

    def test_placeholder_deb(self):
        nfpm = tool("nfpm")
        dpkg_deb = tool("dpkg-deb")
        config = load_yaml(NFPM)
        with tempfile.TemporaryDirectory() as tmp:
            stage = pathlib.Path(tmp) / "stage"
            for entry in config["contents"]:
                if entry.get("type") == "symlink":
                    continue
                src = stage / entry["src"]
                if entry.get("type") == "tree":
                    src.mkdir(parents=True)
                    (src / "placeholder.txt").write_text("placeholder\n")
                    # pnpm deploy writes relative symlinks into node_modules.
                    (src / "link").symlink_to("placeholder.txt")
                else:
                    src.parent.mkdir(parents=True, exist_ok=True)
                    src.write_text("placeholder\n")
            (stage / "maint").mkdir()
            for name in ("postinst", "prerm", "postrm"):
                shutil.copy(ROOT / "packaging/deb/scripts" / name, stage / "maint")
            deb = pathlib.Path(tmp) / "ai-orchestrator_1.0.0-test_amd64.deb"
            subprocess.run(
                [nfpm, "package", "--config", str(NFPM), "--packager", "deb", "--target", str(deb)],
                cwd=stage, env={**os.environ, "AIO_VERSION": "1.0.0-test"},
                check=True, capture_output=True,
            )
            info = subprocess.run([dpkg_deb, "--field", str(deb)], check=True, capture_output=True, text=True).stdout
            self.assertIn("Package: ai-orchestrator", info)
            self.assertIn("Version: 1.0.0~test", info)
            self.assertIn("Depends: nodejs (>= 22), nodejs (<< 23), docker.io | docker-ce, tmux, git, openssh-client", info)
            listing = subprocess.run([dpkg_deb, "--contents", str(deb)], check=True, capture_output=True, text=True).stdout
            self.assertIn("./usr/bin/aio-boxes -> /usr/lib/ai-orchestrator/boxes/aio-boxes", listing)
            self.assertIn("./usr/lib/ai-orchestrator/server/link -> placeholder.txt", listing)
            self.assertRegex(listing, r"-rwxr-xr-x .* \./usr/bin/aio\n")
            control = subprocess.run([dpkg_deb, "--ctrl-tarfile", str(deb)], check=True, capture_output=True).stdout
            self.assertIn(b"postinst", control)
            self.assertIn(b"conffiles", control)


if __name__ == "__main__":
    unittest.main()
