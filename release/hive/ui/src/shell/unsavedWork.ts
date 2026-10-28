import { askFieldHasWords } from '../features/ask/useAskField'
import { domUnsaved, hasUnsaved } from '../features/ask/dirty'
import { useDrafts } from '../experiences/drafts'
import { lookState } from './uiVariant'
import { onIdentityChange } from '../lib/identityEpoch'

/**
 * Typed text anywhere in the app, scoped to the route (stand-in r2 P1, r3 P1). A form that keeps its fields in component
 * state and marks nothing (a new mind's name, a key's label, a wizard's earlier steps) would be lost by a reload all the
 * same, and its fields may already be off the page (a wizard's Continue unmounts the step before). So once a person
 * types into a text field, text area or editable region, the page holds unsaved work until one of:
 *  (a) the route changes (a different page, not the same page's own address settling);
 *  (b) the person empties the field (and so every typed field) while it is on the page;
 *  (c) the form says its save succeeded: markSaved(scope), for the fields typed inside its data-unsaved-scope.
 * Submitting is NOT one of them (stand-in r4 P1): a submit can still be refused, cancelled at a confirmation, or fail.
 * A field leaving the page is not one either: what it held may still live in the form's state. A form that does not
 * opt into markSaved stays conservative until (a) or (b). An identity change forgets everything typed (the person who
 * typed it is gone). Fields that opt out carry data-unsaved-ignore. The cost, accepted: after typing, a deploy asks
 * "Save or copy your work, then Reload" instead of reloading by itself, until one of (a)-(c). That is the safe direction.
 *
 * Choices count exactly like typing (stand-in r5 P1: a merge's per-file resolution picked in a select): a person's
 * change of a select, checkbox, radio, range, file or other non-text input (stand-in r6: a file picked for upload),
 * and a person's click on a custom choice (an
 * element with role radio, checkbox, switch or option, or one carrying data-unsaved-choice, for pickers built from plain
 * buttons). A combobox is caught through its own text (typing) or through the option picked from it; opening it is not
 * a choice. Same scope, same (a)-(c) (a select set back to its empty value is (b)), same identity reset, same opt-out.
 * Search and suggestion surfaces (the Ask, the palette, completions) opt out: picking what to do is not work.
 */
export interface EditableLike {
  tagName?: string
  type?: string
  value?: string
  isContentEditable?: boolean
  textContent?: string | null
  isConnected?: boolean
  closest?: (sel: string) => unknown
}

const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'])
const CHOICE_TYPES = new Set(['checkbox', 'radio', 'range', 'color', 'date', 'datetime-local', 'month', 'time', 'week', 'file'])
const CHOICE_ROLES = '[data-unsaved-choice], [role="radio"], [role="checkbox"], [role="switch"], [role="option"]'
/** each typed field, with the save scope it was typed in (recorded while on the page: a wizard step leaves it later) */
const typed = new Map<EditableLike, string | null>()
/** each choice made, with its save scope: a choice holds no text to empty, so it counts until (a), (c) or a reset */
const chosen = new Map<EditableLike, string | null>()
let routeKey: string | null = null
onIdentityChange(() => {
  typed.clear()
  chosen.clear()
})

const scopeOf = (el: EditableLike): string | null => {
  const scope = el.closest?.('[data-unsaved-scope]') as { getAttribute?: (n: string) => string | null } | null | undefined
  return scope?.getAttribute?.('data-unsaved-scope') ?? null
}

/** The field or editable region an input event came from, when it holds typed text. */
function editableOf(t: unknown): EditableLike | null {
  if (!t || typeof t !== 'object') return null
  const el = t as EditableLike
  if (el.closest?.('[data-unsaved-ignore]')) return null
  const tag = (el.tagName ?? '').toUpperCase()
  if (tag === 'TEXTAREA') return el
  if (tag === 'INPUT') return TEXT_TYPES.has((el.type ?? '').toLowerCase()) ? el : null
  if (el.isContentEditable) return (el.closest?.('[contenteditable]:not([contenteditable="false"])') as EditableLike | null) ?? el
  return null
}

const textOf = (el: EditableLike): string => (typeof el.value === 'string' ? el.value : (el.textContent ?? ''))

