# Hyperon acceptance R1.3 source-pair review

Disposition: PASS_SOURCE_ONLY. Independent source review verified R1.4.2 R2 ZIP SHA a6a3f4d0d735134c08a4e8e6d808dca216af5079cacbcfd8858484f95508f5bc (292,195 bytes; 110 members) and recomputed 91-module digest c63d17cb8886a119fd35358108b4fd5daeb16074cdf74de0a108f218a070d319. Driver, native helper and JSON inputs/expected receipts bind those exact values.

Relative to frozen R1.2, executable changes are source pins and qualification label only. All closure predicates, both census/phase checks, native-case logic, evaluator boundaries and cleanup remain unchanged. Portable tests, outer gate/tests and both wheel locks are byte-identical to R1.2.

52 portable acceptance controls pass using invented bytes/mocked native execution under existing macOS system CPython3.9.6. The separate source candidate has 14 passing portable controls, 0 skipped, under existing bundled CPython3.12.14 (11 AST mutation tests plus 3 actual invented-module import controls). These do not qualify native Hyperon or interrupted-run cleanup.

The product fix now covers all ten reviewed owned Python interpreter argv builders, including the DAP target. Generic person/operator command argv and runner -m/PYTHONPATH semantics remain intact. Native R1.3 rerun requires a fresh worker; do not delete or admit an unexpected installed file. No selection, staging or deployment is claimed.
