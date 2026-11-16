import type { ActionResult } from '../api/types'

/**
 * Frozen READ-ONLY outputs of the Tools app 0.6.3 (omega-tools, view revision below), as its own `act` returns them for
 * inspect-tool and show-examples on atom-recall (identical to Root's 2026-10-08 live-tools-ui-read-payloads fixture)
 * and compose-set on set:pln. Synthetic examples and technical metadata only; nothing here ran a tool.
 */
export const TOOLS_063_REVISION = 'a12a8fb2230c0d98e5f7b76359397abbee4c427af522e2c66e4a2b3cd738cf85'

export const TOOLS_063_RESULTS: Record<'inspect-tool' | 'show-examples' | 'compose-set', ActionResult> = {
  "inspect-tool": {
    "status": "done",
    "detail": {
      "tools": [
        {
          "id": "atom-recall",
          "name": "Exact AtomSpace recall",
          "category": "thought",
          "adds": "Recall candidate references by explicit symbolic keys; reconcile with semantic search later.",
          "claim_ceiling": "Native sample tested separately; neither whole-memory retrieval nor truth/authority.",
          "stage": "prepared-sample-candidate",
          "sample": "tools_atom_recall",
          "source_ids": [
            "source-3b26203a1f005ce4",
            "donor-v2_atom_recall"
          ],
          "effect_authority": "none in this candidate",
          "novelty": "not independently established",
          "implementation_origin": "exact-native-donor",
          "sample_scope": "Exact-key candidate recall; no semantic retrieval or whole-history context builder.",
          "skills": [
            "tools-atom-recall"
          ],
          "example_count": 5
        }
      ],
      "authority": "none",
      "executed_now": false,
      "input_contract": {
        "schema": "omega-tools-inert-input-v2",
        "limits": {
          "max_input_bytes": 8192,
          "max_input_nodes": 512,
          "max_input_depth": 12
        },
        "skills": {
          "tools-atom-recall": {
            "arguments": [
              "ref",
              "refs",
              {
                "kind": "list",
                "max": 64,
                "item": "atom-entry"
              }
            ]
          }
        },
        "types": {
          "atom-entry": {
            "kind": "construct",
            "head": "AtomMemoryEntryV1",
            "fields": [
              "ref",
              "refs"
            ]
          },
          "ref": {
            "kind": "symbol"
          },
          "refs": {
            "kind": "list",
            "max": 64,
            "item": "ref"
          }
        }
      },
      "execution_binding": {
        "program": "omega-tools",
        "action": "run-native",
        "review_receipt": "82725082c45d0410000b3286b7183cd4f5c65e1991f164eba071f34fedd26602",
        "module_selection": [
          "omegahive.tools.atom_recall@0.1.0"
        ],
        "requires": "host app grant plus exact selected module; sandbox allowlist; no provider calls"
      },
      "sources": [
        {
          "id": "source-3b26203a1f005ce4",
          "label": "OMEGAV2_D08_MEMORY_RECALL_LINEAGE_CREDIT_AND_SHARED_MEMORY_2026-08-07.md",
          "kind": "document",
          "status": "inspected",
          "local_ref": "source-3b26203a1f005ce4",
          "locator": "SHA-256 3b26203a1f005ce4581893ab979b879b2bc35b6672840fba937419a1e34ca2f7",
          "origin": "Omega historical technical corpus"
        },
        {
          "id": "donor-v2_atom_recall",
          "label": "lib_omegaclaw_memory_recall.metta",
          "kind": "document",
          "status": "inspected",
          "local_ref": "donor-v2_atom_recall",
          "locator": "SHA-256 4efd99cb48df41888fc76602593e537cf82b76d25d754aab624c7ee3eb8c6896",
          "origin": "Omega historical technical corpus"
        }
      ],
      "wire_examples": [
        {
          "tool": "atom-recall",
          "name": "exact-key-not-semantic",
          "skill": "tools-atom-recall",
          "arguments": [
            "r1",
            [
              "study"
            ],
            [
              [
                "AtomMemoryEntryV1",
                "lamp",
                [
                  "study",
                  "lighting"
                ]
              ],
              [
                "AtomMemoryEntryV1",
                "book",
                [
                  "studying"
                ]
              ]
            ]
          ],
          "expected_native": [
            "(AtomMemoryRecallDecisionV1 r1 (lamp) authority-none)"
          ],
          "contains_native": null,
          "authority": "none",
          "qualification": "banked synthetic; not executed by reading this example"
        }
      ]
    }
  },
  "show-examples": {
    "status": "done",
    "detail": {
      "scope": "banked synthetic examples through isolated candidate import resolution, not installed agent/runtime acceptance",
      "recorded_at": "2026-10-03T20:19:54.552855+00:00",
      "executed_now": false,
      "examples": [
        {
          "tool": "atom-recall",
          "name": "exact-key-not-semantic",
          "call": "(tools-atom-recall r1 (study) ((AtomMemoryEntryV1 lamp (study lighting)) (AtomMemoryEntryV1 book (studying))))",
          "expected": [
            "(AtomMemoryRecallDecisionV1 r1 (lamp) authority-none)"
          ],
          "actual": [
            "(AtomMemoryRecallDecisionV1 r1 (lamp) authority-none)"
          ],
          "passed": true
        },
        {
          "tool": "atom-recall",
          "name": "recall-multi-key-order",
          "call": "(tools-atom-recall r2 (study heat) ((AtomMemoryEntryV1 lamp (study)) (AtomMemoryEntryV1 temp (heat)) (AtomMemoryEntryV1 book (reading))))",
          "expected": [
            "(AtomMemoryRecallDecisionV1 r2 (lamp temp) authority-none)"
          ],
          "actual": [
            "(AtomMemoryRecallDecisionV1 r2 (lamp temp) authority-none)"
          ],
          "passed": true
        },
        {
          "tool": "atom-recall",
          "name": "recall-empty",
          "call": "(tools-atom-recall r3 () ())",
          "expected": [
            "(AtomMemoryRecallDecisionV1 r3 () authority-none)"
          ],
          "actual": [
            "(AtomMemoryRecallDecisionV1 r3 () authority-none)"
          ],
          "passed": true
        },
        {
          "tool": "atom-recall",
          "name": "recall-no-match",
          "call": "(tools-atom-recall r4 (sleep) ((AtomMemoryEntryV1 lamp (study))))",
          "expected": [
            "(AtomMemoryRecallDecisionV1 r4 () authority-none)"
          ],
          "actual": [
            "(AtomMemoryRecallDecisionV1 r4 () authority-none)"
          ],
          "passed": true
        },
        {
          "tool": "atom-recall",
          "name": "recall-cannot-authorize",
          "call": "(memory-recall-can-grant-effect? arbitrary)",
          "expected": [
            "false"
          ],
          "actual": [
            "false"
          ],
          "passed": true
        }
      ],
      "authority": "none",
      "installation": "not installed"
    }
  },
  "compose-set": {
    "status": "done",
    "detail": {
      "schema": "omega-tools-composition-preview/v1",
      "sets": [
        "pln"
      ],
      "components": [
        {
          "role": "beliefs",
          "implementation": {
            "id": "omegahive.tools.belief_governance",
            "version": "0.1.0"
          },
          "configuration": {},
          "state": "isolated-native-sample",
          "host_shadow": false
        },
        {
          "role": "claim-comparison",
          "implementation": {
            "id": "omegahive.tools.ensemble",
            "version": "0.1.0"
          },
          "configuration": {},
          "state": "isolated-native-sample",
          "host_shadow": true
        }
      ],
      "unresolved_required_slots": [
        "pln-inference",
        "reasoning-continuation"
      ],
      "status": "incomplete",
      "executed": false,
      "registered": false,
      "authority": "none",
      "effects": [],
      "activation": "separate exact-component review and existing host policy required",
      "compatibility": "descriptor role/configuration checks only; semantic adapter compatibility is unproven"
    }
  }
}
