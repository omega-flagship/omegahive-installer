"""Private OS-resource ownership for the existing Linux sandbox runner.

SOURCE ONLY: no startup hook, availability enablement, executor or native grant.
The original Host must call bootstrap before workers, from operator unit config.
Every returned run attempt, including a failed preparation, needs cleanup_run.
"""
import math
import contextlib
import _thread
import os
import re
import stat
import time

_os, _now, _pause = os, time.monotonic, time.sleep
_KEY = object()
_CGROUP_MOUNT = "/sys/fs/cgroup"
_READ_MAX, _MOUNT_MAX, _MAX_BOOT_PIDS = 65536, 1024 * 1024, 4096
_MAX_PLACEMENTS = 3
_MAX_RESERVATIONS = 4096
_Lock, _LockType = _thread.allocate_lock, _thread.LockType
_READ_OBSERVATION_FLAGS = (os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
                           if all(hasattr(os, name) for name in ('O_RDONLY', 'O_NOFOLLOW', 'O_CLOEXEC'))
                           else None)
_REQUIRED = {"memory", "pids"}
_UNIT = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.@:-]{0,190}\.service\Z")
_RUN = re.compile(r"run-[A-Za-z0-9][A-Za-z0-9_-]{0,95}\Z")


class CgroupUnavailable(RuntimeError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class _CapacityTransitionBusy(CgroupUnavailable):
    def __init__(self, bootstrap, transition):
        self.bootstrap, self.transition = bootstrap, transition
        super().__init__('capacity_transition_busy')


class _Attempt:
    def __init__(self, key):
        if key is not _KEY:
            raise TypeError("private original resource attempt required")
        self.phase, self.ready, self.retired = "intent", False, False
        self.primary_error = self.primary_traceback = None
        self.secondary_errors = []
        self.close_errors, self.last_close_error = [], None
        self.first_close_error = None
        self.observation_incomplete = False
        self.descriptors, self.directories = [], []
        self.io_until = None


class BootstrapAttempt(_Attempt):
    def __init__(self, key):
        super().__init__(key)
        self.service_unit = self.relative_root = None
        self.service_uid = None
        self.root = self.host = self.runs = None
        self.members, self.moves = (), []
        self.controllers_enabled = False
        self.service_caps_finite = False
        self.service_memory_max = self.service_pids_max = None
        self.live_runs = 0
        self.capacity_policy = None
        self.workspace_policy = None
        self.capacity_lock = _Lock()
        self.capacity_runs = []  # actual original Run objects, not an authority lookup
        self.capacity_ready = self.capacity_unknown = False
        self.reserved_memory = self.reserved_pids = 0
        self.capacity_service_memory = self.capacity_service_pids = None
        self.root_memory_baseline = self.root_pids_baseline = None
        self.pool_observed_memory = self.pool_observed_pids = 0
        self.capacity_generation = 0  # local ledger consistency only, never a native receipt
        self.capacity_snapshot = self.capacity_transition = self.capacity_observation = None


class RunAttempt(_Attempt):
    def __init__(self, key, bootstrap):
        super().__init__(key)
        self.bootstrap, self.name = bootstrap, None
        self.leaf = self.migration = self.kill = None
        self.memory_bytes = self.pids = None
        self.limits_applied = False
        self.placements = []
        self.cleanup_started = self.cleanup_complete = False
        self.kill_attempted = self.kill_known = False
        self.populated_empty = self.removed = False
        self.phase_kill_attempted = self.phase_kill_known = self.phase_empty = False
        self.phase_kill_return = self.phase_kill_error = None
        self.balance_owned = False
        self.original_until = None
        self.kill_unknown = False
        self.stop_deadline_expired = False
        self.capacity_attempted = self.capacity_reserved = False
        self.capacity_release_attempted = self.capacity_released = False
        self.capacity_release_complete = False
        self.capacity_transitions = [None, None]  # original reserve/release records before publication
        self.run_quiesce_attempted = self.run_quiesce_complete = False


class _CapacityTransition:
    """One original metadata transition; never an admission receipt."""
    __slots__ = ('bootstrap', 'run', 'kind', 'before', 'after', 'outcome', 'error')

    def __init__(self, bootstrap, run, kind):
        self.bootstrap, self.run, self.kind = bootstrap, run, kind
        self.before, self.after = bootstrap.capacity_snapshot, None
        self.outcome, self.error = 'PENDING', None


class OwnedDescriptor:
    def __init__(self, key, owner, label):
        if key is not _KEY:
            raise TypeError("private original descriptor intent required")
        self.owner, self.label, self.value = owner, label, None
        self.open_flags = None  # actual original acquisition flags, retained BEFORE os.open
        self.directory_identity = None
        self.open_attempted = self.close_attempted = self.known_closed = False
        self.original_pid, self.placement_confirmed = None, False
        self.quiesce_attempted = self.quiesce_complete = False
        self.phase_kill_attempted = self.phase_kill_known = self.phase_empty = False
        self.phase_kill_return = self.phase_kill_error = None
        self.stop_deadline_expired = False

    @property
    def fd(self):
        if self.value is None or self.close_attempted:
            raise CgroupUnavailable("descriptor_not_live")
        return self.value


def _failure(owner, error):
    owner.ready = False
    if owner.primary_error is None:
        owner.primary_error = error  # retain raw primary BEFORE diagnostics/cleanup
        try:
            owner.primary_traceback = BaseException.__traceback__.__get__(error)
        except BaseException:
            owner.observation_incomplete = True
    elif error is not owner.primary_error:
        try:
            owner.secondary_errors.append(error)
        except BaseException:
            owner.observation_incomplete = True


def _need(condition, code):
    if not condition:
        raise CgroupUnavailable(code)


def _deadline(until):
    _need(type(until) in (int, float) and math.isfinite(until), "original_deadline_required")
    _need(_now() < until, "original_deadline_expired")


def _slot(owner, label):
    value = OwnedDescriptor(_KEY, owner, label)
    owner.descriptors.append(value)  # reserve BEFORE original open/dup
    return value


def close_owned(value):
    """Close this original parent descriptor once; UNKNOWN is never retried."""
    _need(type(value) is OwnedDescriptor and any(value is x for x in value.owner.descriptors),
          "foreign_descriptor")
    if value.close_attempted:
        return value.known_closed
    if value.value is None:
        return not value.open_attempted
    value.close_attempted = True
    try:
        _os.close(value.value)
        value.known_closed = True
    except BaseException as error:
        if value.owner.first_close_error is None:
            value.owner.first_close_error = error  # retain first raw close BEFORE any diagnostic append
        value.owner.last_close_error = error
        try:
            value.owner.close_errors.append(error)
        except BaseException:
            value.owner.observation_incomplete = True
        _failure(value.owner, error)
    return value.known_closed


def _open(owner, path, flags, *, directory=None, label="control"):
    _deadline(owner.io_until)
    value = _slot(owner, label)
    value.open_flags = flags | _os.O_NOFOLLOW | _os.O_CLOEXEC
    value.open_attempted = True
    try:
        value.value = _os.open(path, value.open_flags,
                               **({"dir_fd": directory.fd} if directory is not None else {}))
    except BaseException as error:
        _failure(owner, error)
        raise
    return value


def _io(owner, path, *, directory=None, data=None, cap=_READ_MAX):
    """One complete control write, or bounded read; independent known close."""
    value = _open(owner, path, _os.O_RDONLY if data is None else _os.O_WRONLY,
                  directory=directory)
    primary = None
    result = None
    try:
        if data is not None:
            _deadline(owner.io_until)
            count = _os.write(value.fd, data)
            _need(type(count) is int and count == len(data), "control_write_unknown")
        else:
            chunks, total = [], 0
            while True:
                _deadline(owner.io_until)
                block = _os.read(value.fd, min(4096, cap + 1 - total))
                if not block:
                    break
                chunks.append(block)
                total += len(block)
                _need(total <= cap, "control_read_overflow")
            result = b"".join(chunks).decode("ascii", "strict")
    except BaseException as error:
        primary = error
        _failure(owner, error)
    finally:
        closed = close_owned(value)
    if primary is not None:
        raise primary
    _need(closed, "control_close_unknown")
    return result


def _directory(owner, path):
    _need(path.startswith("/") and path != "/" and all(
        part not in ("", ".", "..") for part in path.split("/")[1:]), "directory_path")
    current = _open(owner, "/", _os.O_RDONLY | _os.O_DIRECTORY, label="path-anchor")
    for part in path.split("/")[1:]:
        following = _open(owner, part, _os.O_RDONLY | _os.O_DIRECTORY,
                          directory=current, label="directory")
        _need(close_owned(current), "ancestor_close_unknown")
        current = following
    return current


def _own_directory(value):
    st = _os.fstat(value.fd)
    _need(stat.S_ISDIR(st.st_mode) and st.st_uid == _os.geteuid()
          and not st.st_mode & 0o022, "directory_owner")
    identity = st.st_dev, st.st_ino
    if value.directory_identity is None:
        value.directory_identity = identity
    _need(value.directory_identity == identity, "directory_identity_changed")
    return identity


def _mkdir(owner, parent, name):
    intent = {"name": name, "attempted": False, "outcome": "NOT_ATTEMPTED", "descriptor": None}
    owner.directories.append(intent)
    intent["attempted"], intent["outcome"] = True, "UNKNOWN"
    try:
        _os.mkdir(name, 0o700, dir_fd=parent.fd)
        intent["outcome"] = "CREATED"
    except FileExistsError:
        intent["outcome"] = "EXISTS_NOT_OWNED"
        raise CgroupUnavailable("directory_exists_not_adopted") from None
    value = _open(owner, name, _os.O_RDONLY | _os.O_DIRECTORY, directory=parent, label=name)
    intent["descriptor"] = value
    _own_directory(value)
    return value


def _words(text):
    values = text.split()
    _need(len(values) == len(set(values)) and all(re.fullmatch(r"[a-z_]+", x) for x in values),
          "controller_readback")
    return set(values)


def _pids(text):
    rows = text.splitlines()
    _need(len(rows) <= _MAX_BOOT_PIDS and len(rows) == len(set(rows))
          and all(re.fullmatch(r"[1-9][0-9]{0,19}", x) for x in rows), "pid_readback")
    return tuple(int(x) for x in rows)


def _self_path(owner):
    raw = _io(owner, "/proc/self/cgroup")
    lines = raw.splitlines()
    _need(len(lines) == 1 and lines[0].startswith("0::/"), "unified_membership_required")
    path = lines[0][3:]
    _need(path != "/" and not path.endswith("/") and all(
        part not in ("", ".", "..") for part in path.split("/")[1:]), "service_membership")
    return path


def _mount(owner, relative_root):
    raw = _io(owner, "/proc/self/mountinfo", cap=_MOUNT_MAX)
    matched = []
    actual_root = _CGROUP_MOUNT + relative_root
    for line in raw.splitlines():
        fields = line.split()
        if "-" in fields and len(fields) >= 10:
            i = fields.index("-")
            _need(i + 1 < len(fields), "mountinfo_invalid")
            if fields[4] == _CGROUP_MOUNT:
                matched.append((fields[3], fields[i + 1]))
            elif fields[4].startswith(_CGROUP_MOUNT + "/"):
                _need(not (actual_root == fields[4] or actual_root.startswith(fields[4] + "/")),
                      "cgroup_root_overmounted")
    _need(matched == [("/", "cgroup2")], "exact_cgroup2_mount_required")


def _service_caps(observer, bootstrap_attempt):
    bootstrap_attempt.service_caps_finite = False
    values = []
    for name in ("memory.max", "pids.max"):
        text = _io(observer, name, directory=bootstrap_attempt.root).strip()
        _need(re.fullmatch(r"[1-9][0-9]{0,19}", text) is not None, "finite_service_caps_required")
        values.append(int(text))
    bootstrap_attempt.service_memory_max, bootstrap_attempt.service_pids_max = values
    bootstrap_attempt.service_caps_finite = True


def valid_capacity_policy(policy):
    """Original operator envelopes only; Linux has no configured defaults."""
    if type(policy) is not tuple or len(policy) != 8 or any(type(x) is not int for x in policy):
        return False
    hm, minimum, pool, reserve, slack, hp, pp, pr = policy
    return (all(0 <= x <= 2**63 - 1 for x in policy)
            and hm >= 16*1024*1024 and pool >= 16*1024*1024
            and minimum <= hm and 0 < slack < min(reserve, hm, pool) and hp > 1 and pp > 0 and pr > 0)


def _number(text):
    value = text.strip()
    _need(re.fullmatch(r"[0-9]{1,19}", value) is not None, "capacity_usage_unknown")
    result = int(value)
    _need(result <= 2**63 - 1, "capacity_usage_unknown")
    return result


def _capacity_preflight(owner):
    policy = owner.capacity_policy
    _need(valid_capacity_policy(policy), "operator_capacity_policy_required")
    hm, minimum, pool, reserve, slack, hp, pp, pr = policy
    _need(hm + pool + reserve <= owner.service_memory_max
          and hp + pp + pr <= owner.service_pids_max, "capacity_envelopes_do_not_fit")
    _need(_io(owner, "memory.swap.max", directory=owner.root).strip() == "0", "service_swap_policy_changed")
    owner.root_memory_baseline = _number(_io(owner, "memory.current", directory=owner.root))
    owner.root_pids_baseline = _number(_io(owner, "pids.current", directory=owner.root))
    _need(owner.root_memory_baseline + slack <= reserve, "root_charge_reserve_insufficient")
    _need(owner.root_pids_baseline <= hp, "host_task_envelope_below_usage")
    owner.capacity_service_memory, owner.capacity_service_pids = owner.service_memory_max, owner.service_pids_max


def _capacity_controls(owner):
    hm, minimum, pool, reserve, slack, hp, pp, pr = owner.capacity_policy
    return ((owner.host, (("memory.max", hm), ("memory.min", minimum),
                          ("memory.swap.max", 0), ("pids.max", hp))),
            (owner.runs, (("memory.max", pool), ("memory.swap.max", 0), ("pids.max", pp))))


def _capacity_apply(owner):
    for directory, controls in _capacity_controls(owner):
        expected = dict(controls)
        # Read current usage BEFORE tightening a newly owned child. Never adopt
        # an existing layout or presume a proposed host envelope is safe.
        _need(_number(_io(owner, "memory.current", directory=directory)) + owner.capacity_policy[4]
              <= expected["memory.max"],
              "memory_envelope_below_usage")
        _need(_number(_io(owner, "pids.current", directory=directory)) <= expected["pids.max"],
              "task_envelope_below_usage")
        for name, value in controls:
            _io(owner, name, directory=directory, data=(str(value) + "\n").encode())
    _capacity_limits(owner, owner)
    owner.capacity_ready = True


def _capacity_limits(owner, observer):
    _need(valid_capacity_policy(owner.capacity_policy), "operator_capacity_policy_required")
    _need(owner.service_memory_max == owner.capacity_service_memory
          and owner.service_pids_max == owner.capacity_service_pids, "service_capacity_changed")
    _need(_io(observer, "memory.swap.max", directory=owner.root).strip() == "0", "service_swap_policy_changed")
    for directory, controls in _capacity_controls(owner):
        for name, value in controls:
            _need(_io(observer, name, directory=directory).strip() == str(value), "capacity_readback_changed")
    _need(_number(_io(observer, "memory.current", directory=owner.root)) + owner.capacity_policy[4]
          <= owner.capacity_service_memory, "service_headroom_unavailable")


@contextlib.contextmanager
def _capacity_guard(owner, observer, until=None):
    _need(type(owner) is BootstrapAttempt and type(owner.capacity_lock) is _LockType,
          "original_capacity_lock_required")
    acquired, primary = False, None
    try:
        if until is None:
            acquired = owner.capacity_lock.acquire(False)  # fresh snapshot backpressure, never wait
        else:
            _deadline(until)
            acquired = owner.capacity_lock.acquire(timeout=max(0, until - _now()))
        _need(acquired is True, "capacity_transition_busy")
        yield
    except BaseException as error:
        primary = error
        raise
    finally:
        if acquired:
            try:
                owner.capacity_lock.release()
            except BaseException as error:
                owner.capacity_unknown = True
                _failure(owner, error)
                _failure(observer, error)
                if primary is None:
                    raise


def _capacity_healthy(owner):
    return (type(owner) is BootstrapAttempt and owner.ready is True and owner.retired is False
            and owner.primary_error is None and owner.observation_incomplete is False
            and owner.capacity_ready is True and owner.capacity_unknown is False
            and valid_capacity_policy(owner.capacity_policy)
            and type(owner.capacity_runs) is list and len(owner.capacity_runs) <= _MAX_RESERVATIONS
            and type(owner.reserved_memory) is int and type(owner.reserved_pids) is int
            and owner.reserved_memory >= 0 and owner.reserved_pids >= 0
            and owner.reserved_memory <= owner.capacity_policy[2]
            and owner.reserved_pids <= owner.capacity_policy[6]
            and type(owner.capacity_generation) is int and 0 <= owner.capacity_generation < 2**63 - 1
            and type(owner.live_runs) is int and owner.live_runs == len(owner.capacity_runs)
            and len({id(x) for x in owner.capacity_runs}) == len(owner.capacity_runs)
            and all(type(x) is RunAttempt and x.bootstrap is owner and x.capacity_reserved is True
                    and x.balance_owned is True and x.capacity_released is False
                    and x.capacity_release_attempted is False
                    and x.first_close_error is None and x.observation_incomplete is False
                    and x.kill_unknown is False
                    and type(x.memory_bytes) is int and type(x.pids) is int
                    for x in owner.capacity_runs)
            and sum(x.memory_bytes for x in owner.capacity_runs) == owner.reserved_memory
            and sum(x.pids for x in owner.capacity_runs) == owner.reserved_pids)


def capacity_available(owner, memory_bytes, pids):
    """Pure original-owner snapshot, not a reservation or kernel observation."""
    if (type(owner) is not BootstrapAttempt or type(memory_bytes) is not int or type(pids) is not int
            or memory_bytes <= 0 or pids <= 0):
        return False
    try:
        with _capacity_guard(owner, owner):
            return (_capacity_healthy(owner) and len(owner.capacity_runs) < _MAX_RESERVATIONS
                    and owner.reserved_memory + memory_bytes <= owner.capacity_policy[2]
                    and owner.reserved_pids + pids <= owner.capacity_policy[6])
    except Exception:
        return False


def capacity_usable(owner, memory_bytes, pids):
    """Ongoing owner/policy health: never demand a second reservation slot."""
    if (type(owner) is not BootstrapAttempt or type(memory_bytes) is not int or type(pids) is not int
            or memory_bytes <= 0 or pids <= 0):
        return False
    try:
        with _capacity_guard(owner, owner):
            return (_capacity_healthy(owner) and memory_bytes <= owner.capacity_policy[2]
                    and pids <= owner.capacity_policy[6])
    except Exception:
        return False


def _publish_capacity_snapshot(owner):
    """Called under the original short pure lock, after a known transition."""
    snapshot = (owner.capacity_generation, owner.capacity_policy, owner.workspace_policy,
                tuple((run, run.memory_bytes, run.pids) for run in owner.capacity_runs),
                owner.reserved_memory, owner.reserved_pids, owner.live_runs)
    owner.capacity_snapshot = snapshot
    return snapshot


def _begin_capacity_transition(owner, run, kind):
    transition = _CapacityTransition(owner, run, kind)
    run.capacity_transitions[0 if kind == 'reserve' else 1] = transition
    observation = (owner.capacity_snapshot, transition, 'PENDING')
    owner.capacity_transition = transition
    owner.capacity_observation = observation  # immutable original identity BEFORE mutation
    owner.capacity_unknown = True
    return transition


def _complete_capacity_transition(owner, transition):
    snapshot = _publish_capacity_snapshot(owner)
    transition.after = snapshot
    observation = (snapshot, transition, 'KNOWN')
    owner.capacity_unknown = False
    transition.outcome = 'KNOWN'
    owner.capacity_observation = observation  # one atomic whole-observation publication


def _fail_capacity_transition(owner, transition, error, *, run, kind):
    if transition is None:
        # Recover only this exact original Run's preallocated return slot;
        # never locate/adopt a record by name or retry an unreturned mutation.
        retained = run.capacity_transitions[0 if kind == 'reserve' else 1]
        if (type(retained) is _CapacityTransition and retained.bootstrap is owner
                and retained.run is run and retained.kind == kind):
            transition = retained
    if transition is not None:
        transition.error = error
        transition.outcome = 'UNKNOWN'
    owner.capacity_unknown, owner.ready = True, False  # BEFORE fallible diagnostics
    _failure(owner, error)


def _original_capacity_transition(owner, transition):
    if (type(transition) is not _CapacityTransition or transition.bootstrap is not owner
            or type(transition.run) is not RunAttempt or transition.run.bootstrap is not owner
            or transition.kind not in ('reserve', 'release') or transition.error is not None
            or transition.outcome not in ('PENDING', 'KNOWN')):
        return False
    run = transition.run
    before = transition.before
    return (type(run.capacity_transitions) is list and len(run.capacity_transitions) == 2
            and run.capacity_transitions[0 if transition.kind == 'reserve' else 1] is transition
            and type(before) is tuple and len(before) == 7
            and before[1] is owner.capacity_policy and before[2] is owner.workspace_policy)


def _continuation_observation_valid(owner, observation, memory_bytes, pids):
    if type(observation) is not tuple or len(observation) != 3:
        return False
    snapshot, transition, stage = observation
    if (type(snapshot) is not tuple or len(snapshot) != 7 or stage not in ('KNOWN', 'PENDING')
            or snapshot[1] is not owner.capacity_policy or snapshot[2] is not owner.workspace_policy
            or not valid_capacity_policy(snapshot[1])):
        return False
    generation, policy, workspace, rows, memory, tasks, count = snapshot
    if (type(generation) is not int or not 0 <= generation < 2**63-1
            or type(rows) is not tuple or len(rows) > _MAX_RESERVATIONS
            or type(memory) is not int or not 0 <= memory <= policy[2]
            or type(tasks) is not int or not 0 <= tasks <= policy[6]
            or type(count) is not int or count != len(rows)
            or memory_bytes > policy[2] or pids > policy[6]):
        return False
    if transition is not None:
        if (not _original_capacity_transition(owner, transition)
                or (stage == 'PENDING' and snapshot is not transition.before)
                or (stage == 'KNOWN' and snapshot is not transition.after)):
            return False
        target_rows = [row for row in rows if type(row) is tuple and len(row) == 3
                       and row[0] is transition.run]
        expected = (stage == 'PENDING' and transition.kind == 'release'
                    or stage == 'KNOWN' and transition.kind == 'reserve')
        if len(target_rows) != int(expected):
            return False
    elif stage != 'KNOWN' or generation != 0 or rows:
        return False
    originals = []
    for row in rows:
        if type(row) is not tuple or len(row) != 3:
            return False
        run, captured_memory, captured_pids = row
        if (type(run) is not RunAttempt or run.bootstrap is not owner
                or type(captured_memory) is not int or type(captured_pids) is not int
                or run.memory_bytes != captured_memory or run.pids != captured_pids
                or run.first_close_error is not None or run.observation_incomplete is not False
                or run.kill_unknown is not False):
            return False
        originals.append(run)
    if (len({id(run) for run in originals}) != count
            or sum(row[1] for row in rows) != memory or sum(row[2] for row in rows) != tasks):
        return False
    current = owner.capacity_transition
    pending_known = _original_capacity_transition(owner, current) and current.outcome == 'PENDING'
    return (owner.ready is True and owner.retired is False and owner.primary_error is None
            and owner.observation_incomplete is False and owner.capacity_ready is True
            and (owner.capacity_unknown is False or pending_known))


def capacity_continuation_usable(owner, memory_bytes, pids):
    """Nonblocking observation for an already-authorized worker ONLY.

    A coherent earlier snapshot may span a known original metadata transition.
    It never promises a fresh slot, physical allocation, or current native state.
    One final read checks changed publication; no spin or old-KNOWN fallback.
    Actual prepare/placement continue to use the locked current original ledger.
    """
    if (type(owner) is not BootstrapAttempt or type(memory_bytes) is not int or type(pids) is not int
            or memory_bytes <= 0 or pids <= 0):
        return False
    observation = owner.capacity_observation
    if not _continuation_observation_valid(owner, observation, memory_bytes, pids):
        return False
    latest = owner.capacity_observation
    if latest is not observation:
        if not _continuation_observation_valid(owner, latest, memory_bytes, pids):
            return False
    snapshot = latest[0]
    current = owner.capacity_transition
    pending_known = _original_capacity_transition(owner, current) and current.outcome == 'PENDING'
    return (owner.capacity_policy is snapshot[1] and owner.workspace_policy is snapshot[2]
            and owner.ready is True and owner.retired is False and owner.primary_error is None
            and owner.observation_incomplete is False and owner.capacity_ready is True
            and (owner.capacity_unknown is False or pending_known))


def _reserve_capacity(owner, until):
    boot = owner.bootstrap
    with _capacity_guard(boot, owner, until):
        _need(_capacity_healthy(boot), "original_capacity_unavailable")
        generation = boot.capacity_generation
    # Two separate bounds: full declared simultaneous limits, and currently
    # observed pool usage plus the requested limit. Never subtract racing child
    # samples or count known active usage twice on top of its full reservation.
    # Hidden late charges/future growth remain possible; the hard pool cap is
    # load-bearing. This is not physical allocation/preallocation authority.
    used_memory = _number(_io(owner, "memory.current", directory=boot.runs))
    used_pids = _number(_io(owner, "pids.current", directory=boot.runs))
    _need(_number(_io(owner, "pids.current", directory=boot.host)) < boot.capacity_policy[5],
          "host_staging_task_capacity_unavailable")
    with _capacity_guard(boot, owner, until):
        _need(_capacity_healthy(boot), "original_capacity_unavailable")
        _need(boot.capacity_generation == generation, "capacity_usage_snapshot_changed")
        _need(len(boot.capacity_runs) < _MAX_RESERVATIONS, "capacity_reservation_limit")
        memory, pids = boot.reserved_memory + owner.memory_bytes, boot.reserved_pids + owner.pids
        _need(memory <= boot.capacity_policy[2] and pids <= boot.capacity_policy[6]
              and used_memory + owner.memory_bytes <= boot.capacity_policy[2]
              and used_pids + owner.pids <= boot.capacity_policy[6], "run_capacity_unavailable")
        count = boot.live_runs + 1
        owner.capacity_attempted = True
        transition = None
        try:
            transition = _begin_capacity_transition(boot, owner, 'reserve')
            boot.capacity_runs.append(owner)  # actual Run retained BEFORE counters/leaf effects
            boot.reserved_memory, boot.reserved_pids, boot.live_runs = memory, pids, count
            boot.pool_observed_memory, boot.pool_observed_pids = used_memory, used_pids
            owner.capacity_reserved = owner.balance_owned = True
            boot.capacity_generation = generation + 1
            _complete_capacity_transition(boot, transition)
        except BaseException as error:
            _fail_capacity_transition(boot, transition, error, run=owner, kind='reserve')
            raise


def require_capacity_owned(owner, *, monotonic_until):
    _need(type(owner) is RunAttempt, "original_capacity_run_required")
    with _capacity_guard(owner.bootstrap, owner, monotonic_until):
        _need(_capacity_healthy(owner.bootstrap) and owner.capacity_reserved
              and not owner.capacity_release_attempted and not owner.capacity_released
              and any(owner is x for x in owner.bootstrap.capacity_runs), "original_capacity_reservation_unknown")
    return True


def release_run_capacity(owner, *, monotonic_until):
    """Final Root path only, AFTER actual workspace/P/FD/job and leaf completion.

    No posted proof is accepted. Native leaf cleanup alone never calls this.
    Unknown release is one-shot debt and can never be retried/healed.
    """
    _need(type(owner) is RunAttempt, "original_capacity_run_required")
    if owner.capacity_release_attempted:
        return owner.capacity_release_complete
    boot = owner.bootstrap
    with _capacity_guard(boot, owner, monotonic_until):
        _need(owner.cleanup_complete and not owner.observation_incomplete, "capacity_cleanup_unknown")
        if not owner.capacity_attempted:
            _need(not owner.capacity_reserved and not any(owner is x for x in boot.capacity_runs),
                  "capacity_reservation_unknown")
            owner.capacity_release_attempted = owner.capacity_released = owner.capacity_release_complete = True
            return True
        _need(not boot.capacity_unknown and owner.capacity_reserved and owner.balance_owned,
              "capacity_reservation_unknown")
        matches = [i for i, value in enumerate(boot.capacity_runs) if value is owner]
        _need(len(matches) == 1 and boot.reserved_memory >= owner.memory_bytes
              and boot.reserved_pids >= owner.pids and boot.live_runs > 0, "capacity_balance_unknown")
        _need(type(boot.capacity_generation) is int and boot.capacity_generation < 2**63 - 1,
              "capacity_generation_exhausted")
        memory, pids, count = boot.reserved_memory-owner.memory_bytes, boot.reserved_pids-owner.pids, boot.live_runs-1
        generation = boot.capacity_generation + 1
        transition = None
        try:
            transition = _begin_capacity_transition(boot, owner, 'release')
            owner.capacity_release_attempted = True
            del boot.capacity_runs[matches[0]]
            boot.reserved_memory, boot.reserved_pids, boot.live_runs = memory, pids, count
            owner.capacity_reserved = owner.balance_owned = False
            owner.capacity_released = True
            boot.capacity_generation = generation
            _complete_capacity_transition(boot, transition)
            owner.capacity_release_complete = True
        except BaseException as error:
            owner.capacity_release_complete = False
            owner.capacity_release_attempted = True  # unknown release is consumed, never retried
            _fail_capacity_transition(boot, transition, error, run=owner, kind='release')
            raise
    return owner.capacity_release_complete


def _close_all(owner):
    for value in reversed(owner.descriptors):
        if type(value) is not OwnedDescriptor or value.owner is not owner:
            owner.observation_incomplete = True
            _failure(owner, CgroupUnavailable('foreign_descriptor_not_adopted'))
            continue  # independent original closes remain eligible; no foreign FD adoption
        if value.value is not None and not value.close_attempted:
            close_owned(value)


def bootstrap(*, service_unit, monotonic_until, capacity_policy=None, workspace_policy=None):
    """Call ONCE before workers; never moves processes back or adopts old layout.

    service_unit is original operator configuration, not request/body metadata.
    This target profile is the system service /system.slice/<unit> only.
    A partial failure is retained for operator reconciliation, not rolled back.
    """
    owner = BootstrapAttempt(_KEY)
    try:
        _need(valid_capacity_policy(capacity_policy), "operator_capacity_policy_required")
        owner.capacity_policy = capacity_policy
        owner.workspace_policy = workspace_policy  # Root captures the exact W-validated tuple; no copy/adoption
        _deadline(monotonic_until)
        owner.io_until = monotonic_until
        _need(type(service_unit) is str and _UNIT.fullmatch(service_unit), "operator_unit_required")
        _need(_os.getuid() == _os.geteuid() and _os.geteuid() > 0, "unprivileged_service_uid_required")
        owner.service_uid = _os.geteuid()
        owner.service_unit = service_unit
        owner.relative_root = _self_path(owner)
        _need(owner.relative_root == "/system.slice/" + service_unit, "original_service_root_required")
        _mount(owner, owner.relative_root)
        owner.root = _directory(owner, _CGROUP_MOUNT + owner.relative_root)
        _own_directory(owner.root)
        _service_caps(owner, owner)
        _capacity_preflight(owner)  # reject unsafe envelopes/charges BEFORE mkdir/migration/cap writes
        _need(_REQUIRED <= _words(_io(owner, "cgroup.controllers", directory=owner.root)),
              "delegation_controllers_missing")
        owner.phase = "host-create"
        owner.host = _mkdir(owner, owner.root, "host")
        owner.members = _pids(_io(owner, "cgroup.procs", directory=owner.root))
        _need(_os.getpid() in owner.members, "original_service_pid_missing")
        for pid in owner.members:
            _deadline(monotonic_until)
            _need(pid in _pids(_io(owner, "cgroup.procs", directory=owner.root)), "root_membership_changed")
            progress = {"pid": pid, "write_attempted": False, "write_known": False}
            owner.moves.append(progress)
            progress["write_attempted"] = True
            _io(owner, "cgroup.procs", directory=owner.host, data=(str(pid) + "\n").encode())
            progress["write_known"] = True
        _need(not _pids(_io(owner, "cgroup.procs", directory=owner.root)), "root_not_empty")
        _need(set(owner.members) <= set(_pids(_io(owner, "cgroup.procs", directory=owner.host))),
              "host_migration_unknown")
        _need(_self_path(owner) == owner.relative_root + "/host", "host_self_membership_unknown")
        owner.phase = "controllers"
        _deadline(monotonic_until)
        _io(owner, "cgroup.subtree_control", directory=owner.root, data=b"+memory +pids\n")
        _need(_REQUIRED <= _words(_io(owner, "cgroup.subtree_control", directory=owner.root)),
              "root_controllers_not_applied")
        owner.runs = _mkdir(owner, owner.root, "runs")
        _need(_REQUIRED <= _words(_io(owner, "cgroup.controllers", directory=owner.runs)),
              "runs_controllers_missing")
        _io(owner, "cgroup.subtree_control", directory=owner.runs, data=b"+memory +pids\n")
        _need(_REQUIRED <= _words(_io(owner, "cgroup.subtree_control", directory=owner.runs)),
              "runs_controllers_not_applied")
        _capacity_apply(owner)
        _deadline(monotonic_until)
        owner.controllers_enabled = owner.ready = True
        owner.phase = "ready"
        with _capacity_guard(owner, owner, monotonic_until):
            snapshot = _publish_capacity_snapshot(owner)
            owner.capacity_observation = (snapshot, None, 'KNOWN')
    except BaseException as error:
        _failure(owner, error)
        owner.phase = "bootstrap-refused"
        _close_all(owner)
    return owner


def _require_capacity_work_ready(owner):
    transition = owner.capacity_transition
    if (owner.capacity_ready is True and owner.capacity_unknown is True
            and _original_capacity_transition(owner, transition)
            and transition.outcome == 'PENDING'):
        # Refuse fresh work without permanently withdrawing the original Boot
        # for a known bounded metadata transition. This carries raw identity,
        # not merely a code/label that another exception could imitate.
        raise _CapacityTransitionBusy(owner, transition)
    _need(owner.capacity_ready and not owner.capacity_unknown, "original_capacity_unavailable")


def _revalidate(owner, observer, until):
    _deadline(until)
    _need(type(owner) is BootstrapAttempt and owner.ready and not owner.retired
          and owner.primary_error is None, "bootstrap_not_ready")
    # Run reads belong to this original run's deadline/FD ledger, not the expired
    # startup allowance or another job's budget. Bootstrap never grants a clock.
    observer.io_until = until
    try:
        _require_capacity_work_ready(owner)  # known PENDING can refuse before any new IO
        _need(_os.getuid() == _os.geteuid() == owner.service_uid, "service_uid_changed")
        for value in (owner.root, owner.host, owner.runs):
            _own_directory(value)
        _mount(observer, owner.relative_root)
        _service_caps(observer, owner)
        _capacity_limits(owner, observer)
        _require_capacity_work_ready(owner)  # transition may begin during the preceding IO
        _need(_self_path(observer) == owner.relative_root + "/host", "host_self_membership_changed")
        _need(not _pids(_io(observer, "cgroup.procs", directory=owner.root)), "root_not_empty")
        for value in (owner.root, owner.runs):
            _need(_REQUIRED <= _words(_io(observer, "cgroup.subtree_control", directory=value)),
                  "controller_withdrawn")
    except BaseException as error:
        known_busy = (type(error) is _CapacityTransitionBusy and error.bootstrap is owner
                      and _original_capacity_transition(owner, error.transition))
        if not known_busy and not (type(error) is CgroupUnavailable and error.code == "original_deadline_expired"):
            owner.ready = False  # actual layout withdrawal/debt, not another job's clock
        raise


def _run_until(owner, supplied):
    _deadline(supplied)
    _need(type(owner) is RunAttempt and owner.original_until is not None, "original_run_deadline_required")
    value = min(supplied, owner.original_until)
    _deadline(value)
    owner.io_until = value
    return value


def _limits(owner):
    for name, expected in (("memory.max", owner.memory_bytes), ("pids.max", owner.pids),
                           ("memory.swap.max", 0), ("memory.oom.group", 1)):
        text = _io(owner, name, directory=owner.leaf)
        _need(text.strip() == str(expected), "limit_readback_mismatch")


def prepare_run(bootstrap_attempt, run_id, *, monotonic_until,
                memory_bytes=1024 * 1024 * 1024, pids=256):
    """Original operator limits only; always return the attempt for finally cleanup."""
    owner = RunAttempt(_KEY, bootstrap_attempt)
    try:
        _deadline(monotonic_until)
        owner.original_until = owner.io_until = monotonic_until
        owner.name, owner.memory_bytes, owner.pids = run_id, memory_bytes, pids  # raw inputs only, no grant
        _revalidate(bootstrap_attempt, owner, monotonic_until)
        _need(type(run_id) is str and _RUN.fullmatch(run_id), "original_run_id_required")
        _need(type(memory_bytes) is int and 16 * 1024 * 1024 <= memory_bytes <= 16 * 1024**3,
              "operator_memory_limit")
        _need(type(pids) is int and 1 <= pids <= 1024, "operator_pids_limit")
        _reserve_capacity(owner, monotonic_until)  # original actual Run retained before any leaf effect
        owner.leaf = _mkdir(owner, bootstrap_attempt.runs, run_id)
        for name, expected in (("memory.max", memory_bytes), ("pids.max", pids),
                               ("memory.swap.max", 0), ("memory.oom.group", 1)):
            _deadline(monotonic_until)
            _io(owner, name, directory=owner.leaf, data=(str(expected) + "\n").encode())
        _limits(owner)
        owner.migration = _open(owner, "cgroup.procs", _os.O_WRONLY, directory=owner.leaf, label="migration")
        owner.kill = _open(owner, "cgroup.kill", _os.O_WRONLY, directory=owner.leaf, label="kill")
        _deadline(monotonic_until)
        owner.limits_applied = owner.ready = True
        owner.phase = "prepared"
    except BaseException as error:
        _failure(owner, error)
        owner.phase = "prepare-refused"
    return owner


def placement_fd(owner, *, monotonic_until):
    """Sequential probe/final-P lease; original dup return is retained first."""
    try:
        until = _run_until(owner, monotonic_until)
        _revalidate(owner.bootstrap, owner, until)
        require_capacity_owned(owner, monotonic_until=until)
        _need(type(owner) is RunAttempt and owner.ready and owner.limits_applied
              and not owner.cleanup_started and len(owner.placements) < _MAX_PLACEMENTS, "run_not_prepared")
        _need(all(x.quiesce_complete and x.known_closed for x in owner.placements), "prior_phase_not_quiesced")
        _limits(owner)
        _need(not _pids(_io(owner, "cgroup.procs", directory=owner.leaf)), "previous_invocation_still_present")
        _need(_number(_io(owner, "pids.current", directory=owner.bootstrap.host))
              < owner.bootstrap.capacity_policy[5], "host_staging_task_capacity_unavailable")
        value = _slot(owner, "placement-copy")
        owner.placements.append(value)
        value.open_attempted = True
        value.value = _os.dup(owner.migration.fd)
        _os.set_inheritable(value.fd, False)
        _deadline(until)
        return value
    except BaseException as error:
        _failure(owner, error)
        raise


def confirm_placement(owner, lease, original_pid, *, monotonic_until):
    """Readback only: caller owns the actual live P handle and release protocol.

    Never call with a posted PID or use prior-probe confirmation for a new P.
    Child must be gated before first fork; parent copy close must be known.
    """
    try:
        until = _run_until(owner, monotonic_until)
        _revalidate(owner.bootstrap, owner, until)
        require_capacity_owned(owner, monotonic_until=until)
        _need(owner.ready and not owner.cleanup_started and any(lease is x for x in owner.placements)
              and lease.known_closed and not lease.placement_confirmed, "placement_lease_unknown")
        _need(type(original_pid) is int and original_pid > 0, "original_live_pid_required")
        _limits(owner)
        _need(_pids(_io(owner, "cgroup.procs", directory=owner.leaf)) == (original_pid,),
              "original_placement_not_observed")
        _deadline(until)
        lease.original_pid, lease.placement_confirmed = original_pid, True
        return True
    except BaseException as error:
        _failure(owner, error)
        raise


def _stop_progress(owner, lease):
    _need(type(owner) is RunAttempt, "original_run_attempt_required")
    if lease is None:
        return owner
    _need(type(lease) is OwnedDescriptor and lease.owner is owner
          and any(lease is x for x in owner.placements), "original_phase_required")
    return lease


def _open_stop_control(owner):
    # Cleanup-only original held leaf; no new read/poll/work allowance.
    value = _slot(owner, "cleanup-kill")
    value.open_attempted = True
    try:
        value.value = _os.open("cgroup.kill", _os.O_WRONLY | _os.O_NOFOLLOW | _os.O_CLOEXEC,
                               dir_fd=owner.leaf.fd)
    except BaseException as error:
        _failure(owner, error)
        raise
    return value


def begin_phase_stop(owner, lease=None, *, monotonic_until):
    """One nonpolling owned stop request BEFORE any Task/thread allocation.

    Cleanup may attempt the owned kill after TOTAL expiry, but expiry stays
    debt and grants no new poll/removal/work budget. No posted PID or retry.
    """
    progress = _stop_progress(owner, lease)
    if progress.phase_kill_attempted:
        return progress.phase_kill_known
    try:
        _need(type(monotonic_until) in (int, float) and math.isfinite(monotonic_until)
              and owner.original_until is not None, "original_stop_deadline_required")
        until = min(monotonic_until, owner.original_until)
        owner.io_until = until
        if _now() >= until:
            owner.stop_deadline_expired = progress.stop_deadline_expired = True
            # Optional expiry reporting cannot prevent the actual owned stop.
            try:
                _failure(owner, CgroupUnavailable("original_deadline_expired"))
            except BaseException as reporting:
                _failure(owner, reporting)
                owner.observation_incomplete = True
        if owner.leaf is None:
            _need(all(x["outcome"] in ("NOT_ATTEMPTED", "EXISTS_NOT_OWNED")
                      for x in owner.directories), "created_leaf_identity_unknown")
            return True  # no original owned leaf; never a kill/readiness claim
        _own_directory(owner.leaf)
        _need(not owner.kill_unknown, "previous_kill_write_unknown")
        progress.phase_kill_attempted = True
        owner.kill_unknown = True  # revoke before original open/write; never retry UNKNOWN
        if owner.kill is None:
            owner.kill = _open_stop_control(owner)
        progress.phase_kill_return = _os.write(owner.kill.fd, b"1\n")
        _need(type(progress.phase_kill_return) is int and progress.phase_kill_return == 2, "kill_write_unknown")
        owner.kill_unknown = False
        progress.phase_kill_known = True
    except BaseException as error:
        progress.phase_kill_error = error  # raw original outcome before diagnostics
        _failure(owner, error)
    return progress.phase_kill_known


def observe_phase_empty(owner, lease=None, *, monotonic_until):
    """One bounded populated read only; no kill, sleep or fresh clock."""
    progress = _stop_progress(owner, lease)
    _run_until(owner, monotonic_until)
    _need(progress.phase_kill_known and not owner.kill_unknown, "original_stop_write_unknown")
    _own_directory(owner.leaf)
    lines = _io(owner, "cgroup.events", directory=owner.leaf).splitlines()
    parts = [line.split() for line in lines]
    _need(all(len(x) == 2 for x in parts) and len({x[0] for x in parts}) == len(parts),
          "events_readback")
    values = dict(parts)
    _need(values.get("populated") in ("0", "1"), "populated_unknown")
    if values["populated"] == "0":
        progress.phase_empty = True
        return True
    return False


def _stop_leaf(owner, until, progress):
    lease = None if progress is owner else progress
    _need(begin_phase_stop(owner, lease, monotonic_until=until), "owned_stop_request_unknown")
    while not observe_phase_empty(owner, lease, monotonic_until=until):
        _pause(min(0.01, max(0, until - _now())))


def quiesce_phase(owner, lease, *, monotonic_until):
    """Stop/observe the leaf without removing it; Root separately reaps original P.

    This is not a wait receipt. The caller must reap that actual Process and close
    its owned protocol FDs before requesting the next placement lease.
    """
    _need(type(owner) is RunAttempt and any(lease is x for x in owner.placements), "original_phase_required")
    if lease.quiesce_attempted:
        return lease.quiesce_complete
    lease.quiesce_attempted = True
    try:
        _need(not owner.cleanup_started and lease.placement_confirmed and lease.known_closed,
              "phase_placement_unknown")
        _stop_leaf(owner, monotonic_until, lease)
        lease.quiesce_complete = lease.phase_kill_known and lease.phase_empty
    except BaseException as error:
        _failure(owner, error)
    return lease.quiesce_complete


def quiesce_run(owner, *, monotonic_until):
    """Non-removing final/aborted stop; workspace and capacity remain owned."""
    _need(type(owner) is RunAttempt, "original_run_attempt_required")
    if owner.run_quiesce_attempted:
        return owner.run_quiesce_complete
    owner.run_quiesce_attempted, owner.ready = True, False
    try:
        if owner.leaf is None:
            _run_until(owner, monotonic_until)
            _need(all(x["outcome"] in ("NOT_ATTEMPTED", "EXISTS_NOT_OWNED") for x in owner.directories),
                  "created_leaf_identity_unknown")
        else:
            progress = owner.placements[-1] if owner.placements else owner
            _stop_leaf(owner, monotonic_until, progress)
            owner.kill_known, owner.populated_empty = progress.phase_kill_known, progress.phase_empty
        owner.run_quiesce_complete = True
    except BaseException as error:
        _failure(owner, error)
    return owner.run_quiesce_complete


def cleanup_run(owner, *, monotonic_until):
    """One owned-leaf cleanup; no arbitrary PID, adoption, retry or deadline reset."""
    _need(type(owner) is RunAttempt, "original_run_attempt_required")
    if owner.cleanup_started:
        return status(owner)
    owner.cleanup_started, owner.ready = True, False
    cleanup_error = None
    try:
        if owner.leaf is None:
            _run_until(owner, monotonic_until)
            _need(all(x["outcome"] in ("NOT_ATTEMPTED", "EXISTS_NOT_OWNED") for x in owner.directories),
                  "created_leaf_identity_unknown")
        else:
            _own_directory(owner.leaf)
            owner.kill_attempted = True
            # Reuse this exact latest phase's immediate stop; terminal wrapper
            # does not issue a duplicate kill for the same phase.
            progress = (owner.placements[-1] if owner.placements
                        and owner.placements[-1].phase_kill_attempted else owner)
            _stop_leaf(owner, monotonic_until, progress)
            owner.kill_known, owner.populated_empty = progress.phase_kill_known, progress.phase_empty
            held = _own_directory(owner.leaf)
            named = _os.stat(owner.name, dir_fd=owner.bootstrap.runs.fd, follow_symlinks=False)
            _need(stat.S_ISDIR(named.st_mode) and (named.st_dev, named.st_ino) == held,
                  "owned_leaf_name_changed")
            _run_until(owner, monotonic_until)
            _os.rmdir(owner.name, dir_fd=owner.bootstrap.runs.fd)
            owner.removed = True
    except BaseException as error:
        cleanup_error = error
        _failure(owner, error)
    finally:
        _close_all(owner)
    closed = all((x.value is None and not x.open_attempted) or x.known_closed for x in owner.descriptors)
    no_owned_leaf = owner.leaf is None and all(x["outcome"] in ("NOT_ATTEMPTED", "EXISTS_NOT_OWNED")
                                              for x in owner.directories)
    owner.cleanup_complete = (cleanup_error is None and not owner.observation_incomplete and closed
                              and (no_owned_leaf or owner.kill_known and owner.populated_empty and owner.removed))
    # Root workspace/P/FD/job disposition is a separate original terminal join.
    # Its final release_run_capacity call, never this native leaf result, releases
    # the reservation. Retired/UNKNOWN workspace pages cannot become free slots.
    owner.phase = "closed" if owner.cleanup_complete else "cleanup-debt"
    return status(owner)


def close_bootstrap(owner):
    """Retire before independent closes; no migration/layout rollback or adoption."""
    _need(type(owner) is BootstrapAttempt, "original_bootstrap_attempt_required")
    owner.retired, owner.ready = True, False
    if (owner.live_runs or owner.capacity_runs or owner.reserved_memory or owner.reserved_pids
            or owner.capacity_unknown):
        owner.phase = "retired-with-live-run-debt"
        return status(owner)
    _close_all(owner)
    owner.phase = "retired"
    return status(owner)


def status(owner):
    """Bounded private status projection, never readiness/identity/work authority."""
    _need(type(owner) in (BootstrapAttempt, RunAttempt), "original_attempt_required")
    result = {"phase": owner.phase, "ready": owner.ready, "retired": owner.retired,
              "primary_error_present": owner.primary_error is not None,
              "secondary_error_count": len(owner.secondary_errors),
              "close_error_count": len(owner.close_errors),
              "observation_incomplete": owner.observation_incomplete,
              "created_directories": sum(x["outcome"] == "CREATED" for x in owner.directories),
              "unknown_directory_creations": sum(x["outcome"] == "UNKNOWN" for x in owner.directories),
              "descriptors_open": sum(x.value is not None and not x.close_attempted for x in owner.descriptors),
              "descriptor_open_unknown": sum(x.open_attempted and x.value is None for x in owner.descriptors),
              "descriptor_close_unknown": sum(x.close_attempted and not x.known_closed for x in owner.descriptors)}
    if type(owner) is BootstrapAttempt:
        result.update(moves_attempted=sum(x["write_attempted"] for x in owner.moves),
                      moves_known=sum(x["write_known"] for x in owner.moves), live_runs=owner.live_runs,
                      service_caps_finite=owner.service_caps_finite,
                      capacity_ready=owner.capacity_ready, capacity_unknown=owner.capacity_unknown,
                      reserved_memory_bytes=owner.reserved_memory, reserved_pids=owner.reserved_pids)
    else:
        result.update(limits_applied=owner.limits_applied, placements=len(owner.placements),
                      confirmed_placements=sum(x.placement_confirmed for x in owner.placements),
                      kill_known=owner.kill_known, populated_empty=owner.populated_empty,
                      leaf_removed=owner.removed, cleanup_complete=owner.cleanup_complete)
    return result
