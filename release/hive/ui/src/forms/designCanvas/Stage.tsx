import { forwardRef, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Icon } from '../../ui/Icon'
import { fit, HANDLES, handlePoint, keepVisible, pinch, placeRing, rectToScreen, resizeBox, snap, toArt, wheel, zoomAt, type Guide, type Handle, type Point, type Rect, type Reserve, type Size, type View } from './geometry'
import { addBlock, addImage, addText, describeElement, isColour, layer, MAX_IMAGE_FILE, moveTo, paletteOf, recolour, remove, resizeStep, resizeTo, retext, toggleWeight, type Change, type Scene, type SceneElement } from './model'
import { fontOf, LINE, wrapText } from './render'
import type { CanvasFence } from './useCanvas'
import { guardComposing } from '../../features/ask/keys'

/**
 * The stage: the design itself, edge to edge. It pans and zooms (wheel, ⌘/Ctrl+wheel and trackpad pinch, two-finger
 * pinch on touch, keys), and every control is revealed in context:
 *  - select an element (click, tap, or Tab then Enter) → a small ring beside it: text, colour, size, layer, remove;
 *  - drag it to move (guides show alignment to the artboard and the other elements), drag an edge or corner to resize;
 *  - right-click or long-press empty space (or the context-menu key) → add text, a block, a picture or a direction;
 *  - controls recede when the pointer leaves them; with reduced motion they appear and disappear at once.
 * Every edit is one native change handed to `commit`; nothing here writes outside the canvas.
 */

export interface StageProps {
  scene: Scene
  selected: string | null
  onSelect: (id: string | null) => void
  commit: (changes: (Change | null)[], opts?: { select?: string | null; say?: string; generation?: CanvasFence }) => Promise<boolean>
  /** Begin delayed local work (useCanvas): the design, sign-in and session it started under; it commits only while they hold. */
  generation: () => CanvasFence
  /** Ask the orchestrator (the universal Ask): the canvas's own words, sent as the person's request. */
  ask: (text: string) => void
  reserve: Reserve
  reduced: boolean
  coarse: boolean
  /** Piece 2: the mind's presence cursor (artboard-normalised 0..1), and its caption. Drawn aria-hidden. */
  cursor?: { x: number; y: number; caption?: string } | null
  /** Tell the parent the view (for the zoom readout and "fit"). */
  onView?: (v: View, fitView: () => void, zoom: (f: number) => void) => void
  /** The person touched the canvas (controls come back, a mind's moves pause). */
  onActivity?: () => void
  /** One plain sentence for something the canvas could not do. */
  notify: (text: string) => void
}

type Gesture =
  | { kind: 'move'; id: string; start: Point; origin: Rect; moved: boolean }
  | { kind: 'resize'; id: string; handle: Handle; start: Point; origin: Rect }
  | { kind: 'pan'; start: Point; origin: View; moved: boolean; pressTimer: number | null; at: Point }
  | { kind: 'pinch' }
  | null

type Pop = 'colour' | 'size' | 'layer' | null

