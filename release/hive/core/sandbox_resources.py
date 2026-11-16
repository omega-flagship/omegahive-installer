"""Private descriptor/resource custody for the existing sandbox runner only.

SOURCE ONLY. This does not admit work, dispatch processes, enable Linux, or
establish native identity. Root supplies its already-admitted original TOTAL
deadlines and directed-down clock adapter; the runner owns original Process
creation, reaping and output. All resource effects use the one cgroup owner.
"""
import asyncio
import math
import os
import time

from .code_aggregate import _CodeAggregate
from ..supervisor import cgroup_v2 as C

_os = os
_now = time.monotonic
_get_loop = asyncio.get_running_loop
_to_thread = asyncio.to_thread
_Process = asyncio.subprocess.Process
_NO_OBSERVATION_UNTIL = -1.7976931348623157e308  # finite binary64 minimum, not a new budget


class ResourceBridgeError(RuntimeError):
    def __init__(self, owner, code):
        self.owner, self.code = owner, code
        super().__init__(code)


class _Evidence:
    def __init__(self):
        self.primary = self.primary_traceback = None
        self.secondary = []
        self.secondary_fallback = self.recording_error = None
        self.observation_incomplete = False

    def remember(self, error, *, unknown=False):
        if self.primary is None:
            self.primary = error
            try:
                self.primary_traceback = BaseException.__traceback__.__get__(error)
            except BaseException as recording:
                self.recording_error = recording
                self.observation_incomplete = True
        elif error is not self.primary:
            if self.secondary_fallback is None:
                self.secondary_fallback = error
            try:
                self.secondary.append(error)
            except BaseException as recording:
                if self.recording_error is None:
                    self.recording_error = recording
                self.observation_incomplete = True
        if unknown:
            self.observation_incomplete = True


def _need(condition, owner, code):
    if not condition:
        raise ResourceBridgeError(owner, code)


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def _raise_first(owner, fallback):
    error = owner.primary if owner.primary is not None else fallback
    traceback = (owner.primary_traceback if error is owner.primary
                 else BaseException.__traceback__.__get__(error))
    raise BaseException.with_traceback(error, traceback)


def _other_contexts_healthy(owner, subject, *, excluding=None):
    """Raw original custody only; no status/callback or alternate registry."""
    for other in owner._runner_contexts:
        if other is excluding:
            continue
        _need(type(other) is ResourceContext and other.owner is owner
              and other.limits is owner.limits and other.bootstrap is owner.attempt
              and type(other.bootstrap) is C.BootstrapAttempt
              and other.capacity_policy is owner.capacity_policy
              and other.bootstrap.capacity_policy is other.capacity_policy
              and other.workspace_policy is owner.workspace_policy
              and other.bootstrap.workspace_policy is other.workspace_policy,
              subject, 'foreign_or_changed_resource_custody')
        _need(other.ready is True and other.aborted is False and other.retired is False
              and other.released is False and other.observation_incomplete is False
              and other.primary is None and other.cleanup_task_unknown is False,
              subject, 'retained_resource_context_debt')
        run = other.run
        _need(type(run) is C.RunAttempt and run.bootstrap is other.bootstrap
              and run.ready is True and run.cleanup_started is False
              and run.kill_unknown is False and run.observation_incomplete is False
              and run.primary_error is None and run.capacity_reserved is True
              and not run.capacity_release_attempted and not run.capacity_released,
              subject, 'retained_resource_run_debt')
        for phase in other.phases:
            _need(type(phase) is ResourcePhase and phase.context is other
                  and phase.primary is None and phase.observation_incomplete is False
                  and phase.stop_task_unknown is False
                  and (not phase.finished or phase.complete),
                  subject, 'retained_resource_phase_debt')


def _known_closed_read_observations(run):
    """Only this actual Run's original readonly acquisition/close ledger.

    No FD is looked up, opened, closed, adopted or retried from this predicate.
    Labels alone are never provenance; exact acquired flags and raw known close
    facts are required. A live/unreturned/foreign/write/uncertain record refuses.
    """
    if (type(run.descriptors) is not list or type(C._READ_OBSERVATION_FLAGS) is not int
            or len({id(slot) for slot in run.descriptors}) != len(run.descriptors)):
        return False
    return all(type(slot) is C.OwnedDescriptor and slot.owner is run
               and slot.label == 'control' and type(slot.open_flags) is int
               and slot.open_flags == C._READ_OBSERVATION_FLAGS
               and slot.open_attempted is True and type(slot.value) is int and slot.value >= 0
               and slot.close_attempted is True and slot.known_closed is True
               for slot in run.descriptors)


