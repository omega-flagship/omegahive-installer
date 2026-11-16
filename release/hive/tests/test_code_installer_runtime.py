"""Purpose: verify installed proposal-test policy, enrolment activation and private runtime configuration."""
import importlib.util
import json
from pathlib import Path
import plistlib
import re
import shlex
import stat
import os
import shutil
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def installer(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location('installed_code_runtime', ROOT / 'install/macos/code-runtime.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module.sys, 'platform', 'darwin')
    profile = {'kind': 'macos-seatbelt-python-node-v1', 'python': '/private/runtime/bin/python3.12',
               'python_sha256': 'a' * 64, 'node': '/private/runtime/bin/node', 'node_sha256': 'b' * 64,
               'sandbox_exec_sha256': 'c' * 64}
    monkeypatch.setattr(module, 'runtime_profile', lambda: dict(profile))
    monkeypatch.setattr(module, 'project_pin', lambda home: {'release': str(home / 'app/hive/plugins/code_project_test'),
                                                          'digest': 'd' * 64})
    home = tmp_path / 'Own Hive'
    code, repo = home / 'code', home / 'repos/small-app'
    (code / 'state').mkdir(parents=True)
    repo.mkdir(parents=True)
    (home / 'hive.env').write_text('HIVE_PORT=8810\nKEEP=preserved\nHIVE_PROPOSAL_TEST_CLAIMS=off\n')
    return module, home, code, repo, profile


def configure(installer):
    module, home, code, repo, profile = installer
    module.prepare(home, code, repo, 8810, 8834, 'a' * 64, home / 'run/code.plist')
    return json.loads((code / 'config.json').read_text())


def test_fresh_install_configures_the_exact_host_contract_but_enrols_before_activation(installer):
    module, home, code, repo, profile = installer
    config = configure(installer)
    assert config['repositories'] == {'small-app': {'path': str(repo), 'execution_confinement': profile, 'execution_policy': 'proposal-only'}}
    assert config['hive_url'] == 'http://127.0.0.1:8810' and config['port'] == 8834
    assert config['proposal_tests_enabled'] is False
    assert config['sandbox_project_tests_enabled'] is True
    assert config['copy_effect_policy'] == {'kind': 'disposable-app-files-v1', 'repository_id': 'small-app',
                                            'paths': ['index.html', 'app.js', 'style.css', 'README.md']}
    values = dict(line.split('=', 1) for line in (home / 'hive.env').read_text().splitlines())
    assert shlex.split(values['HIVE_PROPOSAL_TEST_CLAIMS']) == ['on']
    prefixes = json.loads(shlex.split(values['HIVE_PROPOSAL_TEST_ARGV_PREFIXES'])[0])
    assert prefixes == [[profile['python'], 'check_app.py']]
    assert shlex.split(values['HIVE_CODE_SANDBOX_PROJECT_TESTS']) == ['on']
    assert json.loads(shlex.split(values['HIVE_SANDBOX_RUNTIMES'])[0])['python']['exe'] == profile['python']
    assert 'code-project-test' in json.loads(shlex.split(values['HIVE_APP_PINS'])[0])
    assert values['KEEP'] == 'preserved'
    assert shlex.split(values['HIVE_CODE_SERVICE_CONFIG']) == [str(code / 'config.json')]
    for path in (home / 'hive.env', code / 'config.json', code / 'omegacode.sb'):
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    with pytest.raises(RuntimeError, match='finish enrolment'):
        module.enable(code / 'config.json')


def test_activation_and_repeated_install_preserve_the_same_registration(installer):
    module, home, code, repo, profile = installer
    configure(installer)
    registration = code / 'state/registration.json'
    registration.write_text(json.dumps({'receipt': {'status': 'active'}, 'service_id': 'svc_synthetic'}))
    original = registration.read_bytes()
    assert module.enable(code / 'config.json') is True
    assert module.enable(code / 'config.json') is False
    assert configure(installer)['proposal_tests_enabled'] is True
    assert registration.read_bytes() == original
    assert (home / 'hive.env').read_text().count('HIVE_PROPOSAL_TEST_CLAIMS=') == 1


def test_activation_refuses_an_unpinned_runtime(installer):
    module, home, code, repo, profile = installer
    config = configure(installer)
    (code / 'state/registration.json').write_text(json.dumps({'receipt': {'status': 'active'}}))
    config['repositories']['small-app'].pop('execution_confinement')
    (code / 'config.json').write_text(json.dumps(config))
    with pytest.raises(RuntimeError, match='pinned portable runtime'):
        module.enable(code / 'config.json')


def test_service_sandbox_only_grants_its_own_files_and_loopback_ports(installer):
    module, home, code, repo, profile = installer
    configure(installer)
    policy = (code / 'omegacode.sb').read_text()
    assert '(deny default)' in policy
    assert '(remote ip "localhost:8810")' in policy
    assert '(local ip "localhost:8834")' in policy
    assert json.dumps(str(repo)) in policy and json.dumps(str(code / 'state')) in policy
    assert json.dumps(str(code / 'home')) in policy        # the service's own HOME (omegahive.sh start_code_job)
    assert '(allow network-outbound)' not in policy


def test_the_code_job_runs_with_a_home_of_its_own_inside_its_folder(tmp_path):
    """omegahive-feedback#103: the Code job ran with the owner's HOME inside a profile that lets it read none of that
    home, and git reads ~/.gitconfig there, so with the owner's git config present every git command the service ran
    failed and the Code workspace never opened. omegahive.sh's start_code_job, run here as the launcher runs it, gives
    the job its own folder's home instead, private to it."""
    oh, owner = tmp_path / 'Own Hive', tmp_path / 'owner'
    (oh / 'venv/bin').mkdir(parents=True)
    (oh / 'venv/bin/python').symlink_to(sys.executable)
    (oh / 'code').mkdir()
    (oh / 'run').mkdir()
    (oh / 'hive.env').write_text('HIVE_CODE_SERVICE_RELEASE=' + 'a' * 64 + '\n')
    launcher = (ROOT / 'install/macos/omegahive.sh').read_text()
    function = re.search(r'^start_code_job\(\) \{\n.*?^\}\n', launcher, re.S | re.M).group(0)
    script = (f'OH={shlex.quote(str(oh))} HOME={shlex.quote(str(owner))}\n'
              'CODE=$OH/code CODE_PLIST=$OH/run/code.plist CODE_LABEL=family.test.omegacode\n'
              'TOOLCHAIN=$OH/toolchain/envs/hive\nload_job() { :; }\n' + function + 'start_code_job\n')
    subprocess.run(['bash', '-c', script], check=True)
    job = plistlib.loads((oh / 'run/code.plist').read_bytes())
    assert job['EnvironmentVariables']['HOME'] == str(oh / 'code/home')
    assert stat.S_IMODE((oh / 'code/home').stat().st_mode) == 0o700
    assert job['ProgramArguments'][:3] == ['/usr/bin/sandbox-exec', '-f', str(oh / 'code/omegacode.sb')]


def test_non_macos_install_does_not_enable_an_unsupported_native_profile(installer, monkeypatch):
    module, home, code, repo, profile = installer
    monkeypatch.setattr(module.sys, 'platform', 'linux')
    config = configure(installer)
    assert config['repositories'] == {'small-app': {'path': str(repo)}}
    assert config['proposal_tests_enabled'] is False
    assert module.enable(code / 'config.json') is False
    assert 'HIVE_PROPOSAL_TEST_CLAIMS=off' in (home / 'hive.env').read_text()


def test_setup_fresh_and_upgrade_preserve_app_token_and_unrelated_staging(tmp_path):
    archive = os.environ.get('OMEGACODE_RELEASE_TARBALL')
    if not archive:
        pytest.skip('set OMEGACODE_RELEASE_TARBALL to the published installer archive')
    if sys.platform == 'darwin' and not (Path(sys.base_prefix) / 'bin/node').exists():
        pytest.skip("on a Mac run this with the hive toolchain's Python: the Code runtime pins the node installed "
                    'beside it (install/macos/code-runtime.py)')
    home = tmp_path / 'Own Hive'
    home.mkdir()
    (home / 'venv').symlink_to(Path(sys.prefix), target_is_directory=True)
    (home / 'toolchain/envs/hive/bin').mkdir(parents=True)
    (home / 'app').mkdir()
    (home / 'app/hive').symlink_to(ROOT / 'hive', target_is_directory=True)
    (home / 'toolchain/envs/hive/bin/git').symlink_to(shutil.which('git'))
    (home / 'hive.env').write_text('HIVE_PORT=8810\n')
    env = {**os.environ, 'OMEGAHIVE_HOME': str(home)}
    command = ['bash', str(ROOT / 'install/macos/setup-code.sh'), str(Path(archive).resolve())]
    completed = subprocess.run(command, env=env, capture_output=True, text=True)
    assert completed.returncode == 0, completed.stdout + completed.stderr
    repo = home / 'repos/small-app'
    git = lambda *args: subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True).stdout
    assert git('status', '--porcelain') == ''
    original = (repo / 'app.js').read_bytes()
    token = (home / 'code/operator-token').read_bytes()
    # Simulate the repository installed before project checks were shipped.
    git('rm', 'check_app.py')
    git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Older installed app')
    # An interrupted upgrade may already have copied the check without committing it.
    shutil.copyfile(ROOT / 'install/macos/check-app.py', repo / 'check_app.py')
    (repo / 'README.md').write_text('A person has staged this separate change.\n')
    git('add', 'README.md')
    subprocess.run(command, env=env, check=True, capture_output=True, text=True)
    assert (repo / 'app.js').read_bytes() == original
    assert (home / 'code/operator-token').read_bytes() == token
    assert git('diff', '--cached', '--name-only').splitlines() == ['README.md']
    assert git('show', 'HEAD:check_app.py') == (ROOT / 'install/macos/check-app.py').read_text()
    subprocess.run(command, env=env, check=True, capture_output=True, text=True)
    assert git('diff', '--cached', '--name-only').splitlines() == ['README.md']
