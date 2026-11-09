"""Private bounded Linux workspace for the existing runner, not a work grant.

Parent imports normally. The trusted standalone launcher loads this exact sibling
Source without importing Hive. No resource is acquired at import. All project
files are first created by the placed namespace child, never on the host job.
SO_PEERCRED is deliberately not used: socketpair credentials describe its creator,
whereas the descriptor sender is the original trusted B descendant.
"""
from __future__ import annotations

import array
import asyncio
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import select
import socket
import stat
import struct
import tempfile
import time

BYTES, INODES = 256 * 1024 * 1024, 8192
MAX_INPUT, MAX_INPUT_FILES, MAX_PLAN = 20 * 1024 * 1024, 2000, 512 * 1024
WORKSPACE_POLICY = (BYTES, INODES, MAX_INPUT_FILES, MAX_INPUT)
CHUNK, TMPFS_MAGIC = 65536, 0x01021994
PHASES = ("launcher-probe", "runtime-probe", "workload")
FLAG = "--hive-runner-workspace-v1"


def valid_workspace_policy(policy):
    return (type(policy) is tuple and len(policy) == 4
            and all(type(x) is int for x in policy)
            and policy == (BYTES, INODES, MAX_INPUT_FILES, MAX_INPUT))


class WorkspaceError(RuntimeError):
    pass


class _Evidence:
    def __init__(self):
        self.primary = self.primary_tb = self.recording_error = None
        self.unknown = False

    def remember(self, error, *, unknown=False):
        if self.primary is None:
            self.primary = error
            try:
                self.primary_tb = BaseException.__getattribute__(error, "__traceback__")
            except BaseException:
                self.unknown = True
        self.unknown = self.unknown or unknown

    def raise_first(self):
        if self.primary is not None:
            if self.primary_tb is not None:
                raise BaseException.with_traceback(self.primary, self.primary_tb)
            raise self.primary


def _need(value):
    if value is not True:
        raise WorkspaceError("original quota workspace refused")


def _name(name):
    return (type(name) is str and 1 <= len(name) <= 64 and name[0].isascii()
        and name[0].isalnum() and all(c.isascii() and (c.isalnum() or c in "._-") for c in name))


def _inputs(value):
    _need(type(value) is dict and len(value) <= MAX_INPUT_FILES)
    total = 0
    for name, data in value.items():
        _need(_name(name) and type(data) is bytes)
        total += len(data)
        _need(total <= MAX_INPUT)
    return [[name, len(data), hashlib.sha256(data).hexdigest()]
            for name, data in sorted(value.items())]


def _json(value):
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    _need(len(raw) <= MAX_PLAN)
    return struct.pack("!I", len(raw)) + raw


class _StatFS(ctypes.Structure):
    # Linux LP64 x86_64/aarch64 struct statfs; never a host/image identity receipt.
    _fields_ = [("kind", ctypes.c_long), ("bsize", ctypes.c_long),
        ("blocks", ctypes.c_ulong), ("bfree", ctypes.c_ulong), ("bavail", ctypes.c_ulong),
        ("files", ctypes.c_ulong), ("ffree", ctypes.c_ulong), ("fsid", ctypes.c_int * 2),
        ("namelen", ctypes.c_long), ("frsize", ctypes.c_long), ("flags", ctypes.c_long),
        ("spare", ctypes.c_long * 4)]


def filesystem_facts(fd):
    """Actual FD readbacks, independently called by parent and placed B."""
    _need(platform.system() == "Linux" and platform.machine() in ("x86_64", "aarch64")
          and ctypes.sizeof(ctypes.c_long) == 8)
    basis, vfs, fs = os.fstat(fd), os.fstatvfs(fd), _StatFS()
    libc = ctypes.CDLL(None, use_errno=True)
    libc.fstatfs.argtypes = [ctypes.c_int, ctypes.POINTER(_StatFS)]
    libc.fstatfs.restype = ctypes.c_int
    if libc.fstatfs(fd, ctypes.byref(fs)) != 0:
        raise OSError(ctypes.get_errno(), "workspace fstatfs refused")
    _need(stat.S_ISDIR(basis.st_mode) and basis.st_uid == os.getuid()
          and fs.kind == TMPFS_MAGIC and vfs.f_frsize > 0
          and vfs.f_blocks * vfs.f_frsize == BYTES and vfs.f_files == INODES
          and fs.flags & 6 == 6)  # ST_NOSUID|ST_NODEV
    return (basis.st_dev, basis.st_ino, fs.kind, vfs.f_blocks * vfs.f_frsize,
            vfs.f_files, fs.flags)


