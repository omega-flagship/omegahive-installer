import { useSyncExternalStore } from 'react'
import { setSceneBackdrop, setSceneInk } from '../scene/engine'
import { experienceById } from '../experiences/registry'
import seeds from './uiVariants.seed.json'
import { checkLook } from '../theme/themeCheck'
import checkRules from '../theme/theme.rules.json'
import { sha256 } from '../lib/askMemory/hash'

/**
 * Your look and layout (Surface v1). A variant is data only: colour tokens, font stacks and a few enums. The host
 * validates it (hive/core/ui_prefs.py) and applies it as CSS variables; nothing here runs a variant's code or loads
 * a URL. The saved choice lives on the server per person (GET/PUT/DELETE /api/me/ui) with a local copy for the first
 * paint; a preview is local until the person keeps it. `?ui=default` in the address always resets.
 */
export type Layout = 'rail' | 'topbar' | 'dock'
export const LAYOUTS: { id: Layout; label: string; blurb: string }[] = [
  { id: 'rail', label: 'Side rail', blurb: 'Navigation down the left' },
  { id: 'topbar', label: 'Top bar', blurb: 'Navigation across the top' },
  { id: 'dock', label: 'Dock', blurb: 'A floating dock at the bottom' },
]

export const COLOR_KEYS = ['void', 'abyss', 'ink', 'ink-2', 'ink-3', 'ink-4', 'ink-5', 'line', 'line-2', 'control', 'glass', 'glass-2', 'accent', 'primary-top', 'primary-ink', 'accent-2', 'good', 'warn', 'bad'] as const
export type ColorKey = (typeof COLOR_KEYS)[number]

export interface UiVariant {
  schema: 'omegasurface.variant/0.1'
  id: string
  name: string
  blurb?: string
  author?: string
  scheme: 'dark' | 'light'
  layout: Layout
  density: 'compact' | 'regular' | 'roomy'
  radius: 'square' | 'soft' | 'round' | 'pill'
  motion: 'none' | 'calm' | 'lively'
  /** Why this variant cannot render correctly yet; the gallery shows it but will not apply it. */
  needs?: string
  fonts?: Partial<Record<'display' | 'sans' | 'mono', string>>
  colors: Record<ColorKey, string>
}

export interface UiPrefs {
  variant: UiVariant | null
  /** Overrides the variant's own layout; null follows the variant (or the side rail). */
  layout: Layout | null
  /** Inside apps: each app's own theme (default) or the identity set designed by Surface. */
  apps?: 'owner' | 'designed' | null
  /**
   * Where this person lands in their look (Ask-and-apps contract R1.1 §7): awake (the Ω, the Ask and the apps) or Pro.
   * Each principal's own row; absent means awake. Kept through every whole-preference write (carryLanding).
   */
  landing?: 'awake' | 'pro' | null
  /**
   * A whole alternative front end (experiences/registry.ts); null is the Classic hive. `variant` stays the person's
   * own look throughout: an experience's companion look is worn while it is active (wornVariant), never stored.
   */
  experience?: string | null
}
export interface UiPrefsResponse {
  prefs: UiPrefs | null
  updated_at: string | null
  /**
   * The host's revision of this person's stored look (platform/ui-prefs-revision): 0 with no row, +1 on every accepted
   * PUT or DELETE, never lower. Absent from an older host.
   */
  rev?: number
}
/** Compare-and-set: the revision this write expects the host to be at (sent as `X-UI-Base-Rev: <rev>`). */
export interface UiPrefsWriteOptions {
  baseRev?: number
}

/** The built-in look, as a variant, so the gallery can show and preview it like the others. Mirrors index.css. */
export const DEFAULT_VARIANT: UiVariant = {
  schema: 'omegasurface.variant/0.1',
  id: 'default',
  name: 'OmegaHive',
  blurb: 'Lavender glass in deep space, side rail.',
  scheme: 'dark',
  layout: 'rail',
  density: 'regular',
  radius: 'soft',
  motion: 'lively',
  colors: {
    void: '#04040f', abyss: '#080822', ink: '#eceaff', 'ink-2': '#b9b8dc', 'ink-3': '#8a89b3', 'ink-4': '#7e7da9', 'ink-5': '#5d5c86',
    line: 'rgb(170 170 255 / 0.12)', 'line-2': 'rgb(190 190 255 / 0.2)', control: '#6868a0', glass: 'rgb(16 16 44 / 0.62)',
    'glass-2': 'rgb(24 24 62 / 0.72)', accent: '#a493ff', 'primary-top': '#b9aeff', 'primary-ink': '#0b0820', 'accent-2': '#6ee7ff',
    good: '#4ade80', warn: '#fbbf24', bad: '#fb7185',
  },
}

export const SEED_VARIANTS = seeds as UiVariant[]

/**
 * Whether a look can be worn, and if not why. Light or dark doesn't matter (the light-token round made every surface
 * follow the look); what matters is that it can be read. That is the theme's rules (theme/theme.metta via PeTTa): each
 * token must stand out from what it is read against, a shortfall within the rules' limit is repaired, and a look that
 * still falls short is refused with its reason, so a look a person makes can never hide the interface.
 */
export function blockedReason(v: UiVariant): string | null {
  if (v.needs) return v.needs
  const bad = COLOR_KEYS.find((k) => !lookColourOk(k, v.colors?.[k]))
  if (bad) return `This look can't be worn: its ${bad} colour must be #rrggbb` + (TRANSLUCENT.has(bad) ? ' or rgb(r g b / a)' : '')
  const f = checkLook(v.colors).failures[0]
  if (!f) return null
  return f.ratio === null ? `This look can't be read: ${f.token} on ${f.against} can't be measured` : `This look can't be read: ${f.token} on ${f.against} is ${f.ratio}:1, and it needs ${f.floor}:1`
}

// A look a person makes is data, held to the same shape as the host's check (core/ui_prefs.py) and the same rules file:
// every colour is solid #rrggbb, except the ones the theme's rules let be see-through, which may also be rgb(r g b / a).
const HEX6 = /^#[0-9a-f]{6}$/i
const RGBA = /^rgb\(\s*\d{1,3}\s+\d{1,3}\s+\d{1,3}\s*\/\s*(0|1|0?\.\d{1,3})\s*\)$/
const TRANSLUCENT = new Set<string>(checkRules.translucent)
const lookColourOk = (k: string, c: unknown): boolean => typeof c === 'string' && (HEX6.test(c) || (TRANSLUCENT.has(k) && RGBA.test(c)))
/** A font stack a look may set (the host's rule): letters, digits, spaces, commas, quotes and hyphens, naming a family. */
const safeFont = (f: unknown): string | null =>
  typeof f === 'string' && /^[A-Za-z0-9 ,'-]{1,200}$/.test(f) && f.split(',').some((part) => /[A-Za-z]/.test(part.replace(/[ ']/g, ''))) ? f : null

