"""CI-only: re-run the installed bootstrap helper and show its traceback (it prints only a generic line).
Never prints sign-in codes or tokens: only the exception chain and source lines."""
import runpy
import sys
import traceback
from pathlib import Path

home = Path.home()
runtime = home / ".local/share/omegahive/runtime.json"
sys.argv = ["bootstrap", "--runtime", str(runtime), "--seed", str(home / "bundle/studio-maker-template.json")]
module = runpy.run_path(str(home / "bundle/bootstrap.py"), run_name="ci_diag")
try:
    module["main"]()
    print("bootstrap diagnostic: completed")
except BaseException:
    traceback.print_exc(limit=12)
