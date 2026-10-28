/**
 * "Request an experience", step 1: the request in progress and the person's own looks.
 *
 * - The request (the words, what they made, the preview) lives on this page only. An identity change drops it inside
 *   the change itself (lib/identityEpoch onIdentityChange), and drops its preview from the screen, so one person's
 *   unsaved look never shows to, or is kept by, the next.
 * - "My looks" are kept per person on this device, under the principal the page has bound (store/ask `bound`: reset
 *   synchronously on every identity change and re-bound from me()). Nobody known: they last for this page and this
 *   sign-in only, and go with it.
 * - When this device cannot save them (storage missing, unreadable, full or throwing: stand-in r1o P1), nothing is lost
 *   silently: the person's looks are held for this session (`unsaved`, marked "Not saved on this device"), addMyLook
 *   says it did not persist, and a Keep says so honestly instead of "It's in Your looks". INVARIANT: nothing in the look
 *   store (host adoption, a conflict, Use mine, a replay) touches these looks; only the person (Remove), a later
 *   successful save, or an identity change does.
 * - Keep saves the look as the person's look through the existing path (uiVariant keepLook: the host checks it first),
 *   then adds it to their looks, only if the same person is still signed in (bindEpoch().commit).
 */
import { useSyncExternalStore } from 'react'
import { bindEpoch, onIdentityChange } from '../../lib/identityEpoch'
import { useAskStore } from '../../store/ask'
import { DEFAULT_VARIANT, keepLook, lookState, NotKept, previewLook, SEED_VARIANTS, type KeepResult, type Layout, type UiPrefs, type UiVariant } from '../../shell/uiVariant'
import { EXPERIENCES } from '../../experiences/registry'
import { buildLook, describeLook, settleLooks, type Described } from './describe'

export interface MyLook {
  variant: UiVariant
  layout: Layout | null
  /** the words it was made from */
  words: string
  /** shown as New until the person opens it from the gallery */
  isNew: boolean
  /** this device could not save it: listed for this session only (never written to storage) */
  unsaved?: boolean
}

export interface RequestState {
  open: boolean
  words: string
  /** what the last words made (null before the first try) */
  result: Described | null
  /** the look on screen from these words, and what was on screen before (Undo restores it) */
  previewing: { prefs: UiPrefs; before: UiPrefs | null } | null
  /** the name of the look just kept, for the confirmation line */
  kept: string | null
  /**
   * Whether the look just kept is the one ON SCREEN (Kimi r1j #2). False when the host accepted it but a newer choice
   * (a later save) is showing: the confirmation then says so, rather than "kept" as if it were on screen.
   */
  keptShown: boolean
  /**
   * the id of the look just kept: the panel asks the store where it is NOW (lookStatus), never a flag captured at the
   * Keep (stand-in r1p P2), so the line changes by itself once a held look is saved
   */
  keptId: string | null
  error: string | null
  busy: boolean
  /** this request (a new one on every open, keep and identity change): a late finish only touches its own */
  id: number
  /** the preview on screen when the panel OPENED: what Undo puts back (null: no preview, the saved look shows) */
  base: UiPrefs | null
  /**
   * The EFFECTIVE look when the panel opened (preview ?? saved, resolved then), which every try is built from (stand-in
   * r1h P5): a gallery Keep or a late load of the saved look after opening does not move it.
   */
  from: UiPrefs | null
}

const KEY = 'omegahive.ui.mylooks.v1'
const MAX = 24
const EMPTY: RequestState = { open: false, words: '', result: null, previewing: null, kept: null, error: null, busy: false, id: 0, base: null, from: null, keptShown: false, keptId: null }
let seq = 0

/** A fresh request, open on the look on screen now (its Undo target and its effective base, both resolved now). */
const opened = (patch: Partial<RequestState> = {}): RequestState => ({ ...EMPTY, open: true, id: ++seq, base: lookState().preview, from: lookState().preview ?? lookState().saved, ...patch })

/**
 * The request's own binding (stand-in r1h P4: one helper, like lib/identityEpoch bindEpoch, so no write after an await
 * is guarded line by line). Taken before the await; `commit(write)` runs the write only while BOTH the identity and
 * THIS request (its id) are still current, in the same tick as the write. A request is replaced on every open, close,
 * keep and identity change, so a late answer never clears, sets or replaces another request's state.
 */
