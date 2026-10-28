import { animate, m, useMotionTemplate, useMotionValue, usePresence } from 'framer-motion'
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { hsl, type Agent } from '../sdk'
import { INK, INK2, useFlux, useSlot, type Origin } from './ctx'

/**
 * A liquid-glass panel. It is revealed by a circle that grows out of the liquid you touched (and drains back into
 * it on close); the shader draws the glass itself (frost, refraction at the edge, the specular rim) from the same
 * rectangle and circle, so the glass is made of the liquid.
 */
export function LiquidPanel({ glassKey, origin, label, className, style, radius = 34, children }: {
  glassKey: string
  origin?: Origin
  label: string
  className?: string
  style?: CSSProperties
  radius?: number
  children: ReactNode
}) {
  const { world, reduced, gpu } = useFlux()
  const ref = useRef<HTMLDivElement>(null)
  const r = useMotionValue(reduced ? 3000 : 0)
  const ox = useMotionValue(0)
  const oy = useMotionValue(0)
  const sc = useMotionValue(reduced ? 1 : 0.94)
  const [isPresent, safeToRemove] = usePresence()
  const clip = useMotionTemplate`circle(${r}px at ${ox}px ${oy}px)`

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const o = origin ?? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    ox.set(o.x - rect.left)
    oy.set(o.y - rect.top)
  }, [origin, ox, oy])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = { width: el.offsetWidth, height: el.offsetHeight }
    const far = Math.max(...[[0, 0], [rect.width, 0], [0, rect.height], [rect.width, rect.height]].map(([x, y]) => Math.hypot(x - ox.get(), y - oy.get()))) + 60
    if (isPresent) {
      const a = animate(r, far, reduced ? { duration: 0 } : { type: 'spring', stiffness: 70, damping: 16, mass: 1 })
      const b = animate(sc, 1, reduced ? { duration: 0 } : { type: 'spring', stiffness: 240, damping: 14 })
      if (!el.contains(document.activeElement)) (el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true })
      return () => { a.stop(); b.stop() }
    }
    const a = animate(r, 0, reduced ? { duration: 0, onComplete: safeToRemove } : { duration: 0.5, ease: [0.55, 0, 0.75, 0.3], onComplete: safeToRemove })
    const b = animate(sc, 0.96, { duration: reduced ? 0 : 0.5 })
    return () => { a.stop(); b.stop() }
  }, [isPresent, r, sc, ox, oy, reduced, safeToRemove])

  useEffect(() => {
    const el = ref.current
    if (!el || !gpu) return
    world.glass.set(glassKey, {
      el,
      radius,
      clip: () => {
        const rect = el.getBoundingClientRect()
        return { x: rect.left + ox.get() * (rect.width / el.offsetWidth || 1), y: rect.top + oy.get() * (rect.height / el.offsetHeight || 1), r: r.get() * (rect.width / el.offsetWidth || 1) }
      },
    })
    return () => {
      if (world.glass.get(glassKey)?.el === el) world.glass.delete(glassKey)
    }
  }, [world, gpu, glassKey, radius, ox, oy, r])

  return (
    <m.div
      ref={ref}
      // glass beside the liquid, not a modal: the liquid and the pill stay usable around it (decisions are the shared,
      // contained DecisionDialog); a named region, so it is announced and reachable as a landmark
      role="region"
      aria-label={label}
      className={className}
      style={{
        ...style,
        clipPath: clip,
        WebkitClipPath: clip,
        scale: sc,
        borderRadius: radius,
        color: INK,
        background: gpu ? 'transparent' : 'linear-gradient(180deg, rgb(34 18 58 / 0.86), rgb(18 9 34 / 0.9))',
        backdropFilter: gpu ? undefined : 'blur(24px) saturate(160%)',
        WebkitBackdropFilter: gpu ? undefined : 'blur(24px) saturate(160%)',
        boxShadow: gpu ? undefined : 'inset 0 1px 0 rgb(255 255 255 / 0.28), inset 0 0 0 1px rgb(255 255 255 / 0.1), 0 30px 80px rgb(0 0 0 / 0.5)',
      }}
    >
      {children}
    </m.div>
  )
}

