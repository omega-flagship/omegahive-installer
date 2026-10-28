"""CI-only wrapper: run the pinned bootstrap helper with its exact arguments and print the traceback it hides.
Prints only the exception chain and source lines, never request bodies, codes or tokens."""
import runpy
import sys
import traceback

helper = sys.argv[1]
sys.argv = [helper] + sys.argv[2:]
try:
    module = runpy.run_path(helper, run_name="ci_traced_helper")
    module["main"]()
except SystemExit:
    raise
except BaseException:
    print("CI helper traceback:", file=sys.stderr)
    traceback.print_exc(limit=15)
    raise SystemExit(1)
