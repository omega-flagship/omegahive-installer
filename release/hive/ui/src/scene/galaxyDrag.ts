import { bindEpoch, onIdentityChange, type EpochBinding } from '../lib/identityEpoch'

/**
 * Drag a galaxy by its name (or a far galaxy's point of light) to rearrange the universe; a still press flies in
 * (PLAN_HIVE_VIEW_SCALING r2 §3, UI-only). Listened for on the map's region in the capture phase, before the canvas sees
 * the press, so the map's own pan and pick stay as they are.
 *
 * A drag belongs to the identity it started under (stand-in hive-scale r1 P1-2): an identity change cancels it at once
 * (pointer capture released, the engine's drag dropped and the layout put back), and its position is saved only
 * through the binding taken at pointerdown, under the principal that started it. A drag can never write under anyone
 * else, nor under the same person after a change.
 */
export interface DragEngine {
  galaxyHandleAt(x: number, y: number): string | null
  beginGalaxyDrag(id: string, x: number, y: number): boolean
  moveGalaxyDrag(x: number, y: number): void
  endGalaxyDrag(): { id: string; moved: boolean; x: number; y: number } | null
  cancelGalaxyDrag(): void
}

/** The map's canvas as the drag uses it: where it is, and its cursor. */
export interface DragCanvas {
  getBoundingClientRect(): { left: number; top: number }
  style: { cursor: string }
}

type Listen = Pick<HTMLElement, 'addEventListener' | 'removeEventListener'> & { setPointerCapture?(id: number): void; releasePointerCapture?(id: number): void }

export function attachGalaxyDrag(
  region: Listen,
  canvas: DragCanvas,
  engine: DragEngine,
  opts: { principal(): string | null; save(principal: string, hive: string, p: { x: number; y: number }): void; onMoved?(): void },
): () => void {
  let drag: { pointer: number; binding: EpochBinding; principal: string | null } | null = null
  // the press is on the canvas itself (not an overlay above it): compared by identity
  const onCanvas = (t: EventTarget | null) => Object.is(t, canvas)
  const local = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const cancel = () => {
    if (!drag) return
    const pointer = drag.pointer
    drag = null
    try {
      region.releasePointerCapture?.(pointer)
    } catch {
      /* already released */
    }
    engine.cancelGalaxyDrag()
    canvas.style.cursor = 'grab'
  }
  const onDown = (e: PointerEvent) => {
    if (drag || e.button > 0 || !onCanvas(e.target)) return
    const p = local(e)
    const id = engine.galaxyHandleAt(p.x, p.y)
    if (!id) return
    const binding = bindEpoch()
    if (!engine.beginGalaxyDrag(id, p.x, p.y)) return
    e.stopPropagation()
    drag = { pointer: e.pointerId, binding, principal: opts.principal() }
    region.setPointerCapture?.(e.pointerId)
    canvas.style.cursor = 'grabbing'
  }
  const onMove = (e: PointerEvent) => {
    if (!drag || drag.pointer !== e.pointerId) return
    e.stopPropagation()
    if (!drag.binding.current()) return cancel()
    const p = local(e)
    engine.moveGalaxyDrag(p.x, p.y)
  }
  const onUp = (e: PointerEvent) => {
    if (!drag || drag.pointer !== e.pointerId) return
    e.stopPropagation()
    const d = drag
    if (!d.binding.current()) return cancel()
    drag = null
    try {
      region.releasePointerCapture?.(e.pointerId)
    } catch {
      /* already released */
    }
    canvas.style.cursor = 'grab'
    if (e.type === 'pointercancel') return engine.cancelGalaxyDrag()
    const r = engine.endGalaxyDrag()
    opts.onMoved?.()
    // saved only for the identity the drag started under, checked in the same tick as the write
    if (r?.moved && d.principal) d.binding.commit(() => opts.save(d.principal!, r.id, r))
  }
  // the move cursor over a galaxy's name (after the canvas's own hover has set its cursor)
  const onHoverMove = (e: PointerEvent) => {
    if (drag || e.pointerType !== 'mouse' || !onCanvas(e.target)) return
    const p = local(e)
    if (engine.galaxyHandleAt(p.x, p.y)) canvas.style.cursor = 'move'
    else if (canvas.style.cursor === 'move') canvas.style.cursor = 'grab'
  }
  const offIdentity = onIdentityChange(cancel)
  region.addEventListener('pointerdown', onDown as EventListener, true)
  region.addEventListener('pointermove', onMove as EventListener, true)
  region.addEventListener('pointerup', onUp as EventListener, true)
  region.addEventListener('pointercancel', onUp as EventListener, true)
  region.addEventListener('pointermove', onHoverMove as EventListener)
  return () => {
    cancel()
    offIdentity()
    region.removeEventListener('pointerdown', onDown as EventListener, true)
    region.removeEventListener('pointermove', onMove as EventListener, true)
    region.removeEventListener('pointerup', onUp as EventListener, true)
    region.removeEventListener('pointercancel', onUp as EventListener, true)
    region.removeEventListener('pointermove', onHoverMove as EventListener)
  }
}
