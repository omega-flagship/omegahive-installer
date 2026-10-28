#!/bin/sh
# Fixed launcher run inside the sandbox: set CPU-seconds and file-size limits, then exec.
# Arguments: <cpu seconds> <file size in bytes> <program> [args...]. Pinned host arguments only; never evaluates caller
# strings. (Adapted from OmegaDesign's studio_limits.sh.)
# Linux: util-linux prlimit sets both limits in exact bytes and is required (Ubuntu's dash counts `ulimit -f` in
# 512-byte blocks, so ulimit would halve the limit). macOS: the original ulimit path, 1024-byte units, rounded up.
# Any failure to set a limit exits 78 and the program never starts.
cpu="$1"; bytes="$2"; shift 2
case "$cpu$bytes" in *[!0-9]*|"") exit 78 ;; esac
case "$(uname -s)" in
  Linux)
    command -v prlimit >/dev/null 2>&1 || exit 78
    # r14.4: ONE setup operation, applied to this launcher process itself; the program inherits the limits through
    # exec. There is no second prlimit run that could fail after a successful check (Kimi/stand-in r14.3): if the
    # limits cannot be set, that is a setup failure (78) and the program never starts.
    prlimit --pid="$$" --cpu="$cpu" --fsize="$bytes" || exit 78
    exec "$@" ;;
  Darwin)
    ulimit -t "$cpu" || exit 78
    ulimit -f "$(( (bytes + 1023) / 1024 ))" || exit 78
    exec "$@" ;;
  *) exit 78 ;;
esac
