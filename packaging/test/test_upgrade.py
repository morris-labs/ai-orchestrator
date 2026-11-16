"""Package upgrade behavior through executable stand-ins; never replaces HOME."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class UpgradeInstallTest(unittest.TestCase):
    def run_hook(self, previous='1.0.0', fail=False):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            log = tmp / 'calls'
            programs = {
                'getent': "printf 'alice:x:1000:1000::/home/alice:/bin/bash\\nbob:x:1001:1001::/home/bob:/bin/bash\\ncarol:x:1002:1002::/home/carol:/bin/bash\\n'",
                'systemctl': 'echo "systemctl $*" >> "$CALLS"; case "$*" in *carol@*) exit 1;; esac',
                'runuser': 'echo "runuser $*" >> "$CALLS"; echo "Upgrade summary: box restored"; if [ "$FAIL" = 1 ]; then exit 1; fi',
                'update-desktop-database': 'exit 0',
                'gtk-update-icon-cache': 'exit 0',
            }
            for name, body in programs.items():
                path = tmp / name
                path.write_text('#!/bin/sh\n' + body + '\n')
                path.chmod(0o755)
            env = dict(os.environ, PATH=f'{tmp}:{os.environ["PATH"]}', CALLS=str(log), FAIL=str(int(fail)))
            result = subprocess.run(['sh', str(ROOT / 'packaging/deb/scripts/postinst'), 'configure', previous], env=env, capture_output=True, text=True)
            return result, log.read_text() if log.exists() else ''

    def test_upgrade_runs_for_each_enabled_user_and_prints_summary(self):
        result, calls = self.run_hook()
        self.assertEqual(result.returncode, 0, result.stderr)
        for user in ['alice', 'bob']:
            self.assertIn(f'--user --machine={user}@ restart aio-server', calls)
            self.assertIn(f'runuser -u {user} -- aio upgrade --timeout 300', calls)
        self.assertNotIn('runuser -u carol', calls)
        self.assertIn('box restored', result.stdout)

    def test_failure_fails_configure_and_retry_runs_again(self):
        for _ in range(2):
            result, _ = self.run_hook(fail=True)
            self.assertNotEqual(result.returncode, 0)

    def test_fresh_install_keeps_enable_instructions(self):
        result, calls = self.run_hook(previous='')
        self.assertEqual(result.returncode, 0)
        self.assertIn('enable --now aio-server', result.stdout)
        self.assertEqual(calls, '')


class CheckoutUpgradeTest(unittest.TestCase):
    def test_builds_then_installs_exact_artifact_without_fetching(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            scripts = tmp / 'scripts'
            scripts.mkdir()
            import shutil
            shutil.copy2(ROOT / 'scripts/upgrade.sh', scripts / 'upgrade.sh')
            log = tmp / 'calls'
            programs = {
                scripts / 'build-deb.sh': 'echo build >> "$CALLS"; mkdir -p "$2"; touch "$2/ai-orchestrator_1.0.0_amd64.deb"',
                scripts / 'install-server-unit.sh': 'echo migrate >> "$CALLS"',
                tmp / 'sudo': 'echo "$*" >> "$CALLS"',
                tmp / 'git': 'echo unexpected-git >> "$CALLS"; exit 1',
            }
            for path, body in programs.items():
                path.write_text('#!/bin/sh\n' + body + '\n')
                path.chmod(0o755)
            env = dict(os.environ, PATH=f'{tmp}:{os.environ["PATH"]}', CALLS=str(log))
            result = subprocess.run([str(scripts / 'upgrade.sh')], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            lines = log.read_text().splitlines()
            self.assertEqual(lines[:2], ['build', 'migrate'])
            self.assertRegex(lines[2], r'^apt install --reinstall /.+/ai-orchestrator_1.0.0_amd64.deb$')
            self.assertEqual(len(lines), 3)
