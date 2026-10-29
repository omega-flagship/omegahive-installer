"""Disabled closed-inventory copy for a future admitted relocation control.

No discovery, subprocess, network, target imports or cleanup is performed.
The caller must independently pin the finalizer receipt, helpers and admission.
This helper produces copy facts only; it does not produce relocation evidence.
"""
from pathlib import Path
import os
import re
import stat
import sys
import time


CI_ROOT = Path('/private/tmp/omegahive-ci-r12')
JOB = CI_ROOT / 'runtime-job'
SOURCE = JOB / 'OmegaHive.bundle'
ATTEMPTS = CI_ROOT / 'runtime-relocation-attempts'
COPY_ENABLED = False
EXPECTED_UID = None


class Refused(RuntimeError):
    pass


def need(value, reason):
    if not value:
        raise Refused(reason)


def directory_identity(info):
    return [info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode)]


def entry_identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def capture_rows(finalization, package, contract, tick):
    inventory = finalization.get('component_inventory')
    need(type(inventory) is dict and 0 < len(inventory) <= 100000,
         'bounded_finalized_inventory_required')
    rows, identities = [], {}
    for name, record in sorted(inventory.items()):
        tick()
        package['relative'](name)
        need(type(record) is dict, 'finalized_row_object_required')
        with package['parent_fd'](SOURCE, name) as (parent, leaf):
            info = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
            mode = stat.S_IMODE(info.st_mode)
            need(info.st_uid == EXPECTED_UID and not mode & 0o7000,
                 'owned_runtime_entry_without_special_mode_required')
            identities[name] = entry_identity(info)
            row = {'path': name, 'kind': record.get('kind'), 'mode': f'{mode:04o}'}
            if row['kind'] == 'file':
                need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                     and type(record.get('mode')) is int and record['mode'] == mode,
                     'finalized_owned_singlelink_file_required')
                row.update(bytes=record.get('bytes'), sha256=record.get('sha256'),
                           executable=bool(mode & 0o111))
            elif row['kind'] == 'directory':
                need(stat.S_ISDIR(info.st_mode) and type(record.get('mode')) is int
                     and record['mode'] == mode and mode & 0o500 == 0o500,
                     'finalized_readable_directory_required')
            else:
                need(row['kind'] == 'symlink' and stat.S_ISLNK(info.st_mode)
                     and os.readlink(leaf, dir_fd=parent) == record.get('target'),
                     'finalized_relative_link_required')
                row['target'] = record['target']
            rows.append(row)
    content = contract['content_inventory_sha256'](rows)
    package['verify_tree'](SOURCE, {'files': rows})
    return rows, identities, content


class BoundedOutput:
    def __init__(self, fd, maximum, tick):
        self.fd, self.maximum, self.tick, self.written = fd, maximum, tick, 0

    def write(self, block):
        self.tick()
        need(self.written + len(block) <= self.maximum, 'copy_file_growth_bound')
        remaining = memoryview(block)
        while remaining:
            self.tick()
            count = os.write(self.fd, remaining)
            need(count > 0, 'copy_output_short_write')
            remaining = remaining[count:]
            self.written += count
        return len(block)


