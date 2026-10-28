# G2 person notices, G4 daily spend

A mind can send a short notice to its own person, under a daily budget and quiet hours the person sets. A person can read
their own daily spend. Code: `core/notices.py`, `core/me_spend.py`. Tests: `tests/test_g2_notices.py`,
`tests/test_g4_spend.py`, `ui/src/api/notices.test.ts`.

## G2: notices

**Who may post.** Only a mind in the person's own app space: their P14 app context (`app_person_contexts`) or their P2
app swarm (`app_person_swarms`). The swarm, the mind and the binding must all name the same enabled person, and the swarm
must be private and not archived. Anything else gets `403 not_your_person`: a mind in an ordinary swarm (even the
person's own), another person's mind, a person, an admin, an app. There is no person-facing or program-facing post route.

| Route | Who | Purpose |
|---|---|---|
| `POST /api/agent/notices` `{text, urgent?}` | a mind (its token) | Post to its own person. Answers `{id, state: delivered}` or `{id, state: held, held: cap \| quiet}`. |
| `GET /api/me/notices?after=&limit=` | a person | Delivered notices and digests, newest first, plus `waiting` (held count) and `prefs`. |
| `GET` / `PUT /api/me/notices/settings` `{cap, quiet_start, quiet_end, tz}` | a person | Their own budget. |
| `POST /api/me/notices/release` | a person | "Show them now": everything waiting, as one digest. |

**The budget.**
- `cap` is one of 0, 1, 3, 5, 8 a day (default 3). Quiet hours are two `HH:MM` local times (default 21:00 to 07:00) or
  both `null`. `tz` is an IANA zone (default UTC); the day and quiet hours are read in it. Only the person sets these:
  minds have no route to them.
- A notice over the cap, or in quiet hours, is stored as `held`. It is never dropped. Held notices are not shown or
  pushed. They are delivered together as one digest (`kind: digest`, with `items`) outside quiet hours, once something
  waited through quiet hours or since an earlier day. So a cap hold waits for the next day; a quiet hold goes when quiet
  hours end. The reconcile pass runs `Notices.sweep()`. Reading the list, and any new notice to that person, also lets a
  due digest go first, so yesterday's holds always arrive before today's notice. A digest uses no pop-up.
- Today's cap holds go early only when the person raises the cap and all of them now fit; they then count against
  today's cap. Any other settings change releases nothing. What the person pulls with "Show them now" uses none of the
  cap.
- **Delivery order.** Every notice gets a `delivery` number when it actually reaches the person: on posting, or on its
  release into a digest (each released notice, in posting order, then the digest). Every cursor (the person's `after`
  and a frame's) reads that number, shown as `seq`, so a release is never behind a cursor. The column, its
  index and the backfill are added in one transaction (`Notices.migrate`). Every start also numbers any delivered or
  digested row still left without a number, after the current ones and in posting order, so an interrupted older
  migration cannot hide a notice.
- Self-set reminders do not count. `Notices.reminder(agent_id, text)` is host-internal, for G1's `on_fire: notice`
  (not part of this PR). It has no route, so a mind cannot claim to be a reminder. Reminders are still held in quiet
  hours.

**Urgent.** The class is fixed: `smoke_co`, `water_leak`, `door_open_night`, `security_alarm`. These are the only notices
that may break through quiet hours and the cap. A mind sends `urgent: {kind, event}`. The host accepts it only if
`Notices.home_link_verified(agent, kind, event)` is true. That hook is the host-side allowlist for a verified home-link
event. **It returns False today, because no home link exists yet, so every urgent notice is refused with
`403 urgent_unavailable` and nothing is stored.** Any other kind is a `400`. When a home link lands, it implements the
hook. Nothing else changes.

**Limits.**
- Text is at most 500 UTF-8 bytes, plain text: control characters are refused. It is stored and served verbatim as a JSON
  string and is never interpreted as markup. The UI renders it as text.
- A mind may send at most 20 notices an hour (process-local).
- A person receives at most 200 a local day.
- At most 500 can be held per person. Over a limit the mind gets a `429`: a refusal it can see, never a silent loss.
  Urgent skips the per-person limits, not the per-mind rate.

**Live.** The `notice` event (`{principal, notice, waiting}`) goes to that person only, admins included. It is checked in
`Visibility.event_visible` before the admin bypass, like Ask frames.

**Frame read (P1).** The new op `{"op": "notices", "after"?}` on `POST /api/programs/{id}/ask/frames/{generation}/ops` is
admitted exactly like every P1 op: current consent, lease, generation owner, session and rate. It answers only the
generation's own person's notices from this app's own context. That context is the P14 binding, while it still stands,
plus the person's P2 swarms for this app. It answers in delivery order after a cursor, at most 20, under the op byte
cap. A page always holds at least one row when one exists and always moves the cursor. Held notices appear when they are
released: each with its `digest_id`, then the digest itself scoped to this context (its count counts only this
context's items). A frame subscribes by polling with the cursor. The UI bridge message is `ask-notices`
(`lib/appAsk.ts`).

## G4: daily spend

`GET /api/me/spend?days=N` (N from 1 to 31, default 7) is person-only, behind the same gate as the notices routes, so
the operator password session or any non-person session reads nothing. It returns the caller's own `usage` rows (`payer` = the caller's
principal). The rows are grouped by day in the person's time zone (the notice settings' `tz`). Every day appears, zero
days included. Each day has `total_usd`, `own_keys_usd`, `hive_paid_usd`, `by_mind` and `by_app`, where `by_app` is
keyed by the app of the person's own P14 context or P2 swarm, or `other`. The principal is never taken from the request,
so nobody reads another person's spend here. Admins keep their existing views (`/api/usage`, budgets) unchanged. There is
no new money logic: `Hive.my_spend` now shares `own_key_ids` with it.

The frame op `{"op": "spend", "days"?}` (UI bridge `ask-spend`) answers the person's own per-day totals and this app's
share (`this_app_usd`). It names no minds and no other apps.

## Not in this PR

- **Routes outside a hive frame** for both reads are deferred to a later change.
- **G4 `op` split** (chat, embed, media, speech): usage rows do not record it yet.
- **Held worst-case liabilities** (`cost_reservations`) are not shown in G4.
- **Held notice expiry:** held notices always wait.
- **`/api/usage/me`** keeps its existing shape (a non-person session falls back to `user:operator`). Narrowing it would
  change the operator's existing spend view, so it is a follow-up.
- **G1 `on_fire: notice`:** this PR only provides the hook (`Notices.reminder`).