/**
 * A look's density is its TEXT size (Kimi r1g P1): a factor on the type scale only, set as `--text-scale` (index.css
 * re-points the nine --text-* tokens and their line heights at it). The root rem is never changed, so spacing, radii,
 * min-heights and hit targets (44 px: min-h-11 / size-11) are the same at every density, and the person's own browser
 * text size still applies underneath. Older text written in px does not grow until it moves onto the type scale.
 */
export const TEXT_SCALE: Record<UiVariant['density'], number | null> = { compact: 0.9375, regular: null, roomy: 1.125 }

/** The custom properties a density sets on the root (none for regular). Pure. */
export const densityVars = (d: UiVariant['density']): Record<string, string> => (TEXT_SCALE[d] ? { '--text-scale': String(TEXT_SCALE[d]) } : {})


// ---------------------------------------------------------------- experiences and their companion looks

/** The experience these prefs open, when it is one this build offers (null: the Classic hive). */
export function activeExperience(p: UiPrefs | null): { id: string; name: string; companionLook?: string } | null {
  const e = experienceById(p?.experience)
  return e.id === 'classic' ? null : e
}

/** The companion look an active experience dresses classic pages in, when it has one. */
function companionOf(p: UiPrefs | null): UiVariant | null {
  const id = activeExperience(p)?.companionLook
  return id ? SEED_VARIANTS.find((v) => v.id === id) ?? null : null
}

/**
 * Marks a seed the person chose for themselves when it is also an experience's companion (Deep Sea for Cosmos,
 * Phosphor Terminal for Construct, Sakura Night for Flux), so it is never mistaken for the old gallery's write. Data
 * only: `author` is a field the host already accepts and nothing shows.
 */
export const CHOSEN_BY_YOU = 'Chosen by you'
const companionId = (experience: string | null | undefined): string | undefined => {
  const e = experienceById(experience)
  return e.id === 'classic' ? undefined : e.companionLook
}
/**
 * The seed exactly as shipped, deep-equal in every token (the old gallery stored it verbatim): not the person's own
 * choice. Any adjustment (density, motion, radius, colours, a look made from words) or the CHOSEN_BY_YOU mark makes it
 * theirs (stand-in r3 P2). The seeds' `author` was reworded once (demo D1): a look the old gallery stored verbatim
 * carries the EXACT earlier wording and is still that seed. Only that one string compares as the shipped author; any
 * other author (an edit, CHOSEN_BY_YOU) keeps the look the person's own (demo D1 r2, stand-in P2). The earlier wording
 * is kept only as its SHA-256 (UTF-8, hex), so the source never carries it (demo D1 r2.1 ruling).
 */
export const LEGACY_SEED_AUTHOR_SHA256 = 'c4abd51eca8539ce55d40cc06a27e159473d7e811fbf444f777e51478477d9ed'
const legacySeedAuthor = (author: unknown): boolean => typeof author === 'string' && author.startsWith('Surface seed (') && sha256(author) === LEGACY_SEED_AUTHOR_SHA256
const pristineSeed = (v: UiVariant): boolean => {
  const seed = SEED_VARIANTS.find((s) => s.id === v.id)
  if (!seed) return false
  const asShipped = legacySeedAuthor(v.author) ? { ...v, author: seed.author } : v
  return JSON.stringify(canonical(asShipped)) === JSON.stringify(canonical(seed))
}

/**
 * A look the person picks for themselves, to be worn in `experience`: marked as theirs when it is that experience's
 * companion seed (see CHOSEN_BY_YOU), unchanged otherwise. Every place that sets a variant beside an experience uses it.
 */
export function asOwnChoice(v: UiVariant, experience: string | null | undefined): UiVariant {
  return companionId(experience) === v.id && pristineSeed(v) ? { ...v, author: CHOSEN_BY_YOU } : v
}

/**
 * The person's own look (what the Classic hive wears). The old gallery stored an experience's companion as the
 * variant, together with that experience: only that exact write (the pristine companion seed, saved with ITS
 * experience) reads as no look of their own. The same seed saved with no experience or another one, or marked as
 * chosen, is the person's choice and is kept (stand-in r2 P2).
 */
export function ownVariant(p: UiPrefs | null): UiVariant | null {
  const v = p?.variant ?? null
  return v && companionId(p?.experience) === v.id && pristineSeed(v) ? null : v
}

/** The look on screen: the person's own, or, when they have none, the active experience's companion. */
export const wornVariant = (p: UiPrefs | null): UiVariant | null => ownVariant(p) ?? companionOf(p)

/**
 * The one way to choose an experience (Change experience, the Ask, the guided demo, Ω → Back to the Classic hive): only
 * the experience changes; the person's own look, layout and app identities are kept, so leaving restores them.
 * 'classic' and null both mean the Classic hive.
 */
/** A whole-preference write keeps the person's landing unless it sets one itself (contract R1.1 #6; pure, tested). */
export function carryLanding(next: UiPrefs, from: UiPrefs | null | undefined): UiPrefs {
  // some callers hand a null look at run time (a reset to nothing); it passes through untouched, never throws
  if (!next || next.landing !== undefined || !from?.landing) return next
  return { ...next, landing: from.landing }
}

export function withExperience(p: UiPrefs | null, id: string | null): UiPrefs {
  const own = ownVariant(p)
  return carryLanding({ variant: own && asOwnChoice(own, id), layout: p?.layout ?? null, apps: p?.apps ?? null, experience: id === 'classic' ? null : id }, p)
}

/** What "your look" is called: the experience while one is active (never its companion seed), else the look's own name. */
export const lookName = (p: UiPrefs | null): string => activeExperience(p)?.name ?? (ownVariant(p) ?? DEFAULT_VARIANT).name

export const effectiveLayout = (p: UiPrefs | null): Layout => p?.layout ?? wornVariant(p)?.layout ?? 'rail'

// ---------------------------------------------------------------- store

interface LookState {
  saved: UiPrefs | null
  preview: UiPrefs | null
  /** The server can store a look for this person (the client implements /api/me/ui). */
  available: boolean
  galleryOpen: boolean
  /** The hive has no /api/me/ui yet (an older host): looks are kept on this device only. */
  deviceOnly?: boolean
  /** The host held a look this page did not know about (a 409): the one quiet notice, with Use mine (r1m) */
  conflict?: LookConflict | null
}

const CACHE = 'omegahive.ui.look'
/**
 * The device copy and the pending-sync marker belong to one person (Review P2): on a shared browser, one person's
 * offline escape never applies to, or overwrites, someone else's look. Keys carry the signed-in principal once known.
 */
