import { onIdentityChange } from '../lib/identityEpoch'

/**
 * Where a person dragged the galaxies on their hive map (PLAN_HIVE_VIEW_SCALING r2 §3, UI-only). Kept in this
 * browser's localStorage, keyed by the signed-in principal, as world positions by hive id. Positions are the person's
 * own: they change no membership and no permission, and are never sent anywhere.
 * - Only visible hive ids are ever written (the engine offers only shown galaxies for dragging; never a placeholder).
 * - The in-memory copy is dropped on every identity change, so the next person starts from their own saved layout.
 * - Bounded: at most MAX_HIVES entries, finite numbers only; anything else read back is dropped.
 * - Per principal on this browser profile: on a shared profile each signed-in person keeps their own arrangement, and
 *   anyone with access to the profile's storage can read those positions (hive ids and numbers only, no names).
 * - Never consumed by an audit or operator surface: they only place galaxies on this person's own map.
 */
export type Positions = Record<string, { x: number; y: number }>

export const PREFIX = 'omegadots.hive.galaxies.'
export const MAX_HIVES = 400
const HIVE_ID = /^hive:[A-Za-z0-9:_.@-]{1,160}$/

let cache: { principal: string; positions: Positions } | null = null
onIdentityChange(() => {
  cache = null
})

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function clean(raw: unknown): Positions {
  const out: Positions = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  let n = 0
  for (const [id, p] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_HIVES) break
    const q = p as { x?: unknown; y?: unknown } | null
    if (!HIVE_ID.test(id) || !q || typeof q.x !== 'number' || typeof q.y !== 'number' || !Number.isFinite(q.x) || !Number.isFinite(q.y)) continue
    out[id] = { x: Math.round(q.x), y: Math.round(q.y) }
    n++
  }
  return out
}

/** The person's saved galaxy positions (none for an unknown principal). */
export function readPositions(principal: string | null | undefined): Positions {
  if (!principal) return {}
  if (cache?.principal === principal) return cache.positions
  let positions: Positions
  try {
    positions = clean(JSON.parse(store()?.getItem(PREFIX + encodeURIComponent(principal)) ?? 'null'))
  } catch {
    positions = {}
  }
  cache = { principal, positions }
  return positions
}

function write(principal: string, positions: Positions) {
  cache = { principal, positions }
  try {
    const s = store()
    if (!s) return
    if (Object.keys(positions).length) s.setItem(PREFIX + encodeURIComponent(principal), JSON.stringify(positions))
    else s.removeItem(PREFIX + encodeURIComponent(principal))
  } catch {
    /* private window or full storage: the layout still applies for this visit */
  }
}

/** Keep one galaxy where the person put it. */
export function savePosition(principal: string | null | undefined, hive: string, p: { x: number; y: number }): void {
  if (!principal || !HIVE_ID.test(hive) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return
  const next = { ...readPositions(principal), [hive]: { x: Math.round(p.x), y: Math.round(p.y) } }
  write(principal, clean(next))
}

/** Forget the person's arrangement: the galaxies go back to their packed places. */
export function resetPositions(principal: string | null | undefined): void {
  if (!principal) return
  write(principal, {})
}