def _known_zero_run_cleanup(context, run):
    """Actual returned zero-effect custody, not an error-code exemption."""
    return (context.quiesce_attempted is True and context.prepare_attempted is True
            and run.capacity_attempted is False and run.capacity_reserved is False
            and run.balance_owned is False and run.leaf is None
            and type(run.directories) is list and not run.directories
            and _known_closed_read_observations(run)
            and type(run.placements) is list and not run.placements
            and type(run.capacity_transitions) is list and len(run.capacity_transitions) == 2
            and all(value is None for value in run.capacity_transitions)
            and type(context.phases) is list and not context.phases
            and context.workspace_job is None
            and type(context.workspaces) is list and len(context.workspaces) == 3
            and all(value is None for value in context.workspaces)
            and ((run.capacity_release_attempted is False and run.capacity_released is False
                  and run.capacity_release_complete is False)
                 or (run.capacity_release_attempted is True and run.capacity_released is True
                     and run.capacity_release_complete is True and run.cleanup_complete is True)))


def require_owner_continuation(owner, original_limits, original_bootstrap,
                               original_capacity_policy, original_workspace_policy):
    """Pure continuation of existing work; this never reserves/admit new work.

    Known bounded original cleanup may be in progress. UNKNOWN native/worker/
    callback/descriptor/disposition evidence still refuses. One immutable
    original ledger observation spans known reserve/release metadata progress;
    no lock wait, IO, clock, await, status or fresh capacity grant occurs here.
    """
    _need(type(owner) is _CodeAggregate and owner.limits is original_limits
          and owner.attempt is original_bootstrap and owner._valid_limits()
          and owner.retirement_attempted is False and owner.primary_error is None
          and owner.observation_incomplete is False,
          owner, 'original_resource_owner_changed')
    boot = original_bootstrap
    _need(type(boot) is C.BootstrapAttempt
          and owner.capacity_policy is original_capacity_policy
          and boot.capacity_policy is original_capacity_policy
          and owner.workspace_policy is original_workspace_policy
          and boot.workspace_policy is original_workspace_policy,
          owner, 'original_resource_policy_changed')
    _need(C.capacity_continuation_usable(boot, original_limits[1], original_limits[2]),
          owner, 'original_capacity_unavailable')
    _need(type(owner._runner_contexts) is list, owner, 'original_resource_custody_required')
    for context in owner._runner_contexts:
        _need(type(context) is ResourceContext and context.owner is owner
              and context.limits is original_limits and context.bootstrap is boot
              and context.capacity_policy is original_capacity_policy
              and context.workspace_policy is original_workspace_policy
              and context.reserved is True and context.released is False,
              owner, 'foreign_or_changed_resource_custody')
        _need(context.observation_incomplete is False
              and context.cleanup_task_unknown is False and context.quiesce_task_unknown is False,
              owner, 'retained_resource_context_debt')
        run = context.run
        _need(type(run) is C.RunAttempt and run.bootstrap is boot
              and run.memory_bytes == original_limits[1] and run.pids == original_limits[2]
              and run.first_close_error is None and run.observation_incomplete is False
              and run.kill_unknown is False,
              owner, 'retained_resource_run_debt')
        terminal = (context.retired is True and context.quiesced is True
                    and context.capacity_release_returned is True
                    and context.capacity_release_raw is True
                    and run.cleanup_complete is True and run.capacity_released is True
                    and run.capacity_release_complete is True)
        transition = boot.capacity_transition
        known_release = (context.retired is True and context.quiesced is True
                         and context.capacity_release_attempted is True and run.cleanup_complete is True
                         and type(transition) is C._CapacityTransition
                         and transition.bootstrap is boot and transition.run is run
                         and transition.kind == 'release' and transition.error is None
                         and transition.outcome in ('PENDING', 'KNOWN'))
        _need(terminal or known_release or _known_zero_run_cleanup(context, run)
              or run.capacity_reserved is True and run.balance_owned is True
              and run.capacity_release_attempted is False,
              owner, 'original_capacity_reservation_unknown')
        # A normal work exit/cancellation does not itself make an original
        # in-progress cleanup UNKNOWN. Outside that retained cleanup scope the
        # ordinary strict work predicates still apply.
        _need(context.quiesce_attempted is True or context.ready is True
              and context.aborted is False and context.primary is None,
              owner, 'retained_resource_context_debt')
        for phase in context.phases:
            _need(type(phase) is ResourcePhase and phase.context is context
                  and phase.observation_incomplete is False and phase.stop_task_unknown is False
                  and (not phase.finished or phase.process_reaped and phase.controls_closed),
                  owner, 'retained_resource_phase_debt')
            _need(all(not wait.attempted or wait.removed or not phase.finished
                      for wait in phase.waits), owner, 'retained_callback_removal_unknown')
    _need(owner.limits is original_limits and owner.attempt is boot
          and owner.capacity_policy is original_capacity_policy
          and boot.capacity_policy is original_capacity_policy
          and owner.workspace_policy is original_workspace_policy
          and boot.workspace_policy is original_workspace_policy
          and not owner.retirement_attempted and not boot.retired,
          owner, 'original_resource_policy_changed')
    return True


