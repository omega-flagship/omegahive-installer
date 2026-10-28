/**
 * Presence (the owner, 2026-10-05: watch the orchestrator work live across experiences). Pure resolution of a presence
 * target to what is on screen now, from the `data-presence-*` attributes the experiences put on their main entities,
 * nav targets and regions:
 *
 *   data-presence-ref="<kind>:<ref>"     a mind, swarm, goal, room, artifact or item
 *   data-presence-feature="<feature id>" a feature's nav target (registry id)
 *   data-presence-region="<name>"        a named region (the page, the thread, a passage)
 *
 * It only ever looks at the document as it is. A target that is not on screen is reported as "not on screen"; it is
 * never searched for, scrolled to or fetched (Platform's presence rules, mirrored client-side).
 */
import { NAV_ITEMS } from '../shell/navItems'
import type { PresenceTarget } from '../api/ask'

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** The minimal element and document shapes the resolver needs (the DOM satisfies them; tests pass fakes). */
export interface PresenceEl {
  getBoundingClientRect(): Box & { width: number; height: number }
  closest?(selector: string): unknown
}
export interface PresenceRoot {
  querySelectorAll(selector: string): ArrayLike<PresenceEl>
}

export type Resolved = { kind: 'found'; els: PresenceEl[]; box: Box } | { kind: 'not-on-screen' }

const SAFE = /^[A-Za-z0-9_.:-]{1,200}$/

/** The selectors for a target, most specific first (entity, then feature, then region). Unsafe values give none. */
export function selectorsFor(t: PresenceTarget): string[] {
  const out: string[] = []
  if (t.entity && SAFE.test(t.entity.ref) && /^[a-z]+$/.test(t.entity.kind)) out.push(`[data-presence-ref="${t.entity.kind}:${t.entity.ref}"]`)
  if (t.feature && /^[a-z]+\.[a-z]+$/.test(t.feature)) out.push(`[data-presence-feature="${t.feature}"]`)
  if (t.region && /^[a-z][a-z0-9-]{0,40}$/.test(t.region)) out.push(`[data-presence-region="${t.region}"]`)
  return out
}

/** Visible in the viewport: a real size, and at least partly inside it. Inert (under a modal) does not count. */
export function onScreen(el: PresenceEl, viewport: { width: number; height: number }): boolean {
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return false
  if (r.right <= 0 || r.bottom <= 0 || r.left >= viewport.width || r.top >= viewport.height) return false
  if (el.closest?.('[inert],[aria-hidden="true"]')) return false
  return true
}

/** The on-screen elements for a target (the first selector that has any), with their union box; or not on screen. */
export function resolvePresence(t: PresenceTarget, root: PresenceRoot, viewport: { width: number; height: number }): Resolved {
  for (const sel of selectorsFor(t)) {
    const els = Array.from(root.querySelectorAll(sel)).filter((el) => onScreen(el, viewport))
    if (!els.length) continue
    const boxes = els.map((e) => e.getBoundingClientRect())
    const box = {
      left: Math.max(0, Math.min(...boxes.map((b) => b.left))),
      top: Math.max(0, Math.min(...boxes.map((b) => b.top))),
      right: Math.min(viewport.width, Math.max(...boxes.map((b) => b.right))),
      bottom: Math.min(viewport.height, Math.max(...boxes.map((b) => b.bottom))),
    }
    return { kind: 'found', els, box }
  }
  return { kind: 'not-on-screen' }
}

/** The feature each classic nav item opens, for its `data-presence-feature`: read from the nav itself (shell/navItems). */
export const NAV_FEATURE: Record<string, string> = Object.fromEntries(NAV_ITEMS.map((i) => [i.key, i.feature]))

/** The presence attribute value for an entity. */
export const presenceRef = (kind: 'mind' | 'swarm' | 'goal' | 'room' | 'artifact' | 'item', ref: string): string => `${kind}:${ref}`
