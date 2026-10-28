#!/usr/bin/env python3
"""L0 private Linux status/open client. CONTEXT_CF40; no Linux qualification.

No service start, credential file, password fallback, HTTP proxy or arbitrary op.
The installed descriptor and supervised socket must pass before a code is issued.
"""
import argparse
import contextvars
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import selectors
import socket
import stat
import struct
import subprocess
import sys
import time

SCHEMA = 'studio-linux-user-runtime/2'
KEYS = {'schema', 'runtime_root', 'release_root', 'python', 'petta_path',
        'data_dir', 'port', 'sandbox_python', 'source_revision', 'plugin_dirs',
        'app_pins', 'swipl_bin', 'libpython_dir', 'studio_maker_template',
        'default_model', 'embedding_model', 'ssh_target', 'browser_port'}
UNIT = 'omegahive.service'
SYSTEMCTL = '/usr/bin/systemctl'
OPENER = '/usr/bin/xdg-open'
MAX_REPLY = 65536
HELLO_READY_SECONDS = 15
_HELLO_DEADLINE = contextvars.ContextVar('l0_hello_deadline', default=None)


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
    require(type(value) is dict and set(value) == KEYS and value['schema'] == SCHEMA,
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


def root_program(path):
    ancestry(Path(path))
    info = Path(path).lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0
            and not info.st_mode & 0o022 and info.st_mode & 0o111,
            'trusted_system_program_required')