def copy_fresh_runtime(finalization, attempt_id, package, contract):
    """Copy one reviewed source into one EXCL attempt; preserve all failures."""
    need(COPY_ENABLED is True and type(EXPECTED_UID) is int and EXPECTED_UID > 0
         and os.getuid() == os.geteuid() == EXPECTED_UID and sys.platform == 'darwin',
         'DISABLED_or_unbound_relocation_copy')
    need(type(attempt_id) is str and re.fullmatch('[a-f0-9]{32}', attempt_id),
         'one_explicit_relocation_attempt_id_required')
    end = time.monotonic() + 900

    def tick():
        need(time.monotonic() < end, 'relocation_data_copy_deadline')

    with package['directory_fd'](JOB) as fd:
        job_identity = directory_identity(os.fstat(fd))
    identity = finalization.get('job_identity')
    need(type(identity) is list and len(identity) == 4
         and all(type(value) is int for value in identity)
         and identity == job_identity and job_identity[2:] == [EXPECTED_UID, 0o700]
         and finalization.get('schema') == 'omegahive-ci-runtime-finalization/1'
         and finalization.get('status') == 'FINALIZED_BUNDLE_DERIVATIVE_ONLY'
         and finalization.get('job_path') == str(JOB),
         'current_pinned_finalization_job_required')
    with package['directory_fd'](SOURCE) as fd:
        source_identity = directory_identity(os.fstat(fd))
        need(source_identity[2] == EXPECTED_UID, 'source_root_owner_required')
    rows, source_entries, content = capture_rows(finalization, package, contract, tick)
    attempt_name = 'attempt-' + attempt_id
    target = ATTEMPTS / attempt_name / 'OmegaHive.bundle'
    # The caller creates/pins this private parent during owner admission.
    # mkdir is exclusive: an existing attempt is never resumed or reused.
    with package['directory_fd'](ATTEMPTS) as parent:
        parent_info = os.fstat(parent)
        need(parent_info.st_uid == EXPECTED_UID and stat.S_IMODE(parent_info.st_mode) == 0o700,
             'private_owned_relocation_parent_required')
        os.mkdir(attempt_name, 0o700, dir_fd=parent)
        attempt = os.open(attempt_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            need(directory_identity(os.fstat(attempt))[2:] == [EXPECTED_UID, 0o700],
                 'private_new_attempt_required')
            os.mkdir('OmegaHive.bundle', 0o700, dir_fd=attempt)
            created_root = os.stat('OmegaHive.bundle', dir_fd=attempt, follow_symlinks=False)
            need(stat.S_ISDIR(created_root.st_mode)
                 and directory_identity(created_root)[2:] == [EXPECTED_UID, 0o700],
                 'private_new_copy_root_required')
            with package['directory_fd'](target) as target_fd:
                target_identity = directory_identity(os.fstat(target_fd))
                need(target_identity == directory_identity(created_root),
                     'new_copy_root_path_identity_required')
                directories = sorted((row for row in rows if row['kind'] == 'directory'),
                                     key=lambda row: (row['path'].count('/'), row['path']))
                for row in directories:
                    tick()
                    with package['parent_fd'](target, row['path']) as (out_parent, leaf):
                        os.mkdir(leaf, 0o700, dir_fd=out_parent)
                for row in rows:
                    tick()
                    if row['kind'] == 'directory':
                        continue
                    with package['parent_fd'](target, row['path']) as (out_parent, leaf):
                        if row['kind'] == 'symlink':
                            os.symlink(row['target'], leaf, dir_fd=out_parent)
                            continue
                        fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                     0o600, dir_fd=out_parent)
                        try:
                            writer = BoundedOutput(fd, row['bytes'], tick)
                            original, _digest = package['read_regular'](
                                SOURCE, row['path'], expected=row, output=writer, maximum=1024**3)
                            need(entry_identity(original) == source_entries[row['path']],
                                 'source_identity_changed_before_copy')
                            info = os.fstat(fd)
                            need(stat.S_ISREG(info.st_mode) and info.st_uid == EXPECTED_UID
                                 and info.st_nlink == 1 and info.st_size == row['bytes'],
                                 'owned_new_copy_file_required')
                            os.fsync(fd)
                            os.fchmod(fd, int(row['mode'], 8))
                        finally:
                            os.close(fd)
                for row in reversed(directories):
                    tick()
                    with package['directory_fd'](target / row['path']) as fd:
                        need(os.fstat(fd).st_uid == EXPECTED_UID, 'copied_directory_owner_changed')
                        os.fchmod(fd, int(row['mode'], 8))
                # A default-created symlink must retain the declared link mode;
                # unusual source link modes fail closed, without following it.
                package['verify_tree'](target, {'files': rows})
                package['verify_tree'](SOURCE, {'files': rows})
                with package['directory_fd'](SOURCE) as fd:
                    need(directory_identity(os.fstat(fd)) == source_identity, 'source_root_identity_changed')
                with package['directory_fd'](JOB) as fd:
                    need(directory_identity(os.fstat(fd)) == job_identity, 'source_job_identity_changed')
                need(directory_identity(os.fstat(target_fd)) == target_identity,
                     'held_copy_root_identity_changed')
                with package['directory_fd'](target) as fd:
                    need(directory_identity(os.fstat(fd)) == target_identity, 'copy_root_path_changed')
                tick()
                return {'status': 'CLOSED_RUNTIME_DATA_COPY_ONLY', 'source_root': str(SOURCE),
                        'relocated_bundle_root': str(target), 'fresh_output_created': True,
                        'job_identity': job_identity, 'target_identity': target_identity,
                        'content_inventory_sha256': content, 'entries': len(rows),
                        'native_commands_run': False,
                        'scope': 'Declared bytes, links and modes only; relocation audit/receipt and native qualification absent.'}
        finally:
            os.close(attempt)