const OWNER = 'omegahive.ui.look.owner'
/**
 * Review A1: two different things. `remembered` is the last person this device verified, used only to paint their
 * look before identity is known (read-only). `owner` is the person this page has VERIFIED (me() answered); every
 * write and every replay of a pending change uses `owner`'s keys. Until identity is verified, or when it cannot be
 * (me() missing, refused or failing), `owner` is null: the device-only unbound copy is used, nothing bound to a person
 * is replayed and nothing is written to anyone's keys.
 */
const remembered: string | null = readOwner()
let owner: string | null = null
function readOwner(): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(OWNER)
  } catch {
    return null
  }
}
const keyFor = (base: string, who: string | null = owner) => (who ? `${base}:${who}` : base)
/**
 * Bind the device copy to this page's verified person; null unbinds (identity unknown) without forgetting who was
 * remembered on this device. Returns true when the binding changed.
 */
export function bindLookOwner(principal: string | null): boolean {
  if (principal === owner) return false
  owner = principal
  if (principal) {
    try {
      window.localStorage.setItem(OWNER, principal)
    } catch {
      /* remembered for this page only */
    }
  }
  return true
}
const subs = new Set<() => void>()
let state: LookState = { saved: readCache(remembered), preview: null, available: false, galleryOpen: false }

/** The look this browser last used (the simulator keeps its look here, like a person's own browser). */
export const cachedLook = (): UiPrefs | null => readCache(owner ?? remembered)

function readCache(who: string | null = owner): UiPrefs | null {
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(keyFor(CACHE, who))
    const v = raw ? (JSON.parse(raw) as UiPrefs) : null
    return v && typeof v === 'object' && 'variant' in v ? v : null
  } catch {
    return null
  }
}

function writeCache(p: UiPrefs | null, who: string | null = owner) {
  try {
    if (p) window.localStorage.setItem(keyFor(CACHE, who), JSON.stringify(p))
    else window.localStorage.removeItem(keyFor(CACHE, who))
  } catch {
    /* storage unavailable: the server copy still holds it */
  }
}

/**
 * Whether the look on screen came from something this page did or loaded (a completed load, verified or not, a keep, a
 * reset, an escape), as opposed to the first paint's remembered look before anything was loaded. Only the latter
 * survives an identity change (forgetLookOwner).
 */
let settled = false

/** A write after an await: run now, or skipped (the person changed). */
export type LookCommit = (write: () => void) => unknown
/**
 * ONE ordered save queue (stand-in r1j). Every call that reads or writes the person's stored look on the host (keep,
 * reset, escape, the offline replay and the load's read) runs one at a time, in the order it was ISSUED, so the host
 * always ends on the last one issued that it accepted. Each is issued with a number, and the page (and the device
 * copy) is updated from each call's ACTUAL host result: an accepted save is shown unless a later-issued one is already
 * shown; a refused save shows nothing and changes nothing, so an earlier accepted one still lands. The last accepted
 * wins, on the host and on the page alike. A reset or an escape is shown at once, as before (the person must never wait
 * to leave), and counts as the newest choice from the moment it is made.
 *
 * A call waiting its turn is made only if its identity is still current when the turn comes (never with the next
 * person's sign-in); and each call has a time limit, so a host that never answers cannot stall the queue.
 */
let issued = 0
let shown = 0
let queue: Promise<unknown> = Promise.resolve()
const KEEP_TIMEOUT_MS = 20000
/** A call that was never made: the person changed before its turn came. */
export class NotSent extends Error {}
/**
 * Run `call` in its turn. The time limit only stops WAITING (the queue moves on): the host may still answer later, and
 * that late answer is handed to `late` (its result, or its error), so it is reconciled rather than lost. On a host that
 * keeps revisions (below), a late write that would overwrite a newer one is refused by the host itself.
 */
