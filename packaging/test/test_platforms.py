"""Packaging checks for the macOS and Windows builds.

Run from the repository root:

    python3 -m unittest discover -s packaging/test -v

The tests parse the electron-builder configurations and the entitlements,
run the pure parts of scripts/stage-runtime.mjs and the PE subsystem tool
under Node.js, and run a staged POSIX launcher through a symbolic link.
They can't build a macOS or Windows package; see docs/platforms.md.
"""

import json
import os
import pathlib
import plistlib
import re
import shutil
import struct
import subprocess
import tempfile
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
APPS = ("boxes", "review")


def node(script):
    """Runs an ES module SCRIPT with Node.js from the repository root and returns its output, newlines untouched."""
    if shutil.which("node") is None:
        raise unittest.SkipTest("node is not on PATH")
    return subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        check=True,
        capture_output=True,
    ).stdout.decode()


def builder_config(app):
    with open(ROOT / f"apps/{app}/electron-builder.yml", encoding="utf-8") as f:
        return yaml.safe_load(f)


class ElectronBuilderTest(unittest.TestCase):
    def test_linux_stays_a_dir_target(self):
        for app in APPS:
            self.assertEqual(builder_config(app)["linux"]["target"], "dir", app)

    def test_mac_builds_dmg_and_zip_with_the_hardened_runtime(self):
        for app in APPS:
            mac = builder_config(app)["mac"]
            self.assertEqual(mac["target"], ["dmg", "zip"], app)
            self.assertTrue(mac["hardenedRuntime"], app)
            for key in ("entitlements", "entitlementsInherit"):
                self.assertTrue((ROOT / "apps" / app / mac[key]).resolve().is_file(), key)

    def test_windows_builds_a_per_user_nsis_installer(self):
        for app in APPS:
            config = builder_config(app)
            self.assertEqual(config["win"]["target"], "nsis", app)
            self.assertFalse(config["nsis"]["perMachine"], app)
            self.assertFalse(config["nsis"]["oneClick"], app)

    def test_boxes_carries_the_staged_runtime_on_mac_and_windows_only(self):
        config = builder_config("boxes")
        self.assertNotIn("extraResources", config["linux"])
        for platform in ("mac", "win"):
            (resource,) = config[platform]["extraResources"]
            self.assertEqual(resource["to"], "runtime")
            self.assertEqual(resource["from"], "../../packaging/build/runtime/${os}-${arch}")

    def test_review_registers_its_link_scheme(self):
        config = builder_config("review")
        for platform in ("mac", "win"):
            schemes = [s for p in config[platform]["protocols"] for s in p["schemes"]]
            self.assertEqual(schemes, ["aio-review"], platform)

    def test_app_ids_match_the_windows_app_user_model_ids(self):
        for app in APPS:
            logic = (ROOT / f"apps/{app}/electron/logic.ts").read_text()
            match = re.search(r'APP_USER_MODEL_ID = "([^"]+)"', logic)
            self.assertIsNotNone(match, app)
            self.assertEqual(builder_config(app)["appId"], match.group(1), app)

    def test_entitlements_allow_jit_for_electron_and_node(self):
        with open(ROOT / "packaging/mac/entitlements.plist", "rb") as f:
            entitlements = plistlib.load(f)
        self.assertTrue(entitlements["com.apple.security.cs.allow-jit"])
        self.assertTrue(entitlements["com.apple.security.cs.disable-library-validation"])

    def test_only_the_boxes_main_process_may_send_apple_events(self):
        key = "com.apple.security.automation.apple-events"

        def entitlements(app, setting):
            with open(ROOT / "apps" / app / builder_config(app)["mac"][setting], "rb") as f:
                return plistlib.load(f)

        boxes = entitlements("boxes", "entitlements")
        self.assertTrue(boxes[key])
        self.assertEqual({k: v for k, v in boxes.items() if k != key},
                         entitlements("review", "entitlements"))
        self.assertNotIn(key, entitlements("boxes", "entitlementsInherit"))
        self.assertNotIn(key, entitlements("review", "entitlements"))

    def test_boxes_explains_why_it_sends_apple_events(self):
        info = builder_config("boxes")["mac"]["extendInfo"]
        self.assertIn("Terminal", info["NSAppleEventsUsageDescription"])


