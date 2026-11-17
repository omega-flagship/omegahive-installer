#!/usr/bin/env python3
"""Purpose: write the minds' own packages for the Linux kit's lock, by the rule the release's Mac and Windows locks follow.

A mind imports openai, chromadb and py-landlock beyond hive/requirements.txt (install/macos/python-lock.py, MINDS).
They are pinned at the versions the release's linux-64 lock installs on Windows (install/macos/locks/python-linux-64.txt),
so every platform's minds load the same packages.
"""
import argparse
import importlib.util
import pathlib
import re


def canonical(name):
    return re.sub(r"[-_.]+", "-", name.lower())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", required=True, type=pathlib.Path)
    parser.add_argument("--out", required=True, type=pathlib.Path)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("python_lock", args.release / "install/macos/python-lock.py")
    rule = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rule)
    pins = {canonical(n): v for n, v in rule.PIN.findall((args.release / "install/macos/locks/python-linux-64.txt").read_text())}
    names = [canonical(m) for m in rule.MINDS]
    missing = [m for m in names if m not in pins]
    assert not missing, f"the release's linux-64 lock pins none of {missing}"
    args.out.write_text("".join(f"{m}=={pins[m]}\n" for m in names))
    print(args.out.read_text(), end="")


if __name__ == "__main__":
    main()
