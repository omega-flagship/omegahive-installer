#!/usr/bin/env python3
"""Purpose: configure an own hive's pinned Code runtime, sandbox and proposal-test policy."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import sys

SANDBOX_EXEC = Path('/usr/bin/sandbox-exec')


def write_private(path, text):
    temporary = path.with_name(path.name + '.new')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(text)
    temporary.chmod(0o600)
    temporary.replace(path)


def runtime_profile():
    python = Path(sys.executable).resolve(strict=True)
    node = (Path(sys.base_prefix) / 'bin/node').resolve(strict=True)
    # Time: b bytes hashed, b = size of Python, Node and sandbox-exec.
    sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    return {'kind': 'macos-seatbelt-python-node-v1', 'python': str(python), 'python_sha256': sha(python),
            'node': str(node), 'node_sha256': sha(node), 'sandbox_exec_sha256': sha(SANDBOX_EXEC)}


def service_profile(home, code, repo, release, hive_port, code_port):
    q = lambda value: json.dumps(str(value), ensure_ascii=True)
    runtime = home / 'toolchain/envs/hive'
    return '\n'.join([
        '(version 1)', '(deny default)', '(allow process-fork)', '(allow process-exec)',
        '(allow signal (target same-sandbox))', '(allow sysctl-read)', '(allow ipc-posix-shm)',
        '(allow file-read-metadata)',
        '(allow file-read* (literal "/") ' + ' '.join('(subpath ' + q(path) + ')' for path in
            ['/System', '/usr', '/bin', '/sbin', '/Library/Frameworks', '/Library/Developer',
             '/private/var/db/dyld', '/private/var/db/timezone', '/private/etc', '/dev',
             runtime, home / 'venv', code / 'releases' / release])
            + ' (literal ' + q(code / 'config.json') + ') (literal ' + q(code / 'operator-token') + '))',
        '(allow file-read* file-write* ' + ' '.join('(subpath ' + q(path) + ')' for path in
            [code / 'state', code / 'tmp', code / 'wd', code / 'home', repo]) + ')',
        '(allow file-write* (literal "/dev/null") (literal "/dev/dtracehelper"))',
        '(allow network-outbound (remote ip ' + q(f'localhost:{hive_port}') + '))',
        '(allow network-bind (local ip ' + q(f'localhost:{code_port}') + '))',
        '(allow network-inbound (local ip ' + q(f'localhost:{code_port}') + '))',
    ]) + '\n'


def registered(code):
    path = code / 'state/registration.json'
    return path.exists() and json.loads(path.read_text()).get('receipt', {}).get('status') == 'active'


def project_pin(home):
    sys.path.insert(0, str(home / 'app'))
    from hive.core.programs import Programs
    plugin = home / 'app/hive/plugins/code_project_test'
    return {'release': str(plugin), 'digest': Programs.source_digest(plugin)}


def prepare(home, code, repo, hive_port, code_port, release, plist):
    mac = sys.platform == 'darwin'
    repository = {'path': str(repo)}
    if mac:
        repository['execution_confinement'] = runtime_profile()
        repository['execution_policy'] = 'proposal-only'
    config = {'data_root': str(code / 'state'), 'operator_token_file': str(code / 'operator-token'),
              'port': code_port, 'hive_url': f'http://127.0.0.1:{hive_port}',
              'repositories': {'small-app': repository},
              'proposal_tests_enabled': mac and registered(code),
              'sandbox_project_tests_enabled': mac,
              'copy_effect_policy': {'kind': 'disposable-app-files-v1', 'repository_id': 'small-app',
                                     'paths': ['index.html', 'app.js', 'style.css', 'README.md']}}
    write_private(code / 'config.json', json.dumps(config, indent=2) + '\n')
    write_private(code / 'omegacode.sb', service_profile(home, code, repo, release, hive_port, code_port))
    settings = {'HIVE_CODE_SERVICE_RELEASE': release, 'HIVE_CODE_SERVICE_CONFIG': str(code / 'config.json'),
                'HIVE_CODE_AGENT_PLIST': str(plist), 'HIVE_COPY_APPLY_CLAIMS': 'on',
                # Make starts each plan from this repository: index.html, style.css, app.js and a README, the scaffold
                # create_plan_ports.py builds on (its default name, create-web-scaffold, no install registers)
                'HIVE_CREATE_SCAFFOLD_REPO': 'small-app'}
    if mac:
        values = {}
        for line in (home / 'hive.env').read_text().splitlines():
            key, sep, value = line.partition('=')
            if sep and key.startswith('HIVE_'):
                words = shlex.split(value)
                values[key] = words[0] if words else ''
        pins = json.loads(values.get('HIVE_APP_PINS') or '{}')
        pins['code-project-test'] = project_pin(home)
        apps = set(filter(None, values.get('HIVE_SANDBOX_RUN_APPS', '').split(',')))
        apps.add('code-project-test')
        runtimes = json.loads(values.get('HIVE_SANDBOX_RUNTIMES') or '{}')
        python = repository['execution_confinement']['python']
        runtimes['python'] = {'exe': python, 'reads': [str(Path(python).parent.parent)]}
        settings.update(HIVE_CODE_SANDBOX_PROJECT_TESTS='on', HIVE_APP_PINS=json.dumps(pins),
                        HIVE_SANDBOX_RUN_APPS=','.join(sorted(apps)), HIVE_SANDBOX_RUNTIMES=json.dumps(runtimes))
        settings.update(HIVE_PROPOSAL_TEST_CLAIMS='on', HIVE_PROPOSAL_TEST_ARGV_PREFIXES=json.dumps(
            [[repository['execution_confinement']['python'], 'check_app.py']], separators=(',', ':')))
    path = home / 'hive.env'
    kept = [line for line in path.read_text().splitlines() if line.partition('=')[0] not in settings]
    write_private(path, '\n'.join(kept + [f'{key}={shlex.quote(value)}' for key, value in settings.items()]) + '\n')


def enable(config_path):
    if sys.platform != 'darwin':
        return False
    config = json.loads(config_path.read_text())
    code = config_path.parent
    if not registered(code):
        raise RuntimeError('Code must finish enrolment before proposal tests are enabled')
    if config['repositories']['small-app'].get('execution_confinement', {}).get('kind') != 'macos-seatbelt-python-node-v1':
        raise RuntimeError('Code proposal tests require the pinned portable runtime')
    if config.get('proposal_tests_enabled') is True:
        return False
    config['proposal_tests_enabled'] = True
    write_private(config_path, json.dumps(config, indent=2) + '\n')
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest='action', required=True)
    configure = actions.add_parser('prepare')
    for name in ('home', 'code', 'repo'):
        configure.add_argument(name, type=Path)
    configure.add_argument('hive_port', type=int)
    configure.add_argument('code_port', type=int)
    configure.add_argument('release')
    configure.add_argument('plist', type=Path)
    activate = actions.add_parser('enable')
    activate.add_argument('config', type=Path)
    args = parser.parse_args()
    if args.action == 'enable':
        print('enabled' if enable(args.config) else 'unchanged')
    else:
        prepare(args.home, args.code, args.repo, args.hive_port, args.code_port, args.release, args.plist)


if __name__ == '__main__':
    main()