function inTurn<T>(stillCurrent: () => boolean, call: () => Promise<T>, ms: number, late?: (r: { ok: true; value: T } | { ok: false; error: unknown }) => void): Promise<T> {
  const run = queue.then(() => {
    if (!stillCurrent()) return Promise.reject(new NotSent('The sign-in changed; this was not sent.'))
    const p = call()
    let timedOut = false
    const limited = withTimeout(p, ms).catch((e) => {
      if (e instanceof TimedOut) timedOut = true
      throw e
    })
    p.then(
      (value) => timedOut && late?.({ ok: true, value }),
      (error) => timedOut && late?.({ ok: false, error }),
    )
    return limited
  })
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Compare-and-set with the host (platform/ui-prefs-revision). The host keeps a revision per person: every response
 * carries `rev`, and every write here sends `X-UI-Base-Rev` with the last rev this page saw for this sign-in. A write
 * the host has moved past is refused (409 stale_ui_prefs, with `current`) and writes nothing, so no late or overlapping
 * write (one that timed out here, or one from an earlier sign-in of the same person) can put the host back on an older
 * look.
 *
 * Conflict policy (Surface lead, r1m; stand-in r1l #2): a 409 means the host holds a choice this page did not know
 * about, possibly made on another device. It is NEVER sent again automatically. If the refused choice is still the one
 * this page stands on, the page and the device copy adopt the host's `current`, and one quiet notice tells the person
 * ("Your look was changed on another device to …") with one action, Use mine, which makes their choice again, as a
 * new choice with the new rev, only when they tap it. If the person has already moved on (a newer choice of theirs is
 * standing), the refused one is simply dropped: their newer choice settles it.
 *
 * Every revision update, from any answer (late ones and 409s included), goes through the binding of the identity the
 * call was made under (stand-in r1l #1): an earlier sign-in's answer never touches the current one's revision.
 *
 * An older host sends no `rev`: no revision header is sent, and the r1k behaviour (one ordered queue) is all there is.
 */
let rev: number | null = null
let hostKeepsRevisions: boolean | null = null
/** Whether the host keeps revisions: true (compare-and-set), false (an older host: no rev seen), null (not asked yet). */
export const lookHostMode = (): 'revisions' | 'older-host' | 'unknown' => (hostKeepsRevisions === null ? 'unknown' : hostKeepsRevisions ? 'revisions' : 'older-host')
/** The last revision this page saw for this sign-in (tests and receipts; never stored). */
export const lookRevision = (): number | null => rev
/**
 * The look the host was last known (by this page, this sign-in) to hold: from every GET, accepted write and adopted
 * conflict. A 409 whose `current` look is exactly this one is not a conflict of CHOICES (nobody chose anything else: the
 * host only moved its revision on, as every hive restart does: host r4), so the refused choice is sent again once with
 * the new revision. Any other `current` is someone else's choice: adopted, with the notice, never overwritten.
 */
let hostKnown: string | undefined
/**
 * The whole look, compared DEEP-EQUAL (Surface lead ruling, r1m): every field of the prefs, the variant's colours, fonts
 * and enums included, with object keys in a canonical order, so the same look always compares equal however its JSON
 * arrived, and the same variant id with any other difference (a layout, one colour) does not.
 */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
  return v
}
const fingerprint = (p: UiPrefs | null | undefined) => JSON.stringify(canonical(p ?? null))
function noteHost(p: UiPrefs | null | undefined): void {
  hostKnown = fingerprint(p)
}
/**
 * Note the host's revision from an answer. ONLY ever called inside an identity commit (stand-in r1l #1). A 409's
 * `current` is the TRUTH (Kimi r1k): the base becomes exactly its rev, even if lower than what this page saw before (a
 * host restored from a backup rewinds). Other answers only move the base forward (a late answer can be older).
 */
function noteRev(r: unknown, truth = false): void {
  const n = r && typeof r === 'object' ? (r as { rev?: unknown }).rev : undefined
  if (typeof n === 'number' && Number.isInteger(n) && n >= 0) {
    rev = rev === null || truth ? n : Math.max(rev, n)
    hostKeepsRevisions = true
  } else if (r && typeof r === 'object' && hostKeepsRevisions === null) hostKeepsRevisions = false
}
/**
 * The host's current look from a 409 stale_ui_prefs, or null when the error is anything else. Platform's contract
 * (platform/ui-prefs-revision, 65aa421) puts `current` INSIDE the error envelope: {"error":{"code":"stale_ui_prefs",
 * "message":…,"current":{prefs,updated_at,rev}}}; a `current` beside the envelope is read too.
 */
function staleCurrent(e: unknown): UiPrefsResponse | null {
  const err = e as { status?: number; code?: string; envelope?: Record<string, unknown>; body?: unknown }
  if (!err || err.status !== 409 || err.code !== 'stale_ui_prefs') return null
  const top = err.body && typeof err.body === 'object' ? (err.body as { current?: unknown }).current : undefined
  const cur = err.envelope?.current ?? top
  return cur && typeof cur === 'object' && 'prefs' in (cur as object) ? (cur as UiPrefsResponse) : null
}

/**
 * The person's CHOICES on this page (keep, reset, escape, the offline replay), by issue number: open until the host
 * answers, then kept or failed. The choice the page STANDS ON is the newest one that has not failed: a refused newer
 * choice does not make an older one "moved on" (stand-in r1l #4).
 */
type ChoiceKind = 'keep' | 'reset' | 'escape'
const choices = new Map<number, 'open' | 'kept' | 'failed'>()
function standingChoice(): number {
  let best = 0
  for (const [n, s] of choices) if (s !== 'failed' && n > best) best = n
  return best
}
/** The one quiet notice after a conflict: the host's look, and the person's own choice that Use mine makes again. */
export interface LookConflict {
  /** the look the host holds now, by name */
  name: string
  kind: ChoiceKind
  /** the person's own look (keep or escape); null for a reset */
  mine: UiPrefs | null
}
/** A choice the host did not keep because it held a newer one (a 409). The page shows the host's; a notice says so. */
export class NotKept extends Error {}

/**
 * One choice's save, in turn and compare-and-set, with NO automatic re-send. `apply` reconciles the host's accepted
 * answer; `conflict` adopts the host's `current` (called only when this choice is still the one the page stands on).
 * Late answers (after the time limit) go through the same two paths.
 */
async function casSave(
  stillCurrent: () => boolean,
  commit: LookCommit,
  first: number,
  send: (baseRev: number | undefined) => Promise<UiPrefsResponse>,
  ms: number,
  apply: (r: UiPrefsResponse, n: number) => void,
  conflict: (cur: UiPrefsResponse, n: number) => void,
  /** the base revision for the FIRST send (the offline replay's stored base); later sends use the working revision */
  firstBase?: number,
): Promise<UiPrefsResponse> {
  let n = first
  for (let attempt = 0; ; attempt++) {
    const at = n
    choices.set(at, 'open')
    const accepted = (r: UiPrefsResponse) =>
      commit(() => {
        noteRev(r)
        noteHost(r.prefs)
        choices.set(at, 'kept')
        apply(r, at)
      })
    /** 'resend' only for a revision-only move (the host's look is the one this page knew) on the first refusal */
    const refusedStale = (cur: UiPrefsResponse, mayResend: boolean): 'resend' | 'adopted' | 'dropped' => {
      let out: 'resend' | 'adopted' | 'dropped' = 'dropped'
      commit(() => {
        noteRev(cur, true)
        const standing = standingChoice() === at
        const sameLook = hostKnown !== undefined && hostKnown === fingerprint(cur.prefs)
        choices.set(at, 'failed')
        if (standing && sameLook && mayResend) out = 'resend'
        else if (standing) {
          noteHost(cur.prefs)
          conflict(cur, at)
          out = 'adopted'
        }
      })
      return out
    }
    try {
      // the base is read when the call's TURN comes (not when it was queued): the revision the latest answer taught
      const r = await inTurn(stillCurrent, () => send(attempt === 0 && firstBase !== undefined ? firstBase : (rev ?? undefined)), ms, (late) => {
        // an answer that came after the time limit: reconciled through the same paths, never lost (never re-sent)
        if (late.ok) accepted(late.value)
        else {
          const cur = staleCurrent(late.error)
          if (cur) refusedStale(cur, false)
          else commit(() => choices.set(at, 'failed'))
        }
      })
      if (r && typeof r === 'object') accepted(r)
      return r
    } catch (e) {
      const cur = staleCurrent(e)
      if (cur) {
        if (refusedStale(cur, attempt === 0) === 'resend' && stillCurrent()) {
          // the same choice again, as a newer issue, with the host's revision: once
          n = ++issued
          continue
        }
        throw new NotKept(`Your look was changed on another device to ${lookName(cur.prefs ?? null)}.`)
      }
      // a time limit leaves the choice open (its late answer decides); any other refusal fails it
      if (!(e instanceof TimedOut)) commit(() => choices.set(at, 'failed'))
      throw e
    }
  }
}

/**
 * A new person, a new queue (shell/lookIdentity, inside the identity change): the next person's saves and loads never
 * wait behind the earlier person's (theirs went to the earlier sign-in's account, so there is no order between them to
 * keep). The earlier person's calls still in flight finish on their own and write nothing here (their binding is stale).
 */
export function restartSaveQueue(): void {
  queue = Promise.resolve()
  choices.clear()
  hostKnown = undefined
  replaying = null
  if (state.conflict) set({ conflict: null })
  // the revision this page saw, and whether the host keeps revisions, belong to the earlier sign-in; the next one reads
  // its own (loadLook's GET)
  rev = null
  hostKeepsRevisions = null
}

/** Show issue `n`'s result unless a later-issued one is already shown. Returns whether it was shown. */
function showIf(n: number, write: () => void): boolean {
  if (n <= shown) return false
  shown = n
  write()
  return true
}
/** What a Keep came to on the host and on this page (stand-in r1j: callers use `acceptedPrefs`, never a guess). */
export interface KeepResult {
  /** applied: the host accepted it and the page shows it; accepted-not-shown: accepted, but a later choice is shown */
  outcome: 'applied' | 'accepted-not-shown'
  /** the look exactly as the host accepted it */
  acceptedPrefs: UiPrefs
}

/** Whether a binding still holds now (its commit runs the write only while it does). */
const holds = (commit: LookCommit) => commit(() => true) === true
/**
 * How every async path here binds itself to the identity it started under. shell/lookIdentity installs the identity
 * epoch's bindEpoch (kept out of this module so it imports no store); until then, writes always run.
 */
let binder: () => { commit: LookCommit } = () => ({ commit: (write) => write() })
export function setLookBinder(b: () => { commit: LookCommit }): void {
  binder = b
}
const bound = (): LookCommit => binder().commit

interface LookTransition { ready?: Promise<unknown>; finished?: Promise<unknown>; updateCallbackDone?: Promise<unknown> }
/** A superseded look transition is expected; anything else still reaches the console. */
const quietSkip = (e: unknown) => {
  if ((e as { name?: string } | null)?.name !== 'AbortError') console.error(e)
}

function set(patch: Partial<LookState>) {
  if ('saved' in patch) settled = true
  const before = typeof document === 'undefined' ? null : document.documentElement.dataset.uiVariant
  state = { ...state, ...patch }
  const next = state.preview ?? state.saved, nextId = wornVariant(next)?.id ?? 'default'
  // a change of look cross-fades (View Transitions), unless motion is reduced or the browser can't
  const vt = typeof document !== 'undefined' ? (document as Document & { startViewTransition?: (cb: () => void) => LookTransition | undefined }).startViewTransition : undefined
  const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  if (vt && !calm && before && before !== nextId) {
    // each transition applies the look as it is when it runs, so a quick second change never lands under a stale one
    const t = vt.call(document, () => applyLook(state.preview ?? state.saved))
    // a second change before the first finishes skips the first, whose promises then reject with AbortError: that is
    // the browser keeping up with the person, not a failure, so it is observed here and never left unhandled
    for (const pr of [t?.ready, t?.finished, t?.updateCallbackDone]) pr?.catch(quietSkip)
  } else applyLook(next)
  subs.forEach((f) => f())
}

export const lookState = () => state

/** Called after every change of the look state (what useLook redraws on). Returns an unsubscribe. */
export function subscribeLook(cb: () => void): () => void {
  subs.add(cb)
  return () => {
    subs.delete(cb)
  }
}

export function useLook(): LookState & { current: UiPrefs | null; worn: UiVariant | null; layout: Layout; motion: UiVariant['motion'] } {
  const s = useSyncExternalStore(subscribeLook, () => state, () => state)
  const current = s.preview ?? s.saved
  const worn = wornVariant(current)
  return { ...s, current, worn, layout: effectiveLayout(current), motion: worn?.motion ?? 'lively' }
}

export const openGallery = (open = true) => set({ galleryOpen: open })
export const previewLook = (p: UiPrefs | null) => set({ preview: p })

interface PrefsClient {
  uiPrefs?(): Promise<UiPrefsResponse>
  setUiPrefs?(p: UiPrefs, opts?: UiPrefsWriteOptions): Promise<UiPrefsResponse>
  resetUiPrefs?(opts?: UiPrefsWriteOptions): Promise<UiPrefsResponse>
  me?(): Promise<{ principal: string }>
}

/**
 * Load the person's saved look once signed in. `?ui=default` resets it: the escape that works whatever is applied.
 * Every write after an await goes through `commit` (optional): pass an identity-epoch binding's commit
 * (shell/lookIdentity loadLookBound) and a load that finishes after a sign-in change applies, writes and replays
 * nothing on this page, so a late load of A's look never shows (or is pushed) under B.
 */
export async function loadLook(client: PrefsClient | null, commit: LookCommit = bound()): Promise<void> {
  /** still the identity this load started under (checked in the same tick as what follows it) */
  const live = () => holds(commit)
  const available = !!client?.uiPrefs && !!client.setUiPrefs && !!client.resetUiPrefs
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('ui') === 'default') {
    await resetLook(client, commit)
    commit(() => set({ available }))
    return
  }
  /** this load's result (issue `n`), shown unless a later-issued save is already shown; `available` always */
  const apply = (n: number, patch: Partial<LookState>, also?: () => void) =>
    commit(() => {
      if (!showIf(n, () => (also?.(), set({ available, ...patch })))) set({ available })
    })
  if (!available || !client?.uiPrefs) {
    set({ available: false, saved: null, preview: null })
    writeCache(null)
    return
  }
  try {
    // Whose look is this? Only a verified principal binds the device copy (Review A1). A missing, refused or failing
    // identity lookup leaves this page unbound: it shows the server's own prefs for this session and pushes nothing.
    const who = client.me ? await withTimeout(client.me(), SAVE_TIMEOUT_MS).then((m) => (typeof m?.principal === 'string' && m.principal ? m.principal : null)).catch(() => null) : null
    if (!live()) return
    if (bindLookOwner(who)) set({ saved: who ? readCache() : state.saved, preview: null })
    // whose keys the writes after the next awaits belong to (never whoever is bound by the time they land)
    const mine = owner
    if (!who) {
      // An escape made on this device while unbound still holds here (applied locally, never sent anywhere).
      if (isPending()) {
        apply(++issued, { saved: readCache(), deviceOnly: false })
        return
      }
      const n = ++issued
      const read = client.uiPrefs.bind(client)
      const r = await inTurn(live, () => read(), SAVE_TIMEOUT_MS)
      commit(() => (noteRev(r), noteHost(r.prefs)))
      apply(n, { saved: r.prefs, deviceOnly: false })
      return
    }
    // A change this verified person made on this device that never reached the server (an escape or reset while
    // offline): the offline replay (stand-in r1l #3). The marker, the copy and the base revision are read from this
    // person's own keys, so only they are replayed. The host is READ first, in turn: if it is still at the revision the
    // offline choice was based on, the choice is sent conditionally (through the same compare-and-set, late-result and
    // reconciliation path as every save); if the host moved on while this device was offline, the page adopts the host's
    // look and the same notice offers Use mine for the offline choice. An older host (no revisions) gets the r1k replay.
    // one replay at a time: a second load (App's own and the identity hook's can overlap) waits for it, then reads
    if (replaying) {
      await replaying.catch(() => undefined)
      if (!live()) return
    }
    if (isPending() && client.setUiPrefs) {
      let done: () => void = () => undefined
      replaying = new Promise<void>((r) => (done = r))
      try {
        await replayOffline(client as Parameters<typeof replayOffline>[0], live, commit, mine, available)
      } finally {
        done()
        replaying = null
      }
      return
    }
    const n = ++issued
    const read = client.uiPrefs.bind(client)
    const r = await inTurn(live, () => read(), SAVE_TIMEOUT_MS)
    commit(() => (noteRev(r), noteHost(r.prefs)))
    apply(n, { saved: r.prefs, deviceOnly: false }, () => writeCache(r.prefs, mine))
  } catch (e) {
    if ((e as { status?: number })?.status === 404) {
      // older host: choose freely, kept on this device
      const n = ++issued
      commit(() => {
        if (!showIf(n, () => set({ available: true, deviceOnly: true, saved: readCache(owner) }))) set({ available: true, deviceOnly: true })
      })
      return
    }
    commit(() => set({ available })) // keep the cached look; the next save will reconcile
  }
}

/** The offline replay currently running (one at a time: a second load waits for it). */
let replaying: Promise<void> | null = null

/**
 * A change this verified person made on this device that never reached the server (an escape or reset while offline):
 * the offline replay (stand-in r1l #3). The marker, the copy and the base revision are read from this person's own
 * keys, so only they are replayed. The host is READ first, in turn: if it is still at the revision the offline choice was
 * based on, the choice is sent conditionally (through the same compare-and-set, late-result and reconciliation path as
 * every save); if the host moved on while this device was offline, the page adopts the host's look and the same notice
 * offers Use mine for the offline choice. An older host (no revisions) gets the r1k replay.
 */
async function replayOffline(client: PrefsClient & { uiPrefs: NonNullable<PrefsClient['uiPrefs']> }, live: () => boolean, commit: LookCommit, mine: string | null, available: boolean): Promise<void> {
  const local = readCache()
  const base = offlineBase()
  const c = client
  const kind: ChoiceKind = local ? 'escape' : 'reset'
  const notice = (cur: UiPrefsResponse): LookConflict => ({ name: lookName(cur.prefs ?? null), kind: kind === 'escape' ? 'keep' : 'reset', mine: local })
  // The replay is a choice like any other (stand-in r1m): its place in the order is reserved BEFORE the host is read, so
  // a Keep, reset or escape made while the read is on its way is NEWER than it, and wins.
  const n = ++issued
  choices.set(n, 'open')
  const read = client.uiPrefs.bind(client)
  let g: UiPrefsResponse
  try {
    g = await inTurn(live, () => read(), SAVE_TIMEOUT_MS)
  } catch (e) {
    commit(() => choices.set(n, 'failed'))
    throw e
  }
  commit(() => (noteRev(g), noteHost(g.prefs)))
  if (!live()) return
  // RULE (Surface lead, r1o): a newer choice by the same person supersedes an unsent offline choice. A choice made while
  // the host was read is what the person did LAST, so the replay is discarded: it writes nothing and adopts nothing, and
  // offers nothing back. The newer choice settles the look; if the host refuses it, the conflict notice offers THAT choice
  // (Use mine), never the superseded offline one. The pending flag is left as it is here: only the newer choice's own
  // answer, or an adoption, clears it. A look the person KEPT among their looks is never touched by any of this (Your
  // looks live in their own store), so an offline choice that was one of them is still there.
  let superseded = false
  commit(() => {
    set({ available })
    if (standingChoice() !== n) {
      superseded = true
      choices.set(n, 'failed')
    }
  })
  if (superseded || !live()) return
  if (typeof g?.rev !== 'number') {
    // an older host: the r1k replay, in turn and unconditional (the only option without revisions)
    const push = () => (local && c.setUiPrefs ? c.setUiPrefs(local) : c.resetUiPrefs ? c.resetUiPrefs() : Promise.reject(new Error('cannot reset')))
    await inTurn(live, push, SAVE_TIMEOUT_MS)
      .then(() =>
        commit(() => {
          choices.set(n, 'kept')
          showIf(n, () => (markPending(false, mine), set({ saved: local })))
        }),
      )
      .catch(() => commit(() => choices.set(n, 'failed')))
    return
  }
  if (base === null || g.rev !== base) {
    // the host changed while this device was offline (or the base is unknown): the host's look, and the notice
    commit(() => {
      choices.set(n, 'failed')
      adoptConflict(n, g, mine, notice(g))
    })
    return
  }
  // still at the base: the offline choice is sent conditionally with its STORED base (not the working revision)
  await casSave(
    live,
    commit,
    n,
    (baseRev) => (local && c.setUiPrefs ? c.setUiPrefs(local, baseRev === undefined ? undefined : { baseRev }) : c.resetUiPrefs!(baseRev === undefined ? undefined : { baseRev })),
    SAVE_TIMEOUT_MS,
    (r, at) => showIf(at, () => (writeCache(r.prefs, mine), markPending(false, mine), set({ saved: r.prefs }))),
    (cur, at) => adoptConflict(at, cur, mine, notice(cur)),
    base,
  ).catch(() => undefined)
}

/**
 * An identity change, inside the change itself (shell/lookIdentity). Anything not proven to belong to the new person
 * leaves the screen at once: a verified person's look, AND a look from a completed load that bound nobody (me()
 * missing, refused or failing: the server's prefs were still the earlier sign-in's), a keep, a reset or an escape.
 * The page unbinds (nothing more is written to anyone's keys) and shows the standard look until the new person's
 * own look loads. Only the first paint's remembered look, before anything was loaded, is left as it is. Returns true
 * when it reset.
 */
export function forgetLookOwner(): boolean {
  if (!owner && !settled) return false
  owner = null
  set({ saved: null, preview: null, deviceOnly: false })
  settled = false
  return true
}

/**
 * Keep a look: saved on the server first, so a refused variant never looks applied. The page's writes after the save
 * go through `commit` (optional): pass an identity-epoch binding's commit (lib/identityEpoch bindEpoch, or
 * shell/keepBound) and nothing is written on this page when the person changed while the save was on its way.
 */
export async function keepLook(client: PrefsClient | null, p: UiPrefs, commit: LookCommit = bound()): Promise<KeepResult> {
  p = carryLanding(p, state.saved)
  const n = ++issued
  if (state.deviceOnly) {
    showIf(n, () => {
      writeCache(p)
      markPending(false)
      set({ saved: p, preview: null })
    })
    return { outcome: 'applied', acceptedPrefs: p }
  }
  if (!client?.setUiPrefs) throw new Error('This hive cannot store a look yet')
  const who = owner
  const save = client.setUiPrefs.bind(client)
  let applied = false
  // its turn in the one ordered queue, compare-and-set with the host's revision; made only if the identity it was
  // pressed under is still current then
  const r = await casSave(
    () => holds(commit),
    commit,
    n,
    (baseRev) => save(p, baseRev === undefined ? undefined : { baseRev }),
    KEEP_TIMEOUT_MS,
    (res, at) => {
      // the host accepted it: shown unless a later-issued choice is already on the page; the device copy and the
      // pending flag follow only what is shown (the host now confirms it)
      if (!res.prefs) return
      const accepted = res.prefs
      applied = showIf(at, () => {
        writeCache(accepted, who)
        markPending(false, who)
        set({ saved: accepted, preview: null })
      }) || applied
    },
    (cur, at) => adoptConflict(at, cur, who, { name: lookName(cur.prefs ?? null), kind: 'keep', mine: p }),
  )
  // an answer that keeps nothing (no look echoed back, e.g. a host that answers {ok:false} without an error) is a
  // refusal, said as one, never shown as kept (Kimi r1h P3)
  if (!r || typeof r !== 'object' || !r.prefs) throw new Error('This hive didn’t keep the look; nothing changed.')
  return { outcome: applied ? 'applied' : 'accepted-not-shown', acceptedPrefs: r.prefs }
}

/**
 * The page adopts the host's look after a conflict on the choice it stands on, unless a NEWER choice is already shown
 * (then nothing here is written, cleared or said): shown now (no earlier answer can take it
 * back), written to the device copy, the pending flag cleared (the page now shows what the host holds), and the one
 * quiet notice raised. An escape keeps the classic hive on the page (leaving an experience must never be undone) and
 * stays pending, with the host's revision as its base, so it syncs on the next load if the host has not moved again.
 */
function adoptConflict(n: number, cur: UiPrefsResponse, who: string | null, notice: LookConflict): void {
  // every path's guard (stand-in r1m): a newer choice on the page wins; nothing of this one is written or cleared
  if (n < shown) return
  shown = Math.max(shown, n)
  if (notice.kind === 'escape') {
    // the host's prefs, out of any experience: an old companion write never lands in Classic (stand-in r2 P2)
    const next: UiPrefs | null = cur.prefs ? withExperience(cur.prefs, null) : null
    writeCache(next, who)
    markPending(true, who, typeof cur.rev === 'number' ? cur.rev : null)
    set({ saved: next, preview: null, conflict: notice })
    return
  }
  writeCache(cur.prefs, who)
  markPending(false, who)
  set({ saved: cur.prefs, preview: null, conflict: notice })
}

/** Close the conflict notice without acting. */
export const dismissConflict = () => set({ conflict: null })

/**
 * Use mine (chooseMineAgain): the person's own choice from the conflict notice, made again as a NEW choice (with the revision the
 * conflict taught this page), only because they tapped it. If the host has moved on again, the same notice comes back.
 */
export async function chooseMineAgain(client: PrefsClient | null): Promise<void> {
  const c = state.conflict
  if (!c) return
  set({ conflict: null })
  try {
    if (c.kind === 'keep' && c.mine) await keepLook(client, c.mine)
    else if (c.kind === 'escape') await escapeToClassic(client)
    else await resetLook(client)
  } catch {
    /* a refusal is said where it belongs (a new notice, or the caller's own words) */
  }
}

const PENDING = 'omegahive.ui.look.pending'
const SAVE_TIMEOUT_MS = 8000

/**
 * The pending flag: a choice shown on this device that the host has not confirmed (an escape or reset while offline).
 * With it, the revision that choice was based on (the last one seen before going offline: stand-in r1l #3), so the
 * offline replay can be sent conditionally. Stored beside the flag, cleared with it. It is NOT the page's working
 * revision, which is never stored (it always comes from the latest host answer).
 */
const OFFLINE_BASE = 'omegahive.ui.look.offlinebase'
function markPending(on: boolean, who: string | null = owner, base: number | null = rev) {
  try {
    if (on) {
      window.localStorage.setItem(keyFor(PENDING, who), '1')
      if (base === null) window.localStorage.removeItem(keyFor(OFFLINE_BASE, who))
      else window.localStorage.setItem(keyFor(OFFLINE_BASE, who), String(base))
    } else {
      window.localStorage.removeItem(keyFor(PENDING, who))
      window.localStorage.removeItem(keyFor(OFFLINE_BASE, who))
    }
  } catch {
    /* storage unavailable */
  }
}
/** The revision the pending offline choice was based on, or null (unknown, or an older host). */
function offlineBase(who: string | null = owner): number | null {
  try {
    const v = window.localStorage.getItem(keyFor(OFFLINE_BASE, who))
    return v !== null && /^\d{1,15}$/.test(v) ? Number(v) : null
  } catch {
    return null
  }
}
const isPending = () => {
  try {
    return window.localStorage.getItem(keyFor(PENDING)) === '1'
  } catch {
    return false
  }
}

/** The time limit ran out: we stopped waiting (the host may still answer). */
class TimedOut extends Error {}
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new TimedOut('timed out')), ms)
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)))
  })
}

