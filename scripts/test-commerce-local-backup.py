#!/usr/bin/env python3
"""Offline guard checks; no Keychain, customer data, network, or cloud mutation."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import sys
import subprocess
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('backup', Path(__file__).with_name('commerce-local-backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupGuards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.folder = self.root / 'live-20261026T000000Z'
        self.folder.mkdir()
        self.archive = self.folder / 'commerce-20261026T000000Z.dump.age'
        self.archive.write_bytes(b'age-encryption.org/v1\n' + b'x' * 100)
        self.manifest = {'environment': 'live', 'archive': self.archive.name,
                         'sha256': hashlib.sha256(self.archive.read_bytes()).hexdigest()}
        self.save()

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        (self.folder / 'manifest.json').write_text(json.dumps(self.manifest))

    def test_valid_encrypted_archive(self):
        self.assertEqual(backup.manifest_and_archive(self.folder)[1], self.archive)

    def test_plaintext_rejected_even_with_matching_digest(self):
        self.archive.write_bytes(b'private data' * 20)
        self.manifest['sha256'] = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.save()
        with self.assertRaisesRegex(RuntimeError, 'not_age_encrypted'):
            backup.manifest_and_archive(self.folder)

    def test_integrity_failure(self):
        self.manifest['sha256'] = '0' * 64
        self.save()
        with self.assertRaisesRegex(RuntimeError, 'integrity_failed'):
            backup.manifest_and_archive(self.folder)

    def test_archive_path_escape(self):
        self.manifest['archive'] = '../commerce-20261026T000000Z.dump.age'
        self.save()
        with self.assertRaisesRegex(RuntimeError, 'archive_name_invalid'):
            backup.manifest_and_archive(self.folder)

    def test_symlink_rejected(self):
        target = self.root / 'target.age'
        self.archive.rename(target)
        self.archive.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'archive_invalid'):
            backup.manifest_and_archive(self.folder)

    def test_test_environment_rejected(self):
        self.manifest['environment'] = 'test'
        self.save()
        with self.assertRaisesRegex(RuntimeError, 'environment_invalid'):
            backup.manifest_and_archive(self.folder)

    def test_unknown_cloud_entry_rejected(self):
        previous = backup.CLOUD_PARENT, backup.CLOUD
        try:
            backup.CLOUD_PARENT, backup.CLOUD = self.root, self.root / 'cloud'
            backup.CLOUD.mkdir()
            (backup.CLOUD / 'unrelated').mkdir()
            with self.assertRaisesRegex(RuntimeError, 'unexpected_cloud_backup_entry'):
                backup.cloud_capacity()
        finally:
            backup.CLOUD_PARENT, backup.CLOUD = previous

    def test_recent_login_backup_does_not_skip_next_scheduled_export(self):
        recent = {'backup': 'live-' + backup.datetime.datetime.now(backup.datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'),
                  'cloudUploaded': True}
        (self.root / 'local-backup-last-success.json').write_text(json.dumps(recent))
        args = SimpleNamespace(check=False, record_health_only=False, existing=None, download_drill=False)
        with patch.object(backup, 'BASE', self.root), patch.object(backup, 'cloud_capacity'), \
             patch.object(backup, 'command', side_effect=RuntimeError('export_attempted')) as export:
            with self.assertRaisesRegex(RuntimeError, 'export_attempted'):
                backup.run(args)
            export.assert_called_once()
            self.assertEqual(export.call_args.args[0][-1], 'live')

    def test_timeout_allows_child_finally_cleanup(self):
        marker = self.root / 'child-cleaned'
        script = self.root / 'cooperative-child.py'
        script.write_text('''import pathlib,signal,time,sys
def stop(*_): raise RuntimeError('terminated')
signal.signal(signal.SIGTERM,stop)
try:
 print('ready',flush=True)
 time.sleep(60)
finally: pathlib.Path(sys.argv[1]).write_text('cleaned')
''')
        with self.assertRaises(subprocess.TimeoutExpired):
            backup.command([sys.executable, script, marker], timeout=0.5)
        self.assertEqual(marker.read_text(), 'cleaned')

    def test_private_helper_failure_exposes_only_allowlisted_code(self):
        for output, expected in [
            ('{"error":"encrypted_export_failed"}', 'encrypted_export_failed'),
            ('{"error":"private diagnostic must not escape"}', 'backup_subprocess_failed'),
            ('invalid private diagnostic', 'backup_subprocess_failed'),
            ('["private diagnostic"]', 'backup_subprocess_failed'),
        ]:
            with self.subTest(output=output):
                with self.assertRaisesRegex(RuntimeError, '^' + expected + '$'):
                    backup.command([sys.executable, '-c', 'import sys; print(sys.argv[1]); sys.exit(1)', output],
                                   failure_codes=('encrypted_export_failed',))

    def test_temporary_icloud_error_waits_for_confirmed_upload(self):
        with patch.object(backup, 'status', side_effect=[RuntimeError('icloud_upload_error'),
                    RuntimeError('icloud_status_unavailable'), {'uploaded': True}]) as status, \
             patch.object(backup.time, 'sleep'):
            backup.wait_status([self.archive], 'uploaded')
        self.assertEqual(status.call_count, 3)

    def test_persistent_icloud_error_fails_within_deadline(self):
        with patch.object(backup, 'status', side_effect=RuntimeError('icloud_upload_error')), \
             patch.object(backup.time, 'monotonic', side_effect=[0, 0, 181]), \
             patch.object(backup.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, '^icloud_confirmation_timeout$'):
                backup.wait_status([self.archive], 'uploaded')

    def test_icloud_conflict_fails_immediately(self):
        with patch.object(backup, 'status', side_effect=RuntimeError('icloud_conflict_requires_review')), \
             patch.object(backup.time, 'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError, '^icloud_conflict_requires_review$'):
                backup.wait_status([self.archive], 'uploaded')
        sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
