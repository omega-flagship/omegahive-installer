#!/usr/bin/env python3
"""Start frozen Code source and verify loopback/auth/cleanup in Linux CI.

The CI job verifies the archive and lock before invocation. This probe creates
only private temporary synthetic state and prints no credential or path.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import pathlib
import re
import secrets
import signal
import socket
import subprocess
import tempfile
import threading
import time

import httpx


class ProbeError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


SERVICE_HOST = '127.0.0.1'
SERVICE_PORT = 8724
MAX_STDERR_BYTES = 65536
INTERRUPTED = False


def _handle_signal(signum, frame):
    """Record a graceful cancellation; leave control flow intact so finally can stop the child group."""
    global INTERRUPTED
    INTERRUPTED = True


def _drain_stderr(stream, pgid: int, state: dict) -> None:
    """Discard service stderr while enforcing a strict byte cap and terminating a noisy child group."""
    try:
        while True:
            chunk = stream.read(4096)
            if not chunk:
                return
            state['stderr_bytes'] += len(chunk)
            if state['stderr_bytes'] > MAX_STDERR_BYTES and not state['stderr_limit_exceeded']:
                state['stderr_limit_exceeded'] = True
                try:
                    os.killpg(pgid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                except OSError:
                    state['stderr_stop_failed'] = True
    except OSError:
        state['stderr_read_failed'] = True


def require_fixed_port_available() -> int:
    """Preflight the production port; never teach the startup probe to pick another one."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind((SERVICE_HOST, SERVICE_PORT))
    except OSError as exc:
        raise ProbeError('fixed_service_port_unavailable') from exc
    return SERVICE_PORT


def service_argv(python: pathlib.Path, config: pathlib.Path) -> list[str]:
    return [str(python), '-B', '-s', '-m', 'omegacode', '--config', str(config)]


def service_environment(temp: pathlib.Path, source: pathlib.Path) -> dict[str, str]:
    return {
        'HOME': str(temp),
        'LANG': 'C.UTF-8',
        'PATH': os.defpath,
        'PYTHONDONTWRITEBYTECODE': '1',
        'PYTHONNOUSERSITE': '1',
        'PYTHONPATH': str(source),
        'PYTHONUNBUFFERED': '1',
        'TMPDIR': str(temp),
    }


def _decode_proc_address(raw: str, family: int) -> str:
    try:
        packed = bytes.fromhex(raw)
    except ValueError as exc:
        raise ProbeError('proc_address_malformed') from exc
    if family == socket.AF_INET:
        if len(packed) != 4:
            raise ProbeError('proc_ipv4_address_malformed')
        packed = packed[::-1]
    else:
        if len(packed) != 16:
            raise ProbeError('proc_ipv6_address_malformed')
        # Linux renders each 32-bit word in host byte order.
        packed = b''.join(packed[i:i + 4][::-1] for i in range(0, 16, 4))
    try:
        return socket.inet_ntop(family, packed)
    except OSError as exc:
        raise ProbeError('proc_address_malformed') from exc


def listener_records(port: int, proc_net: pathlib.Path = pathlib.Path('/proc/net')) -> list[dict[str, int | str]]:
    """Enumerate every IPv4/IPv6 TCP listener for this port from procfs."""
    records: list[dict[str, int | str]] = []
    tables = ((proc_net / 'tcp', socket.AF_INET),
              (proc_net / 'tcp6', socket.AF_INET6))
    for table, family in tables:
        try:
            lines = table.read_text().splitlines()[1:]
        except OSError as exc:
            raise ProbeError('linux_proc_tcp_unavailable') from exc
        for line in lines:
            if not line.strip():
                continue
            fields = line.split()
            if len(fields) < 10:
                raise ProbeError('proc_listener_record_malformed')
            try:
                raw_address, raw_port = fields[1].split(':')
                observed_port = int(raw_port, 16)
                state_code = fields[3]
                if not re.fullmatch(r'[0-9A-Fa-f]{2}', state_code):
                    raise ValueError()
            except (ValueError, IndexError) as exc:
                raise ProbeError('proc_listener_record_malformed') from exc
            if state_code != '0A':
                continue
            try:
                inode = int(fields[9])
                uid = int(fields[7])
            except (ValueError, IndexError) as exc:
                raise ProbeError('proc_listener_record_malformed') from exc
            if observed_port == port:
                records.append({'family': family,
                                'address': _decode_proc_address(raw_address, family),
                                'inode': inode,
                                'uid': uid})
    return records


def process_socket_inodes(pid: int) -> set[int]:
    fd_root = pathlib.Path('/proc') / str(pid) / 'fd'
    try:
        fds = list(fd_root.iterdir())
    except OSError as exc:
        raise ProbeError('service_fd_census_unavailable') from exc
    found: set[int] = set()
    for fd in fds:
        try:
            target = os.readlink(fd)
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise ProbeError('service_fd_census_unavailable') from exc
        match = re.fullmatch(r'socket:\[(\d+)\]', target)
        if match:
            found.add(int(match.group(1)))
    return found