/** Where a droplet pours into a panel. With the GPU off it shows a glass orb instead. */
export function Slot({ slotKey, size, hue, dim, className }: { slotKey: string; size: number; hue: number; dim?: boolean; className?: string }) {
  const { gpu } = useFlux()
  const ref = useSlot(slotKey)
  return (
    <span ref={ref} aria-hidden className={`relative inline-block shrink-0 rounded-full ${className ?? ''}`} style={{ width: size, height: size }}>
      {!gpu && <Orb hue={hue} size={size} dim={dim} />}
    </span>
  )
}

export function Orb({ hue, size, dim }: { hue: number; size: number; dim?: boolean }) {
  const s = dim ? 35 : 90
  const l = dim ? 42 : 62
  return (
    <span
      className="absolute inset-0 rounded-full"
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle at 34% 28%, rgb(255 255 255 / 0.95) 0, ${hsl(hue, s, l + 16)} 14%, ${hsl(hue, s, l)} 45%, ${hsl(hue, s, l - 30)} 100%)`,
        boxShadow: `0 0 ${size * 0.5}px ${hsl(hue, s, l, 0.55)}, inset 0 -${size * 0.12}px ${size * 0.2}px rgb(0 0 0 / 0.3)`,
      }}
    />
  )
}

export function GooDefs() {
  return (
    <svg aria-hidden width="0" height="0" style={{ position: 'absolute' }}>
      <defs>
        <filter id="flux-goo">
          <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="b" />
          <feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8" result="g" />
          <feComposite in="SourceGraphic" in2="g" operator="atop" />
        </filter>
      </defs>
    </svg>
  )
}

/** Three droplets that merge and split while a mind thinks. */
export function ThinkingDrops({ hue, label = 'Thinking' }: { hue: number; label?: string }) {
  const { reduced } = useFlux()
  return (
    <span role="status" className="inline-flex items-center gap-2" style={{ color: INK2 }}>
      <span className="relative inline-flex h-5 w-12 items-center" style={{ filter: 'url(#flux-goo)' }} aria-hidden>
        {[0, 1, 2].map((i) => (
          <m.span
            key={i}
            className="absolute size-3 rounded-full"
            style={{ left: 4 + i * 13, background: hsl(hue, 90, 70) }}
            animate={reduced ? undefined : { x: [0, i === 1 ? 0 : i === 0 ? 8 : -8, 0], scale: [1, 1.25, 1] }}
            transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut', delay: i * 0.12 }}
          />
        ))}
      </span>
      <span className="text-[13px]">{label}</span>
    </span>
  )
}

const P: Record<string, string> = {
  close: 'M6 6l12 12M18 6L6 18',
  back: 'M15 5l-7 7 7 7',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM16.5 16.5L21 21',
  home: 'M12 3c4 4.5 7 7.7 7 11a7 7 0 0 1-14 0c0-3.3 3-6.5 7-11z',
  drop: 'M12 3c3 4 6 7 6 10.5a6 6 0 0 1-12 0C6 10 9 7 12 3z',
  plus: 'M12 5v14M5 12h14',
  send: 'M5 12h13M13 6l6 6-6 6',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  sun: 'M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10zM12 1.5v2.5M12 20v2.5M1.5 12H4M20 12h2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8',
  open: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  check: 'M5 12.5l4.5 4.5L19 7',
  power: 'M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0',
  grid: 'M5 5h5v5H5zM14 5h5v5h-5zM5 14h5v5H5zM14 14h5v5h-5z',
  swarm: 'M8.5 9a3 3 0 1 1 0-.01M16 7.5a2.5 2.5 0 1 1 0-.01M14.5 17a3.5 3.5 0 1 1 0-.01M12 4v0M19 13v0',
}

export function Glyph({ name, size = 20, stroke = 1.9 }: { name: keyof typeof P | string; size?: number; stroke?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      <path d={P[name]} />
    </svg>
  )
}

/** A round glass button. */
export function GlassButton({ label, icon, onClick, size = 40, className, autoFocus }: { label: string; icon: string; onClick: () => void; size?: number; className?: string; autoFocus?: boolean }) {
  return (
    <m.button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      data-autofocus={autoFocus ? '' : undefined}
      whileHover={{ scale: 1.08 }}
      whileTap={{ scale: 0.9 }}
      transition={{ type: 'spring', stiffness: 500, damping: 18 }}
      className={`flux-focus grid shrink-0 place-items-center rounded-full ${className ?? ''}`}
      style={{ width: size, height: size, color: INK, background: 'radial-gradient(circle at 35% 25%, rgb(255 255 255 / 0.22), rgb(255 255 255 / 0.06) 60%)', boxShadow: 'inset 0 1px 0 rgb(255 255 255 / 0.3), inset 0 0 0 1px rgb(255 255 255 / 0.12)' }}
    >
      <Glyph name={icon} size={size * 0.46} />
    </m.button>
  )
}

/** Wake / sleep as a liquid switch: the knob stretches as it travels. */
export function LiquidSwitch({ agent, onToggle }: { agent: Agent; onToggle: () => void }) {
  const { reduced } = useFlux()
  const on = agent.status === 'awake' || agent.status === 'starting'
  const busy = agent.status === 'starting'
  const label = agent.status === 'stopped' || agent.status === 'created' ? 'Start' : on ? 'Awake' : agent.status === 'error' ? 'Wake again' : 'Asleep'
  const action = on ? 'Put to sleep' : agent.status === 'stopped' || agent.status === 'created' ? 'Start' : 'Wake'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`${action} ${agent.name}`}
      onClick={onToggle}
      className="flux-focus group inline-flex items-center gap-2.5 rounded-full py-1.5 pl-1.5 pr-3.5 text-[13px] font-semibold"
      style={{ color: INK, background: 'rgb(255 255 255 / 0.07)', boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.14)' }}
    >
      <span className="relative h-7 w-12 rounded-full" style={{ background: on ? hsl(agent.hue, 70, 30, 0.9) : 'rgb(255 255 255 / 0.1)', boxShadow: 'inset 0 1px 3px rgb(0 0 0 / 0.4)' }}>
        <m.span
          className="absolute top-1 size-5 rounded-full"
          initial={false}
          animate={{ left: on ? 24 : 4, scaleX: reduced ? 1 : [1, 1.45, 1] }}
          transition={{ left: { type: 'spring', stiffness: 380, damping: 20 }, scaleX: { duration: 0.35 } }}
          style={{ background: on ? `radial-gradient(circle at 35% 30%, #fff, ${hsl(agent.hue, 90, 72)} 55%)` : 'radial-gradient(circle at 35% 30%, #fff, #a99cbe 60%)', boxShadow: on ? `0 0 14px ${hsl(agent.hue, 90, 65, 0.8)}` : undefined }}
        />
        {busy && <m.span aria-hidden className="absolute inset-0 rounded-full" animate={{ opacity: [0.2, 0.7, 0.2] }} transition={{ duration: 1.1, repeat: Infinity }} style={{ boxShadow: `0 0 0 2px ${hsl(agent.hue, 90, 70)}` }} />}
      </span>
      <span>{busy ? 'Waking…' : label}</span>
    </button>
  )
}