export function bindRequest() {
  const identity = bindEpoch()
  const id = req.id
  const current = () => identity.current() && req.id === id
  return { id, identity, current, commit: <R>(write: () => R): R | undefined => (current() ? write() : undefined) }
}

let req: RequestState = EMPTY
/** an unknown person's looks: this page and this sign-in only */
let pageOnly: MyLook[] = []
let version = 0
const subs = new Set<() => void>()
const emit = () => {
  version++
  subs.forEach((f) => f())
}
const setReq = (p: Partial<RequestState>) => {
  req = { ...req, ...p }
  emit()
}

/** Whose looks these are: the principal the page has bound, or null when nobody is known. */
export function whoNow(): string | null {
  const p = useAskStore.getState().bound?.principal
  return p && p !== 'unknown' ? p : null
}

/**
 * Every person's looks as stored on this device, or null when they cannot be read (no storage, a read that throws, or
 * a value that is not a record). Null is never treated as "none": writing over an unreadable store would erase other
 * people's looks, so a write after a failed read does not happen (writeMine).
 */
function readAll(): Record<string, MyLook[]> | null {
  try {
    const store = globalThis.localStorage
    if (!store) return null
    const raw = store.getItem(KEY)
    if (raw === null || raw === undefined) return {}
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, MyLook[]>) : null
  } catch {
    return null
  }
}
const valid = (l: MyLook) => !!l && typeof l === 'object' && !!l.variant && typeof l.variant.id === 'string' && l.variant.schema === 'omegasurface.variant/0.1'

/**
 * This session's changes to a known person's looks that this device has NOT saved yet (stand-in r1o P1, r1p): the
 * list as the person last saw it (`list`, newest first) and the looks they explicitly Removed (`removed`, tombstones).
 * Present only while a save has failed; a successful save applies it and drops it; an identity change drops it.
 * Nothing in the look store (shell/uiVariant: adoption, conflicts, Use mine, the replay) reaches it.
 */
interface Held {
  list: MyLook[]
  removed: Set<string>
}
const held = new Map<string, Held>()

const strip = ({ unsaved: _unsaved, ...l }: MyLook): MyLook => l
const storedOf = (all: Record<string, MyLook[]> | null, who: string): MyLook[] | null => {
  if (!all) return null
  const list = all[who]
  return Array.isArray(list) ? list.filter(valid) : []
}

/**
 * ONE model for every read and save (stand-in r1p): what is stored now (when readable), merged with what this session
 * holds, with this session's Removes applied as tombstones. The held list keeps its order; a stored look the session
 * does not hold (stored meanwhile, or unreadable when the session last looked) is never dropped: it follows it. Nothing
 * is ever truncated here (the cap refuses a new Keep instead: addMyLook).
 */
function merged(who: string, stored: MyLook[] | null): MyLook[] {
  const h = held.get(who)
  if (!h) return stored ?? []
  const ids = new Set(h.list.map((l) => l.variant.id))
  const rest = (stored ?? []).filter((l) => !ids.has(l.variant.id) && !h.removed.has(l.variant.id))
  return [...h.list.filter((l) => !h.removed.has(l.variant.id)), ...rest]
}

/** This person's looks (newest first); a look this device does not have is marked `unsaved`. */
export function myLooks(who: string | null = whoNow()): MyLook[] {
  if (!who) return pageOnly
  const stored = storedOf(readAll(), who)
  const onDevice = new Set((stored ?? []).map((l) => l.variant.id))
  return merged(who, stored).map((l) => (onDevice.has(l.variant.id) ? strip(l) : { ...strip(l), unsaved: true }))
}

/** Where a look of this person's is: saved on this device, held for this session only, or not among their looks. */
export type LookStatus = 'saved' | 'held' | 'absent'
export function lookStatus(id: string, who: string | null = whoNow()): LookStatus {
  const l = myLooks(who).find((x) => x.variant.id === id)
  return !l ? 'absent' : l.unsaved ? 'held' : 'saved'
}
export const isSaved = (id: string, who: string | null = whoNow()) => lookStatus(id, who) === 'saved'