/**
 * Leave any experience for the classic hive NOW, whatever the network does (Review R1). The change is local and
 * immediate; saving it to the server happens afterwards. If that save is refused, fails or hangs, the device keeps
 * the classic hive and the change is marked to sync on the next load, so a reload never drops the person back in.
 * Resolves to 'saved' or 'local' (applied on this device only).
 */
export async function escapeToClassic(client: PrefsClient | null, timeoutMs = SAVE_TIMEOUT_MS, commit: LookCommit = bound()): Promise<'saved' | 'local' | 'stale'> {
  const n = ++issued
  const who = owner
  const cur = state.preview ?? state.saved
  // the person's own Classic look comes back, never the experience's companion (small things F1)
  const next = withExperience(cur, null)
  // shown at once, as the newest choice (issue n): an earlier save answering later never takes it back
  showIf(n, () => {
    writeCache(next)
    markPending(true)
    set({ saved: next, preview: null, galleryOpen: false })
  })
  if (state.deviceOnly) {
    markPending(false)
    return 'saved'
  }
  if (!client?.setUiPrefs) return 'local'
  try {
    const save = client.setUiPrefs.bind(client)
    await casSave(
      () => holds(commit),
      commit,
      n,
      (baseRev) => save(next, baseRev === undefined ? undefined : { baseRev }),
      timeoutMs,
      // the host confirms what is shown only while this escape IS what is shown (stand-in r1l #4)
      (_r, at) => {
        // a re-send after a revision-only move is a newer issue: it re-shows the same choice
        if (at !== n) showIf(at, () => set({ saved: next }))
        if (shown === at) markPending(false, who)
      },
      (c, at) => adoptConflict(at, c, who, { name: lookName(c.prefs ?? null), kind: 'escape', mine: next }),
    )
    // once the person changed, the answer is not theirs to hear: 'stale', and the caller says nothing
    return holds(commit) ? 'saved' : 'stale'
  } catch {
    // a refusal (or a conflict, shown as a notice) keeps the classic hive here, pending, to sync later
    return holds(commit) ? 'local' : 'stale'
  }
}