class _PipeIntent:
    def __init__(self):
        self.read = self.write = None
        self.attempted, self.raw, self.returned = False, None, False


class _WaitIntent:
    def __init__(self, descriptor, write):
        self.descriptor, self.write = descriptor, write
        self.future = None
        self.attempted = self.registered = self.remove_attempted = self.removed = False
        self.register_return = self.remove_return = None
        self.error = None


class ResourceContext(_Evidence):
    def __init__(self, owner, run_id, mono_until, loop_until, adapter):
        super().__init__()
        self.owner, self.run_id = owner, run_id
        self.limits = self.bootstrap = self.loop = self.capacity_policy = None
        self.monotonic_until, self.loop_until, self.adapter = mono_until, loop_until, adapter
        self.reserved = self.prepare_attempted = self.ready = self.aborted = False
        self.run = None
        self.phases = []
        self.workspaces = [None, None, None]
        self.workspace_job = None
        self.workspace_policy = None
        self.quiesce_attempted = self.quiesced = False
        self.quiesce_coro = self.quiesce_task = self.quiesce_raw = None
        self.quiesce_returned = self.quiesce_task_unknown = False
        self.capacity_release_attempted = self.capacity_release_returned = False
        self.capacity_release_raw = None
        self.cleanup_coro = self.cleanup_task = self.cleanup_raw = None
        self.cleanup_attempted = self.cleanup_returned = self.cleanup_task_unknown = False
        self.first_cleanup_error = None
        self.stop_request_attempted = self.stop_request_known = False
        self.stop_request_raw = self.stop_request_error = None
        self.retired = self.released = False

    def _current(self):
        if self.primary is not None:
            _raise_first(self, self.primary)
        _need(self.observation_incomplete is False and not self.aborted,
              self, 'original_context_error_disallows_work')
        _need(not self.quiesce_attempted and not self.retired, self, 'original_context_retiring')
        _need(type(self.owner) is _CodeAggregate and self.owner.limits is self.limits,
              self, 'original_resource_owner_changed')
        _need(self.owner.attempt is self.bootstrap and not self.owner.retirement_attempted
              and type(self.bootstrap) is C.BootstrapAttempt and self.bootstrap.ready
              and not self.bootstrap.retired, self, 'original_bootstrap_not_live')
        _need(self.owner.capacity_policy is self.capacity_policy
              and self.bootstrap.capacity_policy is self.capacity_policy
              and self.bootstrap.capacity_ready, self, 'original_capacity_policy_changed')
        _need(self.owner.workspace_policy is self.workspace_policy
              and self.bootstrap.workspace_policy is self.workspace_policy,
              self, 'original_workspace_policy_changed')
        if self.run is not None:
            _need(self.run.capacity_reserved and not self.run.capacity_release_attempted
                  and not self.run.capacity_released, self, 'original_run_capacity_missing')
        _need(type(self.owner._runner_contexts) is list
              and any(x is self for x in self.owner._runner_contexts), self, 'resource_custody_missing')
        _other_contexts_healthy(self.owner, self, excluding=self)

    def _mono(self, supplied_loop):
        _need(self.loop is _get_loop() and _finite(supplied_loop), self, 'original_loop_deadline_required')
        until = min(supplied_loop, self.loop_until)
        _need(self.loop.time() < until, self, 'original_total_deadline_expired')
        translated = self.adapter(self.loop, until)
        _need(_finite(translated), self, 'finite_root_clock_translation_required')
        result = min(translated, self.monotonic_until)
        _need(_now() < result, self, 'original_monotonic_deadline_expired')
        return result

    def _helper_evidence(self, phase=None):
        # An already retained genuine bridge error remains earlier than a
        # later helper observation; do not overwrite its original traceback.
        if phase is not None and self.primary is not None:
            phase.remember(self.primary)
        if self.run is None:
            return
        # Fixed raw fallback precedes every optional list/status observation.
        first = self.run.first_close_error
        if first is not None and self.first_cleanup_error is None:
            self.first_cleanup_error = first
        raw = self.run.primary_error if self.run.primary_error is not None else first
        if raw is not None:
            if phase is not None:
                phase.remember(raw)
            self.remember(raw)
            self.aborted = True
        if self.run.observation_incomplete:
            self.observation_incomplete = True
            if phase is not None:
                phase.observation_incomplete = True

    def new_phase(self, *, work_loop_until):
        phase = ResourcePhase(self, work_loop_until)
        self.phases.append(phase)  # reserve before placement dup or pipe effects
        try:
            self._current()
            _need(self.ready and not self.aborted and not self.retired and self.run.ready,
                  self, 'resource_context_not_ready')
            _need(all(x.complete for x in self.phases[:-1]), self, 'prior_original_phase_unresolved')
            from . import sandbox_workspace as W
            # The just-reserved ResourcePhase has no workspace yet. All older
            # exact workspace slots must already have known disposal.
            W.require_phase_boundary(self)  # original exact job/three-slot raw custody, not a posted boolean
            _need(_finite(work_loop_until), self, 'original_work_deadline_required')
            phase.work_loop_until = min(work_loop_until, self.loop_until)
            # This parent IS the sender. Derive once from this exact original
            # work-loop bound; the child receives an immutable absolute value.
            phase.child_until = self._mono(phase.work_loop_until)
            phase.placement_index = len(self.run.placements)
            phase.lease = C.placement_fd(self.run, monotonic_until=phase.child_until)
            self._helper_evidence(phase)
            if phase.primary is not None:
                _raise_first(phase, phase.primary)
            phase.control_slots[0] = phase.lease
            # All four pipe endpoint intents exist in the SAME RunAttempt ledger
            # before either native pair can exist. No second FD owner registry.
            phase.status, phase.release = _PipeIntent(), _PipeIntent()
            phase.pipe_intents[0], phase.pipe_intents[1] = phase.status, phase.release
            phase.status.read = C._slot(self.run, 'status-read')
            phase.control_slots[1] = phase.status.read
            phase.status.write = C._slot(self.run, 'status-child-write')
            phase.control_slots[2] = phase.status.write
            phase.release.read = C._slot(self.run, 'release-child-read')
            phase.control_slots[3] = phase.release.read
            phase.release.write = C._slot(self.run, 'release-write')
            phase.control_slots[4] = phase.release.write
            phase._pipe(phase.status)
            phase._pipe(phase.release)
            phase.ready = True
        except BaseException as error:
            self._helper_evidence(phase)  # original helper E1 precedes its wrapper E2
            phase.remember(error)
            self.remember(error)
            self.aborted = True
            # placement_fd retains the actual returned dup in its original
            # ledger before later checks. Recover only that same retained row.
            if (phase.lease is None and phase.placement_index is not None
                    and len(self.run.placements) == phase.placement_index + 1):
                phase.lease = self.run.placements[phase.placement_index]
                phase.control_slots[0] = phase.lease
            self._helper_evidence()
        return phase

    async def quiesce(self, cleanup_loop_until):
        """Stop/join only; workspace, leaf, capacity and context remain owned."""
        if self.quiesce_attempted:
            return self.quiesced
        self.quiesce_attempted, self.ready = True, False
        try:
            try:
                mono = self._mono(cleanup_loop_until)
            except BaseException as error:
                self.remember(error)
                self.aborted = True
                mono = _NO_OBSERVATION_UNTIL
            _need(not self.prepare_attempted or self.run is not None,
                  self, 'original_run_return_unknown')
            if self.run is not None:
                self.stop_request_attempted = True
                progress = self.run.placements[-1] if self.run.placements else None
                try:
                    self.stop_request_raw = C.begin_phase_stop(self.run, progress, monotonic_until=mono)
                    self._helper_evidence()
                    self.stop_request_known = self.stop_request_raw is True
                    self.stop_request_error = (self.run if progress is None else progress).phase_kill_error
                    if self.stop_request_error is not None:
                        self.remember(self.stop_request_error)
                except BaseException as error:
                    self._helper_evidence()
                    self.remember(error, unknown=True)
            for phase in self.phases:
                if not phase.finished:
                    await phase.finish_phase(phase.proc, {}, cleanup_loop_until)
            _need(all(x.finished and x.process_reaped and x.controls_closed
                      and not x.observation_incomplete for x in self.phases),
                  self, 'original_phase_terminal_unknown')
            _need(not any(x.stop_task is not None and not x.stop_task.done()
                          for x in self.phases), self, 'resource_stop_still_running')
            if self.run is not None:
                self.quiesce_task_unknown = True
                self.quiesce_coro = _to_thread(self._quiesce_native, mono)
                self.quiesce_task = asyncio.create_task(self.quiesce_coro)
                self.quiesce_task_unknown = False
                await _join(self, self.quiesce_task, cleanup_loop_until)
                self._helper_evidence()
                _need(self.quiesce_returned and self.quiesce_raw is True
                      and self.run.run_quiesce_complete, self, 'owned_leaf_quiescence_unknown')
            _need(not self.observation_incomplete, self, 'resource_observation_incomplete')
            self.quiesced = True
        except BaseException as error:
            self._helper_evidence()
            self.remember(error, unknown=True)
        return self.quiesced

    def _quiesce_native(self, mono):
        try:
            self.quiesce_raw = C.quiesce_run(self.run, monotonic_until=mono)
        except BaseException as error:
            self._helper_evidence()
            self.remember(error)
            _raise_first(self, error)
        self.quiesce_returned = True
        self._helper_evidence()
        return self.quiesce_raw

    async def finish(self, cleanup_loop_until):
        """Final Root retirement, after exact workspace/output/job disposition."""
        if self.retired:
            return self.released
        try:
            if not self.quiesce_attempted:
                await self.quiesce(cleanup_loop_until)
            self.retired, self.ready = True, False
            _need(self.quiesced, self, 'original_quiescence_unknown')
            # This validator consumes only its own actual WorkspaceJob/Phase
            # records and the fixed context slots. No posted boolean/callback.
            from . import sandbox_workspace as W
            W.require_context_terminal(self)
            mono = self._mono(cleanup_loop_until)
            if self.run is not None:
                if not self.cleanup_attempted:
                    self.cleanup_attempted = self.cleanup_task_unknown = True
                    self.cleanup_coro = _to_thread(self._cleanup_native, mono)
                    self.cleanup_task = asyncio.create_task(self.cleanup_coro)
                    self.cleanup_task_unknown = False
                _need(self.cleanup_task is not None and not self.cleanup_task_unknown,
                      self, 'resource_cleanup_task_unknown')
                await _join(self, self.cleanup_task, cleanup_loop_until)
                self._helper_evidence()
                _need(self.cleanup_returned and self.run.cleanup_complete,
                      self, 'resource_leaf_cleanup_unknown')
                if self.run.capacity_attempted is False:
                    _need(_known_zero_run_cleanup(self, self.run),
                          self, 'original_zero_effect_custody_unknown')
                # This is the sole capacity release. Helper leaf cleanup never
                # releases a workspace/P/root-FD/job reservation by itself.
                self.capacity_release_attempted = True
                try:
                    self.capacity_release_raw = C.release_run_capacity(self.run, monotonic_until=mono)
                    self.capacity_release_returned = True
                except BaseException as error:
                    self._helper_evidence()
                    self.remember(error, unknown=True)
                    _raise_first(self, error)
                _need(self.capacity_release_raw is True and self.run.capacity_released
                      and self.run.capacity_release_complete,
                      self, 'resource_capacity_release_unknown')
            _need(not self.observation_incomplete, self, 'resource_observation_incomplete')
            for index, value in enumerate(self.owner._runner_contexts):
                if value is self:
                    del self.owner._runner_contexts[index]
                    self.released = True
                    break
            _need(self.released, self, 'resource_custody_missing_at_terminal')
        except BaseException as error:
            self.retired, self.ready = True, False
            self._helper_evidence()
            self.remember(error, unknown=True)
        return self.released

    def _cleanup_native(self, mono):
        try:
            self.cleanup_raw = C.cleanup_run(self.run, monotonic_until=mono)
        except BaseException as error:
            self._helper_evidence()
            self.remember(error)
            _raise_first(self, error)
        self._helper_evidence()
        self.cleanup_returned = True
        return self.cleanup_raw


