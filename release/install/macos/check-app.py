"""Purpose: check the small app's required files and JavaScript syntax before accepting a change."""
from pathlib import Path
import os
import sys


def main():
    root = Path(__file__).resolve().parent
    for name in ('index.html', 'app.js', 'style.css'):
        if not (root / name).read_text(encoding='utf-8').strip():
            raise RuntimeError(name + ' must not be empty')
    node = Path(sys.executable).resolve().with_name('node')
    # Replace this process so the strict sandbox can deny fork. Stdin avoids parent package discovery.
    with (root / 'app.js').open('rb') as source:
        os.dup2(source.fileno(), 0)
    print('Small app files passed; checking JavaScript syntax', flush=True)
    os.execv(str(node), [str(node), '--input-type=module', '--check'])


if __name__ == '__main__':
    main()
