# Screens composed by MeTTa

A screen in the hive is a set of atoms. MeTTa decides what is on it, and the browser draws MeTTa's answer.

```
feature/<name>.metta  ──►  screens/lib_screens.metta (MeTTa)  ──►  ScreenPlan  ──►  screens/Screen.tsx
   the parts, in order        which parts show for the facts       plain data       draws each block
   their conditions           which block draws each, per look                       fills bound values
   a block or a role          each part's depth (flat or 3D)                         hands presses back
                              fallbacks → build tasks
```

## The parts of a screen

```metta
(Screen tools "Tools")                                   ; declares the screen
(Part tools 10 header ((title "Tools") (body "…")))      ; a part drawn by a named block
(RolePart tools 30 collection ((source tools.shown) (title title) (open tool)))   ; the look picks the block
(When tools 30 (has tools.shown))                        ; shown only when every condition holds
(Depth tools 10 float)                                   ; optional: a layer other than the role's
(Row tools 40 commands)                                  ; optional: parts sharing a row sit side by side
(Region tools 50 aside)                                  ; optional: a side column on a wide screen (name it with a part's (region_label "…"))
```

**Conditions** read this moment's facts, which the page states every time it composes:

| Condition | Holds when |
| --- | --- |
| `(has src)` | the fact `(count src)` is above 0 |
| `(none src)` | that count is 0, or wasn't stated |
| `(on flag)` | the flag is true |
| `(off flag)` | the flag is false, or wasn't stated |
| `(is key value)` | the value matches, as a known symbol (compared as data, so words like `member` are safe) |
| `(any (c1 c2 …))` | at least one of the conditions holds |
| `(none-of (c1 c2 …))` | none of the conditions holds (there is no `not`: MeTTa's own `not` would run, not match) |

**Props** are `((key value) …)`. Any part may carry `(fill yes)` to grow to the height its screen is given (a studio filling its bench), and `(tour <name>)`; its wrapper then has `data-tour="<name>"` for guided tours. The name may be bound, `(tour (bind app.tour))`, so each item of a stack can carry its own. Any part may also carry `(hidden-when (flag …))`: it is drawn and stays mounted, but its wrapper is `hidden` while any of those bound flags is true in the page's data, so an island such as an app's frame keeps its state under another view (MeTTa still decides whether the part is there at all). A value is a string, a number, a symbol, a list, or `(bind path)`. A bound value is filled from the page's data when the screen is drawn. A text may also be `(words "…" (bind path) …)`: its strings and bound values, joined.

## Loading, refused, failed and stale: the shared resource fragment

A screen that loads one resource doesn't write its own loading and error parts. It declares the resource once, and
`lib_screens.metta` adds the standard parts to its composition:

```metta
(Resource roles 10 ((waiting "Loading roles") (unsupported "This hive or the demo does not have a role library.")
  (forbidden "Ask an admin of this hive to change roles.") (failed "Could not load roles") (retry retry)))
```

The page states one standard set of facts, built by `screens/resourceFacts.ts` from a `ResourceState`
(`withResource(res, { data, facts })` adds them to the page's own):

| Fact | Meaning |
| --- | --- |
| `(is resource loading)` … `ready`, `unsupported`, `forbidden`, `failed` | where the resource is; `ready` covers an empty answer, and a 403 is `forbidden` |
| `(on resource.stale)` | a refresh failed, and the last data stays on screen |
| `(on resource.empty)` | the answer is in, and empty |
| data `resource.error` | why the last read failed, in plain words |

Each piece takes a fixed order from the base, and is drawn only when the declaration asks for it (a piece not asked
for takes no order):

| Piece | Order | Shows when | Asked for by | Drawn as |
| --- | --- | --- | --- | --- |
| waiting | base+0 | loading | `(waiting T)` or `(noun N)` | `waiting`, labelled T or "Loading N" |
| unsupported | base+1 | unsupported | `(unsupported body)`, optional `(unsupported-icon ban)` | `empty`: "Not available here" |
| forbidden | base+2 | forbidden | `(forbidden body)` | `empty`: "Admins only" |
| failed | base+3 | failed (and forbidden, when there is no forbidden piece) | `(failed lead)`, `(failed-title T)` or `(noun N)` | a `bad` notice "lead: error" ("Could not load N: error"), or with `failed-title` an `empty` titled T with the error under it |
| retry | base+4 | as failed | `(retry intent)` | Try again, sending the intent |
| stale | base+5 | ready and stale | `(retry intent)` or `(stale T)` | a `warn` notice "Could not refresh: error Showing the last loaded data.", or T |
| stale-reason | base+6 | as stale | `(stale-reason label)` | `facts` with a Reason row holding the error |
| stale-retry | base+7 | as stale | `(retry intent)` | Retry, sending the intent |

Any piece can be drawn the page's own way: `(part waiting notice ((tone info) (text "Checking every mind…")))`.
Texts that join words and a bound value use `(words "Could not load roles: " (bind resource.error))`, which the
renderer joins at draw time. The page's other parts read the same facts, such as `(When roles 20 (is resource ready))`.

The guard `badResources` refuses a declaration on an undeclared screen, a screen declared twice, an option the
fragment doesn't know (or a `part` for a piece it doesn't have), and a piece whose order one of the screen's own parts
already has. `space.orders(screen)` lists every order a screen has, its own and the fragment's, for the
"every part can be reached" tests.

## The blocks

Each block has a role (`(Block name role)`), and each role has a default block (`(Prefer role block 1)`).

| Block | Role | What it draws |
| --- | --- | --- |
| `header` | heading | The title, an eyebrow above it, the body text, and Back. |
| `section` | group | A section's title and body. |
| `search` | filter | A text field bound to a value. |
| `chips` | tags | A row of tags. |
| `list` | collection | Rows: title, summary, meta, and an optional open action. |
| `cards` | collection | The same as `list`, as cards. Cosmos, Flux and Canvas draw collections this way. |
| `facts` | details | Label and value rows. |
| `toggles` | choices | One switch per item. |
| `notice` | message | A short notice in one of three tones: info, warn or bad. |
| `empty` | absence | An empty state, with an optional icon. |
| `actions` | commands | Buttons: `(action label intent [waits-on] [icon])`, where waits-on is a bound flag (or `-`) that holds that one button; `(tone primary)` draws them as the page's main action. |
| `segments` | pick | One choice from a few, as a row of radio buttons, each with its count. |
| `menus` | pick | A row of drop-down menus, each bound to a value, with an "every" option first. |
| `entries` | collection | Rows with an icon, a tag, a badge, meta and detail lines, and each row's own open button. |
| `note` | message | A quiet line of small print. |
| `waiting` | absence | A placeholder while something loads. |
| `confirm` | commands | A question with a button that goes ahead (marked as risky) and one that cancels. |
| `reveal` | secret | A value shown once, in a fixed-width face, with Copy and Hide, and a note under it. Optional: `copy_label` and `hide_label` rename the two buttons; `(alert yes)` announces it as it appears. |
| `island` | embed | A part the page still draws itself, by name (`(name idle-minds)`); the page offers it in `host.islands`. |
| `tally` | summary | A row of counts, each with a word and a tone: `(items ((item (bind n) "healthy" good) …))`. |
| `segmented` | filter | A choice of one option, bound to a value: `(options ((option all "All") …))`. |
| `stack` | nest | One item per row, each its own composed screen (the item carries `plan` and `data`); presses come back with the item ids in `scope`; `(current (bind id))` rings and marks the matching item; `(columns auto)` lays the items in a responsive grid. |
| `line` | title | A name (pressable with `open`), a quiet note, and a badge in a tone; `(orb hue-path) (status status-path)` puts an orb before the name, `(dim flag-path)` fades the row. |
| `disclosure` | opener | A row that opens and closes: badge, title, meta, `(expanded <bound flag>)`, and the action it sends. |
| `code` | excerpt | Preformatted text, such as a command and its result. |
| `keyfield` | entry | A hidden field for pasting a key, with its submit button (`waiting` words while `busy` is true), an optional Cancel, and a help line with a link. The key goes back with the `action` press as `value`, never into the page's data. |
| `orbs` | crowd | A row of minds as orbs, up to `most`, then "+N"; each opens `open` with the mind, named by `aria` (`"{name}, open model settings"`). |
| `chooser` | setting | One choice from a few that changes a record, such as a person's role: `(value <path>)`, `(options ((option admin "Admin") …))`. A press sends `action` with `{ value }`, so inside a `stack` it carries the item's scope. Arrow keys move focus without choosing (one tab stop); Space, Enter or a press chooses; `(waits flag)` holds it. |
| `buttons` | commands | Buttons that each carry their own weight, icon and accessible name: `(items ((button "Hold…" hold-app ((aria "Hold reloads of {app.name}") (icon pause) (variant ghost))) …))`. A screen asks for it by name; `actions` stays the default. A button may carry `(expanded flag-path)` for `aria-expanded`. |
| `tabs` | pick | One choice from a few, as tabs bound to a value, each with its count when the item carries one; an item may carry a `color` dot, its `glow` and a `tint`. |
| `pills` | pick | Filters that press on and off, bound to a value: each item's label, a `note`, a `count` (with `count_title` and `partial`), a `hint`, and `quiet` (dashed) or `accent` when on. An optional link at the end: `(more "…") (more_action …)`. `(multi yes)`: several may be on (the bound value is a list), and a press sends `action` with the item and its new state. |
| `switcher` | filter | One way to see something, bound to a value: `(options ((option board "Columns" columns) …))`, each with an icon; one tab stop, and the arrow keys move it. |
| `orrery` | circle | A group's minds circling a glow in its hue: `(hue <path>) (minds <path>)`, each mind's `hue` and `status`; with `open` the whole of it is one button, named by `aria` (`"Open {swarm.name}"`). |
| `paragraph` | prose | A paragraph of plain words, such as what an app does: body text, neither a heading nor small print. |
| `fields` | form | Labelled fields to fill in, each `(field <kind> <label> <bind> ((option value) …))`, its value bound and each change sent through `onInput`: `select` (`(source <list>) (prompt "Choose")`, the empty choice first), `number` (`least`, `most`, `step`), `text` (`placeholder`; `(quiet yes)` keeps the label for assistive technology only), and `checks`, tick boxes under the label as a legend, one per item at `<bind>` (`id`, `label`, `on`), each tick sending `(action …)` with the item and whether it is ticked. `(waits <flag>)` holds a field; `(columns two)` sets two to a row on a wider screen. Option names are data, so none is a library word (`empty`, `min`, `max` would run). |
| `rename` | naming | A name being changed: a text field that starts from a bound `value` and takes focus; Enter sends `action` with the trimmed `value`, Escape or leaving the field sends `cancel_action`. `(maxlength 60)` caps its length. |
| `progress` | measure | A bar split into the parts of a whole, each part as wide as its count: `(source <list>)`, each item's `n`, `label` and `color`. The bar is named for assistive technology by its counts ("2 done, 1 failed"); `(text …)` is the line of words under it, and `(partial <flag>)` marks that line as possibly short. |

**A block nothing draws yet.** Declare it with `(Wants timeline collection)`. It falls back to its role's block, and appears in `plan.missing` as a build task.

**Depth.** Every part sits on a layer: ground, surface, raised or float. A flat look shows the layer as elevation. A look with `(LookSpace <look> 3d)` places the part at that depth.

## Building a page this way

1. **Declare the screens** in `features/<feature>/<name>.metta`, and add that file to `SCREEN_SOURCES` in `screenSpace.ts`.
2. **Write a pure adapter** in `features/<feature>/data.ts`. It turns the hive's data into `{ data, facts }`. Facts are counts and flags only, never a person's words. If the page loads a resource, declare `(Resource …)` and state its facts with `withResource`.
3. **Write the page.** It loads the data, calls `screensSpace().compose(screen, look, facts)`, and renders `<Screen plan host />`. It also carries out presses (`onOpen`, `onAction`, `onInput`, `onBack`).
4. **Decide nothing on screen in TypeScript.** Which parts show, in what order and with which block is MeTTa's decision. If you're tempted to write `{cond && <Thing/>}` around a part, make it a `When` condition instead.
5. **Add a new block only when no existing block will do.** Add its `Block`, `Prefer` and `RoleDepth` atoms, its component in `Screen.tsx`, and a test.
6. **Tests** (vitest, invented data only):
   - the page's screens compose correctly for the facts that matter;
   - the HTML draws the right words;
   - every condition can be reached;
   - the guards stay clean (`screens/screenSpace.test.ts` checks every loaded screen).
