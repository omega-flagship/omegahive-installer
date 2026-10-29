# Custody caller R3: diagnostic Stage 2 pin update

This Source candidate changes only `STAGE2_MANIFEST_PIN` and
`STAGE2_REVIEW_PIN` from the reviewed R2 caller. Every other top-level AST,
including every function and class, is identical. The exporter remains exact R3
at 84,366 bytes / a66fd830865e82e45b7f39575ecce5fd60cee0a87a1c3de5c4eead2ce8a50e98.

The genuine new Stage 2 closure has ten roles, nine with unchanged bytes and one
independently reviewed diagnostic Entry. Its external manifest is 1,162 bytes /
1b62a67f57510a043038559d157be6349447e66b4d4cc188af5e3012e8939d14; its genuine
review is 3,788 bytes /
fc79c6baec8c4675a62161e0adc6b5195f046d2d90d90e0e92c557a8e72c2296.
The old Stage 2 and custody envelopes remain immutable.

The default CLI validates a genuine closed Source envelope and prints a Source
plan. It imports no exporter and starts no runtime work. Explicit `--run` still
requires the dedicated same-job CI owner, pinned PBS interpreter, exact Source
manifest/reviews, actual Stage 2 launch and successful phase/closure/seal facts,
current tasks, a fresh full resource RUN and the unchanged original clocks.
It stages exclusive actual admission/context metadata and execs the reviewed
exporter. It does not create a static PASS review or qualify restored bytes.

The entry setup wall remains 45 seconds. The exporter wall/resource/inventory,
archive and publication guards are unchanged. Prior focused caller controls test
the same unchanged code; the new diagnostic Entry and shell controls are separate
scoped evidence. A genuine new package, independent review, real default Source
plan and exact owner workflow review remain required before another CI attempt.

Actual runtime custody, restore/requalification, UI/app/DMG, Assist demo and
deployment remain separate. First combined CI 40803759458 is retained as failed;
this pin update neither diagnoses that failure nor grants a retry.