class _Owned(_Evidence):
    def __init__(self):
        super().__init__()
        self.value = None
        self.open_attempted = self.returned = self.close_attempted = self.closed = False
        self.absent = False
        self.absence_error = None
        self.raw_close = self.close_error = None

    def close(self, owner):
        if self.close_attempted:
            return self.closed
        if self.value is None:
            return self.absent or not self.open_attempted
        self.close_attempted = True
        try:
            self.raw_close = self.value.close() if type(self.value) is socket.socket else os.close(self.value)
            _need(self.raw_close is None)
            self.closed = True
        except BaseException as error:
            self.close_error = error
            try:
                self.remember(error, unknown=True)
            except BaseException as recording:
                if self.primary is None:
                    self.primary = error
                self.recording_error = recording
                self.unknown = True
            try:
                owner.remember(error, unknown=True)
            except BaseException as recording:
                if owner.primary is None:
                    owner.primary = error
                owner.recording_error = recording
                owner.unknown = True
        return self.closed


def _known_slot(slot):
    return (type(slot) is _Owned and (not slot.open_attempted or slot.closed
            or slot.absent and type(slot.absence_error) is FileNotFoundError))


class WorkspaceJob(_Evidence):
    def __init__(self, context):
        super().__init__()
        self.context, self.loop = context, context.loop
        self.directory = _Owned()
        self.path = self.basis = None
        self.create_attempted = self.create_returned = self.removal_attempted = self.removed = False
        self.ready = self.disposed = False

    def guard(self, until):
        _need(type(until) in (int, float) and math.isfinite(until)
              and self.loop is asyncio.get_running_loop() and self.loop.time() < until <= self.context.loop_until)

    def create(self, until):
        try:
            self.guard(until)
            self.create_attempted = True
            self.path = tempfile.mkdtemp(prefix="sbx-")
            self.create_returned = True
            self.directory.open_attempted = True
            self.directory.value = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            self.directory.returned = True
            self.basis = os.fstat(self.directory.value)
            _need(stat.S_ISDIR(self.basis.st_mode) and self.basis.st_uid == os.getuid()
                  and not self.basis.st_mode & 0o077 and os.path.realpath(self.path) == self.path)
            self.ready = True
        except BaseException as error:
            self.remember(error, unknown=self.create_attempted and not self.create_returned)
        return self

    def dispose(self, until):
        if self.disposed:
            return True
        for phase in self.context.workspaces:
            if phase is not None:
                try:
                    _need(type(phase) is WorkspacePhase and phase.context is self.context and phase.job is self)
                    phase.dispose(until)
                except BaseException as error:
                    if type(phase) is WorkspacePhase and phase.primary is not None:
                        self.remember(phase.primary, unknown=phase.unknown)
                    self.remember(error, unknown=True)
                else:
                    if phase.primary is not None:
                        self.remember(phase.primary, unknown=phase.unknown)
        eligible = all(x is None or type(x) is WorkspacePhase and x.disposed for x in self.context.workspaces)
        try:
            if self.path is not None and self.basis is not None and eligible:
                self.guard(until)
                now = os.lstat(self.path)
                _need((now.st_dev, now.st_ino) == (self.basis.st_dev, self.basis.st_ino))
                _need(not os.listdir(self.directory.value))
                # The original private metadata directory has no project RW bind.
                self.directory.close(self)
                _need(self.directory.closed and not self.removal_attempted)
                self.guard(until)
                self.removal_attempted = True
                os.rmdir(self.path)
                self.removed = True
        except BaseException as error:
            self.remember(error)
        finally:
            self.directory.close(self)
        self.disposed = (self.removed and self.directory.closed and eligible and not self.unknown)
        return self.disposed


def prepare_job(context, *, work_loop_until):
    from . import sandbox_resources as R
    _need(type(context) is R.ResourceContext and context.workspace_job is None
          and type(context.workspaces) is list and len(context.workspaces) == 3
          and context.ready and context.run is not None
          and context.workspace_policy is context.owner.workspace_policy
          and context.workspace_policy is context.bootstrap.workspace_policy
          and valid_workspace_policy(context.workspace_policy))
    context._current()  # Original reserved Run/currentness, never a free-capacity snapshot.
    job = WorkspaceJob(context)
    context.workspace_job = job  # Retain before any original filesystem effect.
    return job.create(work_loop_until)


