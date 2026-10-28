#!/usr/bin/env python3
"""Repeatable latency check for the agent's command syntax membrane."""

import pathlib
import sys
import timeit


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import helper_command_parser as parser  # noqa: E402


CASES = [
    "send dinner is ready: plates are out",
    'remember user said "test carefully" before changing syntax',
    "pin FOCUSED | tracker rebuild: privacy repair",
    "shell find memory/web -maxdepth 2 -type f",
    'space-transform persistent (PersistentNote "agent" $note $conf) events (Event "agent" "merged" "ok" "0.9") cleanup duplicate notes',
    (
        "pin FOCUSED | tracker rebuild: privacy repair\n"
        "send Done: tracker rebuilt\n"
        "remember privacy lesson: General only contains non-private items"
    ),
    'write-file /tmp/test.txt """\nDinner is ready:\n- plates out\n- glucose checked\n"""',
    'space-transform persistent (PersistentNote "agent" $note events (Event "agent" "bad" "0.9") cleanup',
    'write-file /tmp/test.txt "<html><body>Hi: ok</body></html>"',
]


def main():
    loops = 5000

    def old_all():
        for case in CASES:
            parser.balance_parentheses(case)

    def signature_all():
        for case in CASES:
            parser.signature_balance_parentheses(case)

    def reload_signatures_only():
        parser._load_signature_commands(fallback=parser.SIGNATURE_COMMANDS)

    current = timeit.timeit(old_all, number=loops)
    signature = timeit.timeit(signature_all, number=loops)
    reloads = timeit.timeit(reload_signatures_only, number=loops)
    count = loops * len(CASES)

    print("BENCHMARK parser corpus")
    print(f"cases={len(CASES)} loops={loops} total_parses={count}")
    print(f"current_total_s={current:.6f} current_us_per_parse={current / count * 1_000_000:.2f}")
    print(f"signature_total_s={signature:.6f} signature_us_per_parse={signature / count * 1_000_000:.2f}")
    print(f"signature_vs_current_ratio={signature / current:.3f}")
    print(f"reload_declarations_total_s={reloads:.6f} reload_us_per_load={reloads / loops * 1_000_000:.2f}")
    print(f"loaded_signature_count={len(parser.SIGNATURE_COMMANDS)}")
    print(f"signature_file={parser.SIGNATURE_DECLARATIONS_PATH}")


if __name__ == "__main__":
    main()
