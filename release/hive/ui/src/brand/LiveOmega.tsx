import { useEffect, useRef, useState, type ReactNode } from 'react'
import { effectivePace, nextFrame, reallyShown, type MarkPace } from './markPace'
import { useReducedMotion } from '../lib/hooks'
import { markLook } from './stills'
import { timeJump } from './timeJump'

/** The renderer (three r186 WebGLRenderer) needs WebGL 2; probe exactly that, and release the probe's context. */
const webgl = () => {
  try { const g = document.createElement('canvas').getContext('webgl2'); g?.getExtension('WEBGL_lose_context')?.loseContext(); return !!g } catch { return false }
}

/** The renderer's surface, as this wrapper uses it (./live/mark is the reel's own code, shared untyped). */
interface LiveMark { morphTo(look: string, action?: string | null): Promise<void>; act(action: string): void; pulse(style: string): void; behave(name: string): void; calm(): void; presence(state: string, level?: number): void; render(t: number): void; cancelChange(): void; look: string; target: string | null; mp: number
  init(look: string): Promise<void>; dispose(): void }

/**
 * Set up a constructed mark, owning it throughout: if setup rejects or does not finish within `ms`, the mark is
 * disposed (its WebGL context, textures, composer) and false is returned. Exported for its test.
 */
export async function initOwned(mk: { init(look: string): Promise<unknown>; dispose(): void }, look: string, ms = 15000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([mk.init(look), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('mark setup timed out')), ms) })])
    return true
  } catch { mk.dispose(); return false } finally { if (timer) clearTimeout(timer) }
}

/**
 * A living Omega: the reel's own renderer, transparent, wearing the material of whatever this mark stands for (`look`:
 * the experience it sits in, an app, a hero's scene) and morphing in that material's own way when it changes. Every
 * mark is its own instance. Decoration only, never the only signal. `fallback` (the flat glyph, or a still) shows until
 * it has drawn, and instead of it under reduced motion or without WebGL. It pauses off screen and in hidden tabs.
 */