def process_group_members(pgid: int) -> set[int]:
    """Return visible Linux process IDs whose process group is pgid."""
    proc = pathlib.Path('/proc')
    try:
        entries = list(proc.iterdir())
    except OSError as exc:
        raise ProbeError('process_group_census_unavailable') from exc
    members: set[int] = set()
    for entry in entries:
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / 'stat').read_text()
        except FileNotFoundError:
            continue
        except PermissionError:
            # Cannot prove this process group is empty if procfs hides a PID.
            raise ProbeError('process_group_census_denied')
        except OSError as exc:
            raise ProbeError('process_group_census_unavailable') from exc
        close = stat.rfind(')')
        if close < 0:
            raise ProbeError('process_stat_malformed')
        fields = stat[close + 2:].split()
        if len(fields) < 3:
            raise ProbeError('process_stat_malformed')
        try:
            observed_pgid = int(fields[2])
        except ValueError as exc:
            raise ProbeError('process_stat_malformed') from exc
        if observed_pgid == pgid:
            members.add(int(entry.name))
    return members


def verify_loopback_listener(port: int, pid: int) -> list[str]:
    records = listener_records(port)
    if len(records) != 1:
        raise ProbeError('listener_count_not_one')
    record = records[0]
    if record['family'] != socket.AF_INET or record['address'] != '127.0.0.1':
        raise ProbeError('listener_not_ipv4_loopback')
    if record['uid'] != os.getuid():
        raise ProbeError('listener_owner_mismatch')
    if record['inode'] not in process_socket_inodes(pid):
        raise ProbeError('listener_not_owned_by_service_process')
    return ['127.0.0.1']


async def _bounded_get(client: httpx.AsyncClient, url: str, headers: dict[str, str],
                       deadline: float) -> tuple[int, bytes]:
    loop = asyncio.get_running_loop()
    remaining = deadline - loop.time()
    if remaining <= 0:
        raise ProbeError('startup_deadline_exceeded')

    async def fetch() -> tuple[int, bytes]:
        async with client.stream('GET', url, headers=headers) as response:
            body = bytearray()
            async for chunk in response.aiter_bytes():
                if len(body) + len(chunk) > 32768:
                    raise ProbeError('capabilities_body_too_large')
                body.extend(chunk)
            return response.status_code, bytes(body)

    try:
        return await asyncio.wait_for(fetch(), timeout=remaining)
    except asyncio.TimeoutError as exc:
        raise ProbeError('startup_deadline_exceeded') from exc


async def check_http_boundary(port: int, token: str, process: subprocess.Popen[bytes]) -> dict:
    url = f'http://127.0.0.1:{port}/v1/capabilities'
    loop = asyncio.get_running_loop()
    deadline = loop.time() + 15
    timeout = httpx.Timeout(0.5, connect=0.5, read=0.5, write=0.5, pool=0.5)
    async with httpx.AsyncClient(trust_env=False, timeout=timeout) as client:
        while loop.time() < deadline:
            if INTERRUPTED:
                raise ProbeError('runtime_probe_interrupted')
            if process.poll() is not None:
                raise ProbeError('service_exited_before_ready')
            try:
                anon_status, _ = await _bounded_get(client, url, {}, deadline)
                owner_status, body_bytes = await _bounded_get(
                    client, url, {'Authorization': 'Bearer ' + token}, deadline)
            except (httpx.HTTPError, ProbeError) as exc:
                if isinstance(exc, ProbeError) and exc.code != 'startup_deadline_exceeded':
                    raise
                remaining = deadline - loop.time()
                if remaining <= 0:
                    raise ProbeError('startup_deadline_exceeded') from exc
                await asyncio.sleep(min(0.1, remaining))
                continue
            if anon_status == 401 and owner_status == 200:
                try:
                    body = json.loads(body_bytes)
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise ProbeError('capabilities_body_invalid') from exc
                if body.get('service') != 'omegacode':
                    raise ProbeError('unexpected_service_identity')
                return {'anonymous_status': anon_status,
                        'owner_status': owner_status,
                        'service': body['service']}
            remaining = deadline - loop.time()
            if remaining > 0:
                await asyncio.sleep(min(0.1, remaining))
    raise ProbeError('startup_deadline_exceeded')


def stop_owned_process_group(process: subprocess.Popen[bytes], pgid: int) -> None:
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except OSError as exc:
        raise ProbeError('service_group_stop_failed') from exc
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except OSError as exc:
            raise ProbeError('service_group_kill_failed') from exc
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired as exc:
            raise ProbeError('service_process_did_not_exit') from exc

    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if not process_group_members(pgid):
            return
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except OSError as exc:
            raise ProbeError('service_group_kill_failed') from exc
        time.sleep(0.05)
    if process_group_members(pgid):
        raise ProbeError('service_process_group_not_empty')


