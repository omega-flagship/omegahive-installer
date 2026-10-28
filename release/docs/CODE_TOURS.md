# Code tours

Six guided walks through the code, for readers without VS Code. Each step is `file:line` in this repository and
what to look at there. The same tours open step by step in VS Code with the CodeTour extension; see
[`.tours/README.md`](../.tours/README.md). Diagrams and component cards for each area are in the
`omegahive-schematics` repository; the pages are named under each tour.

Lines were read at this repository's handover commit. If a line has moved, search the file for the step's function or
symbol name.

| Tour | Steps |
|---|---|
| [01 Follow an Ask request](#01-follow-an-ask-request) | 15 |
| [02 A belief from mind to commons](#02-a-belief-from-mind-to-commons) | 15 |
| [03 An app action, click to result](#03-an-app-action-click-to-result) | 15 |
| [04 A mind is born](#04-a-mind-is-born) | 15 |
| [05 A paid model call](#05-a-paid-model-call) | 15 |
| [06 Who can see what](#06-who-can-see-what) | 15 |

## 01 Follow an Ask request

From the Ask bar in the UI, through choosing who answers, to the two ways a turn is answered (the mind itself, or the host-side conductor), intents, and the reply frames back in the page.

Tour file: [`.tours/01-follow-an-ask-request.tour`](../.tours/01-follow-an-ask-request.tour). In `omegahive-schematics`: `02-ask-and-ui/01-ask-and-conductor.md`, `components/ask-and-conductor.md`, `components/agent-hub.md`.

1. [`hive/ui/src/features/ask/useAskField.ts:257`](../hive/ui/src/features/ask/useAskField.ts#L257) The Ask bar sends words to the mind
2. [`hive/ui/src/features/ask/answerer.ts:36`](../hive/ui/src/features/ask/answerer.ts#L36) Who answers, shown before the first send
3. [`hive/ui/src/store/ask.ts:1124`](../hive/ui/src/store/ask.ts#L1124) The store makes one request with a stable id
4. [`hive/ui/src/api/live.ts:534`](../hive/ui/src/api/live.ts#L534) POST /api/ask
5. [`hive/core/app.py:1554`](../hive/core/app.py#L1554) The host route
6. [`hive/core/ask.py:633`](../hive/core/ask.py#L633) Ask.create
7. [`hive/core/ask.py:600`](../hive/core/ask.py#L600) The decision: replay, quota, route, busy, spend
8. [`hive/core/ask.py:316`](../hive/core/ask.py#L316) Routing: who answers
9. [`hive/core/ask.py:690`](../hive/core/ask.py#L690) Admission is one transaction
10. [`hive/core/ask.py:706`](../hive/core/ask.py#L706) Path A: the mind answers
11. [`hive/core/ask.py:866`](../hive/core/ask.py#L866) Path A: the mind's reply closes the turn
12. [`hive/core/conductor.py:692`](../hive/core/conductor.py#L692) Path B: the host-side conductor loop
13. [`hive/core/conductor.py:1064`](../hive/core/conductor.py#L1064) Intents: handing work to a team
14. [`hive/core/ask_intents.py:189`](../hive/core/ask_intents.py#L189) Intents.record and submit
15. [`hive/ui/src/store/ask.ts:508`](../hive/ui/src/store/ask.ts#L508) The page renders the reply

## 02 A belief from mind to commons

How a mind's belief reaches its swarm's shared MeTTa space: the native skill, the REST and MCP routes, evidence stamps in Hive.publish, the space service, revision in lib_hive.metta, the operations log, and query.

Tour file: [`.tours/02-a-belief-from-mind-to-commons.tour`](../.tours/02-a-belief-from-mind-to-commons.tour). In `omegahive-schematics`: `04-knowledge/02-beliefs-sharing.md`, `components/hive-spaces.md`, `components/mcp-interface.md`.

1. [`modules/hive/skills.metta:1`](../modules/hive/skills.metta#L1) A native mind calls hive-publish
2. [`modules/hive/src/hive_commons.py:102`](../modules/hive/src/hive_commons.py#L102) The mind's side of the REST call
3. [`hive/core/app.py:2238`](../hive/core/app.py#L2238) REST route: /api/agent/publish
4. [`hive/core/app.py:652`](../hive/core/app.py#L652) The other door: MCP
5. [`hive/core/mcp.py:442`](../hive/core/mcp.py#L442) McpServer.call
6. [`hive/core/mcp.py:535`](../hive/core/mcp.py#L535) _t_hive_publish: policy, then the same publish
7. [`hive/core/hive.py:1520`](../hive/core/hive.py#L1520) Hive.publish: evidence, not repetition
8. [`hive/core/hive.py:1550`](../hive/core/hive.py#L1550) Cited evidence must already exist
9. [`hive/spaces/service.py:214`](../hive/spaces/service.py#L214) SpaceService.publish
10. [`hive/spaces/sexpr.py:130`](../hive/spaces/sexpr.py#L130) Input is parsed before it touches MeTTa
11. [`hive/spaces/service.py:204`](../hive/spaces/service.py#L204) One call into PeTTa
12. [`hive/spaces/lib_hive.metta:123`](../hive/spaces/lib_hive.metta#L123) hive-publish! in MeTTa
13. [`hive/spaces/lib_hive.metta:99`](../hive/spaces/lib_hive.metta#L99) Integration and revision
14. [`hive/spaces/service.py:125`](../hive/spaces/service.py#L125) The operations log
15. [`hive/core/hive.py:1637`](../hive/core/hive.py#L1637) Query

## 03 An app action, click to result

A person clicks an action in an app (the synthetic contract fixture in hive/plugins/contract_fixture). Follow it through the UI, the program action route, visibility, identity and confirm checks, the app's own act(), result validation and the view refresh.

Tour file: [`.tours/03-an-app-action-click-to-result.tour`](../.tours/03-an-app-action-click-to-result.tour). In `omegahive-schematics`: `06-apps/01-programs-contract.md`, `components/programs-host.md`, `components/app-pins.md`.

1. [`hive/plugins/contract_fixture/plugin.json:8`](../hive/plugins/contract_fixture/plugin.json#L8) The app declares what it may do
2. [`hive/plugins/contract_fixture/program.py:36`](../hive/plugins/contract_fixture/program.py#L36) The app declares its actions
3. [`hive/ui/src/features/programs/ProgramHost.tsx:130`](../hive/ui/src/features/programs/ProgramHost.tsx#L130) The click
4. [`hive/ui/src/store/store.ts:1201`](../hive/ui/src/store/store.ts#L1201) store.programAct
5. [`hive/ui/src/api/live.ts:449`](../hive/ui/src/api/live.ts#L449) POST /api/programs/{id}/act
6. [`hive/core/app.py:2899`](../hive/core/app.py#L2899) The route
7. [`hive/core/visibility.py:299`](../hive/core/visibility.py#L299) Visibility checks
8. [`hive/core/program_actions.py:119`](../hive/core/program_actions.py#L119) Identity and credentials are the host's
9. [`hive/core/program_actions.py:381`](../hive/core/program_actions.py#L381) person_act: approver and confirm binding
10. [`hive/core/programs.py:825`](../hive/core/programs.py#L825) Is the app ready?
11. [`hive/core/programs.py:1053`](../hive/core/programs.py#L1053) Programs.act
12. [`hive/plugins/contract_fixture/program.py:116`](../hive/plugins/contract_fixture/program.py#L116) The app's own act()
13. [`hive/core/programs.py:1295`](../hive/core/programs.py#L1295) The result is validated
14. [`hive/ui/src/store/programSession.ts:292`](../hive/ui/src/store/programSession.ts#L292) The page applies the result
15. [`hive/ui/src/store/store.ts:1156`](../hive/ui/src/store/store.ts#L1156) The view refresh

## 04 A mind is born

A native mind from creation to its first model call: the create route, the row and token, the workspace, start through the supervisor and its driver, the optional OS sandbox, the hub connection, and the first call through the hive's model gateway.

Tour file: [`.tours/04-a-mind-is-born.tour`](../.tours/04-a-mind-is-born.tour). In `omegahive-schematics`: `03-minds/01-mind-runtime.md`, `03-minds/02-supervisor-drivers-sandbox.md`, `components/sandbox.md`.

1. [`hive/core/app.py:1239`](../hive/core/app.py#L1239) POST /api/agents
2. [`hive/core/hive.py:742`](../hive/core/hive.py#L742) Hive.create_agent
3. [`hive/core/hive.py:755`](../hive/core/hive.py#L755) The row and its token
4. [`hive/core/hive.py:789`](../hive/core/hive.py#L789) finish_agent
5. [`hive/supervisor/workspace.py:167`](../hive/supervisor/workspace.py#L167) The workspace
6. [`hive/core/app.py:1315`](../hive/core/app.py#L1315) Start (or wake)
7. [`hive/core/hive.py:1124`](../hive/core/hive.py#L1124) _start_locked
8. [`hive/supervisor/drivers.py:521`](../hive/supervisor/drivers.py#L521) Supervisor.start
9. [`hive/supervisor/workspace.py:221`](../hive/supervisor/workspace.py#L221) The mind's environment
10. [`hive/supervisor/drivers.py:172`](../hive/supervisor/drivers.py#L172) LocalDriver.start
11. [`hive/supervisor/sandbox.py:53`](../hive/supervisor/sandbox.py#L53) The sandbox wrap
12. [`modules/channel_hive/src/hive_channel.py:595`](../modules/channel_hive/src/hive_channel.py#L595) The mind dials the hub
13. [`hive/core/app.py:2017`](../hive/core/app.py#L2017) The hub accepts the connection
14. [`lib_llm_ext.py:289`](../lib_llm_ext.py#L289) The mind's model provider is the hive
15. [`hive/core/app.py:2063`](../hive/core/app.py#L2063) The first model call

## 05 A paid model call

One paid model call from a mind: the gateway route, the worst-case estimate, who pays, budget checks, the reservation, the provider call, and settling the real cost.

Tour file: [`.tours/05-a-paid-model-call.tour`](../.tours/05-a-paid-model-call.tour). In `omegahive-schematics`: `03-minds/05-models-and-gateway.md`, `05-governance/02-budgets-and-spend.md`, `components/budgets.md`.

1. [`hive/core/app.py:2063`](../hive/core/app.py#L2063) The route every mind calls
2. [`hive/core/gateway.py:286`](../hive/core/gateway.py#L286) Gateway.estimate
3. [`hive/core/gateway.py:332`](../hive/core/gateway.py#L332) The worst case
4. [`hive/core/config.py:37`](../hive/core/config.py#L37) Prices live on the provider
5. [`hive/core/gateway.py:265`](../hive/core/gateway.py#L265) Which key pays
6. [`hive/core/hive.py:1666`](../hive/core/hive.py#L1666) Which person pays
7. [`hive/core/hive.py:1704`](../hive/core/hive.py#L1704) The budget check
8. [`hive/core/budgets.py:263`](../hive/core/budgets.py#L263) Which limits apply
9. [`hive/core/cost_reservations.py:217`](../hive/core/cost_reservations.py#L217) The budget snapshot
10. [`hive/core/cost_reservations.py:119`](../hive/core/cost_reservations.py#L119) Reserve the worst case
11. [`hive/core/gateway.py:340`](../hive/core/gateway.py#L340) The provider call
12. [`hive/core/app.py:2090`](../hive/core/app.py#L2090) A failed call keeps its hold
13. [`hive/core/app.py:2109`](../hive/core/app.py#L2109) Missing usage is not zero cost
14. [`hive/core/cost_reservations.py:170`](../hive/core/cost_reservations.py#L170) Settle the real cost
15. [`hive/core/hive.py:1735`](../hive/core/hive.py#L1735) Accounting

## 06 Who can see what

Visibility tiers for minds and swarms, how personal minds stay hidden, local-only swarms that refuse outside model calls, and the policy gate on what minds may do.

Tour file: [`.tours/06-who-can-see-what.tour`](../.tours/06-who-can-see-what.tour). In `omegahive-schematics`: `05-governance/03-visibility-and-privacy.md`, `05-governance/01-permissions-and-policy.md`, `components/visibility.md`.

1. [`hive/core/visibility.py:1`](../hive/core/visibility.py#L1) The rule in one paragraph
2. [`hive/core/hive.py:323`](../hive/core/hive.py#L323) New things are private
3. [`hive/core/visibility.py:205`](../hive/core/visibility.py#L205) Viewer.sees
4. [`hive/core/visibility.py:299`](../hive/core/visibility.py#L299) Routes check their path
5. [`hive/core/visibility.py:384`](../hive/core/visibility.py#L384) Lists are filtered
6. [`hive/core/visibility.py:499`](../hive/core/visibility.py#L499) The live stream is filtered
7. [`hive/core/visibility.py:416`](../hive/core/visibility.py#L416) Ask content goes to the asker only
8. [`hive/core/personal.py:119`](../hive/core/personal.py#L119) A personal mind
9. [`hive/core/visibility.py:312`](../hive/core/visibility.py#L312) Personal minds are hidden even from admins' default lists
10. [`hive/core/personal.py:100`](../hive/core/personal.py#L100) Nobody else joins a personal swarm
11. [`hive/core/gateway.py:230`](../hive/core/gateway.py#L230) Local-only swarms
12. [`hive/core/gateway.py:293`](../hive/core/gateway.py#L293) Where the local-only rule runs
13. [`modules/hive/src/hive_commons.py:955`](../modules/hive/src/hive_commons.py#L955) The gate, and what skips it (`LOCAL_ALLOW` and unknown skills bypass it; universal gating is a launch requirement, K10 and K30)
14. [`hive/core/policy.py:181`](../hive/core/policy.py#L181) Policy.decide
15. [`hive/core/policy.py:237`](../hive/core/policy.py#L237) authorize and enforce