class WorkspacePhase(_Evidence):
    def __init__(self, context, resource, index, job, inputs):
        super().__init__()
        self.context, self.resource, self.index, self.job = context, resource, index, job
        self.inputs = dict(inputs)
        self.plan = _inputs(self.inputs)
        self.parent, self.child, self.mountpoint = _Owned(), _Owned(), _Owned()
        self.profile_directory = _Owned()
        self.profile_body_error = self.profile_body_traceback = None
        self.metadata_cleanup_attempted = False
        self.received = [_Owned(), _Owned()]  # CMSG_SPACE padding can expose a second int.
        self.root = self.received[0]
        self.artifacts = [_Owned() for _ in range(32)]
        self.input_checks = [_Owned() for _ in range(MAX_INPUT_FILES)]
        self.pair = None
        self.pair_attempted = self.pair_returned = False
        self.pair_adoption_incomplete = False
        self.root_name = ".quota-root-" + str(index)
        self.profile_name = ".sandbox-profile-" + PHASES[index]
        self.profile_file = ("app-bundle" if index == 2 else PHASES[index]) + ".landlock.json"
        self.mkdir_attempted = self.mkdir_returned = self.rmdir_attempted = self.rmdir_returned = False
        self.mount_basis = self.mount_path = self.facts = None
        self.spawn_attempted = self.handshake_attempted = self.accepted = False
        self.proc = None
        self.ready = self.disposed = self.metadata_removed = False
        self.send_attempted = self.send_returned = self.receive_attempted = self.receive_returned = False
        self.receive_adoption_incomplete = False
        self.raw_send = self.raw_receive = self.ack_return = None

    def setup(self, until):
        try:
            self.job.guard(until)
            self.mkdir_attempted = True
            os.mkdir(self.root_name, 0o700, dir_fd=self.job.directory.value)
            self.mkdir_returned = True
            self.mountpoint.open_attempted = True
            self.mountpoint.value = os.open(self.root_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                           dir_fd=self.job.directory.value)
            self.mountpoint.returned = True
            self.mount_basis = os.fstat(self.mountpoint.value)
            _need(self.mount_basis.st_uid == os.getuid() and not self.mount_basis.st_mode & 0o077)
            self.mount_path = str(Path(self.job.path) / self.root_name)
            self.pair_attempted = True
            self.pair_adoption_incomplete = True
            self.pair = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
            self.pair_returned = True
            self.parent.value, self.child.value = self.pair
            self.parent.open_attempted = self.parent.returned = True
            self.child.open_attempted = self.child.returned = True
            _need(self._pair_joined())
            self.parent.value.setblocking(False)
            self.pair_adoption_incomplete = False
            self.ready = True
        except BaseException as error:
            self.remember(error, unknown=self.pair_adoption_incomplete
                          or self.pair_attempted and not self.pair_returned)
        return self

    def _pair_joined(self):
        return (self.pair_returned is True and type(self.pair) is tuple and len(self.pair) == 2
                and type(self.pair[0]) is socket.socket and type(self.pair[1]) is socket.socket
                and self.pair[0] is not self.pair[1]
                and self.parent.value is self.pair[0] and self.child.value is self.pair[1]
                and self.parent.open_attempted is True and self.parent.returned is True
                and self.child.open_attempted is True and self.child.returned is True)

    def _recover_pair(self):
        # Recover only these actual raw returned objects into their pre-existing
        # slots for independent close. Never clear an interrupted adoption or
        # infer closure from object disposal/GC or a descriptor number.
        if self.pair is None:
            return
        try:
            _need(type(self.pair) is tuple and len(self.pair) == 2
                  and type(self.pair[0]) is socket.socket and type(self.pair[1]) is socket.socket
                  and self.pair[0] is not self.pair[1])
        except BaseException as error:
            self.remember(error, unknown=True)
            return
        for index, slot in enumerate((self.parent, self.child)):
            try:
                if slot.value is None:
                    slot.value = self.pair[index]
                _need(slot.value is self.pair[index])
                slot.open_attempted = slot.returned = True
            except BaseException as error:
                self.remember(error, unknown=True)

    @property
    def transport(self):
        self.raise_first()
        _need(self.ready and not self.pair_adoption_incomplete and self._pair_joined()
              and not self.child.close_attempted)
        return self.child.value.fileno()

    async def _pause(self, until):
        self.job.guard(until)
        await asyncio.sleep(min(.005, until - self.context.loop.time()))
        self.job.guard(until)

    async def _send(self, raw, until, fd=None):
        position, ancillary_sent = 0, False
        while position < len(raw):
            self.job.guard(until)
            try:
                self.send_attempted = True
                self.send_returned = False
                if fd is not None and not ancillary_sent:
                    self.raw_send = self.parent.value.sendmsg([raw], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                        array.array("i", [fd]))])
                    ancillary_sent = True
                else:
                    self.raw_send = self.parent.value.send(raw[position:position + CHUNK])
                self.send_returned = True
                _need(type(self.raw_send) is int and 0 < self.raw_send <= len(raw) - position)
                position += self.raw_send
                await asyncio.sleep(0)
                self.job.guard(until)
            except BlockingIOError:
                self.send_returned = True  # EAGAIN is a known no-transfer result.
                await self._pause(until)

    async def _read(self, length, until):
        out = bytearray()
        while len(out) < length:
            self.job.guard(until)
            try:
                raw = self.parent.value.recv(min(CHUNK, length - len(out)))
            except BlockingIOError:
                await self._pause(until)
                continue
            _need(type(raw) is bytes and bool(raw))
            out.extend(raw)
            await asyncio.sleep(0)
            self.job.guard(until)
        return bytes(out)

    async def handshake(self, proc, until):
        try:
            self.handshake_attempted = True
            _need(self.resource.context is self.context and self.resource.proc is proc
                  and self.resource.confirmed and self.resource.released and proc.returncode is None)
            self.proc = proc
            _need(self.child.close(self))  # parent's duplicate of the inherited endpoint
            start = {"op": "workspace", "version": 1, "phase": self.index,
                "path": self.mount_path, "dev": self.mount_basis.st_dev,
                "ino": self.mount_basis.st_ino, "bytes": BYTES, "inodes": INODES}
            await self._send(_json(start), until, self.mountpoint.value)
            # Receive one actual open-file reference, not a descriptor-number report.
            header = b""
            while not header:
                self.job.guard(until)
                try:
                    self.receive_attempted = True
                    self.receive_returned = False
                    self.receive_adoption_incomplete = True
                    self.raw_receive = self.parent.value.recvmsg(4, socket.CMSG_SPACE(array.array("i").itemsize), socket.MSG_CMSG_CLOEXEC)
                    self.receive_returned = True
                    header, ancillary, flags, _ = self.raw_receive
                except BlockingIOError:
                    self.receive_returned = True
                    self.receive_adoption_incomplete = False
                    await self._pause(until)
                    continue
                count = 0
                for level, kind, data in ancillary:
                    if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                        _need(len(data) % array.array("i").itemsize == 0)
                        for offset in range(0, len(data), array.array("i").itemsize):
                            _need(count < len(self.received))
                            slot = self.received[count]
                            slot.open_attempted = True
                            slot.value = struct.unpack_from("i", data, offset)[0]
                            slot.returned = True
                            count += 1
                self.received[1].close(self)
                self.receive_adoption_incomplete = False
                _need(count == 1 and len(ancillary) == 1 and not flags & socket.MSG_CTRUNC and bool(header))
            header += await self._read(4 - len(header), until)
            length = struct.unpack("!I", header)[0]
            _need(0 < length <= MAX_PLAN)
            message = json.loads(await self._read(length, until))
            _need(type(message) is dict and set(message) == {"op", "phase", "version"}
                  and type(message["phase"]) is int and message["phase"] == self.index
                  and type(message["version"]) is int and message["version"] == 1
                  and message["op"] == "mounted")
            self.facts = filesystem_facts(self.root.value)
            _need(self.facts[0] != self.mount_basis.st_dev)
            await self._send(_json({"op": "inputs", "files": self.plan}), until)
            for name, _, _ in self.plan:
                await self._send(self.inputs[name], until)
            size = struct.unpack("!I", await self._read(4, until))[0]
            _need(0 < size <= MAX_PLAN)
            ready = json.loads(await self._read(size, until))
            _need(type(ready) is dict and set(ready) == {"op", "phase", "files"}
                  and type(ready["phase"]) is int and ready["phase"] == self.index
                  and ready["op"] == "ready" and ready["files"] == self.plan)
            await self.verify_inputs(until)
            _need(proc is self.resource.proc and proc.returncode is None)
            await self._send(b"G", until)
            # Peer must close all its copies before C can inherit anything.
            while True:
                self.job.guard(until)
                try:
                    self.ack_return = self.parent.value.recv(1)
                    break
                except BlockingIOError:
                    await self._pause(until)
            _need(self.ack_return == b"" and self.parent.close(self))
            self.accepted = True
        except BaseException as error:
            self.remember(error, unknown=(self.send_attempted and not self.send_returned)
                          or (self.receive_attempted and not self.receive_returned)
                          or self.receive_adoption_incomplete)
            raise

    async def verify_inputs(self, until):
        """Independent bounded parent FD/hash readbacks before releasing C."""
        for index, (name, length, digest) in enumerate(self.plan):
            slot = self.input_checks[index]
            try:
                self.job.guard(until)
                slot.open_attempted = True
                slot.value = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                                     dir_fd=self.root.value)
                slot.returned = True
                before = os.fstat(slot.value)
                _need(stat.S_ISREG(before.st_mode) and before.st_size == length and before.st_uid == os.getuid())
                count, h = 0, hashlib.sha256()
                while True:
                    self.job.guard(until)
                    raw = os.read(slot.value, min(CHUNK, length - count + 1))
                    _need(type(raw) is bytes)
                    if not raw:
                        break
                    count += len(raw)
                    _need(count <= length)
                    h.update(raw)
                    await asyncio.sleep(0)
                    self.job.guard(until)
                after = os.fstat(slot.value)
                stamp = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
                _need(stamp(before) == stamp(after) and count == length and h.hexdigest() == digest)
            except BaseException as error:
                self.remember(error)
            finally:
                slot.close(self)
            self.raise_first()

    def _physical(self):
        return (self.resource.finished and self.resource.process_reaped and self.resource.controls_closed
                and self.resource.complete and self.resource.proc is self.proc)

    def dispose(self, until):
        if self.disposed:
            return True
        self._recover_pair()
        # Independent references close even when later directory disposal is not eligible.
        for slot in (self.child, self.parent, *self.received, *self.artifacts, *self.input_checks):
            slot.close(self)
        eligible = not self.spawn_attempted or self._physical()
        try:
            if eligible and self.mount_basis is not None and not self.rmdir_attempted:
                self.job.guard(until)
                now = os.stat(self.root_name, dir_fd=self.job.directory.value, follow_symlinks=False)
                _need((now.st_dev, now.st_ino) == (self.mount_basis.st_dev, self.mount_basis.st_ino))
                _need(not os.listdir(self.mountpoint.value))
                self.mountpoint.close(self)
                _need(self.mountpoint.closed)
                self.rmdir_attempted = True
                os.rmdir(self.root_name, dir_fd=self.job.directory.value)
                self.rmdir_returned = True
            if eligible and not self.metadata_cleanup_attempted:
                # Only these exact trusted profile coordinates, never a project tree walk.
                self.metadata_cleanup_attempted = True
                owned = self.profile_directory
                try:
                    self.job.guard(until)
                    _need(not owned.open_attempted)
                    owned.open_attempted = True
                    try:
                        owned.value = os.open(self.profile_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                              dir_fd=self.job.directory.value)
                    except FileNotFoundError as error:
                        owned.absence_error = error
                        owned.absent = type(error) is FileNotFoundError
                    else:
                        owned.returned = True
                        _need(set(os.listdir(owned.value)) <= {self.profile_file})
                        try:
                            os.unlink(self.profile_file, dir_fd=owned.value)
                        except FileNotFoundError:
                            pass
                except BaseException as error:
                    if self.profile_body_error is None:
                        self.profile_body_error = error  # raw E1 BEFORE finally close E2
                        self.profile_body_traceback = BaseException.__getattribute__(error, '__traceback__')
                    self.remember(error)
                finally:
                    owned.close(self)
                _need(self.profile_body_error is None and _known_slot(owned))
                self.job.guard(until)
                try:
                    os.rmdir(self.profile_name, dir_fd=self.job.directory.value)
                except FileNotFoundError:
                    pass
                self.metadata_removed = True
        except BaseException as error:
            self.remember(error)
        finally:
            self.mountpoint.close(self)
        self.disposed = (eligible and self.rmdir_returned and self.metadata_removed
            and all(_known_slot(x) for x in (self.child, self.parent, *self.received, *self.artifacts, *self.input_checks, self.mountpoint, self.profile_directory))
            and not self.unknown and not self.pair_adoption_incomplete
            and (not self.pair_attempted or self._pair_joined()))
        return self.disposed


