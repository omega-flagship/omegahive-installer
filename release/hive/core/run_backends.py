"""Purpose: the one seam through which the hive runs an app's pinned tool bundle (flagship omegahive#85, step 1).

The hive decides *what* runs: which app, which pinned bundle and entry, its inputs and outputs, its limits, and every
policy, approval and budget around it. A run backend decides *how*: it starts the processes, signals and cancels them,
collects the exit code, output and files, and removes its own working folders. No hive code outside a backend starts,
signals or cleans up a run's processes or folders.

Step 1 has one backend, LocalSandboxBackend: the in-OS sandbox (hive/core/sandbox_run.py: Landlock and namespaces on
Linux, sandbox-exec on macOS), which the interface leaves as it is, process custody included. On Linux a stopped run's
group gets SIGTERM, then SIGKILL only while its leader is unreaped (sandbox_run._term_grace). A later backend
(a container, a VM, NuNet DMS) implements the same methods and is selected with HIVE_RUN_BACKEND, without changing any
caller.

The contract, for every backend:
  available() -> bool              whether runs can start on this hive now (may run a short probe: call off the loop)
  allowed_apps() -> set[str]       app ids this hive lets run tool bundles
  runtimes() -> dict               runtime name -> configured interpreter for that runtime
  await run(program, entry, args=(), inputs=None, outputs=(), runtime=..., bundle=..., **limits) -> dict
                                   run one pinned bundle entry to completion; the result carries exit, stdout, stderr,
                                   their truncation flags, the declared output files and missing_outputs. Cancelling
                                   the awaiting task cancels the run; the backend stops and cleans up everything it
                                   started before the cancellation finishes.
  await run_hive_tool(name, files, entry, args=(), inputs=None, outputs=(), **limits) -> dict
                                   run one of the hive's own fixed tools (its files given here, not an app's pinned
                                   bundle; no app allowlist) on the hive's own Python, under the same boundary, limits
                                   and custody as run(), with the same result; the PDF reader is one (webtools)
  aggregate_limits(...), aggregate_continuation_limits(...)
                                   resource custody for a Code aggregate's runs (the backend owns process custody)
  MAX_STDERR, OutputLimit          the stderr cap a result respects, and the error raised when outputs exceed limits
"""
from __future__ import annotations

import os

__all__ = ["RunBackend", "LocalSandboxBackend", "get", "use"]


class RunBackend:
    """The interface. A backend subclasses this and implements every method."""

    name = "abstract"
    MAX_STDERR = 0
    OutputLimit = RuntimeError

    def available(self) -> bool:
        raise NotImplementedError

    def allowed_apps(self) -> set:
        raise NotImplementedError

    def runtimes(self) -> dict:
        raise NotImplementedError

    async def run(self, program, entry, args=(), inputs=None, outputs=(), runtime="node", bundle="tools", **limits):
        raise NotImplementedError

    async def run_hive_tool(self, name, files, entry, args=(), inputs=None, outputs=(), **limits):
        raise NotImplementedError

    def aggregate_limits(self, owner, kind, aggregate_cpu_seconds, aggregate_memory_bytes, aggregate_processes):
        raise NotImplementedError

    def aggregate_continuation_limits(self, owner, kind, original_limits, original_bootstrap, **kwargs):
        raise NotImplementedError


class LocalSandboxBackend(RunBackend):
    """Today's in-OS sandbox, behind the interface: every call goes to hive/core/sandbox_run.py unchanged."""

    name = "local-sandbox"

    @staticmethod
    def _impl():
        from . import sandbox_run
        return sandbox_run

    @property
    def MAX_STDERR(self):  # noqa: N802  (the constant callers compare against)
        return self._impl().MAX_STDERR

    @property
    def OutputLimit(self):  # noqa: N802
        return self._impl().SandboxOutputLimit

    def available(self):
        return self._impl().available()

    def allowed_apps(self):
        return self._impl()._allowed_apps()

    def runtimes(self):
        return self._impl()._runtimes()

    async def run(self, program, entry, args=(), inputs=None, outputs=(), runtime="node", bundle="tools", **limits):
        return await self._impl().run(program, entry, args, inputs, outputs, runtime, bundle, **limits)

    async def run_hive_tool(self, name, files, entry, args=(), inputs=None, outputs=(), **limits):
        return await self._impl().run_hive_tool(name, files, entry, args, inputs, outputs, **limits)

    def aggregate_limits(self, owner, kind, aggregate_cpu_seconds, aggregate_memory_bytes, aggregate_processes):
        return self._impl()._aggregate_limits(owner, kind, aggregate_cpu_seconds, aggregate_memory_bytes,
                                              aggregate_processes)

    def aggregate_continuation_limits(self, owner, kind, original_limits, original_bootstrap, **kwargs):
        return self._impl()._aggregate_continuation_limits(owner, kind, original_limits, original_bootstrap, **kwargs)


_BACKENDS = {LocalSandboxBackend.name: LocalSandboxBackend}
_selected = None


def get() -> RunBackend:
    """The hive's run backend: HIVE_RUN_BACKEND names it (default local-sandbox). An unknown name fails closed."""
    global _selected
    if _selected is None:
        name = os.environ.get("HIVE_RUN_BACKEND", "").strip() or LocalSandboxBackend.name
        if name not in _BACKENDS:
            raise RuntimeError(f"unknown HIVE_RUN_BACKEND {name!r}; known: {sorted(_BACKENDS)}")
        _selected = _BACKENDS[name]()
    return _selected


def use(backend):
    """Replace the hive's run backend (tests, or a host wiring its own); returns the previous one. None resets."""
    global _selected
    previous, _selected = _selected, backend
    return previous

