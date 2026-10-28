import { m } from 'framer-motion'
import { useRef, useState } from 'react'
import { hsl } from '../../lib/color'
import { copyText, useEscape } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Button, Orb } from '../../ui/primitives'
import { shown } from '../../lib/displayName'
import { useModalContainment } from '../../ui/useModalContainment'

/** Shows the one-time agent token right after birth. */
export default function TokenReveal() {
  const reveal = useHive((s) => s.reveal)
  const clear = useHive((s) => s.clearReveal)
  const status = useHive((s) => (reveal ? s.agents[reveal.agent.id]?.status : undefined))
  const [copied, setCopied] = useState(false)
  const [ack, setAck] = useState(false)
  useEscape(clear, ack)
  const box = useRef<HTMLDivElement>(null)
  useModalContainment(box, { active: !!reveal })
  if (!reveal) return null
  const { agent, token } = reveal

  return (
    <m.div className="xc-dress xc-backdrop fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-0 md:items-center md:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <m.div
        ref={box}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="reveal-title"
        aria-describedby="reveal-warn"
        initial={{ y: 60, opacity: 0, scale: 0.97 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 32 }}
        className="xc-frame xc-flush-b glass-strong relative w-full max-w-md overflow-hidden rounded-t-[28px] p-6 md:rounded-[28px]"
        style={{ paddingBottom: 'calc(var(--sab) + 24px)' }}
      >
        <div className="pointer-events-none absolute inset-x-0 -top-24 h-64" style={{ background: `radial-gradient(50% 60% at 50% 50%, ${hsl(agent.hue, 100, 60, 0.4)}, transparent)` }} />
        <div className="relative flex flex-col items-center text-center">
          <m.div initial={{ scale: 0.2, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 160, damping: 12, delay: 0.1 }}>
            <Orb hue={agent.hue} size={72} status={status ?? 'starting'} />
          </m.div>
          <h2 id="reveal-title" className="mt-3 font-display text-2xl font-semibold tracking-tight">
            {shown(agent.name)} is alive
          </h2>
          <p className="mt-1 text-sm text-ink-3">Here is its agent token, for the hub, the LLM gateway and the publish API.</p>
        </div>

        <div className="relative mt-5">
          <div className="eyebrow mb-1.5">Agent token</div>
          <div className="flex items-stretch gap-2">
            <code className="min-w-0 flex-1 rounded-xl border border-line bg-black/40 px-3 py-3 font-mono text-[13px] leading-relaxed break-all text-ink select-all">{token}</code>
            <button
              onClick={async () => {
                if (await copyText(token)) {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1800)
                }
              }}
              className="flex w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl border border-line bg-white/[0.06] text-[10px] text-ink-2 hover:bg-white/[0.1]"
              aria-label={copied ? 'Copied' : 'Copy token'}
            >
              <Icon name={copied ? 'check' : 'copy'} size={18} className={copied ? 'text-good' : ''} />
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        <div id="reveal-warn" className="relative mt-4 flex gap-3 rounded-xl border border-warn/30 bg-warn/[0.08] p-3 text-[13px] leading-relaxed">
          <Icon name="alert" size={18} className="mt-0.5 shrink-0 text-warn" />
          <div>
            <strong className="font-semibold text-warn">Shown only once.</strong>{' '}
            <span className="text-ink-2">The hive stores it hashed and cannot show it again. If it is lost, delete the mind and create a new one.</span>
          </div>
        </div>

        <label className="relative mt-4 flex min-h-11 cursor-pointer items-center gap-3 text-sm">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="size-5 accent-[#a493ff]" />
          I have stored the token somewhere safe
        </label>

        <div className="relative mt-3 flex gap-2">
          <Button
            variant="subtle"
            className="flex-1"
            disabled={!ack}
            onClick={() => {
              clear()
              navigate({ name: 'dot', id: agent.id })
            }}
          >
            Open {shown(agent.name)}
          </Button>
          <Button variant="primary" className="flex-1" disabled={!ack} onClick={clear}>
            Done
          </Button>
        </div>
      </m.div>
    </m.div>
  )
}
