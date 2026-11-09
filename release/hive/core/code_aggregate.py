"""Private Host startup custody for the existing aggregate runner.

Diagnostic readiness uses the same nonmutating original-state producer as Code
discovery. It is never consumed as work authority; per-run kernel revalidation,
limits, placement and cleanup remain owned by the existing runner integration.
"""
import contextlib
import re
import sys
import time

from ..supervisor import cgroup_v2

_UNIT = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.@:-]{0,190}\.service\Z")
_STATUS_FIELDS = frozenset({
    "phase", "ready", "retired", "primary_error_present", "secondary_error_count",
    "observation_incomplete", "created_directories", "unknown_directory_creations",
    "descriptors_open", "descriptor_close_unknown", "moves_attempted", "moves_known",
    "live_runs", "close_error_count", "descriptor_open_unknown", "service_caps_finite",
    "capacity_ready", "capacity_unknown", "reserved_memory_bytes", "reserved_pids",
})
_STATUS_BOOL_FIELDS = frozenset({"ready", "retired", "primary_error_present",
                                 "observation_incomplete", "service_caps_finite", "capacity_ready", "capacity_unknown"})
_STATUS_PHASES = frozenset({"intent", "host-create", "controllers", "ready", "bootstrap-refused",
                            "retired", "retired-with-live-run-debt"})


class AggregateStartupCleanupError(RuntimeError):
    """Retains original cleanup evidence privately, with a fixed public message."""

    def __init__(self, owner):
        self.owner = owner
        super().__init__("Code resource startup cleanup is unresolved")


