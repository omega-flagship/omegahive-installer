#!/usr/bin/env python3
"""Fixed user-service launcher. CONTEXT_CF40; Source only, Linux NOT_RUN.

Uses the same closed runtime descriptor as control.py. No app imports or runtime
downloads. The installer owns descriptor creation, release pins and user service.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import sys


class Refused(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise Refused(reason)


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate_json_key')
            result[key] = value
        return result
    def bad(_):
        raise Refused('nonfinite_json')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=bad)


def plain_path(value):
    require(type(value) is str and 0 < len(value.encode()) <= 4096
            and not any(c in value for c in '\x00\r\n'), 'invalid_path')
    path = Path(value)
    require(path.is_absolute() and str(path) == value and '..' not in path.parts,
            'absolute_plain_path_required')
    return path


def ancestry(path):
    for parent in reversed(path.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, os.getuid())
                and not info.st_mode & 0o022, 'unsafe_path_ancestor')


def directory(value, private=False):
    path = plain_path(value)
    ancestry(path)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and not info.st_mode & (0o077 if private else 0o022),
            'unsafe_owned_directory')
    require(path.resolve(strict=True) == path, 'directory_link_refused')
    return path


def executable(value, root, allow_link=False):
    path = plain_path(value)
    ancestry(path)
    info = path.lstat()
    require((allow_link and stat.S_ISLNK(info.st_mode)) or stat.S_ISREG(info.st_mode),
            'plain_executable_required')
    target = path.resolve(strict=True)
    ancestry(target)
    info = target.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid in (0, os.getuid())
            and not info.st_mode & 0o022 and info.st_mode & 0o111
            and target.is_relative_to(root), 'executable_outside_selected_runtime')
    return path, target


def selected_data_dir(value, home):
    expected = home / '.local/share/omegahive/data'
    require(plain_path(value) == expected, 'fixed_private_home_data_required')
    return directory(str(expected), private=True)


def runtime_choices(value):
    model = value['default_model']
    require(type(model) is str and len(model) <= 240
            and re.fullmatch(r'(?:openrouter|openai|anthropic)/[A-Za-z0-9][A-Za-z0-9_.:/-]*', model),
            'explicit_real_default_model_required')
    embedding = value['embedding_model']
    require(type(embedding) is str and len(embedding) <= 240
            and re.fullmatch(r'(?:mock/hash|(?:openrouter|openai|anthropic)/[A-Za-z0-9][A-Za-z0-9_.:/-]*)', embedding),
            'explicit_embedding_model_required')
    target = value['ssh_target']
    require(target is None or (type(target) is str and len(target) <= 300
            and re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}@[A-Za-z0-9][A-Za-z0-9.-]{0,252}', target)),
            'nonsecret_ssh_target_required')


def runtime(path):
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    expected = home / '.local/share/omegahive/runtime.json'
    require(plain_path(path) == expected, 'fixed_runtime_descriptor_required')
    directory(str(expected.parent), private=True)
    fd = os.open(expected, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
                and before.st_nlink == 1 and stat.S_IMODE(before.st_mode) == 0o600
                and 0 < before.st_size <= 65536, 'private_descriptor_required')
        raw = os.read(fd, 65537)
        fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink',
                  'st_size', 'st_mtime_ns', 'st_ctime_ns')
        identity = lambda s: tuple(getattr(s, k) for k in fields)
        require(len(raw) == before.st_size and identity(before) == identity(os.fstat(fd))
                == identity(expected.lstat()), 'descriptor_changed')
    finally:
        os.close(fd)
    value = strict_json(raw)
    keys = {'schema', 'runtime_root', 'release_root', 'python', 'petta_path',
            'data_dir', 'port', 'sandbox_python', 'source_revision', 'plugin_dirs',
            'app_pins', 'swipl_bin', 'libpython_dir', 'studio_maker_template',
        'default_model', 'embedding_model', 'ssh_target', 'browser_port'}
    require(type(value) is dict and set(value) == keys
            and value['schema'] == 'studio-linux-user-runtime/2',
            'closed_runtime_descriptor_required')
    require(type(value['port']) is int and value['port'] == 8700
            and type(value['browser_port']) is int and value['browser_port'] == 8701
            and type(value['source_revision']) is str
            and re.fullmatch('[a-f0-9]{40}', value['source_revision']),
            'bound_release_and_port_required')
    runtime_choices(value)
    template = value['studio_maker_template']
    require(template is None or (type(template) is str and re.fullmatch('a_[a-f0-9]{8}', template)),
            'studio_maker_template_id_required')
    root = directory(value['runtime_root'])
    require(root.is_relative_to(expected.parent / 'releases')
            and root != expected.parent / 'releases', 'versioned_runtime_required')
    app = directory(value['release_root'])
    require(app == root / 'app', 'release_app_root_required')
    python, canonical = executable(value['python'], root, allow_link=True)
    require(Path(sys.executable).resolve(strict=True) == canonical,
            'selected_interpreter_required')
    executable(value['sandbox_python'], root)
    executable(value['swipl_bin'], root)
    require(directory(value['petta_path']).is_relative_to(root), 'petta_outside_runtime')
    selected_data_dir(value['data_dir'], home)
    if value['libpython_dir'] is not None:
        require(directory(value['libpython_dir']) == root / 'runtime/python/lib',
                'exact_selected_private_python_library_directory_required')
    dirs = value['plugin_dirs']
    require(type(dirs) is list and len(dirs) <= 16 and len(set(dirs)) == len(dirs),
            'closed_plugin_directories_required')
    for item in dirs:
        require(directory(item).is_relative_to(root), 'plugin_outside_runtime')
    pins = value['app_pins']
    require(type(pins) is dict and len(pins) <= 16, 'closed_app_pins_required')
    for name, pin in pins.items():
        require(type(name) is str and re.fullmatch('[a-z][a-z0-9_-]{0,63}', name)
                and type(pin) is dict and set(pin) <= {'release', 'digest', 'files'}
                and {'release', 'digest'} <= set(pin), 'invalid_app_pin')
        release = directory(pin['release'])
        require(any(release.is_relative_to(Path(d)) for d in dirs)
                and type(pin['digest']) is str
                and re.fullmatch('sha256:[a-f0-9]{64}', pin['digest']), 'app_pin_binding')
        files = pin.get('files', {})
        require(type(files) is dict and len(files) <= 512, 'app_files_bound')
        for rel, digest in files.items():
            require(type(rel) is str and rel and not Path(rel).is_absolute()
                    and '..' not in Path(rel).parts and '\x00' not in rel
                    and type(digest) is str
                    and re.fullmatch('(?:sha256:)?[a-f0-9]{64}', digest), 'app_file_pin')
    return value, home, hashlib.sha256(raw).hexdigest()


def loader_agreement(config, environ=None):
    environ = os.environ if environ is None else environ
    expected = config['libpython_dir'] or ''
    require(environ.get('LD_LIBRARY_PATH', '') == expected,
            'selected_private_loader_environment_required')
    require(not any(environ.get(key, '') for key in
                    ('LD_PRELOAD', 'LD_AUDIT', 'PYTHONPATH', 'PYTHONHOME')),
            'ambient_loader_or_python_setting_refused')
    return expected


def main():
    require(sys.platform.startswith('linux') and os.getuid() == os.geteuid() != 0
            and not sys.flags.optimize, 'unprivileged_linux_required')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', required=True)
    args = parser.parse_args()
    config, home, fingerprint = runtime(args.runtime)
    loader_agreement(config)
    require(os.environ.get('HIVE_SANDBOX_PYTHON') == config['sandbox_python'],
            'user_unit_sandbox_interpreter_mismatch')
    # The unit's selected value is checked, then ALL inherited variables are dropped.
    env = {
        'HOME': str(home), 'LANG': 'C.UTF-8', 'LC_ALL': 'C',
        'PATH': str(Path(config['python']).parent) + ':' + str(Path(config['swipl_bin']).parent) + ':/usr/bin:/bin',
        'VIRTUAL_ENV': str(Path(config['python']).parent.parent),
        'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1',
        'HIVE_LOCAL_OWNER': '1', 'HIVE_HOST': '127.0.0.1',
        'HIVE_PORT': str(config['port']), 'HIVE_PUBLIC_URL': 'http://127.0.0.1:' + str(config['port']),
        'HIVE_LOCAL_BROWSER_PORT': str(config['browser_port']),
        'HIVE_MIND_SANDBOX': '1', 'HIVE_SANDBOX_PYTHON': config['sandbox_python'],
        'HIVE_DATA_DIR': config['data_dir'], 'HIVE_CORE_ROOT': config['release_root'],
        'HIVE_DRIVER': 'local', 'PETTA_PATH': config['petta_path'],
        'HIVE_DEFAULT_MODEL': config['default_model'],
        'HIVE_ASK_CONDUCTOR_MODEL': config['default_model'],
        'HIVE_EMBEDDING_MODEL': config['embedding_model'],
        'HIVE_PLUGIN_DIRS': os.pathsep.join(config['plugin_dirs']),
        'HIVE_APP_PINS': json.dumps(config['app_pins'], sort_keys=True, separators=(',', ':')),
        'HIVE_APP_PINS_REQUIRED': '1',
        'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
        'GIT_TERMINAL_PROMPT': '0', 'GIT_NO_LAZY_FETCH': '1', 'GIT_OPTIONAL_LOCKS': '0',
    }
    if config['studio_maker_template'] is not None:
        env['HIVE_STUDIO_MAKER_TEMPLATE'] = config['studio_maker_template']
    if config['libpython_dir'] is not None:
        env['LD_LIBRARY_PATH'] = config['libpython_dir']
    require(runtime(args.runtime)[2] == fingerprint, 'descriptor_changed_before_exec')
    os.umask(0o077)
    os.chdir(config['release_root'])
    # -I is for this stdlib launcher. Hive uses its normal venv + reviewed source cwd.
    # No inherited PYTHONPATH/PYTHONHOME/provider key/Google identity/LD path survives.
    os.execve(config['python'], [config['python'], '-B', '-m', 'hive'], env)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Refused as error:
        print('OmegaHive: ' + str(error), file=sys.stderr)
        raise SystemExit(78)
    except Exception:
        print('OmegaHive: private user-service launch refused.', file=sys.stderr)
        raise SystemExit(78)
