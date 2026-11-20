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
| `(below src n)` | the fact `(count src)` is stated and under n (unstated, it does not hold), so a threshold such as "under a fifth left" is MeTTa's, not the page's |
| `(any (c1 c2 …))` | at least one of the conditions holds |
| `(none-of (c1 c2 …))` | none of the conditions holds (there is no `not`: MeTTa's own `not` would run, not match) |

**Props** are `((key value) …)`. Any part may carry `(fill yes)` to grow to the height its screen is given (a studio filling its bench), `(sticky yes)` to stay at the top while the page scrolls under it (with the row it shares, such as a row of filters), `(grow yes)` to take an equal share of its row's width, at least 20rem, so two charts sit side by side where they fit and stack on a phone, and `(tour <name>)`; its wrapper then has `data-tour="<name>"` for guided tours. The name may be bound, `(tour (bind app.tour))`, so each item of a stack can carry its own. Any part may carry `(flush yes)` to sit right against the part after it, without the screen's spacing, as a view's bar sits on its view. Any part may also carry `(hidden-when (flag …))`: it is drawn and stays mounted, but its wrapper is `hidden` while any of those bound flags is true in the page's data, so an island such as an app's frame keeps its state under another view (MeTTa still decides whether the part is there at all). A value is a string, a number, a symbol, a list, or `(bind path)`. A bound value is filled from the page's data when the screen is drawn. A text may also be `(words "…" (bind path) …)`: its strings and bound values, joined.

## The frame every look wears: the usage region

Some parts belong to a look's frame, not to a page: they show wherever the look is, whatever page is open. `frame.metta`
declares the frame screen, and a feature declares its frame parts in its own `.metta` with a frame region:

```metta
(RolePart frame 10 measure ((source allowance.mine.parts) (text (bind allowance.mine.left))))   ; features/usage/allowance.metta
(When frame 10 (on allowance.mine))
(Region frame 10 usage)                                  ; the place each look shows usage
```

`usage` is the place each look shows usage: classic's top bar after Spend, and each other look's equivalent in its
frame. Every look's frame renders `<UsageRegion />` (shell/UsageRegion.tsx) there, which composes the frame for the look
being worn and draws the parts MeTTa placed in that region (`RegionParts`), so a part declared once shows in every look,
each drawing its role its own way. A page's own `Screen` never draws a frame region.

A view drawn over a look's frame renders the region in its own header as `<UsageRegion covering />`: a page, a mind's
panel (where a person chats with a mind, under that mind's budget) and Still's reading. While one is open the look's
frame draws nothing in its region, so a screen shows one battery, and it draws again once the view closes. A look's rest
and awake views show no usage, so they carry no region; the battery is there once the look's own frame is up.
`features/usage/allowanceMeterPlaces.test.ts` checks that every look in the registry carries the region, that every
covering view and every mind's chat does, and that nothing mounts the battery by hand.

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
| forbidden | base+2 | forbidden | `(forbidden body)`, or `(forbidden quiet)` for a part only some people may read | `empty`: "Admins only"; quiet draws nothing, takes no order, and a refusal is no failure |
| failed | base+3 | failed (and forbidden, when there is no forbidden piece) | `(failed lead)`, `(failed-title T)` or `(noun N)` | a `bad` notice "lead: error" ("Could not load N: error"), or with `failed-title` an `empty` titled T with the error under it |
| retry | base+4 | as failed | `(retry intent)` | Try again, sending the intent |
| stale | base+5 | ready and stale | `(retry intent)` or `(stale T)` | a `warn` notice "Could not refresh: error Showing the last loaded data.", or T |
| stale-reason | base+6 | as stale | `(stale-reason label)` | `facts` with a Reason row holding the error |
| stale-retry | base+7 | as stale | `(retry intent)` | Retry, sending the intent |

Any piece can be drawn the page's own way: `(part waiting notice ((tone info) (text "Checking every mind…")))`.
Texts that join words and a bound value use `(words "Could not load roles: " (bind resource.error))`, which the
renderer joins at draw time. The page's other parts read the same facts, such as `(When roles 20 (is resource ready))`.

**Several resources on one screen.** A screen that loads more than one resource names each declaration, and the page
states each one's facts under its name:

```metta
(Resource usage 30 ((name held) (waiting "Loading held calls") (failed "Could not read held costs") (retry reload-held)))
(Resource usage 60 ((name limits) (noun "spending limits") (retry reload-limits)))
(When usage 70 (is limits ready))
```

```ts
withResource(held, withResource(limits, own, 'limits'), 'held')
```

A declaration named `limits` reads the value `limits` and the flags `limits.stale` and `limits.empty`, and its texts
bind `limits.error`. A declaration without a name is the resource in the tables above, so `(is resource …)`,
`resource.stale` and `resource.error` keep their meaning.

The guard `badResources` refuses a declaration on an undeclared screen, the same resource declared twice on one
screen, an option the fragment doesn't know (or a `part` for a piece it doesn't have), and a piece whose order one of
the screen's own parts already has. `space.orders(screen)` lists every order a screen has, its own and the fragment's,
for the "every part can be reached" tests.

## The blocks

Each block has a role (`(Block name role)`), and each role has a default block (`(Prefer role block 1)`).

| Block | Role | What it draws |
| --- | --- | --- |
| `header` | heading | The title, an eyebrow above it, the body text, and Back. `(title_id …)` gives the title an id, so the page can name what it heads by it (`aria-labelledby`). |
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
| `entries` | collection | Rows with an icon, a tag, a badge, meta and detail lines, and each row's own open button; `(aria <field>)` names that button from the row ("Remove the old default on Nori"), and `(row_actions ((action label intent [aria]) …))` adds buttons of the row's own, each pressed with the row's item, the aria text naming the row ("Dismiss {title}"). |
| `note` | message | A quiet line of small print. |
| `waiting` | absence | A placeholder while something loads. |
| `confirm` | commands | A question with a button that goes ahead (marked as risky) and one that cancels. `(tone plain)` draws the go-ahead as an ordinary button, for a yes that destroys nothing; `(alert yes)` makes it an alertdialog, which a screen reader announces as it appears, named by `(label …)` and described by the question. |
| `reveal` | secret | A value shown once, in a fixed-width face, with Copy and Hide, and a note under it. Optional: `copy_label` and `hide_label` rename the two buttons; `(alert yes)` announces it as it appears. |
| `island` | embed | A part the page still draws itself, by name (`(name idle-minds)`); the page offers it in `host.islands`. It is one element wherever it is placed: keyed by its name, so a screen may move it to another part and it stays mounted, with what the person typed in it. One the page offers that draws nothing (a panel with nothing to say) takes no room. |
| `tally` | summary | A row of counts, each with a word and a tone: `(items ((item (bind n) "healthy" good) …))`. |
| `segmented` | filter | A choice of one option, bound to a value: `(options ((option all "All") …))`. |
| `stack` | nest | One item per row, each its own composed screen (the item carries `plan` and `data`); presses come back with the item ids in `scope`; `(current (bind id))` rings and marks the matching item; `(columns auto)` lays the items in a responsive grid. |
| `line` | title | A name (pressable with `open`), a quiet note, and a badge in a tone; `(orb hue-path) (status status-path)` puts an orb before the name, `(dim flag-path)` fades the row. |
| `disclosure` | opener | A row that opens and closes: badge, title, meta, `(expanded <bound flag>)`, and the action it sends. |
| `code` | excerpt | Preformatted text, such as a command and its result. |
| `keyfield` | entry | A hidden field for pasting a key, with its submit button (`waiting` words while `busy` is true), an optional Cancel, and a help line with a link. The key goes back with the `action` press as `value`, never into the page's data. |
| `orbs` | crowd | A row of minds as orbs, up to `most`, then "+N"; each opens `open` with the mind, named by `aria` (`"{name}, open model settings"`). |
| `chooser` | setting | One choice from a few that changes a record, such as a person's role: `(value <path>)`, `(options ((option admin "Admin") …))`. A press sends `action` with `{ value }`, so inside a `stack` it carries the item's scope. Arrow keys move focus without choosing (one tab stop); Space, Enter or a press chooses; `(waits flag)` holds it. |
| `buttons` | commands | Buttons that each carry their own weight, icon and accessible name: `(items ((button "Hold…" hold-app ((aria "Hold reloads of {app.name}") (icon pause) (variant ghost))) …))`. A screen asks for it by name; `actions` stays the default. A button may carry `(expanded flag-path)` for `aria-expanded`, and `(on flag-path)` or `(off flag-path)` to be drawn only while that bound flag is true, or false. Buttons are keyed by their place among those drawn, so two that trade places on a flag (Full screen, then Close) are one element, and the person's focus stays on it. |
| `tabs` | pick | One choice from a few, as tabs bound to a value, each with its count when the item carries one; an item may carry a `color` dot, its `glow` and a `tint`. |
| `pills` | pick | Filters that press on and off, bound to a value: each item's label, a `note`, a `count` (with `count_title` and `partial`), a `hint`, and `quiet` (dashed) or `accent` when on. An optional link at the end: `(more "…") (more_action …)`. `(multi yes)`: several may be on (the bound value is a list), and a press sends `action` with the item and its new state. |
| `switcher` | filter | One way to see something, bound to a value: `(options ((option board "Columns" columns) …))`, each with an icon; one tab stop, and the arrow keys move it. |
| `orrery` | circle | A group's minds circling a glow in its hue: `(hue <path>) (minds <path>)`, each mind's `hue` and `status`; with `open` the whole of it is one button, named by `aria` (`"Open {swarm.name}"`). |
| `paragraph` | prose | A paragraph of plain words, such as what an app does: body text, neither a heading nor small print. |
| `fields` | form | Labelled fields to fill in, each `(field <kind> <label> <bind> ((option value) …))`, its value bound and each change sent through `onInput`: `select` (`(source <list>) (prompt "Choose")`, the empty choice first), `number` (`least`, `most`, `step`), `text` (`placeholder`; `(quiet yes)` keeps the label for assistive technology only), `long`, text on several lines (`(rows n)`, `placeholder`, `quiet` as for `text`), and `checks`, tick boxes under the label as a legend, one per item at `<bind>` (`id`, `label`, `on`), each tick sending `(action …)` with the item and whether it is ticked. `(waits <flag>)` holds a field; `(focus yes)` gives a field the focus when it is drawn (an editor that just opened); `(columns two)` sets two to a row on a wider screen. `(submit <action>)` makes Enter in a number or text field send that action, as the form's own button does (never while the field waits, nor an input method's confirming Enter). Option names are data, so none is a library word (`empty`, `min`, `max` would run). |
| `rename` | naming | A name being changed: a text field that starts from a bound `value` and takes focus; Enter sends `action` with the trimmed `value`, Escape or leaving the field sends `cancel_action`. `(maxlength 60)` caps its length. |
| `progress` | measure | A bar split into the parts of a whole, each part as wide as its count: `(source <list>)`, each item's `n`, `label` and `color`. The bar is named for assistive technology by its counts ("2 done, 1 failed"); `(text …)` is the line of words under it, and `(partial <flag>)` marks that line as possibly short. |
| `picture` | figure | A picture the page made, such as a screenshot: `(source (bind path))`, a `data:` or `blob:` address (nothing from another origin), `(alt "…")` what it shows in words, an optional `(caption "…")`, and an optional button under it, `(action <intent>)` named `(action_label "…")`. It draws nothing while the source is empty |
| `figures` | summary | Key figures as tiles: each item's `label`, `value`, an optional `chip` (`chip_title`, `chip_aria`), a `note` in the warn tone (`note_title`), and its change against the period before (`delta` words, `delta_dir` up or down, `delta_tone` good or bad, `delta_note`). An item with `hero` true is the large first tile. A screen asks for it by name; `tally` stays the default |
| `chart` | details | Columns over time, each a stack of its series' values, in a captioned card (`title`, `subtitle`, `chip`): `(source <columns>)`, each with `x`, `at`, `total`, `total_words`, `aria` and `parts` (each series' `key`, `n` and `words`); `(series <list>)` each key's `label` and `color`, bottom first, also the legend; `(axis <path>)` the scale's `max` and `ticks` (`n`, `words`). A column shows its tooltip while hovered or focused |
| `bars` | measure | Rows of bars scaled to the largest row, in a captioned card as `chart`: each row's `label`, `value`, `parts` side by side (`n`, `color`), an `orb` hue, and a `detail` line shown while it is hovered or focused; `(legend <list>)`, and `(empty "…")` for no rows. A screen asks for it by name; `progress` stays the default |
| `table` | collection | Rows in a table: `(columns ((column <field> <header> ((align end) (phone hide) (tone quiet) (mark <field>) (mark_title <field>))) …))`; a header may be bound; `(phone hide)` keeps a column off a phone; a row's `mark` draws a small warn tag after its value; `(caption …)` names the table for assistive technology |
| `said` | utterance | Words someone said, drawn inside the look's own line or bubble: each statement or truth value said in English (marked `data-said`), and each artifact id as the artifact's title in a chip that opens it (`onOpen('artifact', { id, kind })`), never the id. The titles come from the page's data (`words.named`), and the words between chips take the page's mark when it gives one (`words.mark`) |
| `bar` | toolbar | The bar above something the page draws under it, such as a view: `(icon …)`, the title on one line, and its buttons at the end, as `buttons` draws them. `(title_id …)` gives the title an id the page names that thing by; `(edge flag-path)` draws the bar as the top edge of a full-screen frame while the flag is true. |
| `written` | opener | The same words as written, behind a small "Show as written" (`label` renames it). Closed, they stay in the DOM, hidden; an artifact id in them is still a chip. `(class …)` is the place's own class for it |
| `mark` | collapsed | Something put away to its mark, which opens it again: the Ask collapsed to its living Omega. One round control showing the page's own glyph (`(glyph <island>)`), placed where the page says (`left`, `bottom`, `mode`), with `label` and `title`, `(state answering)` tracing its rim, and `(news <flag>)` a dot for an answer since it collapsed; a press sends `action`. The Ask's stylesheet dresses it as the look's field. |