export function Stage(p: StageProps) {
  const { scene, selected, onSelect, commit, reserve } = p
  const rootRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const ringRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  const [view, setView] = useState<View | null>(null)
  const userMoved = useRef(false)
  const gesture = useRef<Gesture>(null)
  const pointers = useRef(new Map<number, Point>())
  const [preview, setPreview] = useState<{ id: string; box: Rect } | null>(null)
  const [guides, setGuides] = useState<Guide[]>([])
  const [hover, setHover] = useState<string | null>(null)
  const [hoverHandles, setHoverHandles] = useState(false)
  const [focusId, setFocusId] = useState<string | null>(null)
  // the open popover and the words editor belong to one selection: selecting something else closes them
  const [popFor, setPopFor] = useState<{ id: string | null; pop: Pop }>({ id: null, pop: null })
  const pop = popFor.id === selected ? popFor.pop : null
  const setPop = (next: Pop) => setPopFor({ id: selected, pop: next })
  const [editFor, setEditing] = useState<string | null>(null)
  const editing = editFor && editFor === selected ? editFor : null
  const [menu, setMenu] = useState<{ at: Point; art: Point } | null>(null)
  const pendingImageAt = useRef<Point>({ x: 80, y: 80 })
  const [avoid, setAvoid] = useState<Rect[]>([])
  const uid = useId().replace(/:/g, '')

  // ---- the stage's size, and the fitted view until the person moves it themselves
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const measure = () => {
      setSize({ width: el.clientWidth, height: el.clientHeight })
      // what the ring must never cover, in the stage's px: Ω's corner and the drawer pill
      const at = el.getBoundingClientRect()
      const rect = (q: Element | null | undefined): Rect | null => {
        const r = q?.getBoundingClientRect()
        return r && r.width ? { x: r.left - at.left - 6, y: r.top - at.top - 6, width: r.width + 12, height: r.height + 12 } : null
      }
      setAvoid([rect(document.querySelector('[data-omega-button]')), rect(el.closest('.dc')?.querySelector('.dc-drawer-handle'))].filter((r): r is Rect => !!r))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const fitted = useMemo(() => (size.width ? fit({ width: scene.width, height: scene.height }, size, reserve) : null), [scene.width, scene.height, size, reserve])
  useEffect(() => {
    if (fitted && (!userMoved.current || !view)) setView(fitted)
    // a new artboard size (another design) fits again
  }, [fitted]) // eslint-disable-line react-hooks/exhaustive-deps
  const v = view ?? fitted
  const setUserView = useCallback((next: View) => {
    userMoved.current = true
    setView(keepVisible(next, { width: scene.width, height: scene.height }, size))
  }, [scene.width, scene.height, size])
  const fitNow = useCallback(() => {
    userMoved.current = false
    if (fitted) setView(fitted)
  }, [fitted])
  const zoomBy = useCallback((f: number) => v && setUserView(zoomAt(v, f, { x: size.width / 2, y: (size.height - reserve.bottom + reserve.top) / 2 })), [v, size, reserve, setUserView])
  useEffect(() => {
    if (v) p.onView?.(v, fitNow, zoomBy)
  }, [v, fitNow, zoomBy]) // eslint-disable-line react-hooks/exhaustive-deps

  const byId = useMemo(() => new Map(scene.elements.map((e) => [e.id, e])), [scene.elements])
  const sel = selected ? byId.get(selected) ?? null : null
  useEffect(() => {
    if (selected && !byId.has(selected)) onSelect(null)
  }, [selected, byId, onSelect])

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = rootRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const boxOf = (e: SceneElement): Rect => (preview && preview.id === e.id ? preview.box : { x: e.x, y: e.y, width: e.width, height: e.height })

  // ---- pointer: select, move, resize, pan, pinch, long-press
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    p.onActivity?.()
    if (!v || editing) return
    const target = e.target as Element
    if (target.closest('.dc-ring, .dc-menu, .dc-edit')) return
    if (e.button === 2) return   // the context menu opens on its own event
    const at = local(e)
    pointers.current.set(e.pointerId, at)
    if (pointers.current.size === 2) {
      // a second finger: pinch, whatever the first one was doing
      const g = gesture.current
      if (g?.kind === 'pan' && g.pressTimer) window.clearTimeout(g.pressTimer)
      gesture.current = { kind: 'pinch' }
      setPreview(null)
      setGuides([])
      return
    }
    setMenu(null)
    const handle = target.closest('[data-handle]')?.getAttribute('data-handle') as Handle | null
    const elId = target.closest('[data-el]')?.getAttribute('data-el') ?? null
    // keys follow the pointer: the element pointed at, else the stage (arrows, Delete, zoom and fit then work at once)
    const focusTo = (elId ? target.closest('[data-el]') : rootRef.current) as HTMLElement | SVGElement | null
    focusTo?.focus({ preventScroll: true })
    if (handle && sel) {
      gesture.current = { kind: 'resize', id: sel.id, handle, start: at, origin: boxOf(sel) }
    } else if (elId && byId.has(elId)) {
      const el = byId.get(elId)!
      if (selected !== elId) onSelect(elId)
      gesture.current = { kind: 'move', id: elId, start: at, origin: boxOf(el), moved: false }
    } else {
      const pressTimer = e.pointerType === 'touch' ? window.setTimeout(() => openMenu(at), 550) : null
      gesture.current = { kind: 'pan', start: at, origin: v, moved: false, pressTimer, at }
    }
    rootRef.current?.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!v) return
    const at = local(e)
    const prev = pointers.current.get(e.pointerId)
    if (prev) pointers.current.set(e.pointerId, at)
    const g = gesture.current
    if (!g) {
      // hovering: outline what is under the pointer; resize handles near the selection's edges
      const elId = (e.target as Element).closest?.('[data-el]')?.getAttribute('data-el') ?? null
      setHover(elId)
      if (sel) {
        const r = rectToScreen(v, boxOf(sel))
        const pad = p.coarse ? 22 : 12
        setHoverHandles(at.x > r.x - pad && at.x < r.x + r.width + pad && at.y > r.y - pad && at.y < r.y + r.height + pad)
      }
      return
    }
    if (g.kind === 'pinch') {
      const pts = [...pointers.current.values()]
      if (pts.length === 2 && prev) {
        const other = [...pointers.current.entries()].find(([id]) => id !== e.pointerId)![1]
        setUserView(pinch(v, [prev, other], [at, other]))
      }
      return
    }
    const dx = (at.x - g.start.x) / v.scale
    const dy = (at.y - g.start.y) / v.scale
    if (g.kind === 'pan') {
      if (Math.hypot(at.x - g.start.x, at.y - g.start.y) > 6) {
        g.moved = true
        if (g.pressTimer) {
          window.clearTimeout(g.pressTimer)
          g.pressTimer = null
        }
      }
      if (g.moved) setUserView({ ...g.origin, tx: g.origin.tx + (at.x - g.start.x), ty: g.origin.ty + (at.y - g.start.y) })
      return
    }
    if (g.kind === 'move') {
      if (!g.moved && Math.hypot(at.x - g.start.x, at.y - g.start.y) < 4) return
      g.moved = true
      const raw = { ...g.origin, x: g.origin.x + dx, y: g.origin.y + dy }
      const others = scene.elements.filter((o) => o.id !== g.id)
      const s = e.altKey ? { x: raw.x, y: raw.y, guides: [] } : snap(raw, others, scene, 6 / v.scale)
      const x = Math.max(0, Math.min(scene.width - raw.width, s.x))
      const y = Math.max(0, Math.min(scene.height - raw.height, s.y))
      setPreview({ id: g.id, box: { ...raw, x, y } })
      setGuides(s.guides)
      return
    }
    // resize
    const box = resizeBox(g.origin, g.handle, dx, dy)
    setPreview({ id: g.id, box })
  }

  const endGesture = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId)
    const g = gesture.current
    if (g?.kind === 'pinch') {
      if (pointers.current.size === 0) gesture.current = null
      return
    }
    gesture.current = null
    if (!g) return
    if (g.kind === 'pan') {
      if (g.pressTimer) window.clearTimeout(g.pressTimer)
      if (!g.moved && e.type === 'pointerup') onSelect(null)
      return
    }
    const box = preview?.id === g.id ? preview.box : null
    setPreview(null)
    setGuides([])
    const el = byId.get(g.id)
    if (!el || !box || e.type !== 'pointerup') return
    if (g.kind === 'move') void commit([moveTo(scene, el, box.x, box.y)])
    else void commit([resizeTo(scene, el, box)])
  }

  const onWheel = useCallback(
    (e: WheelEvent) => {
      if (!v || (e.target as Element).closest?.('.dc-ring, .dc-menu, .dc-edit')) return
      e.preventDefault()
      const r = rootRef.current!.getBoundingClientRect()
      setUserView(wheel(v, e, { x: e.clientX - r.left, y: e.clientY - r.top }))
    },
    [v, setUserView],
  )
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel])

  // ---- adding things where the person pointed
  const openMenu = (at: Point) => {
    if (!v) return
    const art = toArt(v, at)
    gesture.current = null
    setMenu({ at, art: { x: Math.max(0, Math.min(scene.width - 1, art.x)), y: Math.max(0, Math.min(scene.height - 1, art.y)) } })
  }
  const onContextMenu = (e: React.MouseEvent) => {
    if ((e.target as Element).closest('.dc-ring, .dc-menu, .dc-edit')) return
    e.preventDefault()
    const elId = (e.target as Element).closest('[data-el]')?.getAttribute('data-el')
    if (elId) {
      onSelect(elId)
      return
    }
    openMenu(local(e))
  }
  const accent = paletteOf(scene)[0]
  const add = async (what: 'text' | 'block' | 'picture' | 'direction') => {
    const at = menu?.art ?? { x: scene.width / 2 - 100, y: scene.height / 2 - 40 }
    setMenu(null)
    if (what === 'text') {
      const c = addText(scene, at)
      if (await commit([c], { select: c.element, say: 'Text added.' })) setEditing(c.element)
    } else if (what === 'block') {
      const c = addBlock(scene, at, accent && accent !== scene.background.toUpperCase() ? accent : undefined)
      await commit([c], { select: c.element, say: 'Block added.' })
    } else if (what === 'picture') {
      pendingImageAt.current = at
      fileRef.current?.click()
    } else p.ask('Suggest another direction for this design, keeping the brief')
  }
  const onFile = async (f: File | undefined) => {
    if (!f) return
    if (!['image/png', 'image/jpeg'].includes(f.type)) return p.notify('Only PNG or JPEG pictures can go on the design.')
    if (f.size > MAX_IMAGE_FILE) return p.notify('That picture is larger than 10 MB. Choose a smaller one.')
    // Review B1/B2: reading a picture takes time; it lands only on the design, under the sign-in, it was started on
    const fence = p.generation()
    const say = (text: string) => fence.valid() && p.notify(text)
    try {
      const src = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = () => reject(new Error('The picture could not be read.'))
        r.readAsDataURL(f)
      }).catch(() => '')
      if (!fence.valid()) return
      if (!src) return say('The picture could not be read. Try another one.')
      const natural = await new Promise<{ width: number; height: number } | undefined>((resolve) => {
        const img = new Image()
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
        img.onerror = () => resolve(undefined)
        img.src = src
      })
      if (!fence.valid()) {
        if (fence.reason() === 'design') p.notify('Another design was opened while the picture was being read, so it was not added.')
        return
      }
      // the person's own file name stays as the picture's description; its origin is not claimed
      const c = addImage(scene, pendingImageAt.current, src, f.name, natural)
      await commit([c], { select: c.element, say: 'Picture added.', generation: fence })
    } catch (e) {
      say(e instanceof Error ? e.message : 'The picture could not be added.')
    } finally {
      fence.release()
    }
  }

  // ---- keyboard: elements are reachable with Tab; the selection moves with arrows; keys for zoom and fit
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    p.onActivity?.()
    const t = e.target as HTMLElement
    if (t.closest('.dc-edit, .dc-menu') || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return
    const elId = t.closest('[data-el]')?.getAttribute('data-el') ?? null
    if ((e.key === 'Enter' || e.key === ' ') && elId) {
      e.preventDefault()
      if (selected === elId && byId.get(elId)?.kind === 'text') setEditing(elId)
      else onSelect(elId)
      return
    }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault()
      openMenu({ x: size.width / 2, y: size.height / 2 })
      return
    }
    if (e.key === 'Escape') {
      if (menu) setMenu(null)
      else if (pop) setPop(null)
      else if (selected) onSelect(null)
      else return
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (!e.metaKey && !e.ctrlKey && (e.key === '+' || e.key === '=')) return void zoomBy(1.2)
    if (!e.metaKey && !e.ctrlKey && e.key === '-') return void zoomBy(1 / 1.2)
    if (!e.metaKey && !e.ctrlKey && e.key === '0') return void fitNow()
    if (!sel) return
    const step = e.shiftKey ? 10 : 1
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    if (arrows[e.key]) {
      e.preventDefault()
      void commit([moveTo(scene, sel, sel.x + arrows[e.key][0], sel.y + arrows[e.key][1])])
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      void commit([remove(sel)], { select: null, say: `${describeElement(sel)} removed.` })
    }
  }

  // ---- the ring's place beside the selection, moving with it
  const [ringSize, setRingSize] = useState<Size>({ width: 240, height: 48 })
  useLayoutEffect(() => {
    const r = ringRef.current
    if (r && (r.offsetWidth !== ringSize.width || r.offsetHeight !== ringSize.height)) setRingSize({ width: r.offsetWidth, height: r.offsetHeight })
  })
  const selBox = sel && v ? rectToScreen(v, boxOf(sel)) : null
  // the place that covers the least of the design (the other elements, then the artboard), never Ω or the drawer pill;
  // it is recomputed from the preview box, so the ring follows the selection while it is dragged or resized
  const ringAt =
    selBox && v
      ? placeRing(selBox, ringSize, size, reserve, {
          others: scene.elements.filter((o) => o.id !== sel!.id).map((o) => rectToScreen(v, boxOf(o))),
          board: rectToScreen(v, { x: 0, y: 0, width: scene.width, height: scene.height }),
          avoid,
        })
      : null
  const dragging = !!preview

  if (!v) return <div ref={rootRef} className="dc-stage" />
  const tf = `translate(${v.tx} ${v.ty}) scale(${v.scale})`
  const showHandles = !!sel && !editing && (hoverHandles || p.coarse || focusId === sel.id || !!preview)
  const editEl = editing ? byId.get(editing) : null

  return (
    <div
      ref={rootRef}
      className="dc-stage"
      tabIndex={-1}
      role="group"
      aria-label="The design: Tab moves between its elements, Enter selects, arrows move, Delete removes, plus and minus zoom, 0 fits"
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onPointerLeave={() => !gesture.current && (setHover(null), setHoverHandles(false))}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      onDoubleClick={(e) => {
        // the stage holds pointer capture during a press, so the event's target is the stage: look under the pointer
        if ((e.target as Element).closest('.dc-ring, .dc-menu, .dc-edit')) return
        const under = document.elementFromPoint(e.clientX, e.clientY)
        const elId = under?.closest('[data-el]')?.getAttribute('data-el')
        if (elId && byId.get(elId)?.kind === 'text') {
          onSelect(elId)
          setEditing(elId)
        } else if (!elId) fitNow()
      }}
    >
      <svg className="dc-svg" width={size.width} height={size.height} aria-hidden={false}>
        <defs>
          <clipPath id={`${uid}-board`}>
            <rect width={scene.width} height={scene.height} />
          </clipPath>
          <filter id={`${uid}-shadow`} x="-10%" y="-10%" width="120%" height="130%">
            <feDropShadow dx="0" dy={8 / v.scale} stdDeviation={18 / v.scale} floodOpacity="0.38" />
          </filter>
        </defs>
        <g transform={tf}>
          <rect className="dc-board" width={scene.width} height={scene.height} fill={scene.background} filter={`url(#${uid}-shadow)`} />
          <g clipPath={`url(#${uid}-board)`} role="list" aria-label={`${scene.title}: ${scene.elements.length} element${scene.elements.length === 1 ? '' : 's'}`}>
            {scene.elements.map((el) => (
              <g
                key={el.id}
                data-el={el.id}
                role="listitem"
                tabIndex={0}
                aria-label={`${describeElement(el)}${selected === el.id ? ', selected' : ''}`}
                aria-current={selected === el.id ? 'true' : undefined}
                onFocus={() => setFocusId(el.id)}
                onBlur={() => setFocusId((f) => (f === el.id ? null : f))}
                className="dc-el"
                style={{ opacity: editing === el.id ? 0 : 1 }}
              >
                <Shape el={{ ...el, ...boxOf(el) }} />
              </g>
            ))}
          </g>
        </g>
        {/* overlays, in screen px (crisp at any zoom) */}
        <g className="dc-over" aria-hidden="true">
          {hover && hover !== selected && byId.get(hover) && !dragging && <Outline r={rectToScreen(v, boxOf(byId.get(hover)!))} kind="hover" />}
          {focusId && focusId !== selected && byId.get(focusId) && <Outline r={rectToScreen(v, boxOf(byId.get(focusId)!))} kind="focus" />}
          {selBox && <Outline r={selBox} kind="selected" />}
          {showHandles && selBox && HANDLES.map((h) => {
            const pt = handlePoint(selBox, h)
            const s = p.coarse ? 14 : 9
            return <rect key={h} data-handle={h} className="dc-handle" data-dir={h} x={pt.x - s / 2} y={pt.y - s / 2} width={s} height={s} rx={2} style={{ pointerEvents: 'all' }} />
          })}
          {guides.map((gd, i) =>
            gd.axis === 'x' ? (
              <line key={i} className="dc-guide" x1={gd.at * v.scale + v.tx} x2={gd.at * v.scale + v.tx} y1={v.ty - 20} y2={v.ty + scene.height * v.scale + 20} />
            ) : (
              <line key={i} className="dc-guide" y1={gd.at * v.scale + v.ty} y2={gd.at * v.scale + v.ty} x1={v.tx - 20} x2={v.tx + scene.width * v.scale + 20} />
            ),
          )}
          {p.cursor && <Cursor x={p.cursor.x * scene.width * v.scale + v.tx} y={p.cursor.y * scene.height * v.scale + v.ty} caption={p.cursor.caption} />}
        </g>
      </svg>

      {sel && ringAt && !editing && (
        <Ring
          ref={ringRef}
          el={sel}
          scene={scene}
          at={ringAt}
          pop={pop}
          setPop={setPop}
          commit={commit}
          onEdit={() => setEditing(sel.id)}
          onDone={() => onSelect(null)}
          coarse={p.coarse}
        />
      )}
      {editEl && editEl.kind === 'text' && (
        <TextEditor
          el={editEl}
          box={rectToScreen(v, boxOf(editEl))}
          scale={v.scale}
          onDone={(text) => {
            setEditing(null)
            if (text !== null) void commit([retext(editEl, text)])
          }}
        />
      )}
      {menu && <AddMenu at={menu.at} stage={size} reserve={reserve} onPick={add} onClose={() => setMenu(null)} />}
      <input ref={fileRef} type="file" accept="image/png,image/jpeg" hidden onChange={(e) => {
        void onFile(e.target.files?.[0])
        e.target.value = ''
      }} />
    </div>
  )
}