def prepare_phase(context, resource, index, inputs, *, work_loop_until):
    from . import sandbox_resources as R
    _need(type(context) is R.ResourceContext and type(resource) is R.ResourcePhase
          and resource.context is context and resource in context.phases
          and type(index) is int and 0 <= index < 3 and context.workspaces[index] is None
          and type(context.workspace_job) is WorkspaceJob and context.workspace_job.context is context)
    phase = WorkspacePhase(context, resource, index, context.workspace_job, inputs)
    context.workspaces[index] = phase
    return phase.setup(work_loop_until)


def require_context_terminal(context):
    from . import sandbox_resources as R
    _need(type(context) is R.ResourceContext and type(context.workspaces) is list
          and len(context.workspaces) == 3)
    job = context.workspace_job
    if job is None:
        _need(all(x is None for x in context.workspaces))
        return
    _need(type(job) is WorkspaceJob and job.context is context and job.disposed
          and job.removed and job.directory.closed and not job.unknown)
    for index, phase in enumerate(context.workspaces):
        if phase is not None:
            _need(type(phase) is WorkspacePhase and phase.context is context and phase.index == index
                  and phase.job is job and type(phase.resource) is R.ResourcePhase
                  and phase.resource.context is context and phase.resource in context.phases
                  and phase.disposed and phase.rmdir_returned and phase.metadata_removed
                  and not phase.unknown
                  and not phase.pair_adoption_incomplete
                  and (not phase.pair_attempted or phase._pair_joined())
                  and all(_known_slot(s) for s in (*phase.received, *phase.artifacts, *phase.input_checks, phase.parent, phase.child, phase.mountpoint, phase.profile_directory)))