**A block nothing draws yet.** Declare it with `(Wants timeline collection)`. It falls back to its role's block, and appears in `plan.missing` as a build task.

**Depth.** Every part sits on a layer: ground, surface, raised or float. A flat look shows the layer as elevation. A look with `(LookSpace <look> 3d)` draws the part at that depth under its own perspective, about its own centre: nearer parts are a little larger, and every part stays where the layout puts it, however long the screen. Islands stay flat.

## Words said in the hive

A mind's reply, a mind's answer in the Ask, a person's message, the hive's own note, a room's talk, a goal's detail and a
statement "as written" are drawn in every look by one composed screen, `words` (`features/views/words.metta`), through
one slot, `features/views/Words.tsx`. A look renders `<Words text={…} />` inside its own line or bubble, and never draws
the words' chips or statements itself. A place that marks words its own way passes `mark`, as the Ask lights up what
was asked about; the said block draws the words between chips through it.

The slot states two flags, `words.said` and `words.written` (the words held notation that is said in English, or the
place shows only "as written"), looks up each artifact the words name for the person, and draws the parts with
`InlineParts`, which draws a plan's blocks without wrappers so they sit inside text. It loads with the screen engine;
until then the words show in plain text, each artifact id as "an artifact", and the composed parts then take their
place without mounting again. Words drawn after it has loaded draw at once.

