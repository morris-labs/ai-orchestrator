"""Build entry-point behavior with Docker/npm stand-ins and an installed layout."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ImageUpgradeTest(unittest.TestCase):
    def build(self, mode):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            shutil.copytree(ROOT / 'scripts', tmp / 'scripts')
            image = tmp / 'image'
            (image / 'dist').mkdir(parents=True)
            (image / 'keeper').mkdir()
            for name in ['Dockerfile', 'versions.env']:
                shutil.copy2(ROOT / 'image' / name, image / name)
            before = (image / 'versions.env').read_text()
            version = next(line.split('=', 1)[1] for line in before.splitlines() if line.startswith('AIO_ENGINE_VERSION='))
            (image / 'dist' / f'aio-engine-{version}.tgz').touch()
            for name in ['keeper.sh', 'start-session.sh']:
                (image / 'keeper' / name).touch()
            bin_dir = tmp / 'bin'
            bin_dir.mkdir()
            docker = bin_dir / 'docker'
            docker.write_text('''#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
case "$*" in
  'buildx version') exit 0;;
  'image inspect '*previous) echo previous-image;;
  'image inspect previous-image') exit 0;;
  'image inspect '*) if [ -e "$BUILT" ]; then echo new-image; else echo old-image; fi;;
  # Like the containerd image store: moving the last tag deletes the old image.
  'image tag old-image '*) [ -e "$BUILT" ] && { echo "No such image: old-image" >&2; exit 1; };;
  'build '*)
    [ "$MODE" = fail ] && exit 1
    case "$*" in *CLAUDE_CODE_VERSION=99.0.0*) [ "$MODE" = fallback ] && exit 1;; esac
    touch "$BUILT";;
esac
exit 0
''')
            npm = bin_dir / 'npm'
            npm.write_text("#!/bin/sh\necho 99.0.0\n")
            for program in [docker, npm]:
                program.chmod(0o755)
            env = dict(os.environ, PATH=f'{bin_dir}:{os.environ["PATH"]}', AIO_DATA_DIR=str(tmp / 'data'), CALLS=str(tmp / 'calls'), BUILT=str(tmp / 'built'), MODE=mode)
            result = subprocess.run([str(tmp / 'scripts/build-image.sh'), '--upgrade', '--no-pack', '--uid', '1000', '--gid', '1000', '--user', 'tester'], env=env, text=True, capture_output=True)
            return result, (tmp / 'calls').read_text(), before, (image / 'versions.env').read_text()

    def test_latest_build_updates_pins_and_keeps_one_previous(self):
        result, calls, _, pins = self.build('latest')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('AIO_UPGRADE_IMAGE=latest', result.stdout)
        self.assertIn('CLAUDE_CODE_VERSION=99.0.0', pins)
        self.assertLess(calls.index('image tag aio-agent aio-agent-upgrade:pending'), calls.index('build '))
        self.assertIn('image tag aio-agent-upgrade:pending aio-agent-upgrade:previous', calls)
        self.assertIn('image rm previous-image', calls)
        self.assertIn('image rm aio-agent-upgrade:pending', calls)

    def test_failed_latest_uses_pins_without_changing_them(self):
        result, calls, before, after = self.build('fallback')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('AIO_UPGRADE_IMAGE=pinned', result.stdout)
        self.assertIn('falling back', result.stderr)
        self.assertEqual(before, after)
        builds = [line for line in calls.splitlines() if line.startswith('build ')]
        self.assertEqual(len(builds), 2)
        self.assertIn('CLAUDE_CODE_VERSION=99.0.0', builds[0])
        self.assertNotIn('CLAUDE_CODE_VERSION=99.0.0', builds[1])

    def test_failed_pair_preserves_current_and_previous_images_and_pins(self):
        result, calls, before, after = self.build('fail')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('both the latest and the pinned', result.stderr)
        self.assertNotIn('aio-agent-upgrade:previous', calls.replace('image inspect --format {{.Id}} aio-agent-upgrade:previous', ''))
        self.assertNotIn('image rm previous-image', calls)
        self.assertIn('image rm aio-agent-upgrade:pending', calls)
        self.assertEqual(before, after)
