# Private Stage2 failure capture Source envelope

This envelope contains Source code and two unchanged independent Source reviews.
It contains no private captured output or owner/account credentials.

The caller authenticates the helper before a non-main import, creates the closed
13-field schema2 owner metadata from held current controls and explicit workflow
labels, and calls helper.run once with Guard(original_start). Source and metadata
work share the original15-second/128MiB process scope (13swork,2sclose reserve).
Producer source/control reads are capped3MiB and the independent helper Store6MiB;
combined source/control reads cannot exceed9MiB. Log range reads separately cap
160KiB; retained opaque tails cap16KiB each. Private controls stay0400/0600. Only
externally authenticated Source permits0644;0664 always refuses.

The fixed caller/helper paths after owner staging are ci/mac-private-phase-tails/
capture_failed_phase.py and retain_failed_phase_tails.py. Each is invoked through
the explicit reviewed owner workflow with isolated Python, a closed environment,
the current exact Stage2 manifest/review and self/helper hashes. Owner labels are
attestations; no authenticated Hive membership, host admission or account identity
is inferred. The original Stage2 status and control files are never rewritten.

Only a known capture_dir pointer goes to current-step GITHUB_OUTPUT. Opaque log
bytes never go to caller stdout, graph or UI. A later independent upload selects
only STDOUT.tail.bin,STDERR.tail.bin,PRIVATE_TAIL_RECEIPT_R1.json under that exact
namespace; missing/partial artifacts are not promoted to complete evidence. The
new mac-private-phase-failure-tails profile requires its separate private intake
reader and acquisition admission; existing public diagnostic ZIP profiles do not
admit it. No payload is pushed onto the Mini.

Source review is not execution qualification. The helper28 synthetic checks have
passed; caller22 checks and complete workflow integration are still pending when
this Source-only envelope was prepared. No new CI or native/runtime/demo pass is
cleared by this manifest. Retain failed and superseded Source/receipts unchanged.
