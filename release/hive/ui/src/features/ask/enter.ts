/**
 * What Enter does in the Ask (UI review 2026-10-12, ST1). Every skin highlights one row under the field and marks it
 * with ↵; Enter must do exactly what clicking that row does. Before this, the highlight sat on the first row
 * ("Search everything for …") while Enter ran the §2.4 policy, which hands words it does not understand to a mind:
 * the person saw "Search" and paid for an answer instead.
 *
 * Two rules, pure and shared by every skin (the one hook, useAskField):
 *  - `askRows`: when the policy will hand the words to a mind, that row ("Ask Vega: …") comes first, so it is the row
 *    highlighted at rest and the spend is shown before Enter, never hidden under another row.
 *  - `enterAction`: Enter never hands words to a mind unless the highlighted row is a mind row. A moved highlight, or a
 *    highlighted row the policy would pass over for a mind, is taken exactly as a click takes it.
 */
import { mindCandidate, type Candidate, type Decision } from '../../lib/intent'

/** A row whose act hands the words to a mind (the orchestrator, or a steer of the turn in flight). */
export const sendsToMind = (c: Candidate | undefined): boolean => c?.act?.do === 'mind'

/** How many suggestions to show: more while choosing between same-named things. */
const most = (c: Candidate[]) => (c.some((x) => x.choice) ? 9 : 5)
const shownName = (n: string | null) => (n && !/^\s*omega\s*$/i.test(n) ? n : 'the orchestrator')

/**
 * The rows the Ask shows for these words, in order. While a turn is answering, the first row tells it now (a steer).
 * When the policy will ask a mind, that row is first; otherwise the mind row is offered last.
 */
export function askRows(cands: Candidate[], value: string, answerer: string | null, d: Decision, steering: boolean): Candidate[] {
  const list = cands.filter((c) => c.act || c.fill || c.limit || c.clarify).slice(0, most(cands))
  if (value.trim().length < 2) return list
  const mind = mindCandidate(value, answerer)
  if (steering) return [{ ...mind, key: 'steer', tag: 'Tell', parts: [{ t: 'Tell ' }, { t: shownName(answerer), em: true }, { t: ' now: ' }, { t: value.trim(), q: true }] }, ...list]
  return d.kind === 'mind' ? [mind, ...list] : [...list, mind]
}

/** The highlighted row: the one `sel` points at, kept inside the list. */
export const highlighted = (rows: Candidate[], sel: number): Candidate | undefined => rows[Math.min(sel, Math.max(0, rows.length - 1))]

/**
 * What the person can see under the field, as the skin drew it (r2.1, stand-in #3). Every skin declares it
 * (useAskField `declareSeen`); a field nothing declared for shows nothing, so its Enter does nothing.
 *  - `rows`: the suggestion rows with their highlight (not replaced by a voice notice, a panel or a picker)
 *  - `panel`: the policy's panel ("Did you mean…", a question, a plain line)
 */
export interface AskSeen {
  rows: boolean
  panel: boolean
}
export const NOTHING_SEEN: AskSeen = { rows: false, panel: false }

export type Refusal = 'hidden' | 'empty' | 'panel'
export type Enter = { kind: 'take'; c: Candidate } | { kind: 'policy'; d: Decision } | { kind: 'refuse'; why: Refusal }

/**
 * What one Enter does.
 *  - Rows on screen: 'take' does exactly what clicking the highlighted row does. A moved highlight, a turn in flight
 *    (its first row is the steer, when the words are long enough to be one), or a highlighted row the policy would pass
 *    over for a mind are all taken as a click. Otherwise 'policy': it acts on the highlighted row itself, or only opens a
 *    question under the field.
 *  - No row on screen: Enter acts only on what a VISIBLE panel itself offers to Enter, and the only panel that does is
 *    "That place changed. Send to the Ask instead?" (`placeChanged`): its words name that Enter sends them to the Ask.
 *    Any other panel ("Did you mean…", a question, a plain line) is answered with its own buttons: Enter refuses
 *    ('panel'), and no unseen act runs, paid or not (Kimi r2.1 #2).
 *  - Nothing on screen (a voice notice or a picker replaced the rows): 'refuse'. Nothing hidden authorises anything.
 */
export function enterAction(rows: Candidate[], sel: number, moved: boolean, d: Decision, o: { steering: boolean; seen: AskSeen; placeChanged: boolean }): Enter {
  if (o.seen.rows) {
    const row = highlighted(rows, sel)
    if (!row) return { kind: 'refuse', why: 'empty' }
    if (moved || o.steering) return { kind: 'take', c: row }
    // the policy would hand the words to a mind (or say nothing can answer): Enter takes the highlighted row exactly as
    // a click does. A mind row sends its own words (r2.2: Construct's `ask kelp` sends "kelp", never the whole line);
    // any other row is what the person sees, so it runs instead of a mind's answer under it (ST1)
    if (d.kind === 'mind' || d.kind === 'none') return { kind: 'take', c: row }
    return { kind: 'policy', d }
  }
  if (o.seen.panel) return o.placeChanged ? { kind: 'policy', d } : { kind: 'refuse', why: 'panel' }
  // nothing drawn: hidden rows (a notice or a picker in their place), or no rows at all yet (too few words)
  return { kind: 'refuse', why: rows.length ? 'hidden' : 'empty' }
}

/** Does this Enter hand the words to a mind (a paid answer)? */
export const asksMind = (e: Enter): boolean => (e.kind === 'take' ? sendsToMind(e.c) : e.kind === 'policy' && e.d.kind === 'mind')