export function Chip({ children, hue }: { children: ReactNode; hue?: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold" style={{ color: INK, background: hue != null ? hsl(hue, 80, 55, 0.2) : 'rgb(255 255 255 / 0.09)', boxShadow: `inset 0 0 0 1px ${hue != null ? hsl(hue, 80, 70, 0.35) : 'rgb(255 255 255 / 0.14)'}` }}>
      {children}
    </span>
  )
}

/**
 * A motivation a task serves (its why), as a small liquid chip. Quieter when the motivation is not active. Touching it
 * shows the tasks under that motivation; it changes nothing and tells no mind anything.
 */
export function MotivationChip({ m: mo, on, onClick }: { m: { id: string; title: string; status: string }; on?: boolean; onClick: () => void }) {
  const quiet = mo.status !== 'active'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      aria-label={`Tasks under “${mo.title}”${quiet ? `, ${mo.status}` : ''}`}
      data-motivation-chip={mo.id}
      className="flux-focus inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-semibold hover:bg-white/10"
      style={{ color: quiet ? INK2 : INK, background: on ? 'rgb(255 200 240 / 0.24)' : quiet ? 'rgb(255 255 255 / 0.04)' : 'rgb(255 190 235 / 0.1)', boxShadow: `inset 0 0 0 1px ${quiet ? 'rgb(255 255 255 / 0.14)' : 'rgb(255 190 235 / 0.4)'}` }}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: quiet ? '#b9add0' : '#ffb8e6' }} />
      <span className="truncate">{mo.title}</span>
      {quiet && <span aria-hidden className="shrink-0 font-normal">· {mo.status}</span>}
    </button>
  )
}
