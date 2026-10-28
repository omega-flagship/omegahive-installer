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
import time

import httpx


class ProbeError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


SERVICE_HOST = '127.0.0.1'
SERVICE_PORT = 8724


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
            fields = line.split()
            if len(fields) < 10 or fields[3] != '0A':
                continue
            try:
                raw_address, raw_port = fields[1].split(':')
                observed_port = int(raw_port, 16)
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
        log_path = temp / 'service.stderr.log'
        process: subprocess.Popen[bytes] | None = None
        pgid: int | None = None
        outcome: dict | None = None
        failure: ProbeError | None = None
        with log_path.open('wb') as log:
            os.chmod(log_path, 0o600)
            try:
                process = subprocess.Popen(
                    service_argv(python, config),
                    cwd=temp, env=env, stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL, stderr=log,
                    start_new_session=True,
                )
                # start_new_session makes the child its session and group leader.
                # Retain pid as pgid even if it exits before the first health poll.
                pgid = process.pid
                if os.getpgid(process.pid) != pgid:
                    raise ProbeError('service_group_not_isolated')
                http_result = asyncio.run(check_http_boundary(port, token, process))
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

        if failure is not None:
            raise failure
        if outcome is None:
            raise ProbeError('runtime_probe_no_result')
        # The temporary-directory context exits before the caller can report PASS.
        return outcome


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', required=True, type=pathlib.Path,
                        help='directory containing source_r10/src/omegacode')
    parser.add_argument('--python', required=True, type=pathlib.Path,
                        help='absolute path to the hash-pinned Python interpreter')
    args = parser.parse_args()
    source = args.source_root.resolve()
    python = args.python.resolve()
    if not (source / 'omegacode' / '__main__.py').is_file() or not python.is_file():
        print(json.dumps({'ok': False, 'failure': 'source_or_interpreter_missing'}))
        return 2
    try:
        outcome = run_probe(source, python)
    except ProbeError as exc:
        print(json.dumps({'ok': False, 'failure': exc.code}, sort_keys=True))
        return 1
    except OSError:
        print(json.dumps({'ok': False, 'failure': 'runtime_probe_os_error'}, sort_keys=True))
        return 1
    print(json.dumps({'ok': True, **outcome, 'process_group_clean': True}, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
