# Code tours

Guided walks through the OmegaHive code, one request or idea at a time. Each step opens a file at a line and explains
what happens there. The tours describe the code at this repository's handover commit; if a line moves, the step text
still names the function to look for.

## Install

1. Install [Visual Studio Code](https://code.visualstudio.com/).
2. Install the **CodeTour** extension (publisher `vsls-contrib`, id `vsls-contrib.codetour`) from the Extensions view,
   or run `code --install-extension vsls-contrib.codetour`.
3. Open the root of this repository as the VS Code folder. CodeTour finds the `.tours/` folder by itself.
4. Open the **CodeTour** panel in the Explorer sidebar and pick a tour, or run **CodeTour: Start Tour** from the
   command palette.

No VS Code? [`docs/CODE_TOURS.md`](../docs/CODE_TOURS.md) lists every step as `file:line`.

## Tours

| Tour | What it follows |
|---|---|
| [01 Follow an Ask request](01-follow-an-ask-request.tour) | The Ask bar, who answers, the two ways a turn is answered (the mind, or the host-side conductor), intents, and the reply |
| [02 A belief from mind to commons](02-a-belief-from-mind-to-commons.tour) | Publishing over REST or MCP, evidence stamps, the space service, revision in `lib_hive.metta`, the operations log, query |
| [03 An app action, click to result](03-an-app-action-click-to-result.tour) | A click in an app (the synthetic contract fixture), the action route, visibility and identity checks, `act()`, result validation, the view refresh |
| [04 A mind is born](04-a-mind-is-born.tour) | Create, workspace, supervisor and driver, the OS sandbox, the hub connection, the first model call |
| [05 A paid model call](05-a-paid-model-call.tour) | The gateway, who pays, budget checks, the worst-case reservation, the provider call, settling the cost |
| [06 Who can see what](06-who-can-see-what.tour) | Visibility tiers, hidden personal minds, local-only swarms, the policy gate |

A suggested order for a first read: 04, 01, 05, 06, 02, 03.
