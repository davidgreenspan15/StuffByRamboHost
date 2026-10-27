#!/usr/bin/env python3
"""Trusted-Mac-only encrypted export to the existing iCloud Drive allowance.

No database credential leaves this Mac. No plaintext database enters iCloud.
The private setup exporter/helper must already exist; this script creates no
credential and changes no paid plan. It never deletes prior backups. Reaching
the bounded storage cap fails closed for operator retention review.
"""
import argparse
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import sys
import time

BASE = Path.home() / 'Library/Application Support/Gesture Flow Production Setup'
CLOUD_PARENT = Path.home() / 'Library/Mobile Documents/com~apple~CloudDocs/DatabaseBackups'
CLOUD = CLOUD_PARENT / 'GestureFlow'
PYTHON = '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3'
MAX_ARCHIVE = 20 * 1024 * 1024
MAX_TOTAL = 160 * 1024 * 1024
SAFE_BACKUP = re.compile(r'^live-[0-9]{8}T[0-9]{6}Z$')


def checked_directory(path):
    if not path.is_dir() or path.is_symlink() or path.resolve() != path.absolute():
        raise RuntimeError('backup_directory_invalid')


def terminate_child(child, grace_seconds=45):
    if child.poll() is None:
        child.terminate()
    try:
        return child.communicate(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        # Only after allowing the child to clean up its own private resources.
        os.killpg(child.pid, signal.SIGKILL)
        return child.communicate(timeout=5)


def command(args, timeout=30, failure_codes=()):
    child = subprocess.Popen([str(x) for x in args], stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, text=True,
                             start_new_session=True)
    try:
        output, _ = child.communicate(timeout=timeout)
    except BaseException:
        terminate_child(child)
        raise
    if child.returncode:
        # Only predeclared operational codes may cross the private helper
        # boundary. Never log arbitrary stdout, stderr or exception text.
        try:
            code = json.loads(output).get('error')
        except (ValueError, AttributeError):
            code = None
        if isinstance(code, str) and code in failure_codes:
            raise RuntimeError(code)
        raise RuntimeError('backup_subprocess_failed')
    return output


def status(path, operation='status'):
    result = json.loads(command([BASE / 'commerce-icloud-status', operation, path],
                                failure_codes=('icloud_status_unavailable',)))
    if result.get('conflict'):
        raise RuntimeError('icloud_conflict_requires_review')
    if result.get('error'):
        raise RuntimeError('icloud_status_unavailable')
    if result.get('uploadError'):
        raise RuntimeError('icloud_upload_error')
    return result


def wait_status(paths, key, timeout=180):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            complete = all(status(path).get(key) is True for path in paths)
        except RuntimeError as error:
            # iCloud can briefly report an upload error immediately after a
            # local copy. Confirm recovery within the same bounded wait; a
            # persistent error or exhausted quota never records success.
            if str(error) not in ('icloud_upload_error', 'icloud_status_unavailable'):
                raise
            complete = False
        if complete:
            return
        time.sleep(5)
    raise RuntimeError('icloud_confirmation_timeout')


def cloud_capacity():
    checked_directory(CLOUD_PARENT)
    if CLOUD.exists():
        checked_directory(CLOUD)
        total = 0
        for folder in CLOUD.iterdir():
            if not SAFE_BACKUP.fullmatch(folder.name):
                raise RuntimeError('unexpected_cloud_backup_entry')
            checked_directory(folder)
            for asset in folder.iterdir():
                if asset.is_symlink() or not asset.is_file():
                    raise RuntimeError('unexpected_cloud_backup_asset')
                total += asset.stat().st_size
        if total + MAX_ARCHIVE + 65536 > MAX_TOTAL:
            raise RuntimeError('backup_storage_cap_requires_retention_review')
    return True


def manifest_and_archive(folder):
    checked_directory(folder)
    if not SAFE_BACKUP.fullmatch(folder.name):
        raise RuntimeError('backup_name_invalid')
    manifest = json.loads((folder / 'manifest.json').read_text())
    name = manifest.get('archive', '')
    if Path(name).name != name or not re.fullmatch(r'commerce-[0-9]{8}T[0-9]{6}Z\.dump\.age', name):
        raise RuntimeError('backup_archive_name_invalid')
    archive = folder / name
    if archive.is_symlink() or not 100 <= archive.stat().st_size <= MAX_ARCHIVE:
        raise RuntimeError('backup_archive_invalid')
    with archive.open('rb') as stream:
        if not stream.read(32).startswith(b'age-encryption.org/v1\n'):
            raise RuntimeError('backup_is_not_age_encrypted')
    if hashlib.sha256(archive.read_bytes()).hexdigest() != manifest.get('sha256'):
        raise RuntimeError('backup_integrity_failed')
    if manifest.get('environment') != 'live':
        raise RuntimeError('backup_environment_invalid')
    return manifest, archive


def record_health(manifest):
    created = datetime.datetime.strptime(manifest['createdAt'], '%Y%m%dT%H%M%SZ').replace(tzinfo=datetime.timezone.utc)
    now = datetime.datetime.now(datetime.timezone.utc)
    if not 0 <= (now - created).total_seconds() <= 26 * 3600:
        raise RuntimeError('backup_age_outside_health_window')
    module = BASE / 'production-ops-db.py'
    if module.is_symlink() or module.stat().st_uid != os.getuid():
        raise RuntimeError('private_database_helper_invalid')
    spec = importlib.util.spec_from_file_location('local_backup_database', module)
    database = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(database)
    db = database.Database()
    try:
        db.execute('''insert into commerce_ops.backup_checks(singleton,backup_created_at,verified_at)
          values(true,$1::timestamptz,$2::timestamptz)
          on conflict(singleton) do update set backup_created_at=excluded.backup_created_at,
            verified_at=excluded.verified_at
          where commerce_ops.backup_checks.backup_created_at <= excluded.backup_created_at''',
          (created.isoformat(), now.isoformat()))
    finally:
        db.close()


def run(args):
    checked_directory(BASE)
    if BASE.stat().st_mode & 0o077:
        raise RuntimeError('private_setup_permissions_invalid')
    cloud_capacity()
    if args.check:
        print(json.dumps({'prepared': True, 'newCredentials': False, 'newPaidPlan': False}))
        return
    if args.record_health_only:
        previous = json.loads((BASE / 'local-backup-last-success.json').read_text())
        if not SAFE_BACKUP.fullmatch(previous['backup']):
            raise RuntimeError('last_success_backup_name_invalid')
        folder = CLOUD / previous['backup']
        manifest, archive = manifest_and_archive(folder)
        if manifest['sha256'] != previous['sha256']:
            raise RuntimeError('last_success_archive_mismatch')
        wait_status([archive, folder / 'manifest.json'], 'uploaded')
        record_health(manifest)
        print(json.dumps({'backupHealthRecorded': True, 'newBackup': False}))
        return
    # Every scheduled or login invocation attempts a new backup. An age-based
    # skip with a daily schedule can otherwise create an almost two-day gap.
    with (BASE / 'local-backup.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.existing:
            folder = args.existing.absolute()
            if folder.parent != BASE / 'encrypted-backups':
                raise RuntimeError('backup_source_outside_private_root')
        else:
            result = json.loads(command([PYTHON, BASE / 'manual-encrypted-backup.py', 'live'], timeout=240,
                failure_codes=('keychain_read_failed', 'backup_identity_not_available_to_native_helper',
                               'source_metadata_failed', 'export_permission_denied',
                               'encrypted_export_failed', 'backup_exceeds_free_storage_cap')))
            folder = Path(result['output'])
            if folder.parent != BASE / 'encrypted-backups':
                raise RuntimeError('backup_source_outside_private_root')
        manifest, archive = manifest_and_archive(folder)
        CLOUD.mkdir(mode=0o700, exist_ok=True)
        destination = CLOUD / folder.name
        if destination.exists():
            # Resume confirmation after a sync interruption only for exact
            # already-copied bytes; never overwrite or repair an unknown item.
            existing_manifest, existing_archive = manifest_and_archive(destination)
            if existing_manifest != manifest or existing_archive.name != archive.name:
                raise RuntimeError('existing_cloud_backup_conflict')
        else:
            destination.mkdir(mode=0o700)
            for source in (archive, folder / 'manifest.json'):
                target = destination / source.name
                with source.open('rb') as reader, target.open('xb') as writer:
                    shutil.copyfileobj(reader, writer)
                    writer.flush()
                    os.fsync(writer.fileno())
                os.chmod(target, 0o600)
        assets = [destination / archive.name, destination / 'manifest.json']
        wait_status(assets, 'uploaded')
        manifest_and_archive(destination)
        if args.download_drill:
            for path in assets:
                status(path, 'evict')
            for path in assets:
                status(path, 'download')
            wait_status(assets, 'downloaded')
            manifest_and_archive(destination)
            result = json.loads(command([
                PYTHON, '/Users/ramigreenspan/Desktop/mac-apps/GestureControl/scripts/ops/commerce_restore_drill.py',
                '--backup', destination, '--pg-bin', '/opt/homebrew/opt/postgresql@17/bin',
                '--identity-service', 'codex.gesture-flow.commerce-backup.age-v2',
                '--identity-account', 'ramigreenspan', '--identity-helper', BASE / 'store-backup-key-v2',
            ], timeout=240))
            if result.get('logicalRestore') != 'passed':
                raise RuntimeError('cloud_backup_restore_failed')
            expected = manifest.get('sourceCounts', {})
            if not expected or any(result.get(key) != value for key, value in expected.items()):
                raise RuntimeError('cloud_restore_counts_mismatch')
        evidence = {
            'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'backup': folder.name, 'cloudUploaded': True, 'encryptedBytes': archive.stat().st_size,
            'sha256': manifest['sha256'], 'downloadAndRestorePassed': bool(args.download_drill),
            'newCredentials': False, 'newPaidPlan': False,
        }
        record_health(manifest)
        evidence['backupHealthRecorded'] = True
        (BASE / 'local-backup-last-success.json').write_text(json.dumps(evidence, indent=2) + '\n')
        print(json.dumps(evidence))


def main():
    os.umask(0o077)
    # Bound even filesystem/Keychain/iCloud consent stalls in background jobs.
    # The supervisor never reads protected folders. It asks the worker to stop
    # first so an active restore drill can shut down its temporary PostgreSQL.
    if '--worker' not in sys.argv[1:]:
        child = subprocess.Popen([PYTHON, __file__, '--worker', *sys.argv[1:]],
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 text=True, start_new_session=True)
        try:
            output, _ = child.communicate(timeout=600)
            print(output, end='')
            return child.returncode
        except subprocess.TimeoutExpired:
            terminate_child(child, grace_seconds=60)
            print(json.dumps({'backup': 'failed', 'error': 'local_backup_timeout'}))
            return 2
    def interrupted(_signal, _frame):
        raise RuntimeError('local_backup_terminated')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--existing', type=Path, help='Private live archive for first cloud verification')
    parser.add_argument('--download-drill', action='store_true')
    parser.add_argument('--record-health-only', action='store_true', help='Record verified existing cloud backup after health SQL installation')
    args = parser.parse_args()
    try:
        run(args)
    except Exception as error:
        code = str(error) if type(error) is RuntimeError and re.fullmatch(r'[a-z_]+', str(error)) else 'local_backup_failed'
        print(json.dumps({'backup': 'failed', 'error': code}))
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