class ResourcePhase(_Evidence):
    def __init__(self, context, work_loop_until):
        super().__init__()
        self.context, self.work_loop_until, self.child_until = context, work_loop_until, None
        self.placement_index = self.lease = self.status = self.release = None
        self.waits = []
        self.control_slots = [None, None, None, None, None]
        self.pipe_intents = [None, None]
        self.ready = self.confirmed = self.released = False
        self.spawn_attempted = False
        self.proc = None
        self.status_raw = self.release_raw = None
        self.status_data = b''
        self.status_eof = self.release_attempted = False
        self.kill_attempted = self.kill_known = False
        self.kill_error = self.kill_return = None
        self.stop_attempted = self.stop_task_unknown = self.stop_returned = False
        self.stop_request_attempted = self.stop_request_known = False
        self.stop_request_raw = self.stop_request_error = self.stop_mono_until = None
        self.stop_progress = None
        self.stop_coro = self.stop_task = self.stop_raw = None
        self.stop_native_primary_before = None
        self.finished = self.complete = self.controls_closed = self.process_reaped = False

    def _pipe(self, intent):
        intent.read.open_attempted = intent.write.open_attempted = intent.attempted = True
        intent.raw = _os.pipe2(_os.O_NONBLOCK | _os.O_CLOEXEC)  # retain pair before packaging
        intent.returned = True
        _need(type(intent.raw) is tuple and len(intent.raw) == 2
              and all(type(fd) is int and fd >= 0 for fd in intent.raw)
              and intent.raw[0] != intent.raw[1], self, 'original_pipe_pair_unknown')
        intent.read.value = intent.raw[0]
        intent.write.value = intent.raw[1]

    @property
    def transport(self):
        if self.primary is not None:
            _raise_first(self, self.primary)
        self.context._current()
        _need(self.ready and not self.context.aborted and not self.finished,
              self, 'original_phase_not_ready')
        _need(_now() < self.child_until and self.context.loop.time() < self.context.loop_until,
              self, 'original_phase_deadline_expired')
        return (self.lease.fd, self.status.write.fd, self.release.read.fd, self.child_until)

    def spawn_kwargs(self):
        transport = self.transport
        return {'pass_fds': transport[:3]}

    def note_spawn_attempt(self):
        self.context._current()
        _need(not self.spawn_attempted and self.ready and not self.finished,
              self, 'original_spawn_already_reserved')
        _need(not self.context.aborted and not self.context.retired
              and _now() < self.child_until, self, 'original_phase_not_live')
        self.spawn_attempted = True

    def _bind(self, proc):
        if self.proc is None:
            self.proc = proc  # retain original return before type/property checks
        _need(proc is self.proc and type(proc) is _Process and self.spawn_attempted,
              self, 'original_process_required')

    def _close(self, slot):
        if slot is None:
            return True
        _need(all(w.removed or not w.attempted for w in self.waits if w.descriptor is slot),
              self, 'callback_removal_unknown')
        try:
            known = C.close_owned(slot)
        except BaseException as error:
            self.context._helper_evidence(self)
            self.remember(error)
            self.context.remember(error)
            _raise_first(self, error)
        self.context._helper_evidence(self)  # raw close E1 before False becomes wrapper E2
        return known

    def _close_controls(self):
        known = True
        # A raw native pair is retained before any validation/packaging. Recover
        # only its own pre-reserved endpoint slots after a metadata failure.
        for intent in self.pipe_intents:
            if intent is not None and intent.returned:
                try:
                    raw = intent.raw
                    _need(type(raw) is tuple and len(raw) == 2
                          and type(raw[0]) is int and type(raw[1]) is int
                          and raw[0] >= 0 and raw[1] >= 0 and raw[0] != raw[1],
                          self, 'retained_original_pipe_pair_unknown')
                    if intent.read.value is None:
                        intent.read.value = raw[0]
                    if intent.write.value is None:
                        intent.write.value = raw[1]
                    _need(intent.read.value == raw[0] and intent.write.value == raw[1],
                          self, 'original_pipe_slot_changed')
                except BaseException as error:
                    known = False
                    self.remember(error, unknown=True)
                    self.context.remember(error, unknown=True)
        for slot in self.control_slots:
            try:
                if not self._close(slot):
                    known = False
            except BaseException as error:
                known = False
                self.remember(error, unknown=True)
                self.context.remember(error, unknown=True)
        self.controls_closed = known
        if not known:
            self.observation_incomplete = self.context.observation_incomplete = True
        return known

    async def _wait(self, slot, write, until):
        loop = self.context.loop
        intent = _WaitIntent(slot, write)
        self.waits.append(intent)  # reserve before actual event-loop registration
        primary = None
        try:
            left = min(until, self.context.loop_until) - loop.time()
            _need(left > 0, self, 'original_protocol_deadline_expired')
            intent.future = loop.create_future()

            def ready():
                if not intent.future.done():
                    intent.future.set_result(None)

            intent.attempted = True
            add = loop.add_writer if write else loop.add_reader
            intent.register_return = add(slot.fd, ready)
            _need(intent.register_return is None, self, 'readiness_registration_unknown')
            intent.registered = True
            await asyncio.wait_for(asyncio.shield(intent.future), left)
            _need(loop.time() < min(until, self.context.loop_until),
                  self, 'original_protocol_deadline_expired')
        except BaseException as error:
            primary = error
            self.remember(error)
            self.context.remember(error)
            raise
        finally:
            if intent.attempted and not intent.remove_attempted:
                intent.remove_attempted = True
                try:
                    remove = loop.remove_writer if write else loop.remove_reader
                    intent.remove_return = remove(slot.value)
                    _need(type(intent.remove_return) is bool, self, 'readiness_removal_unknown')
                    intent.removed = True
                except BaseException as error:
                    intent.error = error
                    self.remember(error, unknown=True)
                    self.context.remember(error, unknown=True)
            if intent.future is not None and not intent.future.done():
                try:
                    intent.future.cancel()
                except BaseException as error:
                    self.remember(error, unknown=True)
                    self.context.remember(error, unknown=True)
            if primary is None and intent.attempted and not intent.removed:
                raise intent.error

    async def confirm_and_release(self, proc, work_loop_until):
        try:
            self._bind(proc)
            self.context._current()
            _need(self.ready and not self.context.aborted and not self.confirmed,
                  self, 'phase_confirmation_not_eligible')
            _need(_finite(work_loop_until) and work_loop_until <= self.work_loop_until,
                  self, 'original_work_deadline_may_only_narrow')
            until = min(work_loop_until, self.work_loop_until, self.context.loop_until)
            for slot in (self.lease, self.status.write, self.release.read):
                _need(self._close(slot), self, 'parent_child_copy_close_unknown')
            while not self.status_eof:
                await self._wait(self.status.read, False, until)
                try:
                    self.status_raw = _os.read(self.status.read.fd, 2 - len(self.status_data))
                except BlockingIOError:
                    continue
                _need(self.context.loop.time() < until, self, 'original_work_deadline_expired')
                _need(type(self.status_raw) is bytes, self, 'original_status_read_unknown')
                if not self.status_raw:
                    self.status_eof = True
                else:
                    self.status_data += self.status_raw
                    _need(self.status_data == b'P', self, 'placement_status_invalid')
            _need(self.status_data == b'P' and self._close(self.status.read),
                  self, 'placement_status_or_close_unknown')
            _need(proc is self.proc and proc.returncode is None,
                  self, 'original_process_not_live_before_confirmation')
            confirmed = C.confirm_placement(self.context.run, self.lease, proc.pid,
                                             monotonic_until=self.child_until)
            self.context._helper_evidence(self)
            if self.primary is not None:
                _raise_first(self, self.primary)
            _need(confirmed is True,
                  self, 'original_placement_confirmation_unknown')
            self.confirmed = True
            _need(proc.returncode is None, self, 'original_process_not_live_before_release')
            await self._wait(self.release.write, True, until)
            self.release_attempted = True
            self.release_raw = _os.write(self.release.write.fd, b'R')
            _need(type(self.release_raw) is int and self.release_raw == 1,
                  self, 'release_write_unknown')
            _need(self.context.loop.time() < until, self, 'original_work_deadline_expired')
            _need(self._close(self.release.write), self, 'release_close_unknown')
            self.released = True
        except BaseException as error:
            self.context._helper_evidence(self)
            self.remember(error)
            self.context.remember(error)
            self.context.aborted = True
            _raise_first(self, error)

    def stop_before_reap(self, proc, cleanup_loop_until):
        if self.stop_attempted:
            return
        self.stop_attempted = True
        original_process = False
        try:
            if proc is not None:
                self._bind(proc)
                original_process = True
            elif self.spawn_attempted:
                self.observation_incomplete = self.context.observation_incomplete = True
        except BaseException as error:
            self.remember(error, unknown=True)
            self.context.remember(error, unknown=True)
        try:
            try:
                mono = self.context._mono(cleanup_loop_until)
            except BaseException as error:
                self.remember(error)
                self.context.remember(error)
                self.context.aborted = True
                mono = _NO_OBSERVATION_UNTIL
            self.stop_mono_until = mono
            # The genuine helper-owned single kill request precedes protocol
            # bookkeeping, to_thread/coroutine allocation and Task factories.
            self.stop_request_attempted = True
            try:
                # A reserved phase rejected before it receives a new lease has
                # no new P/stop generation. Reuse the original latest progress
                # exactly as terminal helper cleanup does; never invent one.
                self.stop_progress = (self.lease if self.lease is not None else
                                      (self.context.run.placements[-1]
                                       if self.context.run.placements else None))
                self.stop_request_raw = C.begin_phase_stop(
                    self.context.run, self.stop_progress, monotonic_until=mono)
                self.context._helper_evidence(self)
                self.stop_request_known = self.stop_request_raw is True
                progress = self.context.run if self.stop_progress is None else self.stop_progress
                self.stop_request_error = progress.phase_kill_error
                if self.stop_request_error is not None:
                    self.remember(self.stop_request_error)
                    self.context.remember(self.stop_request_error)
            except BaseException as error:
                self.context._helper_evidence(self)
                self.stop_request_error = error
                self.remember(error, unknown=True)
                self.context.remember(error, unknown=True)
            if not self.confirmed:
                self.context.aborted = True
                # Exact retained live handle only, at most once and before any
                # confirmed placement. Never a numeric PID/PGID fallback.
                if original_process and proc.returncode is None and not self.kill_attempted:
                    self.kill_attempted = True
                    try:
                        self.kill_return = proc.kill()
                        _need(self.kill_return is None, self, 'original_process_kill_unknown')
                        self.kill_known = True
                    except BaseException as error:
                        self.kill_error = error
                        self.remember(error, unknown=True)
                        self.context.remember(error, unknown=True)
            # Close outcomes cannot skip an owned-leaf stop. Confirmed quiesce
            # does not retire FDs. Unconfirmed cleanup may close its ledger, so
            # it must not run if any callback's original removal is UNKNOWN.
            self._close_controls()
            _need(self.confirmed or all(w.removed or not w.attempted for w in self.waits),
                  self, 'callback_removal_unknown_before_leaf_cleanup')
            self.stop_native_primary_before = self.context.run.primary_error
            self.stop_task_unknown = True
            self.stop_coro = _to_thread(self._stop_native, mono)
            self.stop_task = asyncio.create_task(self.stop_coro)
            self.stop_task_unknown = False
        except BaseException as error:
            self.context._helper_evidence(self)
            self.remember(error, unknown=True)
            self.context.remember(error, unknown=True)

    def _stop_native(self, mono):
        try:
            if self.confirmed:
                self.stop_raw = C.quiesce_phase(self.context.run, self.lease, monotonic_until=mono)
            else:
                self.stop_raw = C.quiesce_run(self.context.run, monotonic_until=mono)
        except BaseException as error:
            self.context._helper_evidence(self)
            self.remember(error)
            self.context.remember(error)
            _raise_first(self, error)
        self.context._helper_evidence(self)
        self.stop_returned = True
        return self.stop_raw

    async def finish_phase(self, proc, cleanup, cleanup_loop_until):
        if self.finished:
            return self.complete
        try:
            if not self.stop_attempted:
                self.stop_before_reap(proc, cleanup_loop_until)
            _need(self.stop_task is not None and not self.stop_task_unknown,
                  self, 'original_stop_task_unknown')
            await _join(self, self.stop_task, cleanup_loop_until)
            self.context._helper_evidence(self)
            self._close_controls()
            if self.spawn_attempted:
                _need(proc is self.proc and type(proc) is _Process,
                      self, 'original_spawn_handle_unknown')
                self.process_reaped = (type(proc.returncode) is int
                                       and cleanup.get('original_process_reaped') is True)
            else:
                self.process_reaped = proc is None and self.proc is None
            _need(self.process_reaped and self.controls_closed and self.stop_returned,
                  self, 'original_phase_terminal_unknown')
            _need(not self.stop_task.cancelled() and not self.observation_incomplete,
                  self, 'original_stop_progress_unknown')
            if self.confirmed:
                _need(self.lease.quiesce_complete and self.lease.known_closed,
                      self, 'original_leaf_quiescence_unknown')
                self.complete = True
            else:
                _need(self.stop_raw is True and self.context.run.run_quiesce_complete,
                      self, 'aborted_leaf_quiescence_unknown')
                self.complete = False  # aborted context can never authorize next phase
        except BaseException as error:
            self.context._helper_evidence(self)
            self.remember(error, unknown=True)
            self.context.remember(error, unknown=True)
            self.context.aborted = True
        finally:
            self.finished = True
        return self.complete