class _CodeAggregate:
    def __init__(self, settings):
        self._runner_contexts = []  # original physical custody, reserved before any startup/run effects
        # Only the original Settings object supplies these values. Retain a
        # primitive immutable copy before any resource effect; requests cannot
        # replace the unit/limits, and no enablement boolean exists here.
        self.limits = (
            getattr(settings, "code_cgroup_service_unit", "omegahive.service"),
            getattr(settings, "code_sandbox_memory_bytes", 1073741824),
            getattr(settings, "code_sandbox_pids", 256),
            getattr(settings, "code_sandbox_runtime_seconds", 120),
            getattr(settings, "code_sandbox_swap_bytes", 0),
        )
        self.capacity_policy = tuple(getattr(settings, name, None) for name in (
            "code_sandbox_host_memory_bytes", "code_sandbox_host_memory_min_bytes",
            "code_sandbox_pool_memory_bytes", "code_sandbox_root_memory_reserve_bytes",
            "code_sandbox_kernel_slack_bytes", "code_sandbox_host_pids",
            "code_sandbox_pool_pids", "code_sandbox_root_pids_reserve"))
        self.workspace_policy = None  # fixed original W Source tuple, captured before bootstrap effects
        self.attempt = None
        self.phase = "not-started"
        self.start_attempted = self.retirement_attempted = False
        self.primary_error = self.primary_traceback = None
        self.retirement_error = self.projection_error = None
        self.retirement_call_error = self.retirement_inspection_error = None
        self.retirement_traceback = None
        self.observation_incomplete = False

    def _valid_limits(self):
        unit, memory, pids, seconds, swap = self.limits
        return (type(unit) is str and _UNIT.fullmatch(unit) is not None
                and type(memory) is int and 16*1024*1024 <= memory <= 16*1024**3
                and type(pids) is int and 1 <= pids <= 1024
                and type(seconds) is int and 1 <= seconds <= 120
                and type(swap) is int and swap == 0)

    def start(self):
        if self.start_attempted:
            raise RuntimeError("Code resource startup already attempted")
        self.start_attempted = True
        if not self._valid_limits():
            self.phase = "invalid-operator-config"
            return
        if sys.platform != "linux":
            self.phase = "not-linux"
            return
        if not cgroup_v2.valid_capacity_policy(self.capacity_policy):
            self.phase = "capacity-unconfigured"
            return
        try:
            from . import sandbox_workspace as W
            self.workspace_policy = W.WORKSPACE_POLICY
            if not W.valid_workspace_policy(self.workspace_policy):
                self.phase = "workspace-unconfigured"
                return
        except Exception as error:
            self.primary_error = error
            self.primary_traceback = BaseException.__traceback__.__get__(error)
            self.phase = "workspace-unavailable"
            return
        self.phase = "bootstrap-attempted"
        try:
            # Run synchronously before Supervisor/Hive construction: RepoMaps
            # can start its original remount thread inside Hive.__init__.
            until = time.monotonic() + 5.0
            self.attempt = cgroup_v2.bootstrap(service_unit=self.limits[0], monotonic_until=until,
                                              capacity_policy=self.capacity_policy,
                                              workspace_policy=self.workspace_policy)
            if type(self.attempt) is not cgroup_v2.BootstrapAttempt:
                raise TypeError("original resource bootstrap attempt required")
            self.phase = "bootstrap-returned"
            error = self.attempt.primary_error
            if error is not None and not isinstance(error, Exception):
                # The helper retains all failure outcomes; a process interrupt
                # still interrupts startup instead of being treated as absence.
                raise BaseException.with_traceback(error, self.attempt.primary_traceback)
        except BaseException as error:
            self.primary_error = error  # raw primary BEFORE any projection/close
            self.primary_traceback = BaseException.__traceback__.__get__(error)
            self.phase = "bootstrap-raised"
            raise

    def retire(self, primary=None):
        """One helper retirement; never retry an UNKNOWN close or adopt a PID."""
        if self.retirement_attempted:
            return
        self.retirement_attempted = True  # reserve BEFORE a fallible helper call
        self.phase = "retirement-attempted"
        attempt = self.attempt
        if attempt is None:
            self.phase = "retired-no-attempt"
            if self._runner_contexts:
                self.observation_incomplete = True
                if primary is None:
                    raise AggregateStartupCleanupError(self)
            return
        try:
            # Original runner cleanup must retire all RunAttempts before this
            # call; the helper refuses parent closes with live debt. Discovery
            # never gates retirement or replaces retained raw cleanup evidence.
            cgroup_v2.close_bootstrap(attempt)
        except BaseException as error:
            # Retain before fallible evidence packaging. The helper may have
            # already closed descriptors before its status allocation failed.
            self.retirement_error = error
            self.retirement_call_error = error
            self.retirement_traceback = BaseException.__traceback__.__get__(error)
            self.observation_incomplete = True
            self.phase = "retirement-unresolved"
        try:
            self._inspect_retained_cleanup(attempt)
            self.phase = "retired" if attempt.retired else "retirement-unresolved"
        except BaseException as error:
            if self.retirement_error is None:
                self.retirement_error = error
            else:
                self.retirement_inspection_error = error
            self.observation_incomplete = True
            self.phase = "retirement-unresolved"
        if primary is None:
            # Re-raise the raw first cleanup failure, without formatting or a
            # fallible replacement exception. Its traceback retains this owner.
            # A live-debt observation without a raised error needs a fixed new
            # refusal; it never claims that cleanup completed.
            if self.retirement_error is not None:
                raise BaseException.with_traceback(
                    self.retirement_error, BaseException.__traceback__.__get__(self.retirement_error))
            if self.observation_incomplete:
                raise AggregateStartupCleanupError(self)

    def _inspect_retained_cleanup(self, attempt):
        # The producer latches the actual first close error before either
        # evidence list, even when an earlier bootstrap E0 already exists.
        # Consume that original raw record directly; never reconstruct it from
        # last error/list order, a returned baseline, or optional status.
        first = attempt.first_close_error
        if first is not None:
            self.retirement_error = first
            self.observation_incomplete = True
        if self._runner_contexts:
            self.observation_incomplete = True  # never invoke, adopt or retry a retained context
        if (attempt.observation_incomplete is not False
                or attempt.retired is not True
                or type(attempt.live_runs) is not int or attempt.live_runs != 0
                or attempt.capacity_unknown or attempt.capacity_runs
                or attempt.reserved_memory or attempt.reserved_pids):
            self.observation_incomplete = True
        for descriptor in attempt.descriptors:
            # Only original retained states can establish a known close. No
            # close call, FD adoption or retry follows from this inspection.
            flags = (descriptor.open_attempted, descriptor.close_attempted, descriptor.known_closed)
            if any(type(flag) is not bool for flag in flags):
                self.observation_incomplete = True
                continue
            if descriptor.open_attempted:
                if (descriptor.value is None or type(descriptor.value) is not int
                        or not descriptor.close_attempted or not descriptor.known_closed):
                    self.observation_incomplete = True
            elif descriptor.value is not None or descriptor.close_attempted or descriptor.known_closed:
                self.observation_incomplete = True
        for intent in attempt.directories:
            if intent["outcome"] == "UNKNOWN":
                self.observation_incomplete = True

    def status(self):
        out = {"phase": self.phase, "linux_execution_enabled": False,
               "startup_attempted": self.start_attempted,
               "retirement_attempted": self.retirement_attempted,
               "startup_error_present": self.primary_error is not None,
               "retirement_error_present": self.retirement_error is not None,
               "projection_error_present": self.projection_error is not None,
               "observation_incomplete": self.observation_incomplete}
        if self.attempt is not None:
            try:
                value = cgroup_v2.status(self.attempt)
                if (type(value) is not dict or any(type(key) is not str for key in value)
                        or set(value) != _STATUS_FIELDS
                        or type(value["phase"]) is not str or value["phase"] not in _STATUS_PHASES
                        or any(type(value[key]) is not bool for key in _STATUS_BOOL_FIELDS)
                        or any(type(value[key]) is not int or not 0 <= value[key] <= 2**63-1
                               for key in _STATUS_FIELDS - _STATUS_BOOL_FIELDS - {"phase"})):
                    raise ValueError("bounded resource status required")
                out["bootstrap"] = value
            except BaseException as error:
                if self.projection_error is None:
                    self.projection_error = error
                self.observation_incomplete = True
                out["projection_error_present"] = out["observation_incomplete"] = True
        # Compute after projection: a projection failure can taint original
        # state. This diagnostic is never an input to discovery or admission.
        if sys.platform == "linux":
            try:
                from . import sandbox_run
                sandbox_run._aggregate_limits(self, "landlock", None, None, None)
            except Exception:
                pass
            else:
                out["linux_execution_enabled"] = True
        return out

    def lifespan(self, original):
        @contextlib.asynccontextmanager
        async def owned(app):
            primary = None
            try:
                async with original(app):
                    yield
            except BaseException as error:
                primary = error
                raise
            finally:
                # Independent of the original lifespan's successful INIT/yield.
                self.retire(primary)
        return owned


def close_app_resources(app, primary=None):
    """Entry-point fallback when recovery/uvicorn never enters lifespan."""
    # create_app() that raises never binds __main__.app. This also tolerates
    # an independently supplied/partially initialized ASGI app with no Hive;
    # it neither adopts an owner nor claims that a partial owner's debt cleared.
    hive = getattr(getattr(app, "state", None), "hive", None)
    if hive is not None:
        hive._code_aggregate.retire(primary)