def require_phase_boundary(context):
    from . import sandbox_resources as R
    _need(type(context) is R.ResourceContext and type(context.workspaces) is list
          and len(context.workspaces) == 3)
    if context.workspace_job is None:
        _need(all(x is None for x in context.workspaces))
        return
    job = context.workspace_job
    _need(type(job) is WorkspaceJob and job.context is context and job.ready
          and not job.unknown and not job.disposed)
    for index, phase in enumerate(context.workspaces):
        if phase is not None:
            _need(type(phase) is WorkspacePhase and phase.context is context
                  and phase.job is job and phase.index == index and phase.disposed
                  and not phase.unknown
                  and not phase.pair_adoption_incomplete
                  and (not phase.pair_attempted or phase._pair_joined())
                  and all(_known_slot(s) for s in (*phase.received, *phase.artifacts, *phase.input_checks, phase.parent, phase.child, phase.mountpoint, phase.profile_directory)))


def artifact_directory(phase):
    _need(type(phase) is WorkspacePhase and phase.index == 2 and phase.accepted
          and phase._physical() and phase.root.returned and not phase.root.close_attempted)
    return phase.root.value


async def read_outputs(phase, names, total_cap, *, cleanup_loop_until):
    """Original named-file contract through retained FD, with every read FD owned.

    No adversarial recursive traversal. Errors/unknown closes do not free the
    workspace or its capacity reservation. Generic/Darwin reader is unchanged.
    """
    directory = artifact_directory(phase)
    from .sandbox_run import SandboxOutputLimit
    _need(type(names) is list and len(names) <= 32 and len(set(names)) == len(names)
          and all(_name(n) for n in names) and type(total_cap) is int and 1 <= total_cap <= 30 * 1024 * 1024)
    output, digests, total = {}, {}, 0
    for index, name in enumerate(names):
        owned = phase.artifacts[index]
        _need(not owned.open_attempted)
        try:
            phase.job.guard(cleanup_loop_until)
            owned.open_attempted = True
            try:
                owned.value = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                                      dir_fd=directory)
            except FileNotFoundError as error:
                owned.absence_error = error
                owned.absent = type(error) is FileNotFoundError
                continue
            owned.returned = True
            before = os.fstat(owned.value)
            if not stat.S_ISREG(before.st_mode) or before.st_size > min(30 * 1024 * 1024, total_cap - total):
                raise SandboxOutputLimit("sandbox artifact type or size refused")
            chunks, size = [], 0
            while True:
                phase.job.guard(cleanup_loop_until)
                raw = os.read(owned.value, min(CHUNK, total_cap - total - size + 1))
                _need(type(raw) is bytes)
                if not raw:
                    break
                size += len(raw)
                if size > 30 * 1024 * 1024 or total + size > total_cap:
                    raise SandboxOutputLimit("sandbox artifact total exceeded")
                chunks.append(raw)
                await asyncio.sleep(0)
                phase.job.guard(cleanup_loop_until)
            after = os.fstat(owned.value)
            stamp = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
            if stamp(before) != stamp(after) or size != before.st_size:
                raise RuntimeError("sandbox artifact changed during read")
            data = b"".join(chunks)
        except BaseException as error:
            phase.remember(error)
        finally:
            owned.close(phase)
        phase.raise_first()
        output[name], digests[name] = data, hashlib.sha256(data).hexdigest()
        total += size
    return output, digests, total