/**
 * Save this person's looks as `list` (this session's view after one change; `removed`: an explicit Remove), MERGED with
 * what is stored now; true only when written. A failed read writes nothing (writing over an unreadable store would
 * erase other people's looks); a failed write holds the change for this session.
 */
function writeMine(who: string | null, list: MyLook[], removed?: string): boolean {
  if (!who) {
    // nobody known: this page and this sign-in only, by design; never saved on the device, and marked so
    pageOnly = list.filter((l) => l.variant.id !== removed).map((l) => ({ ...strip(l), unsaved: true }))
    return false
  }
  const h: Held = held.get(who) ?? { list: [], removed: new Set() }
  const next: Held = { list: list.map(strip), removed: new Set(h.removed) }
  for (const l of next.list) next.removed.delete(l.variant.id) // kept again: no longer removed
  if (removed) next.removed.add(removed)
  held.set(who, next)
  const all = readAll()
  if (!all) return false
  try {
    globalThis.localStorage!.setItem(KEY, JSON.stringify({ ...all, [who]: merged(who, storedOf(all, who)).map(strip) }))
    held.delete(who)
    return true
  } catch {
    return false // full (QuotaExceeded) or refused: held for this session
  }
}

/** The most looks a person keeps; at the cap a new Keep is REFUSED (said), never made by discarding one. */
export const MAX_LOOKS = MAX
export const FULL_LINE = `Your looks is full (${MAX}). Remove one to keep this.`
/** Whether a look with this id would be refused as one too many (an id already among the looks replaces itself). */
export function looksFull(id: string, who: string | null = whoNow()): boolean {
  const list = myLooks(who)
  return list.length >= MAX && !list.some((l) => l.variant.id === id)
}

/** What adding a look came to: saved on this device, held for this session only, or refused because the looks are full. */
export type AddResult = 'saved' | 'held' | 'full'
export function addMyLook(who: string | null, look: MyLook): AddResult {
  if (looksFull(look.variant.id, who)) return 'full'
  const saved = writeMine(who, [look, ...myLooks(who).filter((l) => l.variant.id !== look.variant.id)])
  emit()
  return saved ? 'saved' : 'held'
}

/**
 * What a Keep says (the panel, derived from the store each time it is drawn, so it changes by itself once a held look
 * is saved: stand-in r1p P2; the preview bar, at the moment of the Keep). `status`: lookStatus of the kept look.
 */
export const NOT_SAVED_LINE = 'This device couldn’t save it, so it will be gone from Your looks after you close the hive or sign out.'
export function keptLine(name: string, shown: boolean, status: LookStatus): string {
  const newer = shown ? '' : ' A newer choice is on screen now.'
  if (status === 'held') return `Kept ${name} for now. ${NOT_SAVED_LINE}${newer}`
  if (status === 'absent') return `Kept ${name} as your look. It isn’t in Your looks.${newer}`
  return shown ? `Kept as ${name}. It’s in Your looks, below.` : `Kept ${name} in Your looks, below. A newer choice is on screen now.`
}
export function removeMyLook(id: string): void {
  writeMine(whoNow(), myLooks().filter((l) => l.variant.id !== id), id)
  emit()
}
/** Opened from the gallery: no longer New. */
export function markSeen(id: string): void {
  const list = myLooks()
  if (!list.some((l) => l.variant.id === id && l.isNew)) return
  writeMine(whoNow(), list.map((l) => (l.variant.id === id ? { ...l, isNew: false } : l)))
  emit()
}

// ---------------------------------------------------------------- the request

export const requestState = () => req

export function openRequest(open = true): void {
  if (!open) dropPreview()
  setReq(open ? opened() : { ...EMPTY, id: ++seq })
}
export const setWords = (words: string) => setReq({ words, error: null })

/** What is on screen now (the gallery's own preview included). */
const onScreen = (): UiPrefs | null => lookState().preview ?? lookState().saved

