import { plural } from '../../lib/plural'
import { m } from 'framer-motion'
import { useEffect, useState } from 'react'
import { useHive } from '../sdk'
import { pendingList } from './model'

/** The jack-in sequence. Any key, click or tap skips it; under reduced motion it never plays. */
export function Boot({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)
  const [typed, setTyped] = useState(0)
  const hive = useHive((s) => s.hive)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const approvals = useHive((s) => s.approvals)
  const conn = useHive((s) => s.connection)
  const nMinds = Object.keys(agents).length
  const nSwarms = Object.keys(swarms).length
  const waiting = pendingList(approvals).length
  const lines: { l: string; r: string; tone?: string }[] = [
    { l: 'establishing carrier', r: 'OK' },
    { l: `link ${hive?.name ?? 'omegahive'} ${hive?.version ?? ''}`.trim(), r: conn === 'open' || conn === 'idle' ? 'OK' : conn.toUpperCase() },
    { l: `indexing ${plural(nMinds, 'mind')} · ${plural(nSwarms, 'swarm')}`, r: 'OK' },
    { l: 'inbox', r: waiting ? `${waiting} WAITING` : 'CLEAR', tone: waiting ? 'amber' : undefined },
    { l: 'loading operator programs', r: 'OK' },
  ]
  const wake = 'wake up, operator. the hive has you.'
  useEffect(() => {
    if (step < lines.length) {
      const t = setTimeout(() => setStep((s) => s + 1), 150 + Math.random() * 90)
      return () => clearTimeout(t)
    }
    if (typed < wake.length) {
      const t = setTimeout(() => setTyped((n) => n + 1), 24)
      return () => clearTimeout(t)
    }
    const t = setTimeout(onDone, 520)
    return () => clearTimeout(t)
  }, [step, typed, lines.length, onDone])
  useEffect(() => {
    const skip = (e: Event) => {
      if (e instanceof KeyboardEvent && (e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      e.stopPropagation()
      onDone()
    }
    window.addEventListener('keydown', skip, true)
    window.addEventListener('pointerdown', skip, true)
    return () => {
      window.removeEventListener('keydown', skip, true)
      window.removeEventListener('pointerdown', skip, true)
    }
  }, [onDone])
  return (
    <m.div className="cx-boot" initial={{ opacity: 1 }} exit={{ opacity: 0, scale: 1.04, filter: 'brightness(2.2)' }} transition={{ duration: 0.38, ease: 'easeIn' }} role="status" aria-label="Connecting to the hive">
      <div className="cx-boot-in">
        <div className="cx-boot-title">
          <span className="cx-c-inv">OMEGAHIVE // CONSTRUCT</span> <span className="cx-c-dim">v1.0 · operator shell</span>
        </div>
        {lines.slice(0, step).map((x, i) => (
          <div key={i} className="cx-boot-l">
            <span className="cx-c-dim">» </span>
            <span className="cx-c-txt">{x.l} </span>
            <span className="cx-boot-dots" aria-hidden />
            <span className={x.tone === 'amber' ? 'cx-c-amber' : 'cx-c-hi'}> [ {x.r} ]</span>
          </div>
        ))}
        {step >= lines.length && (
          <div className="cx-boot-wake cx-c-hi cx-glow">
            {wake.slice(0, typed)}
            <span className="cx-cursor" />
          </div>
        )}
        <div className="cx-boot-skip cx-c-dim">press any key to skip</div>
      </div>
    </m.div>
  )
}