`features/views/wordsPlaces.test.ts` keeps every look on it. It fails when a look in the registry has no chat entry,
when a look's chat or a shared view draws words without the slot, when MeTTa does not compose the `said` block for a
look, or when anything else draws a chip or a statement.

## The Ask

The Ask is on every page in every look, and its sizes and its mark are one composed screen, `ask` (`screens/ask.metta`).
The person keeps a size on their hive (`features/ask/askSize.ts`): collapsed to its Omega, the bubble, or the left half.
`features/ask/AskHost.tsx` states three facts, `ask.size`, `ask.mode` (desktop, landscape or phone) and `ask.drawn` (it
draws the look's Ask on this page), and MeTTa answers with the look's own Ask as the island `ask` in one region (`mark`,
hidden behind the mark; `bubble`; `half-left`; or `sheet`, a phone's full-height thread), and the `mark` block while
the Ask is collapsed and drawn. The look's Ask lays itself out in the region it is given, and stays mounted from one
size to the next because an island is keyed by its name.

`features/ask/askScreen.ts` composes it and gives the host it is drawn with; AskHost draws it with `InlineParts`, since
its parts place themselves over the page (a wrapper's depth would become the containing block of their fixed places).
It composes from a space of
`lib_screens.metta`, `looks.metta` and `ask.metta` only, so the first paint parses three sources rather than every
screen; its answers are the whole space's. `features/ask/askScreen.test.ts` checks every look the registry offers at
every size on every kind of screen, that small space against the whole one, and that nothing else composes the Ask or
draws its mark; `features/ask/askScreen.mounted.test.tsx` mounts every look's own Ask in the screen and checks the mark,
its press, and the look's Ask kept mounted in its region at every size.

## Arranging what is shown

When a mind or a person shows something, MeTTa decides where everything goes: the shown item in the centre at its
kind's size, the items that belong to the task in strips beside it, and the rest out of view.
`screens/arrange/lib_arrange.metta` holds the rules, and `ArrangeSpace.compose(state)` in `arrangeSpace.ts` states one
moment's atoms for one call and reads the answer, as `ScreensSpace.compose` does.

A state is what the page holds: the stage's size, the items it has (`artifact`, `mind`, `task`, `decision` or
`message`, with an artifact's stored kind), which items belong to which task, how many times each item has been in
view with each task, the shares a person has dragged splits to, and the statements said, oldest first:

| Statement | What MeTTa arranges |
| --- | --- |
| `(Show k t)` | k in the centre at its kind's size (`KindSize`), or at that area in k's own shape once the page knows it (`ItemShape`, a picture's pixels), shrunk only to fit the stage; every item with interest or a relation in task t in a strip beside it, as wide as the strip and never smaller than its kind's least size (`KindLeast`), while k keeps its own least size (on a smaller stage the strips go first); every other item out of view |
| `(Recall k)` | k beside what is shown, side by side along the stage's longer side (a row on a wide stage, a column on a tall one); the shown items not in it go in the tray |
| `(Compare a b t)` | a over b, each half of the stage |
| `(PutAway k)` | k out of view, into the tray, even when it was the last thing shown |
| `(Clear)` | nothing: the look is as it was |

The newest `Show`, `Compare` or `Clear` anchors the arrangement, and each `Recall` and `PutAway` after it adds or
takes away one item, the anchored ones included; a newer one of the same item undoes an older one, so pressing a put-away
item in the tray brings it back. A row or column starts at equal shares; a split the person dragged opens at the shares they left
it at whenever the same kinds are split the same way, a pair in either order.

The answer is `(Arranged mode task placed dividers tray seen unknown)`: every item drawn with its kind and rectangle,
every divider with the least and most it may be dragged to, the tray, the items to credit with interest in the task
(once per statement, as `seen.episode` says), and the keys the log names that the page has no item for. A drag is
stated too, `(Dragging group i at)`, so the divider and its two neighbours move as MeTTa decides, never past either
neighbour's least size. A group is named by its path from the outermost one (`()`, `(0)`, `(0 1)`; the page writes `g`,
`g0`, `g0-1`), so a pair compared beside a recalled item has two dividers a drag tells apart.

`screens/arrange/arrange.test.ts` checks each statement, with seeded random stages and item sets for the rules that
must hold everywhere: nothing overlaps or leaves the stage, and exactly the items with interest or a relation are
drawn beside what is shown.

The stage draws the answer over whichever look is open. `StageHost` is mounted once in App.tsx, beside the Ask, so
every look and page has it; it binds the stage to the signed-in person and loads `StageView`, and MeTTa with it, at
the first statement. `StageView` draws each item at its rectangle through `drawers.tsx`: a view through the hive's
view frame, still waiting for its person's Run it; an image or a text from its saved revision; a mind, a task, a
decision or a message from the hive's own data; an item beside the shown one as a card that brings it into view when
pressed. Each divider is a window splitter (arrows move it by five hundredths, Home and End to its ends), the tray's
chips bring an item back, and Put away or Escape clears the stage. While a divider is held its position is stated on
each frame, so MeTTa moves it and its two neighbours; letting go teaches those shares for those kinds. What a person
teaches is kept for them in this browser (`arrange.ts`), and a change of person empties the stage.

The stage arranges in the window below its own bar and above the docked Ask's room. The Ask is drawn over the stage, so
while its thread is open the stage takes the largest strip the thread leaves, the window above a thread rising over the
dock or the rest of the screen beside one pinned to a side (`stageWindow` in `arrange.ts`). The component that draws
the thread reports where it is (`useThreadReport` in features/ask/askRoom.ts); pages and the hive map keep only the
dock's room, as before.

A mind says it with a skill: `hive-show ar_id`, `hive-recall ar_id` or `hive-compare ar_picture ar_text`
(modules/hive). The host (hive/core/stage.py) sends it only to the person the mind's turn answers, the asker of its Ask
turn, or outside the Ask the person whose own mind it is or whose own space it is in, never to everyone who can see the
mind; each item must be one that person may see. Where the conductor answers the Ask (hive/core/conductor.py, on by default), the mind it speaks as says
the same with its `show`, `recall` and `compare` tools, to that turn's asker, by the same rule. The frame, `stage.said`, names each item with its kind, so `StageHost` says it to the stage and MeTTa
arranges it in that event. The host keeps each person's recent statements, and after a dropped socket the page reads
what it missed from `GET /api/me/stage?after=n`, never what was said before it opened.

Saving a creation shows it to nobody, so the answer to a creation's first saved text names `hive-show` with its id, and
the create help and the screen line of a mind's catalog say the same.

The conductor reads a page through the view the page gives the Ask. The Artifacts page lists each creation by its id,
the one open in place first, and the hive names each from its own data, only what the asker may see, so "show me the
picture called Harbour at dusk" finds its id. On any other page the conductor's `show`, `recall` and `compare` take the
title the person gave instead of an id (`Stage.titled`): the hive shows the creation when exactly one the asker may see
has that title, case and spacing aside, or else holds it in its title. When two or more do, it shows none and names each
back with what it is and how long ago it was made, so the conductor asks the person which one.

The Canvas look's own board is arranged the same way. `experiences/canvas/board.metta`, loaded into the same space,
places each swarm's island, its minds as cards and its tasks as stickies, the Decisions lane, the empty board and an
open chat card, from the swarms, minds, tasks and decisions the look states in its own order (`board.ts`); a card is a
mind's `KindSize` and a sticky a task's, so the stage and the board draw one size for each. `board.test.ts` checks the
answer against the board the look drew before its placement moved into MeTTa (`board.fixture.json`), and
`noPlacement.test.ts` fails on any size, gap or layout function in the Canvas look's TypeScript, on any board item built
outside `board.ts`, and on any part drawn away from the rectangle MeTTa gave it. On a shown item, whatever has been in
view with its task comes back beside it in any look, a board card included.

The open page's own composed parts take part the same way. A page's `Screen` tells the stage what it draws
(`screens/openScreens.ts`); a screen inside a view's frame, a stage tile or another screen does not. Each part but an
island is an item of kind `part`: when the person is back on the page after a statement, MeTTa credits its parts with
that statement's task, and the next thing shown in the task brings the ones with interest beside it, each drawn by the
block that draws it on the page and acting through the page's own host. An island stays with its page: it is the page's
own component with its own state, and one holding an iframe would reload if its node moved.

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

## When a screen or a part fails

A composition that throws gives the plain unavailable notice in the screen's place (`rememberedCompose`), and a part
whose block throws while it is drawn shows "This part could not be drawn." in its own place while the other parts stay
(`PartBoundary` in `Screen.tsx`). Both are told to `lib/screenFailures.ts`, which reads no store, so a test that mocks
the store still loads any screen. The page's recent errors hear it (`lib/recentErrors.ts`, kind `screen`), and the
feedback area offers the person a drafted report about them (`features/feedback/drafts.ts`); nothing is sent unless
they choose to.