/** Read the words and, when they make a look, preview it at once (Undo puts back what was there). */
export function tryWords(words: string = req.words): Described {
  const read = describeLook(words, { minds: [], swarms: [], pending: 0, experiences: EXPERIENCES.map((e) => ({ id: e.id, name: e.name })), looks: SEED_VARIANTS.map((v) => ({ id: v.id, name: v.name })) })
  // every try starts from the effective look when the panel opened (stand-in r1h P5): never a later gallery preview,
  // Keep or saved-look load, nor the previous try; asked without the panel, from what is on screen now
  const before = req.open ? req.base : lookState().preview
  const from = req.open ? req.from : onScreen()
  // what cannot be applied here as asked is said, not drifted (Kimi K3)
  const d = settleLooks(from, read, DEFAULT_VARIANT, SEED_VARIANTS)
  const prefs = buildLook(from, d, DEFAULT_VARIANT, SEED_VARIANTS, takenIds())
  if (prefs) previewLook(prefs)
  else if (req.previewing) previewLook(before)
  setReq({ words, result: d, previewing: prefs ? { prefs, before } : null, kept: null, error: null })
  return d
}

/**
 * Every look id this new look must not reuse (Kimi r1g P2): the standard look, the seeds, the person's own looks, the
 * saved look, the request's base and effective look, and what is previewed. Only ONE entry is replaceable (stand-in r1h
 * P2): the preview, when it is exactly this request's own previous try. Its id stays reserved through every other
 * source (a saved look kept from it through the gallery, say).
 */
function takenIds(): string[] {
  const shown = lookState().preview
  const replaceable = !!shown && shown === req.previewing?.prefs
  const ids = [
    DEFAULT_VARIANT.id,
    ...SEED_VARIANTS.map((v) => v.id),
    ...myLooks().map((l) => l.variant.id),
    lookState().saved?.variant?.id,
    req.base?.variant?.id,
    req.from?.variant?.id,
    replaceable ? undefined : shown?.variant?.id,
  ]
  return [...new Set(ids.filter((x): x is string => !!x))]
}

/**
 * Undo: the look that was on screen before these words; the words stay, to change and try again. When that look is
 * the saved one itself (after a Keep, the kept look), no preview is needed: the saved look shows.
 */
export function undoPreview(): void {
  if (!req.previewing) return
  const before = req.previewing.before
  previewLook(before && before === lookState().saved ? null : before)
  setReq({ previewing: null, result: null })
}

/** Close by the same person: the look that was on screen before these words comes back (as Undo). */
function dropPreview(): void {
  const p = req.previewing
  if (p && lookState().preview === p.prefs) previewLook(p.before)
}

interface PrefsClient {
  setUiPrefs?(p: UiPrefs): Promise<unknown>
}

/**
 * What a Keep came to, for whoever pressed it (Kimi r1h P3):
 * - kept: the host kept it and this request shows it (`saved`: whether Your looks were saved on this device at that
 *   moment; a record only: what is SAID is always derived from lookStatus when it is said);
 * - refused: the host did not keep it (`reason`, when it said why; otherwise a plain generic line is said);
 * - superseded: this request is no longer the one showing (the panel was closed or reopened, or the person changed)
 *   when the answer came. Nothing is said for it: the person has moved on to a newer request, which speaks for itself,
 *   and a late "refused" or "kept" about a request they closed would read as being about the one in front of them. Its
 *   real effect is still visible where it belongs: a look the host kept is in Your looks.
 * - idle: nothing to keep, or a Keep of this request already on its way (that one will answer).
 * - conflict: the host held a newer look (another device): the page shows it, and the one look notice (Use mine) speaks.
 */
export type KeepOutcome = { kind: 'kept'; shown: boolean; saved: boolean } | { kind: 'conflict' } | { kind: 'refused'; reason: string | null } | { kind: 'superseded' } | { kind: 'idle' }
export const GENERIC_REFUSAL = 'This hive didn’t keep the look; nothing changed.'

/** Keep it, as a boolean: true only when kept and shown (the panel's own button). */
export async function keepRequested(client: PrefsClient | null): Promise<boolean> {
  return (await keepRequestedOutcome(client)).kind === 'kept'
}