async def _join(owner, task, supplied_loop_until):
    """A missing/cancelled/unfinished Future is not a native stop receipt."""
    context = owner if type(owner) is ResourceContext else owner.context
    _need(_finite(supplied_loop_until), owner, 'original_cleanup_deadline_required')
    until = min(supplied_loop_until, context.loop_until)
    _need(context.loop.time() < until, owner, 'original_cleanup_deadline_expired')
    while not task.done():
        left = until - context.loop.time()
        _need(left > 0, owner, 'original_cleanup_deadline_expired')
        try:
            await asyncio.wait_for(asyncio.shield(task), left)
        except asyncio.CancelledError as error:
            owner.remember(error)  # retain; do not cancel or replace original worker
            context.remember(error)
    _need(context.loop.time() < until, owner, 'original_cleanup_deadline_expired')
    _need(not task.cancelled(), owner, 'original_worker_cancelled_unknown')
    raw = task.result()
    _need(context.loop.time() < until, owner, 'original_cleanup_deadline_expired')
    return raw


def prepare_context(owner, run_id, *, monotonic_until, loop_until, sender_monotonic_until):
    """Root's admitted scope only; retain every returned failed context too."""
    context = ResourceContext(owner, run_id, monotonic_until, loop_until, sender_monotonic_until)
    try:
        _need(type(owner) is _CodeAggregate and type(owner.limits) is tuple and owner._valid_limits(),
              context, 'actual_operator_resource_owner_required')
        context.limits, context.bootstrap = owner.limits, owner.attempt
        context.capacity_policy = owner.capacity_policy
        context.workspace_policy = owner.workspace_policy
        _need(type(context.bootstrap) is C.BootstrapAttempt
              and context.bootstrap.capacity_policy is context.capacity_policy,
              context, 'original_capacity_policy_required')
        _need(context.bootstrap.workspace_policy is context.workspace_policy,
              context, 'original_workspace_policy_required')
        _need(type(owner._runner_contexts) is list, context, 'preallocated_resource_custody_required')
        _other_contexts_healthy(owner, context)
        _need(_finite(monotonic_until) and _finite(loop_until) and callable(sender_monotonic_until),
              context, 'original_total_clock_inputs_required')
        context.loop = _get_loop()
        context.monotonic_until = min(monotonic_until, context._mono(loop_until))
        owner._runner_contexts.append(context)  # reserve BEFORE original prepare effects
        context.reserved = True
        context._current()
        context.prepare_attempted = True
        context.run = C.prepare_run(context.bootstrap, run_id,
                                    monotonic_until=context.monotonic_until,
                                    memory_bytes=context.limits[1], pids=context.limits[2])
        _need(type(context.run) is C.RunAttempt and context.run.bootstrap is context.bootstrap,
              context, 'original_resource_run_return_required')
        context._helper_evidence()
        context.ready = (context.run.ready and context.run.limits_applied
                         and context.run.primary_error is None)
        if not context.ready:
            context.aborted = True
    except BaseException as error:
        context.remember(error)
        context.aborted = True
    return context