export function LiveOmega({ look, size, fallback, className = '', presence, pulse, hold, pace = 'awake', onLive }: {
  look?: string | null; size: 'corner' | 'hero'; fallback: ReactNode; className?: string
  /** what it is doing (the Ask's own mark): listening leans in, speaking ripples; and a pulse of a style's own particles */
  presence?: { state: 'idle' | 'listening' | 'speaking'; level: number }; pulse?: { kind: 'behave' | 'style'; name: string; key: string } | null
  /** a behaviour held while a state lasts (leaning in while you type, still while it waits, flowers talking while it answers) */
  hold?: string | null
  /**
   * How often it may draw (Ask-and-apps contract R1.1 #3, the weakest device; brand/markPace): 'still' draws once and runs
   * no frame loop, 'awake' (the default) at most ~30 times a second, 'full' a hero every frame. Off screen, hidden by CSS,
   * in a hidden tab, or while the shell rests: never.
   */
  pace?: MarkPace
  /** told when the living mark is on screen (true) and when it isn't, or no longer is (false): a host that draws its own
   * stand-in behind the mark (Cosmos's star) shows it only while the mark can't */
  onLive?: (live: boolean) => void
}) {
  const m = markLook(look), reduce = useReducedMotion(), box = useRef<HTMLDivElement>(null)
  const mark = useRef<LiveMark | null>(null), shown = useRef(m), [ready, setReady] = useState(false)
  // a mark that fails (a lost context) shows its stand-in at once, not over a fade: the centre is never empty
  const [cut, setCut] = useState(false)
  // the mark's own clock: it runs backwards while a change is being undone (a true rewind, like a tape), forwards otherwise
  const clock = useRef({ scene: 0, last: 0, dir: 1, since: 0 })
  const paceRef = useRef(pace), wakeRef = useRef<() => void>(() => undefined)
  useEffect(() => { paceRef.current = pace; wakeRef.current() }, [pace])

  useEffect(() => {
    const el = box.current
    if (reduce || !el || !webgl()) return
    let gone = false, raf = 0, timer = 0, visible = true, last = 0
    const canvas = document.createElement('canvas'), dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.max(1, Math.round(el.clientWidth * dpr)); canvas.height = Math.max(1, Math.round(el.clientHeight * dpr))
    canvas.setAttribute('aria-hidden', 'true'); canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none'
    let pending: LiveMark | null = null
    const fail = () => { setCut(true); gone = true; if (raf) cancelAnimationFrame(raf); raf = 0; if (timer) clearTimeout(timer); timer = 0; mark.current?.dispose(); pending?.dispose(); mark.current = null; canvas.remove(); setReady(false) }   // back to the still or glyph
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); fail() }, { once: true })
    const tick = (now: number) => {
      raf = 0
      if (gone || !mark.current) return
      if ((size === 'hero' && paceRef.current === 'full') || now - last > 32) {                          // a corner mark, or any awake mark, draws at most ~30 times a second; a full hero every frame
        last = now; const c = clock.current, dt = Math.min(.1, (now - (c.last || now)) / 1000); c.last = now; c.scene += dt * c.dir
        try {
          mark.current.render(c.scene)
          if (c.dir < 0 && (mark.current.mp <= .001 || now - c.since > 4000)) { mark.current.cancelChange(); c.dir = 1 }   // rewound to the start (or 4 s at most): as if it never began
        } catch { fail(); return }
      }
      schedule()
    }
    // the next frame only while really shown and the shell is not resting (brand/markPace; the counted gate, §9.4)
    const schedule = () => {
      const pace = effectivePace(paceRef.current, reallyShown(el, visible, document.hidden), document.documentElement.dataset.shellPhase, size)
      const next = nextFrame(pace, size)
      if (next === 'none') return
      if (next === 'raf') { raf = requestAnimationFrame(tick); return }
      timer = window.setTimeout(() => { timer = 0; if (!gone) raf = requestAnimationFrame(tick) }, next)
    }
    // still: one frame (to show the change), then no loop until the pace moves again
    const wake = () => { if (!raf && !timer && !gone && visible && !document.hidden && mark.current) raf = requestAnimationFrame(tick) }
    wakeRef.current = wake
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; wake() }); io.observe(el)
    document.addEventListener('visibilitychange', wake)
    // the shell's state moves (rest, awake, Pro): a still mark may wake, a drawing one goes still on its next frame
    const phaseWatch = new MutationObserver(wake); phaseWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-shell-phase'] })
    import('./live/mark')
      .then(async ({ OmegaMark }) => {
        if (gone) return
        el.appendChild(canvas)
        // film-only paths off in the app: no frame readback, no sound, no film-only pieces, no stage or showcase
        const mk = new OmegaMark(canvas, { look: shown.current, base: `${import.meta.env.BASE_URL}brand/`, texExt: 'webp', cameraZ: size === 'corner' ? 600 : 760, reduce: false, preserveDrawingBuffer: false, sound: false, filmPieces: false }) as unknown as LiveMark   // owned from construction: disposed on failure, timeout or unmount
        pending = mk
        const ok = await initOwned(mk, shown.current)
        pending = null
        if (!ok) { canvas.remove(); return }
        if (gone) { mk.dispose(); return }
        mark.current = mk
        clock.current = { scene: 0, last: 0, dir: 1, since: 0 }
        try { mk.render(0) } catch { fail(); return }
        setReady(true); wake()
      })
      .catch(() => canvas.remove())
    return () => { gone = true; if (raf) cancelAnimationFrame(raf); if (timer) clearTimeout(timer); io.disconnect(); phaseWatch.disconnect(); document.removeEventListener('visibilitychange', wake); mark.current?.dispose(); pending?.dispose(); mark.current = null; canvas.remove(); setReady(false) }
  }, [reduce, size])

  // the thing it stands for changed: morph, in the new material's own way (omega-mark.metta, morph-style); changed back
  // before the morph finished: rewind it
  useEffect(() => {
    if (m === shown.current) return
    shown.current = m
    const mk = mark.current
    if (!mk) return
    if (mk.target && m === mk.look) { clock.current.dir = -1.6; clock.current.since = performance.now(); timeJump() }          // undone mid-change: it literally rewinds (and the clock shows 1.21 GW)
    else { clock.current.dir = 1; void mk.morphTo(m) }
  }, [m])

  // live only once its first frame is on screen (rendered, then a painted frame later), so a host's stand-in never
  // goes before something is drawn in its place (Kimi, looks r1)
  const onLiveRef = useRef(onLive)
  useEffect(() => { onLiveRef.current = onLive })
  const [painted, setPainted] = useState(false)
  useEffect(() => {
    if (!ready) return
    let b = 0
    const a = requestAnimationFrame(() => { b = requestAnimationFrame(() => setPainted(true)) })
    // a mark that stops being ready is unpainted with it, so the next ready waits for its own first frame
    return () => { cancelAnimationFrame(a); cancelAnimationFrame(b); setPainted(false) }
  }, [ready])
  const live = ready && painted
  useEffect(() => { onLiveRef.current?.(live); return () => onLiveRef.current?.(false) }, [live])
  useEffect(() => { if (presence) mark.current?.presence(presence.state, presence.level) }, [presence?.state, presence?.level, ready])
  useEffect(() => { if (pulse) { if (pulse.kind === 'behave') mark.current?.behave(pulse.name); else mark.current?.pulse(pulse.name) } }, [pulse?.key])
  useEffect(() => { if (hold) mark.current?.behave(hold); else mark.current?.calm() }, [hold, ready])

  return (
    <div ref={box} className={`relative ${className}`} aria-hidden="true">
      <div className={`size-full transition-opacity ${cut ? 'duration-0' : 'duration-300'} ${ready ? 'opacity-0' : 'opacity-100'}`}>{fallback}</div>
    </div>
  )
}