/**
 * Keep it: the person's look from now on (saved through the host's check first), then one of their looks, marked New.
 * Every write after the await goes through this request's binding (bindRequest); the person's looks through its
 * identity half.
 */
export async function keepRequestedOutcome(client: PrefsClient | null): Promise<KeepOutcome> {
  const p = req.previewing
  if (!p || req.busy) return { kind: 'idle' }
  // taken before the await: the person's data is bound to the identity, the request's state to THIS request
  const binding = bindRequest()
  const who = whoNow()
  const words = req.words
  // the cap REFUSES a new Keep, before the host is asked, and discards nothing (stand-in r1p P1b): the look stays on
  // screen as the preview, and every look already held or stored stays
  if (looksFull(p.prefs.variant!.id, who)) {
    setReq({ error: FULL_LINE })
    return { kind: 'refused', reason: FULL_LINE }
  }
  setReq({ busy: true, error: null })
  let result: KeepResult
  try {
    result = await keepLook(client as Parameters<typeof keepLook>[0], p.prefs, binding.identity.commit)
  } catch (e) {
    // the host held a newer look (a 409): the page shows it and the one notice offers Use mine; the request itself says
    // nothing more (no error line), so the person reads it once
    if (e instanceof NotKept) {
      const said = binding.commit(() => {
        setReq({ busy: false, error: null })
        return true
      })
      return said ? { kind: 'conflict' } : { kind: 'superseded' }
    }
    const reason = e instanceof Error && e.message ? e.message : null
    const said = binding.commit(() => {
      setReq({ busy: false, error: reason ?? GENERIC_REFUSAL })
      return true
    })
    return said ? { kind: 'refused', reason } : { kind: 'superseded' }
  }
  // the person kept it (the host has it, and it is their look now): it is one of THEIR looks while they are signed in,
  // even if this panel was closed or reopened meanwhile
  // 'held' when this device could not save it: it is then held for this session and said so (r1o P1); STALE (another
  // person now) is not saved
  const added = binding.identity.commit(() => addMyLook(who, { variant: p.prefs.variant!, layout: p.prefs.layout, words, isNew: true }))
  const saved = added === 'saved'
  // the request's own confirmation: only if this request is still the one showing. The next tries start from the KEPT
  // look, and Undo returns to it: exactly the look the host ACCEPTED (keepLook's acceptedPrefs, stand-in r1j), never the
  // saved look as it happens to be (a later save may be on its way, or shown) nor the preview the Keep cleared
  const kept = result.acceptedPrefs
  // accepted but not on screen (a newer save is showing): kept, in Your looks, and said as exactly that (Kimi r1j #2)
  const onScreen = result.outcome === 'applied'
  const shown = binding.commit(() => {
    setReq(opened({ kept: p.prefs.variant!.name, keptShown: onScreen, keptId: p.prefs.variant!.id, base: kept, from: kept }))
    return true
  })
  return shown ? { kind: 'kept', shown: onScreen, saved } : { kind: 'superseded' }
}

// an identity change drops the request and every unsaved preview at once, with NOTHING restored: what was on screen
// before the words (a gallery preview, say) was the earlier person's too (stand-in r1b P1). The look returns to the
// saved one. This page's unknown-person looks go with it.
onIdentityChange(() => {
  if (req.previewing || lookState().preview) previewLook(null)
  pageOnly = []
  held.clear()
  req = { ...EMPTY, id: ++seq }
  emit()
})
// a newly bound person reads their own looks
useAskStore.subscribe((s, prev) => {
  if (s.bound !== prev.bound) emit()
})

export function useRequest(): RequestState {
  return useSyncExternalStore(sub, () => req, () => req)
}
/** Where one of this person's looks is now (lookStatus), redrawn on every change of their looks or person. */
export function useLookStatus(id: string | null): LookStatus {
  useSyncExternalStore(sub, () => version, () => version)
  return id ? lookStatus(id) : 'absent'
}
/** This person's looks, redrawn on every change of look or person. */
export function useMyLooks(): MyLook[] {
  useSyncExternalStore(sub, () => version, () => version)
  return myLooks()
}
function sub(cb: () => void) {
  subs.add(cb)
  return () => {
    subs.delete(cb)
  }
}