class RuntimeStagingTest(unittest.TestCase):
    def test_the_bundled_node_is_major_version_22_like_the_deb(self):
        lines = [
            l for l in (ROOT / "packaging/runtime/node-version").read_text().splitlines()
            if l and not l.startswith("#")
        ]
        self.assertRegex(lines[-1], r"^22\.\d+\.\d+$")
        self.assertIn("REQUIRED_NODE_MAJOR=22", (ROOT / "scripts/build-deb.sh").read_text())

    def test_archive_names_and_checksums(self):
        out = node(
            'import * as s from "./scripts/stage-runtime.mjs";'
            'console.log(JSON.stringify({'
            ' mac: s.nodeArchiveName("22.1.0", "mac", "arm64"),'
            ' win: s.nodeArchiveName("22.1.0", "win", "x64"),'
            ' linux: s.nodeArchiveName("22.1.0", "linux", "x64"),'
            ' sha: s.expectedSha("aa  node-a.zip\\nbb  node-b.zip\\n", "node-b.zip"),'
            ' none: s.expectedSha("aa  node-a.zip\\n", "node-c.zip"),'
            ' pinned: s.pinnedNodeVersion("# c\\n22.3.4\\n")}))'
        )
        self.assertEqual(
            json.loads(out),
            {
                "mac": "node-v22.1.0-darwin-arm64.tar.gz",
                "win": "node-v22.1.0-win-x64.zip",
                "linux": "node-v22.1.0-linux-x64.tar.xz",
                "sha": "bb",
                "none": None,
                "pinned": "22.3.4",
            },
        )

    def test_windows_launcher_uses_crlf_and_backslashes(self):
        out = node(
            'import { windowsLauncher } from "./scripts/stage-runtime.mjs";'
            'process.stdout.write(windowsLauncher("cli/dist/main.js"));'
        )
        self.assertIn("\r\n", out)
        self.assertIn('"%~dp0..\\node\\node.exe" "%~dp0..\\cli\\dist\\main.js" %*', out)

    def test_posix_launcher_follows_a_symbolic_link(self):
        launcher = node(
            'import { posixLauncher } from "./scripts/stage-runtime.mjs";'
            'process.stdout.write(posixLauncher("cli/dist/main.js"));'
        )
        with tempfile.TemporaryDirectory() as tmp:
            runtime = pathlib.Path(tmp, "My Runtime")
            (runtime / "node/bin").mkdir(parents=True)
            (runtime / "bin").mkdir()
            fake_node = runtime / "node/bin/node"
            fake_node.write_text('#!/bin/sh\nprintf "%s|" "$@"\n')
            fake_node.chmod(0o755)
            aio = runtime / "bin/aio"
            aio.write_text(launcher)
            aio.chmod(0o755)
            link = pathlib.Path(tmp, "aio")
            link.symlink_to(aio)
            out = subprocess.run(
                [str(link), "box", "a b"], check=True, capture_output=True, text=True
            ).stdout
        self.assertEqual(out, f"{runtime.resolve()}/cli/dist/main.js|box|a b|")


class PeSubsystemTest(unittest.TestCase):
    @staticmethod
    def fake_pe(magic):
        buf = bytearray(0x200)
        buf[0:2] = b"MZ"
        struct.pack_into("<I", buf, 0x3C, 0x80)
        buf[0x80:0x84] = b"PE\0\0"
        struct.pack_into("<H", buf, 0x80 + 24, magic)
        struct.pack_into("<H", buf, 0x80 + 24 + 68, 3)
        return buf

    def test_sets_the_subsystem_of_pe32_and_pe32plus_images(self):
        if shutil.which("node") is None:
            self.skipTest("node is not on PATH")
        tool = ROOT / "scripts/lib/pe-subsystem.mjs"
        for magic in (0x10B, 0x20B):
            with tempfile.TemporaryDirectory() as tmp:
                exe = pathlib.Path(tmp, "node.exe")
                exe.write_bytes(self.fake_pe(magic))
                read = lambda: subprocess.run(
                    ["node", str(tool), str(exe)], check=True, capture_output=True, text=True
                ).stdout.strip()
                self.assertEqual(read(), "3")
                subprocess.run(["node", str(tool), str(exe), "gui"], check=True)
                self.assertEqual(read(), "2")
                data = exe.read_bytes()
                self.assertEqual(len(data), 0x200)

    def test_refuses_a_file_that_isnt_a_pe_image(self):
        if shutil.which("node") is None:
            self.skipTest("node is not on PATH")
        with tempfile.TemporaryDirectory() as tmp:
            junk = pathlib.Path(tmp, "junk")
            junk.write_bytes(b"\0" * 0x100)
            result = subprocess.run(
                ["node", str(ROOT / "scripts/lib/pe-subsystem.mjs"), str(junk)],
                capture_output=True,
                text=True,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not an MZ executable", result.stderr)


class BuildScriptsTest(unittest.TestCase):
    def test_build_mac_prints_its_steps_on_any_host(self):
        out = subprocess.run(
            [str(ROOT / "scripts/build-mac.sh"), "--print", "--arch", "arm64", "--no-install"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        self.assertNotIn("install --frozen-lockfile", out)
        self.assertIn("stage-runtime.mjs --os mac --arch arm64", out)
        self.assertIn("electron-builder --mac --arm64", out)

    def test_build_scripts_are_executable(self):
        for script in ("scripts/build-mac.sh", "scripts/stage-runtime.mjs"):
            self.assertTrue(os.access(ROOT / script, os.X_OK), script)

    def test_build_win_stages_for_windows_with_git_bash(self):
        text = (ROOT / "scripts/build-win.ps1").read_text()
        self.assertIn("'scripts/stage-runtime.mjs', '--os', 'win'", text)
        self.assertIn("'scripts/build-image.sh', '--pack-only'", text)
        self.assertIn("Set-StrictMode -Version Latest", text)

    def test_shellcheck(self):
        shellcheck = shutil.which("shellcheck")
        if shellcheck is None:
            if os.environ.get("AIO_REQUIRE_TOOLS") == "1":
                raise AssertionError("shellcheck is required (AIO_REQUIRE_TOOLS=1) but not on PATH")
            self.skipTest("shellcheck is not on PATH")
        subprocess.run([shellcheck, str(ROOT / "scripts/build-mac.sh")], check=True)


if __name__ == "__main__":
    unittest.main()
