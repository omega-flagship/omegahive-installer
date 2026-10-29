# Lifecycle supervisor design sources

Inspected 2026-10-29 against systemd 249 documentation, matching the Ubuntu 22.04 CI lane's version family.

- [systemd.service 249](https://www.freedesktop.org/software/systemd/man/249/systemd.service.html): `ExecStopPost` is the cleanup hook for normal stops and unexpected exits, including failed startup. `RuntimeMaxSec` bounds an active service. SIGTERM is considered a clean termination for service types other than oneshot; the TERM control therefore checks the observed signal/code rather than requiring `Result=signal` exclusively.
- [systemd-run 249](https://www.freedesktop.org/software/systemd/man/249/systemd-run.html): transient services are supervised by the service manager. `Type=exec` waits for successful process execution.
- [systemd v249 service implementation](https://github.com/systemd/systemd/blob/v249/src/core/service.c): an exited service does not retain its running-state timer. The supervisor therefore omits `RemainAfterExit`, permits immediate post-exit cleanup, and retains systemd's exit facts in the cleanup receipt instead of depending on a retained live unit.

These documented semantics motivate the supervisor design. Only native CI receipts can establish the exact invocation's behavior on the admitted runner. The existing installer `ci/code-c2/containment.sh` contains direct subprocesses; the new root cleanup explicitly covers the separate fresh user manager. Neither source documentation nor portable controls qualify native cleanup.
