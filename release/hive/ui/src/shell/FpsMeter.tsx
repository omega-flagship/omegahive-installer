import { useEffect, useRef } from 'react'
import { frameStats, setFpsMeter, useFpsMeterOn } from './fpsMeterState'

/**
 * A small live frame-rate meter for testing experiences on a real device: fps over the last second, the 95th
 * percentile frame time, the worst frame, and a sparkline of recent frames. It only measures; it never changes
 * rendering. On with `?fps=1`, from the Ω menu or from Change UI; the choice is remembered on this device.
 */
const W = 96
const H = 22

export function FpsMeter({ place = 'escape' }: { place?: 'escape' | 'centre' }) {
  const show = useFpsMeterOn()
  const text = useRef<HTMLSpanElement>(null)
  const detail = useRef<HTMLSpanElement>(null)
  const spark = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!show) return
    let raf = 0
    let last = performance.now()
    let lastPaint = last
    const recent: number[] = [] // the last second of frames
    const history: number[] = [] // one bar per frame for the sparkline
    const tick = (t: number) => {
      const d = t - last
      last = t
      if (d > 0 && d < 1000) {
        recent.push(d)
        history.push(d)
        if (history.length > W) history.shift()
        let sum = recent.reduce((a, b) => a + b, 0)
        while (sum > 1000 && recent.length > 1) sum -= recent.shift()!
      }
      // update the readout twice a second; drawing is cheap and never touches React state
      if (t - lastPaint > 500) {
        lastPaint = t
        const s = frameStats(recent)
        if (text.current) {
          text.current.textContent = `${s.fps} fps`
          text.current.style.color = s.fps >= 55 ? '#4ade80' : s.fps >= 30 ? '#fbbf24' : '#fb7185'
        }
        if (detail.current) detail.current.textContent = `p95 ${s.p95}ms · worst ${s.worst}ms${s.slow ? ` · ${s.slow} slow` : ''}`
        const c = spark.current?.getContext('2d')
        if (c) {
          c.clearRect(0, 0, W, H)
          history.forEach((ms, i) => {
            const h = Math.min(H, (ms / 50) * H)
            c.fillStyle = ms <= 17.5 ? '#4ade80' : ms <= 33.4 ? '#fbbf24' : '#fb7185'
            c.fillRect(i, H - h, 1, h)
          })
          c.fillStyle = 'rgb(255 255 255 / 0.35)'
          c.fillRect(0, H - (16.7 / 50) * H, W, 1) // the 60 fps line
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const onVis = () => {
      cancelAnimationFrame(raf)
      if (!document.hidden) {
        last = performance.now()
        recent.length = 0
        raf = requestAnimationFrame(tick)
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [show])

  if (!show) return null
  return (
    <div
      role="status"
      aria-label="Frame rate"
      className={`xc-dress xc-frame pointer-events-auto fixed bottom-3 z-[81] flex ${place === 'escape' ? 'left-14' : 'left-1/2 -translate-x-1/2'} items-center gap-2 rounded-xl border border-white/15 bg-black/80 px-2 py-1 font-mono text-[11px] text-white/80 shadow-lg backdrop-blur-md`}
      style={{ marginBottom: 'var(--sab, 0px)' }}
      data-tour="fps-meter"
    >
      <span ref={text} className="min-w-[46px] text-[12px] font-semibold tabular-nums">— fps</span>
      <canvas ref={spark} width={W} height={H} className="block" aria-hidden="true" />
      <span ref={detail} className="hidden tabular-nums sm:inline">measuring…</span>
      <button onClick={() => setFpsMeter(false)} aria-label="Hide frame rate" className="ml-0.5 px-1 text-white/60 hover:text-white">
        ×
      </button>
    </div>
  )
}