# Child-side protocol. Only the immutable trusted P/A/B prolog calls these.
class ChildWorkspace(_Evidence):
    def __init__(self, fd, until):
        super().__init__()
        self.fd, self.until = fd, until
        self.channel, self.root = _Owned(), _Owned()
        self.received = [_Owned(), _Owned()]
        self.mountpoint = self.received[0]
        self.barriers = [None, None]
        self.oom_slots = [_Owned(), _Owned(), _Owned()]
        self.oom_before = self.oom_requested = self.oom_after = None
        self.oom_write_attempted = False
        self.oom_write_raw = None
        self.start = self.raw_receive = self.raw_send = None
        self.phase = self.path = None
        self.mounted = self.ready = self.closed = False

    def guard(self):
        _need(type(self.until) is float and math.isfinite(self.until) and time.monotonic() < self.until)

    def wait(self, write=False):
        self.guard()
        poll = select.poll()
        poll.register(self.channel.value.fileno(), select.POLLOUT if write else select.POLLIN)
        result = poll.poll(max(1, math.floor((self.until - time.monotonic()) * 1000)))
        self.guard()
        _need(bool(result) and not any(mask & (select.POLLERR | select.POLLNVAL) for _, mask in result))

    def receive(self, count):
        out = bytearray()
        while len(out) < count:
            self.wait()
            try:
                raw = self.channel.value.recv(min(CHUNK, count - len(out)))
            except BlockingIOError:
                continue
            _need(type(raw) is bytes and bool(raw))
            out.extend(raw)
        return bytes(out)

    def message(self):
        size = struct.unpack("!I", self.receive(4))[0]
        _need(0 < size <= MAX_PLAN)
        return json.loads(self.receive(size))

    def send(self, raw, fd=None):
        position, ancillary_sent = 0, False
        while position < len(raw):
            self.wait(True)
            try:
                if fd is not None and not ancillary_sent:
                    self.raw_send = self.channel.value.sendmsg([raw], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                        array.array("i", [fd]))])
                    ancillary_sent = True
                else:
                    self.raw_send = self.channel.value.send(raw[position:position + CHUNK])
            except BlockingIOError:
                continue
            _need(type(self.raw_send) is int and 0 < self.raw_send <= len(raw) - position)
            position += self.raw_send

    def prepare(self):
        try:
            self.guard()
            self.channel.open_attempted = True
            self.channel.value = socket.socket(fileno=self.fd)
            self.channel.returned = True
            self.channel.value.setblocking(False)
            header = b""
            while not header:
                self.wait()
                try:
                    self.raw_receive = self.channel.value.recvmsg(4, socket.CMSG_SPACE(array.array("i").itemsize), socket.MSG_CMSG_CLOEXEC)
                except BlockingIOError:
                    continue
                header, ancillary, flags, _ = self.raw_receive
                count = 0
                for level, kind, data in ancillary:
                    if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                        _need(len(data) % array.array("i").itemsize == 0)
                        for offset in range(0, len(data), array.array("i").itemsize):
                            _need(count < len(self.received))
                            owned = self.received[count]
                            owned.open_attempted = True
                            owned.value = struct.unpack_from("i", data, offset)[0]
                            owned.returned = True
                            count += 1
                self.received[1].close(self)
                _need(count == 1 and len(ancillary) == 1 and not flags & socket.MSG_CTRUNC and bool(header))
            header += self.receive(4 - len(header))
            size = struct.unpack("!I", header)[0]
            _need(0 < size <= MAX_PLAN)
            self.start = json.loads(self.receive(size))
            _need(type(self.start) is dict and set(self.start) == {"op", "version", "phase", "path", "dev", "ino", "bytes", "inodes"}
                  and self.start["op"] == "workspace" and type(self.start["version"]) is int and self.start["version"] == 1
                  and type(self.start["phase"]) is int and 0 <= self.start["phase"] < 3
                  and self.start["bytes"] == BYTES and self.start["inodes"] == INODES)
            self.phase, self.path = self.start["phase"], self.start["path"]
            _need(type(self.path) is str and os.path.isabs(self.path) and os.path.realpath(self.path) == self.path)
            held, coordinate = os.fstat(self.mountpoint.value), os.stat(self.path, follow_symlinks=False)
            _need(stat.S_ISDIR(held.st_mode) and held.st_uid == os.getuid() and not held.st_mode & 0o077
                  and (held.st_dev, held.st_ino) == (coordinate.st_dev, coordinate.st_ino)
                  == (self.start["dev"], self.start["ino"]))
        except BaseException as error:
            self.remember(error)
        return self

    def mounted_root(self, workspace):
        try:
            self._populate(workspace)
        except BaseException as error:
            self.remember(error)
        finally:
            if not self.ready:
                self.close()
        self.raise_first()

    def _populate(self, workspace):
        """B calls after mounting/reopening the real namespace tmpfs, before C."""
        self.raise_first()
        self.guard()
        self.root.open_attempted = True
        self.root.value = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        self.root.returned = True
        facts = filesystem_facts(self.root.value)
        _need(facts[0] != os.fstat(self.mountpoint.value).st_dev)
        self.send(_json({"op": "mounted", "version": 1, "phase": self.phase}), self.root.value)
        self.mounted = True
        message = self.message()
        _need(type(message) is dict and set(message) == {"op", "files"} and message["op"] == "inputs"
              and type(message["files"]) is list and len(message["files"]) <= MAX_INPUT_FILES)
        total, names = 0, set()
        for item in message["files"]:
            _need(type(item) is list and len(item) == 3)
            name, length, digest = item
            _need(_name(name) and name not in names and type(length) is int and length >= 0
                  and type(digest) is str and len(digest) == 64
                  and all(c in "0123456789abcdef" for c in digest))
            names.add(name)
            total += length
            _need(total <= MAX_INPUT)
            self.guard()
            owned = _Owned()
            try:
                owned.open_attempted = True
                owned.value = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                                      0o600, dir_fd=self.root.value)
                owned.returned = True
                remaining, h = length, hashlib.sha256()
                while remaining:
                    data = self.receive(min(CHUNK, remaining))
                    position = 0
                    while position < len(data):
                        self.guard()
                        count = os.write(owned.value, data[position:])
                        _need(type(count) is int and 0 < count <= len(data) - position)
                        position += count
                    h.update(data)
                    remaining -= len(data)
                _need(h.hexdigest() == digest)
            except BaseException as error:
                self.remember(error)
            finally:
                owned.close(self)
            self.raise_first()
        self.send(_json({"op": "ready", "phase": self.phase, "files": message["files"]}))
        _need(self.receive(1) == b"G")
        self.guard()
        self.close()
        _need(self.closed)
        self.ready = True

    def adjust_oom_score(self):
        """P only, after actual placement and before fork/pressure; never lower."""
        try:
            self.guard()
            first, writer, verify = self.oom_slots
            first.open_attempted = True
            first.value = os.open("/proc/self/oom_score_adj", os.O_RDONLY | os.O_CLOEXEC)
            first.returned = True
            raw = os.read(first.value, 32)
            _need(type(raw) is bytes)
            text = raw.strip()
            self.oom_before = int(text)
            _need(type(raw) is bytes and raw.endswith(b"\n") and len(raw) <= 16
                  and str(self.oom_before).encode() == text and -1000 <= self.oom_before <= 1000)
            _need(first.close(self))
            self.oom_requested = max(500, self.oom_before)
            if self.oom_requested != self.oom_before:
                self.guard()
                writer.open_attempted = True
                writer.value = os.open("/proc/self/oom_score_adj", os.O_WRONLY | os.O_CLOEXEC)
                writer.returned = True
                data = str(self.oom_requested).encode("ascii")
                self.oom_write_attempted = True
                self.oom_write_raw = os.write(writer.value, data)
                # proc writes are individual settings, not a stream to retry in parts.
                _need(type(self.oom_write_raw) is int and self.oom_write_raw == len(data))
                _need(writer.close(self))
            self.guard()
            verify.open_attempted = True
            verify.value = os.open("/proc/self/oom_score_adj", os.O_RDONLY | os.O_CLOEXEC)
            verify.returned = True
            raw = os.read(verify.value, 32)
            _need(type(raw) is bytes)
            self.oom_after = int(raw.strip())
            _need(type(raw) is bytes and raw.endswith(b"\n") and len(raw) <= 16
                  and str(self.oom_after).encode() == raw.strip()
                  and self.oom_after == self.oom_requested and self.oom_after >= self.oom_before)
        except BaseException as error:
            self.remember(error)
        finally:
            for slot in self.oom_slots:
                slot.close(self)
        self.raise_first()

    def close_channels(self):
        # Every role closes every known reference independently; no retry on UNKNOWN.
        for owned in (self.root, *self.received, *self.oom_slots, self.channel):
            owned.close(self)
        self.closed = all(not x.open_attempted or x.closed for x in (self.root, *self.received, *self.oom_slots, self.channel)) and not self.unknown
        return self.closed

    def close(self):
        for barrier in self.barriers:
            if barrier is not None:
                barrier.close()
        return self.close_channels()

    def role_barrier(self, index):
        _need(type(index) is int and 0 <= index < 2 and self.barriers[index] is None)
        barrier = _RoleBarrier(self)
        self.barriers[index] = barrier
        return barrier.create()