/**
 * Back to the standard look, now; the server is told afterwards. The pending marker set here belongs to the person
 * resetting, and the one write after the await (clearing it) goes through `commit` and that person's own key, so a
 * late answer never touches the next person's marker.
 */
export async function resetLook(client: PrefsClient | null, commit: LookCommit = bound()): Promise<'done' | 'conflict' | 'stale'> {
  const n = ++issued
  const who = owner
  // shown at once, as the newest choice (issue n): an earlier save answering later never takes it back
  showIf(n, () => {
    writeCache(null, who)
    markPending(true, who)
    set({ saved: null, preview: null })
  })
  let conflict = false
  if (client?.resetUiPrefs) {
    const reset = client.resetUiPrefs.bind(client)
    await casSave(
      () => holds(commit),
      commit,
      n,
      (baseRev) => reset(baseRev === undefined ? undefined : { baseRev }),
      SAVE_TIMEOUT_MS,
      // the host confirms what is shown only while this reset IS what is shown (stand-in r1l #4)
      (_r, at) => {
        if (at !== n) showIf(at, () => set({ saved: null }))
        if (shown === at) markPending(false, who)
      },
      (c, at) => adoptConflict(at, c, who, { name: lookName(c.prefs ?? null), kind: 'reset', mine: null }),
    ).catch((e) => {
      // a conflict: the page shows the host's look and the notice; any other failure keeps the flag (local)
      if (e instanceof NotKept) conflict = true
    })
  }
  // 'stale': the person changed while the server was told; their caller says nothing to the next person
  return !holds(commit) ? 'stale' : conflict ? 'conflict' : 'done'
}