def desktop_environment(home):
    run = directory('/run/user/' + str(os.getuid()), private=True)
    return {'HOME': str(home), 'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C',
            'XDG_RUNTIME_DIR': str(run), 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=' + str(run / 'bus')}


def _request_timeout(maximum):
    deadline = _HELLO_DEADLINE.get()
    if deadline is None:
        return maximum
    remaining = deadline - time.monotonic()
    require(remaining > 0, 'control_reply_timeout')
    return min(maximum, remaining)


def supervisor_pid(home):
    root_program(SYSTEMCTL)
    end = time.monotonic() + _request_timeout(3)
    process = subprocess.Popen([SYSTEMCTL, '--user', 'show', '-p', 'MainPID', '--value', UNIT],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env=desktop_environment(home), close_fds=True)
    selector = selectors.DefaultSelector()
    data = {'stdout': bytearray(), 'stderr': bytearray()}
    try:
        process.stdin.close()
        for name, stream in [('stdout', process.stdout), ('stderr', process.stderr)]:
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        while selector.get_map():
            require(time.monotonic() < end, 'supervisor_timeout')
            for key, _ in selector.select(min(.1, max(0, end - time.monotonic()))):
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                data[key.data].extend(chunk)
                require(sum(map(len, data.values())) <= 4096, 'supervisor_output_limit')
        require(process.wait(timeout=max(.01, end - time.monotonic())) == 0
                and not data['stderr'], 'supervisor_not_available')
        require(re.fullmatch(rb'[0-9]{1,10}\n?', data['stdout']) is not None,
                'supervisor_pid_format')
        pid = int(data['stdout'])
        require(1 < pid < 2**31, 'service_not_running')
        return pid
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
        process.wait(timeout=1)
        process.stdout.close()
        process.stderr.close()


def request(config, home, op, expected_pid=None):
    require(op in ('hello', 'signin'), 'fixed_control_operation_required')
    data = selected_data_dir(config['data_dir'], home)
    run = directory(str(data / 'run'), private=True)
    path = run / 'control.sock'
    require(len(os.fsencode(path)) < 100, 'control_path_too_long')
    info = path.lstat()
    require(stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid()
            and stat.S_IMODE(info.st_mode) == 0o600, 'private_control_socket_required')
    first = supervisor_pid(home)
    if expected_pid is not None:
        require(first == expected_pid, 'service_restarted')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(_request_timeout(3))
        client.connect(str(path))
        pid, uid, _gid = struct.unpack('3i', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
        require(uid == os.getuid() and pid == first == supervisor_pid(home),
                'supervised_peer_mismatch')
        # The service is not dumpable, so /proc/<pid>/exe is unreadable here; the peer is bound by SO_PEERCRED and
        # systemd's MainPID, and its hello attests its own executable (checked in validated_hello / exe_matches).
        client.sendall((json.dumps({'op': op}) + '\n').encode())
        raw = bytearray()
        end = time.monotonic() + _request_timeout(5)
        while not raw.endswith(b'\n'):
            require(time.monotonic() < end, 'control_reply_timeout')
            client.settimeout(max(.01, end - time.monotonic()))
            chunk = client.recv(min(4096, MAX_REPLY + 1 - len(raw)))
            require(bool(chunk), 'control_reply_incomplete')
            raw.extend(chunk)
            require(len(raw) <= MAX_REPLY and b'\n' not in raw[:-1], 'control_reply_limit')
        require(pid == supervisor_pid(home) and path.lstat().st_ino == info.st_ino
                and path.lstat().st_dev == info.st_dev, 'service_changed_during_request')
    return strict_json(raw), pid


def headless_guidance(config):
    target = config['ssh_target']
    if target is None:
        target = '<you>@<this-server>'
        print('Replace <you> and <this-server> with your SSH user and this server address.')
    port, browser_port = str(config['port']), str(config['browser_port'])
    print('On your own computer, keep this loopback-only SSH tunnel running:')
    print('ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:' + browser_port + ':127.0.0.1:' + port + ' ' + target)
    return 0


def loader_agreement(config, environ=None):
    environ = os.environ if environ is None else environ
    expected = config['libpython_dir'] or ''
    require(environ.get('LD_LIBRARY_PATH', '') == expected,
            'selected_private_loader_environment_required')
    require(not any(environ.get(key, '') for key in
                    ('LD_PRELOAD', 'LD_AUDIT', 'PYTHONPATH', 'PYTHONHOME')),
            'ambient_loader_or_python_setting_refused')
    return expected


def exe_matches(config, hello):
    """The hive's self-attested executable must be exactly the configured Python (same file, by device and inode)."""
    exe = hello.get('exe') if type(hello) is dict else None
    real = os.stat(Path(config['python']).resolve(strict=True))
    return (type(exe) is dict and set(exe) == {'dev', 'ino'} and all(type(exe[k]) is int for k in exe)
            and (exe['dev'], exe['ino']) == (real.st_dev, real.st_ino))


def listener_matches(config, hello):
    """The hive's attested listener must be the only LISTEN socket on 127.0.0.1:<port> in this network namespace,
    and owned by this account. Checked before any sign-in code is requested."""
    inode = hello.get('listener_inode') if type(hello) is dict else None
    if type(inode) is not str or not inode.isdecimal() or inode == '0':
        return False
    local = '0100007F:' + format(config['port'], '04X')
    fd = os.open('/proc/self/net/tcp', os.O_RDONLY | os.O_NOFOLLOW)
    try:
        raw = os.read(fd, 4 * 1024 ** 2 + 1)
    finally:
        os.close(fd)
    if len(raw) > 4 * 1024 ** 2:
        return False
    listening = set()
    for line in raw.decode('ascii', 'replace').splitlines()[1:]:
        fields = line.split()
        if len(fields) >= 10 and fields[1] == local and fields[3] == '0A':
            if fields[7] != str(os.getuid()):
                return False
            listening.add(fields[9])
    return listening == {inode}


def validated_hello(config, answer):
    hello, pid = answer
    require(exe_matches(config, hello), 'service_executable_mismatch')
    require(type(hello) is dict and hello.get('ok') is True and hello.get('local_owner') is True
            and type(hello.get('pid')) is int and hello['pid'] == pid
            and type(hello.get('port')) is int and hello['port'] == config['port']
            and type(hello.get('instance')) is str
            and re.fullmatch('[a-f0-9]{32}', hello['instance']), 'local_owner_hello_mismatch')
    return hello, pid


def wait_for_hello(config, home):
    # Only hello can be retried. A foreign identity or malformed reply fails closed.
    deadline = time.monotonic() + HELLO_READY_SECONDS
    token = _HELLO_DEADLINE.set(deadline)
    retryable = {'service_not_running', 'supervisor_not_available', 'supervisor_timeout',
                 'control_reply_timeout', 'control_reply_incomplete'}
    try:
        while True:
            try:
                return validated_hello(config, request(config, home, 'hello'))
            except Refused as error:
                if str(error) not in retryable:
                    raise
            except (FileNotFoundError, ConnectionRefusedError, TimeoutError):
                pass
            remaining = deadline - time.monotonic()
            require(remaining > 0, 'control_reply_timeout')
            time.sleep(min(0.25, remaining))
    finally:
        _HELLO_DEADLINE.reset(token)


def main():
    require(sys.platform.startswith('linux') and os.getuid() == os.geteuid() != 0
            and not sys.flags.optimize, 'unprivileged_linux_required')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', required=True)
    parser.add_argument('--json', action='store_true', help='Machine-readable status only.')
    parser.add_argument('--defer-headless-signin', action='store_true',
                        help='Installer-only captured headless handoff: do not issue a sign-in code.')
    parser.add_argument('operation', choices=('status', 'open'))
    args = parser.parse_args()
    require(not args.json or args.operation == 'status', 'json_requires_status')
    require(not args.defer_headless_signin or args.operation == 'open', 'defer_requires_open')
    config, home, fingerprint = runtime(args.runtime)
    loader_agreement(config)
    if args.operation == 'open':
        hello, pid = wait_for_hello(config, home)
    else:
        hello, pid = validated_hello(config, request(config, home, 'hello'))
    if args.operation == 'status':
        if args.json:
            print(json.dumps({'running': True, 'local_owner': True, 'pid': pid,
                              'port': config['port'], 'source_revision': config['source_revision'],
                              'scope': 'Supervised control identity only; not First Light or sandbox qualification.'}))
        else:
            print('OmegaHive is running.')
        return 0
    env = desktop_environment(home)
    display = os.environ.get('DISPLAY', '')
    wayland = os.environ.get('WAYLAND_DISPLAY', '')
    headless = not display and not wayland
    if headless:
        try:
            headless_guidance(config)
        except Exception:
            raise Refused('signin_link_output_failed') from None
        if args.defer_headless_signin:
            print('OmegaHive is ready. From your SSH terminal, run: ~/.local/bin/omegahive open')
            print('That explicit command will issue a one-use sign-in link. No link was issued during this captured install.')
            return 0
    else:
        require((display and re.fullmatch(r':[0-9]+(?:\.[0-9]+)?', display))
                or (wayland and re.fullmatch(r'wayland-[0-9]+', wayland)),
                'local_graphical_session_required')
        if display:
            require(re.fullmatch(r':[0-9]+(?:\.[0-9]+)?', display), 'remote_display_refused')
            env['DISPLAY'] = display
        if wayland:
            require(re.fullmatch(r'wayland-[0-9]+', wayland), 'wayland_name_refused')
            env['WAYLAND_DISPLAY'] = wayland
        # X authority is passed by path only to the local browser; never read or logged here.
        authority = os.environ.get('XAUTHORITY', '')
        if authority:
            authority_path = plain_path(authority)
            ancestry(authority_path)
            info = authority_path.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                    and info.st_nlink == 1 and not info.st_mode & 0o077, 'private_xauthority_required')
            env['XAUTHORITY'] = str(authority_path)
        root_program(OPENER)
    require(runtime(args.runtime)[2] == fingerprint, 'descriptor_changed_before_signin')
    require(listener_matches(config, hello), 'service_listener_mismatch')
    answer, _ = request(config, home, 'signin', pid)
    url = ''
    issued = time.monotonic()
    try:
        require(type(answer) is dict and set(answer) == {'ok', 'code', 'url', 'expires_in'}
                and answer['ok'] is True and type(answer['expires_in']) is int
                and answer['expires_in'] == 60 and type(answer['code']) is str
                and re.fullmatch('[A-Za-z0-9_-]{43}', answer['code']), 'signin_reply_refused')
        url = 'http://127.0.0.1:' + str(config['port']) + '/local-signin#' + answer['code']
        require(answer['url'] == url, 'signin_url_refused')
        if headless:
            # Explicit open intentionally prints to its caller, including SSH/non-TTY.
            # The installer must defer when its automatic headless output is captured.
            # The exact service URL above was verified before changing its port only.
            url = 'http://127.0.0.1:' + str(config['browser_port']) + '/local-signin#' + answer['code']
            try:
                print('Open this link on your own computer, within a minute: ' + url, flush=True)
            except Exception:
                raise Refused('signin_link_output_failed') from None
            return 0
        result = subprocess.run([OPENER, url], env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=5, check=False, close_fds=True)
        require(result.returncode == 0 and time.monotonic() - issued < 10,
                'browser_handoff_failed_open_again')
    finally:
        if type(answer) is dict:
            answer.clear()
        answer = None
        url = ''
    print('Your hive is open in your browser.')
    return 0


def refusal_message(reason):
    screen = 'OmegaHive needs a screen to open on. Please run this from the Ubuntu desktop: omegahive open'
    forwarded = ("This window forwards a screen (ssh -X or -Y), which OmegaHive doesn't use. "
                 "Sign in with plain ssh (without -X or -Y), then run omegahive open again.")
    messages = {
        'signin_link_output_failed': "Your sign-in link couldn't be shown. Run omegahive open again.",
        'browser_handoff_failed_open_again': "Your browser didn't open in time. Run omegahive open again.",
        'local_graphical_session_required': forwarded if os.environ.get('DISPLAY', '')[:1] not in ('', ':') else screen,
        'remote_display_refused': forwarded,
        'wayland_name_refused': screen,
        'control_reply_timeout': "Your hive didn't answer. Run omegahive open again in a minute.",
        'service_not_running': "OmegaHive isn't running.",
        'supervisor_not_available': "OmegaHive isn't running.",
    }
    return messages.get(reason, "OmegaHive couldn't open. Details are in ~/.local/share/omegahive/logs")


def run_cli():
    try:
        return main()
    except Refused as error:
        print(refusal_message(str(error)), file=sys.stderr)
        return 78
    except Exception:
        print("OmegaHive isn't running.", file=sys.stderr)
        return 78


if __name__ == '__main__':
    raise SystemExit(run_cli())
