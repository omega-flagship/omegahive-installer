"""A per-test time limit for hive CI's pytest runs that a failing test does not lift (loaded with -p hive_test_timeout).

pytest's own faulthandler_timeout stops guarding a test as soon as the test's setup or call fails:
_pytest/faulthandler.py's pytest_exception_interact hook runs faulthandler.cancel_dump_traceback_later(). So a test that
fails and then hangs in its teardown ran without a limit, and run 44793192701's hive-petta shard 2 sat silent from
18:48 to the step's 45-minute limit with nothing in its log. This plugin guards each test's whole protocol (setup, call
and teardown) whatever the outcome. When a test runs past the limit, it:
  1. names the test and its phase on stderr,
  2. dumps every thread's stack (faulthandler.dump_traceback),
  3. kills the pytest process's descendants (found by their /proc parent links, so a child started in its own session
     is found too), so that none of them keeps the step's output open after pytest ends,
  4. ends pytest with exit status 1 (os._exit: no summary and no junit file, which hive-full reports for the shard).
A watchdog thread does this, and a Python thread needs the GIL. For a test stuck in C code that holds the GIL,
faulthandler.dump_traceback_later is armed at twice the limit as the backstop: it dumps and exits without the GIL, but
it names no test and kills no child. This plugin re-arms that backstop after pytest's faulthandler hook cancels it.

HIVE_TEST_TIMEOUT_S, the limit in seconds, is required: the step that loads the plugin states it. Use the plugin
instead of faulthandler_timeout, not beside it. Both drive faulthandler's one timer, so the plugin refuses to start
when faulthandler_timeout is set.
"""

import faulthandler
import os
import signal
import sys
import threading
import time

import pytest

ENV = "HIVE_TEST_TIMEOUT_S"


def descendants(root, proc="/proc"):
    """Every live process whose chain of parents reaches root, read from /proc/<pid>/stat. Empty without /proc."""
    try:
        entries = os.listdir(proc)
    except OSError:
        return []
    children = {}
    for entry in entries:
        if not entry.isdigit():
            continue
        try:
            with open(os.path.join(proc, entry, "stat"), "rb") as fh:
                stat = fh.read()
        except OSError:
            continue  # it ended while we read
        # The command name sits in parentheses and may hold spaces or ")": the fields after the last ")" are
        # state, ppid, ...
        fields = stat[stat.rfind(b")") + 2:].split()
        if len(fields) > 1:
            children.setdefault(int(fields[1]), []).append(int(entry))
    found, todo = [], [root]
    while todo:
        for pid in children.get(todo.pop(), []):
            found.append(pid)
            todo.append(pid)
    return found


class Watchdog:
    def __init__(self, limit, fd):
        self.limit = limit
        self.fd = fd
        self.cond = threading.Condition()
        self.test = None      # (nodeid, deadline) of the test being guarded
        self.phase = "setup"
        self.thread = threading.Thread(target=self._run, name="hive-test-timeout", daemon=True)
        self.thread.start()

    def arm(self, nodeid):
        with self.cond:
            self.test = (nodeid, time.monotonic() + self.limit)
            self.phase = "setup"
            self.cond.notify()
        self.backstop(self.limit * 2)

    def disarm(self):
        with self.cond:
            self.test = None
            self.cond.notify()
        faulthandler.cancel_dump_traceback_later()

    def backstop(self, seconds):
        faulthandler.dump_traceback_later(max(seconds, 1), exit=True, file=self.fd)

    def remaining(self):
        with self.cond:
            return None if self.test is None else self.test[1] - time.monotonic()

    def _run(self):
        with self.cond:
            while True:
                if self.test is None:
                    self.cond.wait()
                    continue
                left = self.test[1] - time.monotonic()
                if left > 0:
                    self.cond.wait(left)
                    continue
                self._fire(self.test[0], self.phase)

    def _write(self, text):
        os.write(self.fd, text.encode("utf-8", "replace"))

    def _fire(self, nodeid, phase):
        self._write(f"\n\nhive_test_timeout: {nodeid} ran past {self.limit:g} s, in its {phase}; "
                    "every thread's stack follows, then its child processes are killed and the run ends\n")
        faulthandler.dump_traceback(file=self.fd, all_threads=True)
        killed = []
        for pid in descendants(os.getpid()):
            try:
                os.kill(pid, signal.SIGKILL)
                killed.append(pid)
            except OSError:
                pass  # it ended meanwhile
        self._write(f"hive_test_timeout: killed {len(killed)} child process(es){': ' if killed else ''}"
                    f"{' '.join(map(str, killed))}\n")
        os._exit(1)


_KEY = pytest.StashKey[Watchdog]()


def pytest_configure(config):
    raw = os.environ.get(ENV)
    if raw is None:
        raise pytest.UsageError(f"-p hive_test_timeout needs {ENV}, the per-test limit in seconds")
    try:
        limit = float(raw)
    except ValueError:
        limit = 0
    if not limit > 0:
        raise pytest.UsageError(f"{ENV} must be a positive number of seconds, got {raw!r}")
    if float(config.getini("faulthandler_timeout") or 0) > 0:
        raise pytest.UsageError("-p hive_test_timeout replaces faulthandler_timeout: drop -o faulthandler_timeout")
    config.stash[_KEY] = Watchdog(limit, os.dup(sys.__stderr__.fileno()))


@pytest.hookimpl(wrapper=True, tryfirst=True)
def pytest_runtest_protocol(item):
    dog = item.config.stash[_KEY]
    dog.arm(item.nodeid)
    try:
        return (yield)
    finally:
        dog.disarm()


def _phase(name):
    @pytest.hookimpl(wrapper=True, tryfirst=True)
    def hook(item):  # pluggy passes a hook only the arguments it names
        dog = item.config.stash[_KEY]
        with dog.cond:
            dog.phase = name
        return (yield)
    return hook


pytest_runtest_setup = _phase("setup")
pytest_runtest_call = _phase("call")
pytest_runtest_teardown = _phase("teardown")


@pytest.hookimpl(trylast=True)
def pytest_exception_interact(node, call, report):
    """pytest's faulthandler hook (tryfirst) has just cancelled faulthandler's timer, our backstop: set it again."""
    dog = node.config.stash.get(_KEY, None)
    left = dog.remaining() if dog is not None else None
    if left is not None:
        dog.backstop(left + dog.limit)