// ---------------------------------------------------------------- applying a look to the document

const RADIUS: Record<UiVariant['radius'], Record<string, string> | null> = {
  soft: null,
  square: { '--radius-sm': '0px', '--radius-md': '0px', '--radius-lg': '1px', '--radius-xl': '2px', '--radius-2xl': '2px', '--radius-3xl': '3px' },
  round: { '--radius-lg': '0.75rem', '--radius-xl': '1rem', '--radius-2xl': '1.375rem', '--radius-3xl': '2rem' },
  pill: { '--radius-md': '0.75rem', '--radius-lg': '1rem', '--radius-xl': '1.25rem', '--radius-2xl': '1.75rem', '--radius-3xl': '2.5rem' },
}

/** Every custom property a look may set, so switching back removes all of them. */
const OWNED = [
  ...COLOR_KEYS.map((k) => `--color-${k}`),
  '--font-display', '--font-sans', '--font-mono',
  '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-2xl', '--radius-3xl',
  '--look-page-a', '--look-page-b', '--look-strong', '--look-orb-mid', '--look-orb-end', '--look-orb-ink', '--look-orb-glow',
  '--look-selection', '--look-glow', '--look-card', '--look-panel',
]

/** Mix a #rrggbb colour with alpha, for surfaces derived from the palette. */
const alpha = (hex: string, a: number) => `rgb(${parseInt(hex.slice(1, 3), 16)} ${parseInt(hex.slice(3, 5), 16)} ${parseInt(hex.slice(5, 7), 16)} / ${a})`