// ------------------------------------------------------------------ drawing one element (Design's own rendering)

export function Shape({ el }: { el: SceneElement }) {
  if (el.kind === 'rect') return <rect x={el.x} y={el.y} width={el.width} height={el.height} fill={el.fill} rx={el.radius} ry={el.radius} />
  if (el.kind === 'image') return <image x={el.x} y={el.y} width={el.width} height={el.height} href={el.src} preserveAspectRatio="xMidYMid meet"><title>{el.alt}</title></image>
  const size = el.fontSize ?? 16
  const w = wrapText(el)
  return (
    <>
      {/* a hit area for the whole box, so a click between lines still selects the text */}
      <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="transparent" />
      <text x={el.x} y={el.y + size} fill={el.color} fontFamily={fontOf(el)} fontSize={size} fontWeight={el.weight} style={{ whiteSpace: 'pre' }}>
        {w.lines.map((line, i) => (
          <tspan key={i} x={el.x} dy={i ? size * LINE : 0}>
            {line}
          </tspan>
        ))}
      </text>
    </>
  )
}

/** A whole scene, still (Compare's directions and Deliver's card). */
export function ScenePicture({ scene, label }: { scene: Scene; label: string }) {
  return (
    <svg viewBox={`0 0 ${scene.width} ${scene.height}`} role="img" aria-label={label} className="dc-picture" preserveAspectRatio="xMidYMid meet">
      <rect width={scene.width} height={scene.height} fill={scene.background} />
      {scene.elements.map((el) => (
        <g key={el.id}>
          <Shape el={el} />
        </g>
      ))}
    </svg>
  )
}