def run_probe(source: pathlib.Path, python: pathlib.Path) -> dict:
    with tempfile.TemporaryDirectory(prefix='omegacode-runtime-probe-') as temp_name:
        temp = pathlib.Path(temp_name)
        os.chmod(temp, 0o700)
        data = temp / 'data'
        data.mkdir(mode=0o700)
        repo = temp / 'synthetic-repository'
        repo.mkdir(mode=0o700)
        token_file = temp / 'operator-token'
        token = secrets.token_urlsafe(36)
        token_file.write_text(token + '\n')
        os.chmod(token_file, 0o600)

        port = require_fixed_port_available()

        config = temp / 'config.json'
        config.write_text(json.dumps({
            'data_root': str(data),
            'operator_token_file': str(token_file),
            'hive_url': 'http://127.0.0.1:8700',
            'repositories': {'synthetic': {'path': str(repo)}},
        }))
        os.chmod(config, 0o600)

        env = service_environment(temp, source)
        process: subprocess.Popen[bytes] | None = None
        pgid: int | None = None
        stderr_state = {'stderr_bytes': 0, 'stderr_limit_exceeded': False,
                        'stderr_stop_failed': False, 'stderr_read_failed': False}
        stderr_thread: threading.Thread | None = None
        outcome: dict | None = None
        failure: ProbeError | None = None
        try:
            process = subprocess.Popen(
                service_argv(python, config),
                cwd=temp, env=env, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, bufsize=0,
                start_new_session=True,
            )
            # start_new_session makes the child its session and group leader.
            # Retain pid as pgid even if it exits before the first health poll.
            pgid = process.pid
            stderr_thread = threading.Thread(target=_drain_stderr,
                                             args=(process.stderr, pgid, stderr_state),
                                             name='omegacode-probe-stderr', daemon=True)
            stderr_thread.start()
            if os.getpgid(process.pid) != pgid:
                raise ProbeError('service_group_not_isolated')
            if INTERRUPTED:
                raise ProbeError('runtime_probe_interrupted')
            http_result = asyncio.run(check_http_boundary(port, token, process))
            if INTERRUPTED:
                raise ProbeError('runtime_probe_interrupted')
            if stderr_state['stderr_limit_exceeded']:
                raise ProbeError('service_stderr_limit_exceeded')
            if stderr_state['stderr_stop_failed'] or stderr_state['stderr_read_failed']:
                raise ProbeError('service_stderr_census_failed')
            listeners = verify_loopback_listener(port, process.pid)
            outcome = {**http_result, 'listener_addresses': listeners,
                       'synthetic_state': True}
        except ProbeError as exc:
            failure = exc
        except OSError as exc:
            failure = ProbeError('runtime_probe_os_error')
        except Exception as exc:
            failure = ProbeError('runtime_probe_failed')
        finally:
            if process is not None and pgid is not None:
                try:
                    stop_owned_process_group(process, pgid)
                except ProbeError as exc:
                    failure = exc
                except Exception as exc:
                    failure = ProbeError('service_group_cleanup_failed')
            if stderr_thread is not None:
                stderr_thread.join(timeout=5)
                if stderr_thread.is_alive():
                    failure = ProbeError('service_stderr_drain_did_not_finish')
                elif stderr_state['stderr_limit_exceeded'] and failure is None:
                    failure = ProbeError('service_stderr_limit_exceeded')
                elif (stderr_state['stderr_stop_failed'] or stderr_state['stderr_read_failed']) and failure is None:
                    failure = ProbeError('service_stderr_census_failed')
            if INTERRUPTED and failure is None:
                failure = ProbeError('runtime_probe_interrupted')

        if failure is not None:
            raise failure
        if outcome is None:
            raise ProbeError('runtime_probe_no_result')
        # The temporary-directory context exits before the caller can report PASS.
        return outcome


def main() -> int:
    global INTERRUPTED
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', required=True, type=pathlib.Path,
                        help='staged release root containing omegacode/__main__.py (PYTHONPATH=releases/<pin>)')
    parser.add_argument('--python', required=True, type=pathlib.Path,
                        help='absolute path to the hash-pinned Python interpreter')
    args = parser.parse_args()
    source = args.source_root.resolve()
    python = args.python.resolve()
    if not (source / 'omegacode' / '__main__.py').is_file() or not python.is_file():
        print(json.dumps({'ok': False, 'failure': 'source_or_interpreter_missing'}))
        return 2
    INTERRUPTED = False
    prior_signals = {}
    try:
        for signum in (signal.SIGTERM, signal.SIGINT):
            prior_signals[signum] = signal.signal(signum, _handle_signal)
        outcome = run_probe(source, python)
        if INTERRUPTED:
            raise ProbeError('runtime_probe_interrupted')
    except ProbeError as exc:
        print(json.dumps({'ok': False, 'failure': exc.code}, sort_keys=True))
        return 1
    except OSError:
        print(json.dumps({'ok': False, 'failure': 'runtime_probe_os_error'}, sort_keys=True))
        return 1
    finally:
        for signum, handler in prior_signals.items():
            signal.signal(signum, handler)
    print(json.dumps({'ok': True, **outcome, 'process_group_clean': True}, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