export function lookVars(v: UiVariant): Record<string, string> {
  const c = checkLook(v.colors).colors as UiVariant['colors']   // the colours as the theme's rules allow them (repaired if they fell short)
  const out: Record<string, string> = {}
  for (const k of COLOR_KEYS) out[`--color-${k}`] = c[k]
  for (const [slot, f] of [['display', v.fonts?.display], ['sans', v.fonts?.sans], ['mono', v.fonts?.mono]] as const) {
    const font = safeFont(f)
    if (font) out[`--font-${slot}`] = font                       // a font string that isn't a plain stack is left out, not applied
  }
  Object.assign(out, RADIUS[v.radius] ?? {})
  out['--look-page-a'] = alpha(c.abyss, 0.9)
  out['--look-page-b'] = alpha(c.void, 0.94)
  out['--look-strong'] = alpha(c.abyss, 0.95)
  out['--look-orb-mid'] = c['primary-top']
  out['--look-orb-end'] = c.accent
  out['--look-orb-ink'] = c['primary-ink']
  out['--look-orb-glow'] = alpha(c.accent, 0.85)
  out['--look-selection'] = alpha(c.accent, 0.4)
  out['--look-glow'] = alpha(c.accent, 0.45)
  out['--look-card'] = c.abyss
  out['--look-panel'] = alpha(c.abyss, 0.72)
  return out
}

export function applyLook(p: UiPrefs | null): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const k of OWNED) root.style.removeProperty(k)
  // only a variant of the schema this host understands is applied (Kimi): an unknown version falls back to the standard look
  const w = wornVariant(p)
  const v = w && w.schema === 'omegasurface.variant/0.1' && !blockedReason(w) ? w : null
  if (v) for (const [k, val] of Object.entries(lookVars(v))) root.style.setProperty(k, val)
  root.dataset.uiLayout = effectiveLayout(p)
  root.dataset.uiVariant = v?.id ?? 'default'
  root.style.colorScheme = v?.scheme ?? 'dark'                                   // native controls, scrollbars and form fields follow the look
  root.dataset.uiScheme = v?.scheme ?? 'dark'
  if (v) root.dataset.uiMotion = v.motion
  else delete root.dataset.uiMotion
  // text size through the type scale only; the root rem (and so every spacing and hit target) stays as it is
  const scaled = v ? densityVars(v.density) : {}
  root.style.removeProperty('--text-scale')
  for (const [k, val] of Object.entries(scaled)) root.style.setProperty(k, val)
  if (v && scaled['--text-scale']) root.dataset.uiDensity = v.density
  else delete root.dataset.uiDensity
  // the scene gets the same colours as the page: repaired where the theme's rules repaired them
  const c = v ? checkLook(v.colors).colors : null
  setSceneBackdrop(c ? [c.abyss, c.abyss, c.void] : null)
  setSceneInk(c ? { ink: c.ink, ink2: c['ink-2'], bad: c.bad } : null)   // names drawn into the scene follow the look's ink
}

applyLook(state.saved)