function Outline({ r, kind }: { r: Rect; kind: 'hover' | 'focus' | 'selected' }) {
  return <rect className={`dc-outline dc-outline-${kind}`} x={r.x - 1.5} y={r.y - 1.5} width={r.width + 3} height={r.height + 3} rx={3} />
}

function Cursor({ x, y, caption }: { x: number; y: number; caption?: string }) {
  return (
    <g className="dc-cursor" transform={`translate(${x} ${y})`}>
      <path d="M0 0 L0 18 L5 13 L9 22 L12 21 L8 12 L15 12 Z" />
      {caption && (
        <text x={18} y={28} className="dc-cursor-caption">
          {caption}
        </text>
      )}
    </g>
  )
}

// ------------------------------------------------------------------ the ring of controls


interface RingProps {
  el: SceneElement
  scene: Scene
  at: { x: number; y: number; side: string }
  pop: Pop
  setPop: (p: Pop) => void
  commit: StageProps['commit']
  onEdit: () => void
  onDone: () => void
  coarse: boolean
}

const Ring = forwardRef<HTMLDivElement, RingProps>(function Ring({ el, scene, at, pop, setPop, commit, onEdit, onDone }, ref) {
  const colourable = el.kind === 'text' || el.kind === 'rect'
  const now = el.kind === 'text' ? el.color : el.fill
  const swatches = paletteOf(scene)
  const toggle = (k: Exclude<Pop, null>) => setPop(pop === k ? null : k)
  const style: CSSProperties = { left: at.x, top: at.y }
  const name = describeElement(el)
  return (
    <div ref={ref} className="dc-ring dc-recede" style={style} data-side={at.side} role="toolbar" aria-label={`Change ${name}`} onKeyDown={(e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (pop) setPop(null)
        else onDone()
      }
      // arrow keys move between the ring's buttons (one tab stop for the toolbar)
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const bs = [...(e.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > .dc-ring-row > button'))]
        const i = bs.indexOf(document.activeElement as HTMLButtonElement)
        if (i >= 0) {
          e.preventDefault()
          bs[(i + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length].focus()
        }
      }
    }}>
      <div className="dc-ring-row">
        {el.kind === 'text' && (
          <button type="button" className="dc-ring-btn" onClick={onEdit} aria-label="Edit the words" title="Edit the words (Enter)">
            <Icon name="edit" size={17} />
            <span className="dc-ring-word">Text</span>
          </button>
        )}
        {colourable && (
          <button type="button" className="dc-ring-btn" aria-expanded={pop === 'colour'} aria-label="Colour" title="Colour" onClick={() => toggle('colour')}>
            <span className="dc-swatch" style={{ background: now }} aria-hidden="true" />
            <span className="dc-ring-word">Colour</span>
          </button>
        )}
        <button type="button" className="dc-ring-btn" aria-expanded={pop === 'size'} aria-label="Size" title="Size" onClick={() => toggle('size')}>
          <span className="dc-glyph" aria-hidden="true">{el.kind === 'text' ? 'Aa' : '⤢'}</span>
          <span className="dc-ring-word">Size</span>
        </button>
        <button type="button" className="dc-ring-btn" aria-expanded={pop === 'layer'} aria-label="Layer" title="Layer" onClick={() => toggle('layer')}>
          <Icon name="layers" size={17} />
          <span className="dc-ring-word">Layer</span>
        </button>
        <button type="button" className="dc-ring-btn dc-ring-danger" aria-label={`Remove ${name}`} title="Remove (Delete)" onClick={() => void commit([remove(el)], { select: null, say: `${name} removed.` })}>
          <Icon name="trash" size={17} />
        </button>
      </div>
      {pop === 'colour' && colourable && (
        <div className="dc-pop" role="group" aria-label="Colours from this design">
          {swatches.map((c) => (
            <button key={c} type="button" className="dc-swatch-btn" aria-label={`Colour ${c}`} aria-pressed={now?.toUpperCase() === c} style={{ background: c }} onClick={() => void commit([recolour(el, c)])} />
          ))}
          <label className="dc-swatch-btn dc-swatch-any" title="Any colour">
            <span className="sr-only">Any colour</span>
            <input type="color" value={isColour(now) ? now : '#000000'} onChange={(e) => void commit([recolour(el, e.target.value.toUpperCase())])} />
          </label>
        </div>
      )}
      {pop === 'size' && (
        <div className="dc-pop" role="group" aria-label="Size">
          <button type="button" className="dc-pop-btn" onClick={() => void commit([resizeStep(scene, el, 1 / 1.12)])}>Smaller</button>
          <button type="button" className="dc-pop-btn" onClick={() => void commit([resizeStep(scene, el, 1.12)])}>Larger</button>
          {el.kind === 'text' && (
            <button type="button" className="dc-pop-btn" aria-pressed={el.weight === 'bold'} onClick={() => void commit([toggleWeight(el)])}>Bold</button>
          )}
        </div>
      )}
      {pop === 'layer' && (
        <div className="dc-pop" role="group" aria-label="Layer">
          <button type="button" className="dc-pop-btn" onClick={() => void commit([layer(scene, el, 'front')])}>Bring to front</button>
          <button type="button" className="dc-pop-btn" onClick={() => void commit([layer(scene, el, 'back')])}>Send to back</button>
        </div>
      )}
    </div>
  )
})

// ------------------------------------------------------------------ editing words in place

function TextEditor({ el, box, scale, onDone }: { el: SceneElement; box: Rect; scale: number; onDone: (text: string | null) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const done = useRef(false)
  useEffect(() => {
    const t = ref.current
    if (!t) return
    t.focus()
    t.select()
  }, [])
  const finish = (text: string | null) => {
    if (done.current) return
    done.current = true
    onDone(text)
  }
  const size = (el.fontSize ?? 16) * scale
  return (
    <textarea
      ref={ref}
      className="dc-edit"
      aria-label="The words"
      defaultValue={el.text}
      maxLength={10000}
      style={{ left: box.x, top: box.y, width: Math.max(80, box.width), minHeight: Math.max(size * 1.4, box.height), fontSize: size, lineHeight: LINE, color: el.color, fontWeight: el.weight === 'bold' ? 700 : 400, fontFamily: fontOf(el) }}
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        // an IME's confirming Enter belongs to the input method (features/ask/keys; r2.4 sweep)
        if (guardComposing(e)) return
        if (e.key === 'Escape') {
          e.preventDefault()
          finish(null)
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          finish(e.currentTarget.value)
        }
      }}
    />
  )
}