class _RoleBarrier(_Evidence):
    """Original P-close before A work, then original A-close before B work."""
    def __init__(self, session):
        super().__init__()
        self.session = session
        self.read, self.write = _Owned(), _Owned()
        self.raw = None
        self.attempted = self.returned = self.ack_attempted = False
        self.raw_ack = self.raw_read = None

    def create(self):
        try:
            self.session.guard()
            self.attempted = True
            self.raw = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
            self.returned = True
            _need(type(self.raw) is tuple and len(self.raw) == 2
                  and all(type(fd) is int and fd >= 0 for fd in self.raw)
                  and self.raw[0] != self.raw[1])
            self.read.value, self.write.value = self.raw
            self.read.open_attempted = self.read.returned = True
            self.write.open_attempted = self.write.returned = True
        except BaseException as error:
            self.remember(error, unknown=self.attempted and not self.returned)
            self.session.remember(error, unknown=True)
        self.raise_first()
        return self

    def remember(self, error, *, unknown=False):
        # Session E0 can predate this role's derived guard or later close E1.
        if self.primary is None and self.session.primary is not None:
            self.primary = self.session.primary
            self.primary_tb = self.session.primary_tb
        super().remember(error, unknown=unknown)
        self.session.remember(self.primary, unknown=self.unknown)

    def wait(self, owned, writing=False):
        self.session.guard()
        poll = select.poll()
        poll.register(owned.value, select.POLLOUT if writing else select.POLLIN)
        raw = poll.poll(max(1, math.floor((self.session.until - time.monotonic()) * 1000)))
        self.session.guard()
        _need(bool(raw) and not any(mask & (select.POLLERR | select.POLLNVAL) for _, mask in raw))

    def parent_closed(self):
        """Only ACK after this role's actual reference closes returned known."""
        try:
            read_closed = self.read.close(self)
            channels_closed = self.session.close_channels()
            if self.session.primary is not None:
                self.remember(self.session.primary, unknown=self.session.unknown)
            _need(read_closed and channels_closed)
            self.wait(self.write, True)
            self.ack_attempted = True
            self.raw_ack = os.write(self.write.value, b"C")
            _need(type(self.raw_ack) is int and self.raw_ack == 1)
        except BaseException as error:
            self.remember(error)
        finally:
            self.close()
        self.raise_first()

    def child_wait(self):
        try:
            _need(self.write.close(self))
            data = b""
            while True:
                self.wait(self.read)
                try:
                    self.raw_read = os.read(self.read.value, 2 - len(data))
                except BlockingIOError:
                    continue
                _need(type(self.raw_read) is bytes)
                if not self.raw_read:
                    break
                data += self.raw_read
                _need(data == b"C")
            _need(data == b"C")
        except BaseException as error:
            self.remember(error)
        finally:
            self.close()
        self.raise_first()

    def close(self):
        for owned in (self.read, self.write):
            owned.close(self)
        if self.primary is not None:
            self.session.remember(self.primary, unknown=self.unknown)


def child_prepare(fd, until):
    _need(type(fd) is int and fd >= 3)
    return ChildWorkspace(fd, until).prepare()
