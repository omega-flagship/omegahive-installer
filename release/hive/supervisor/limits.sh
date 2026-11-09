#!/bin/sh
# Fixed launcher run inside the sandbox: set CPU-seconds and file-size limits, then exec.
# Arguments: <cpu seconds> <file size in bytes> <program> [args...]. Pinned host arguments only; never evaluates caller
# strings. (Adapted from OmegaDesign's studio_limits.sh.)
# Linux: util-linux prlimit sets both limits in exact bytes and is required (Ubuntu's dash counts `ulimit -f` in
# 512-byte blocks, so ulimit would halve the limit). macOS: the original ulimit path, 1024-byte units, rounded up.
# Any failure to set a limit exits 78 and the program never starts.
cpu="$1"; bytes="$2"; shift 2
case "$cpu$bytes" in *[!0-9]*|"") exit 78 ;; esac
# The host runner supplies a fixed platform for forkless macOS jobs. No uname
# subprocess is needed there. The original positional invocation stays supported.
memory=0; processes=0
if [ "$1" = "--hive-resource-limits" ]; then
    [ "$#" -ge 6 ] || exit 78
    platform="$2"; memory="$3"; processes="$4"; shift 4
    [ "$1" = "--" ] || exit 78
    shift
    case "$platform" in Linux|Darwin) ;; *) exit 78 ;; esac
    case "$memory" in *[!0-9]*|"") exit 78 ;; esac
    case "$processes" in *[!0-9]*|"") exit 78 ;; esac
else
    platform="$(uname -s)"
fi
[ "$#" -gt 0 ] || exit 78
case "$platform" in
  Linux)
    command -v prlimit >/dev/null 2>&1 || exit 78
    # r14.4: ONE setup operation, applied to this launcher process itself; the program inherits the limits through
    # exec. There is no second prlimit run that could fail after a successful check (Kimi/stand-in r14.3): if the
    # limits cannot be set, that is a setup failure (78) and the program never starts.
    # AS is virtual address space of EACH process. NPROC counts the real uid,
    # not this job. Neither is an aggregate descendant resource guarantee.
    if [ "$memory" -gt 0 ] && [ "$processes" -gt 0 ]; then
        prlimit --pid="$$" --cpu="$cpu" --fsize="$bytes" --as="$memory" --nproc="$processes" || exit 78
    elif [ "$memory" -gt 0 ]; then
        prlimit --pid="$$" --cpu="$cpu" --fsize="$bytes" --as="$memory" || exit 78
    elif [ "$processes" -gt 0 ]; then
        prlimit --pid="$$" --cpu="$cpu" --fsize="$bytes" --nproc="$processes" || exit 78
    else
        prlimit --pid="$$" --cpu="$cpu" --fsize="$bytes" || exit 78
    fi
    exec "$@" ;;
  Darwin)
    # No strict physical/aggregate memory bound is claimed for sandbox-exec.
    [ "$memory" -eq 0 ] || exit 78
    ulimit -t "$cpu" || exit 78
    ulimit -f "$(( (bytes + 1023) / 1024 ))" || exit 78
    if [ "$processes" -gt 0 ]; then ulimit -u "$processes" || exit 78; fi
    exec "$@" ;;
  *) exit 78 ;;
esac
