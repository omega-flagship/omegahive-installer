/**
 * "What this shows and can do" (UNIVERSAL_ASK_DESIGN §3; Host amendment §1.1): `context.view`, ≤ 2 KB. A page or skin
 * calls `useAskView(view)` with what is on screen; the Ask keeps the latest per scope and sends it with each turn.
 * Without one, the Ask derives a small default from the route and what the store already shows.
 *
 * Privacy (Platform, 2026-10-05): for Atlas, Truth and any owner-opted app, only ids and kinds are sent; no labels
 * and no summary.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { conformingField, VIEW_FIELDS_MAX, VIEW_NAME, VIEW_REGIONS_MAX, type AskField, type AskView, type SelectionKind } from '../../api/ask'

/** What a page exports: its own title and labels stay on the page; the wire view is ids, act ids and a summary. */
export interface PageView {
  title?: string
  refs?: { kind: SelectionKind; ref: string; label?: string }[]
  acts?: string[]
  summary?: string
  /** fields the conductor may fill (vocabulary v1 §3; declared with features/ask/fields useAskFillable) */
  fields?: AskField[]
  /** named regions it may point at, highlight or scroll to (`data-presence-region` names) */
  regions?: string[]
}

export const VIEW_MAX_BYTES = 2048
export const PRIVATE_APPS = new Set(['atlas', 'omegatruth', 'truth'])

/**
 * A route segment as it is meant: percent-decoded until it stops changing (at most 3 rounds). Null when it cannot be
 * read for sure: a malformed escape, or still encoded after 3 rounds. Callers checking privacy treat null as private
 * (fail closed; Platform host review of aa43ae4: `%61tlas`, `%2561tlas` must not get past the private-app check).
 */
export function decodeSegment(s: string): string | null {
  let cur = s
  for (let i = 0; i < 4; i++) {
    let next: string
    try {
      next = decodeURIComponent(cur)
    } catch {
      return null
    }
    if (next === cur) return cur
    if (i === 3) return null
    cur = next
  }
  return null
}

/** Is this app id a private app's (Atlas, Truth), however it is encoded or cased? Unreadable ids are private. */
export function isPrivateApp(id: string): boolean {
  const d = decodeSegment(id)
  return d === null || PRIVATE_APPS.has(d.trim().toLowerCase())
}

/**
 * Does this hash (or route string) open a private app's page? Read from the raw string, segment by segment, before
 * any router parsing: an app segment after `program`/`programs` (also a mind's `dot/<id>/program/<app>`) that is
 * private, or any segment that cannot be decoded for sure (fail closed).
 */
export function isPrivateHash(raw: string): boolean {
  const path = raw.replace(/^#/, '').split('?')[0]
  const segs = path.split('/').filter(Boolean).map(decodeSegment)
  if (segs.some((x) => x === null)) return true
  const s = (segs as string[]).map((x) => x.trim().toLowerCase())
  return s.some((x, i) => i > 0 && (s[i - 1] === 'program' || s[i - 1] === 'programs') && isPrivateApp(x))
}

type ExportedView = { scope: string; view: PageView; current?: () => boolean; visit?: number }
let latest: ExportedView | null = null
// A guarded view from an earlier native hash visit must not revive when Back returns to the same raw hash.
// This is local invalidation only. It grants no navigation, identity or action authority.
let visit = 0
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())
let hashWatchers = 0
let watchedWindow: Window | null = null
const hashChanged = () => { visit++; emit() }
/** No import-time window calls. One native hash watch while any export or subscriber is mounted. */
function watchHash(): () => void {
  hashWatchers++
  if (!watchedWindow && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    watchedWindow = window
    watchedWindow.addEventListener('hashchange', hashChanged)
  }
  return () => {
    hashWatchers--
    if (!hashWatchers && watchedWindow) {
      watchedWindow.removeEventListener('hashchange', hashChanged)
      watchedWindow = null
    }
  }
}

/** The page's export. The latest caller wins; it is cleared when the caller unmounts. */
export function useAskView(scope: string, view: PageView | null, displayedOriginCurrent?: () => boolean): void {
  const sig = view ? JSON.stringify(view) : ''
  const capturedVisit = displayedOriginCurrent ? visit : undefined
  useEffect(() => {
    if (!sig) return
    const unwatch = watchHash()
    const mine: ExportedView = { scope, view: JSON.parse(sig) as PageView, ...(displayedOriginCurrent ? { current: displayedOriginCurrent, visit: capturedVisit } : {}) }
    latest = mine
    emit()
    return () => {
      unwatch()
      if (latest === mine) {
        latest = null
        emit()
      }
    }
  }, [scope, sig, displayedOriginCurrent, capturedVisit])
}

export const currentView = (): { scope: string; view: PageView } | null => {
  if (!latest?.current) return latest
  try { return latest.visit === visit && latest.current() ? latest : null } catch { return null }
}
export function useCurrentView(): { scope: string; view: PageView } | null {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      const unwatch = watchHash()
      return () => {
        unwatch()
        subs.delete(cb)
      }
    },
    currentView,
    currentView,
  )
}

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length

/**
 * The view as sent (the built host's exact keys: refs ≤ 50 of {kind, ref}, acts ≤ 50, summary ≤ 500, all in 2 KB).
 * Labels never leave the page; the title joins the summary (which the host accepts but does not forward to the mind).
 * Fields and regions follow the host's limits (Platform r2 Q1): at most 32 each, exactly {id, label, kind}, names
 * matching VIEW_NAME, labels 1–80 without control characters; anything else is dropped (labels trimmed), never sent.
 * They are kept before refs and acts when the view must be trimmed to 2 KB.
 * Private apps (Platform r2 Q6): nothing at all. The Ask turn context for them is `{ private: true }` (context.ts),
 * and an act result from their pages carries an empty view.
 */
export function fitView(v: PageView, opts: { privateApp?: boolean } = {}): AskView {
  const refs = (v.refs ?? []).slice(0, 50).map((r) => ({ kind: r.kind, ref: r.ref.slice(0, 200) }))
  const acts = (v.acts ?? []).slice(0, 50)
  const summary = [v.title, v.summary].filter(Boolean).join(': ').slice(0, 500)
  if (opts.privateApp) return {}
  const seen = new Set<string>()
  const fields = (v.fields ?? [])
    .map(conformingField)
    .filter((f): f is AskField => !!f && !seen.has(f.id) && !!seen.add(f.id))
    .slice(0, VIEW_FIELDS_MAX)
  const regions = [...new Set((v.regions ?? []).filter((r) => typeof r === 'string' && VIEW_NAME.test(r)))].slice(0, VIEW_REGIONS_MAX)
  const out: AskView = { refs, acts, ...(summary ? { summary } : {}), ...(fields.length ? { fields } : {}), ...(regions.length ? { regions } : {}) }
  while (bytes(out) > VIEW_MAX_BYTES && ((out.refs?.length ?? 0) > 0 || (out.acts?.length ?? 0) > 0)) {
    if (out.refs?.length) out.refs = out.refs.slice(0, -1)
    else out.acts = out.acts!.slice(0, -1)
  }
  if (bytes(out) > VIEW_MAX_BYTES) delete out.summary
  while (bytes(out) > VIEW_MAX_BYTES && (out.regions?.length || out.fields?.length)) {
    if (out.regions?.length) out.regions = out.regions.slice(0, -1)
    else out.fields = out.fields!.slice(0, -1)
  }
  return out
}