// ------------------------------------------------------------------ adding: right-click or long-press empty space

function AddMenu({ at, stage, reserve, onPick, onClose }: { at: Point; stage: Size; reserve: Reserve; onPick: (w: 'text' | 'block' | 'picture' | 'direction') => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
  }, [onClose])
  const w = 220
  const h = 196
  const left = Math.max(8, Math.min(stage.width - w - 8, at.x))
  const top = Math.max(reserve.top + 8, Math.min(stage.height - reserve.bottom - h - 8, at.y))
  const items: [Parameters<typeof onPick>[0], string, string][] = [
    ['text', 'Text', 'Words where you pointed'],
    ['block', 'Block', 'A shape in the design’s colour'],
    ['picture', 'Picture', 'A PNG or JPEG from this device'],
    ['direction', 'Another direction', 'Ask for a different take'],
  ]
  return (
    <div
      ref={ref}
      className="dc-menu"
      role="menu"
      aria-label="Add to the design"
      style={{ left, top, width: w }}
      onKeyDown={(e) => {
        e.stopPropagation()
        const bs = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
        const i = bs.indexOf(document.activeElement as HTMLButtonElement)
        const to = e.key === 'ArrowDown' ? (i + 1) % bs.length : e.key === 'ArrowUp' ? (i - 1 + bs.length) % bs.length : -1
        if (to >= 0) {
          e.preventDefault()
          bs[to].focus()
        } else if (e.key === 'Escape' || e.key === 'Tab') {
          e.preventDefault()
          onClose()
        }
      }}
    >
      {items.map(([id, label, hint]) => (
        <button key={id} type="button" role="menuitem" className="dc-menu-item" onClick={() => onPick(id)}>
          <span className="dc-menu-label">{label}</span>
          <span className="dc-menu-hint">{hint}</span>
        </button>
      ))}
    </div>
  )
}