/** An input event: the person typed into a field (remember it), or emptied it while it is on the page (forget it). */
export function noteEdit(target: unknown): void {
  const el = editableOf(target)
  if (!el) return
  if (textOf(el).trim()) typed.set(el, typed.get(el) ?? scopeOf(el))
  else typed.delete(el)
}

/**
 * A person's change event: a select or a non-text input changed (text fields are typing, noted by noteEdit). A select
 * set back to its empty value is the choice undone.
 */
export function noteChange(target: unknown): void {
  if (!target || typeof target !== 'object') return
  const el = target as EditableLike
  if (el.closest?.('[data-unsaved-ignore]')) return
  const tag = (el.tagName ?? '').toUpperCase()
  const choice = tag === 'SELECT' || (tag === 'INPUT' && CHOICE_TYPES.has((el.type ?? '').toLowerCase()))
  if (!choice) return
  // a select set back to its empty value, or a file input cleared (no file chosen), is the choice undone
  if ((tag === 'SELECT' || (el.type ?? '').toLowerCase() === 'file') && el.value === '') chosen.delete(el)
  else chosen.set(el, chosen.get(el) ?? scopeOf(el))
}

/** A person's click: on a custom choice (a radio, checkbox, switch or option by role, or a data-unsaved-choice picker). */
export function noteClick(target: unknown): void {
  if (!target || typeof target !== 'object') return
  const at = target as EditableLike
  const el = at.closest?.(CHOICE_ROLES) as EditableLike | null | undefined
  if (!el || el.closest?.('[data-unsaved-ignore]')) return
  chosen.set(el, chosen.get(el) ?? scopeOf(el))
}

/**
 * A form's save actually succeeded (after its confirmation, after the hive accepted it): the words typed inside its
 * data-unsaved-scope are where they belong. Call it only on success; a refused, cancelled or failed save keeps them.
 */
export function markSaved(scope: string): void {
  for (const [el, s] of [...typed]) if (s === scope) typed.delete(el)
  for (const [el, s] of [...chosen]) if (s === scope) chosen.delete(el)
}

/** The route, by page: '#/program/omegadesign' and its settled '#/program/omegadesign/s_forge' are the same page. */
export function routeKeyOf(hash: string): string {
  return hash.split('?')[0].replace(/^#?\/?/, '').split('/').slice(0, 2).join('/')
}

/** The address changed: a different page forgets what was typed on the last one. */
export function noteRoute(hash: string): void {
  const key = routeKeyOf(hash)
  if (routeKey !== null && key !== routeKey) {
    typed.clear()
    chosen.clear()
  }
  routeKey = key
}

/** Something typed on this page still holds words, or a choice was made on it, on the page or not. */
export function typedWork(): boolean {
  if (chosen.size) return true
  for (const el of typed.keys()) if (textOf(el).trim()) return true
  return false
}

/** Listen everywhere (capture: a field that stops propagation still counts). Install once, at boot. No submit listener. */
export function installEditTracking(win: Pick<Window, 'addEventListener' | 'location'> & { document: Pick<Document, 'addEventListener'> } = window): void {
  noteRoute(win.location.hash)
  // only what a person did: a script's synthetic event is not their work
  const person = (e: Event) => e.isTrusted !== false
  win.document.addEventListener('input', (e) => noteEdit(e.target), true)
  win.document.addEventListener('change', (e) => person(e) && noteChange(e.target), true)
  win.document.addEventListener('click', (e) => person(e) && noteClick(e.target), true)
  win.addEventListener('hashchange', () => noteRoute(win.location.hash))
}

/**
 * Would a reload lose something now? The page-level answer for lib/chunkReload.ts: pages that mark themselves unsaved
 * (features/ask/dirty.ts: useUnsaved, data-ask-unsaved, a look being previewed), the Ask field's unsent words, kept
 * drafts (experiences/drafts.ts, in memory only), and any typed text or choice made on the page.
 */
export function unsavedWork(): boolean {
  if (hasUnsaved({ domUnsaved, lookPreview: () => lookState().preview !== null })) return true
  if (askFieldHasWords()) return true
  if (Object.values(useDrafts.getState().drafts).some((d) => d.trim() !== '')) return true
  return typedWork()
}
