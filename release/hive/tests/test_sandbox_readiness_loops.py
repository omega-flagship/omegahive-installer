"""Purpose: a Linux sandbox resource wait ends cleanly whichever event loop runs the hive. asyncio's own loops answer
loop.remove_reader with a bool; uvloop, which uvicorn runs the hive on wherever it is installed, answers None for the
same removal, and the wait must not read that as an unknown removal."""
import asyncio
import os
import unittest

from hive.core import sandbox_resources as sr


class _Slot:
    """One open descriptor, named the two ways ResourcePhase._wait reads it."""

    def __init__(self, fd):
        self.fd = self.value = fd


class _NoneLoop(asyncio.SelectorEventLoop):
    """asyncio's loop, answering a removal the way uvloop 0.23.0 does: it removes, and returns None."""

    def remove_reader(self, fd):
        super().remove_reader(fd)
        return None


class ReadinessRemovalTests(unittest.TestCase):
    def wait_once(self, make_loop):
        """One readiness wait on a pipe that is readable at once; returns the wait's intent after it ends."""
        loop = make_loop()
        read, write = os.pipe()
        try:
            os.write(write, b"x")
            context = sr._Evidence()
            context.loop, context.loop_until = loop, loop.time() + 30
            phase = sr.ResourcePhase(context, loop.time() + 30)
            loop.run_until_complete(phase._wait(_Slot(read), False, loop.time() + 10))
            return phase.waits[-1]
        finally:
            os.close(read)
            os.close(write)
            loop.close()

    def test_asyncio_loop_answers_true(self):
        intent = self.wait_once(asyncio.SelectorEventLoop)
        self.assertTrue(intent.removed)
        self.assertIs(intent.remove_return, True)

    def test_a_loop_answering_none_still_ends_the_wait(self):
        intent = self.wait_once(_NoneLoop)
        self.assertTrue(intent.removed)
        self.assertIsNone(intent.remove_return)

    def test_none_is_no_removal_when_the_wait_registered_nothing(self):
        # uvloop answers None to a removal whether or not the reader was registered, so where the registration
        # itself failed, None proves nothing: the registration's error stands and the removal stays unknown.
        class _RefusingNoneLoop(_NoneLoop):
            def add_reader(self, fd, callback, *args):
                raise OSError("registration refused")
        loop = _RefusingNoneLoop()
        read, write = os.pipe()
        try:
            context = sr._Evidence()
            context.loop, context.loop_until = loop, loop.time() + 30
            phase = sr.ResourcePhase(context, loop.time() + 30)
            with self.assertRaisesRegex(OSError, "registration refused"):
                loop.run_until_complete(phase._wait(_Slot(read), False, loop.time() + 10))
            intent = phase.waits[-1]
            self.assertFalse(intent.registered)
            self.assertFalse(intent.removed)
            self.assertEqual(getattr(intent.error, "code", None), "readiness_removal_unknown")
            self.assertTrue(phase.observation_incomplete)
        finally:
            os.close(read)
            os.close(write)
            loop.close()

    def test_uvloop_ends_the_wait(self):
        try:
            import uvloop
        except ImportError:
            self.skipTest("uvloop isn't installed here")
        intent = self.wait_once(uvloop.new_event_loop)
        self.assertTrue(intent.removed)


if __name__ == "__main__":
    unittest.main()
