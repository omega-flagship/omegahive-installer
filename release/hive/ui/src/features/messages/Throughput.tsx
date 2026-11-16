import { useState } from 'react'
import type { Agent } from '../../api/types'
import { shown } from '../../lib/displayName'
import { useMe } from '../../lib/useAdmin'
import { has, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { Button } from '../../ui/primitives'

/** A mind-to-mind messages-an-hour limit (hive/core/throughput.py): its own number, or empty for the inherited default.
 *  Over it a message is refused now and the sender is told when to try again, never queued. */
export function ThroughputField({ value, inherited, onChange, label, used, disabled }: {
  value: number | null
  inherited: number
  onChange: (v: number | null) => void
  label: string
  used?: number
  disabled?: boolean
}) {
  const [text, setText] = useState(value == null ? '' : String(value))
  const [seen, setSeen] = useState(value)
  if (seen !== value) {   // the value changed from outside (saved, or a live update): show it (no effect needed)
    setSeen(value)
    setText(value == null ? '' : String(value))
  }
  const bad = text.trim() !== '' && !/^\d{1,5}$/.test(text.trim())
  return (
    <label className="block">
      <span className="text-[12px] text-ink-3">{label}</span>
      <input
        inputMode="numeric"
        value={text}
        disabled={disabled}
        placeholder={`Default: ${inherited}`}
        aria-invalid={bad}
        onChange={(e) => {
          setText(e.target.value)
          const t = e.target.value.trim()
          if (t === '') onChange(null)
          else if (/^\d{1,5}$/.test(t)) onChange(Number(t))
        }}
        className="mt-1 min-h-11 w-full rounded-xl border border-line bg-shade/30 px-3 text-[13.5px] text-ink outline-none focus:border-line-2"
      />
      <span className={bad ? 'mt-1 block text-[12px] text-bad' : 'mt-1 block text-[12px] text-ink-4'}>
        {bad ? 'A whole number, or empty for the default.' : <>
          Messages an hour to other minds. Over it a message is refused, not queued, and the sender is told when to try again.
          {used != null && <> Sent in the last hour: {used}.</>}
        </>}
      </span>
    </label>
  )
}


/** A mind's own limit, in its settings (admins change it; null returns to the hive default). */
export function MindThroughput({ agent }: { agent: Agent }) {
  const patch = useHive((s) => s.patchAgent)
  const toast = useHive((s) => s.toast)
  const client = useHive((s) => s.client)
  const { admin } = useMe()
  const t = agent.throughput
  const defaults = useResource(() => need(client, 'hiveThroughput', 'Message limits')(), { isEmpty: () => false })
  const stored = t?.messages_per_hour ?? null
  const [value, setValue] = useState<number | null>(stored)
  const [seen, setSeen] = useState(stored)
  if (seen !== stored) {   // saved or changed elsewhere: start from the stored limit again
    setSeen(stored)
    setValue(stored)
  }
  if (!t || agent.kind === 'module') return null
  const dirty = value !== (t.messages_per_hour ?? null)
  return (
    <section aria-labelledby="throughput-h" className="space-y-2">
      <h3 id="throughput-h" className="eyebrow">Messages to other minds</h3>
      <ThroughputField label={`${shown(agent.name)}'s limit an hour`} value={value} onChange={setValue} disabled={!admin}
        inherited={defaults.data?.defaults.mind ?? t.messages_per_hour_effective} used={t.messages_last_hour} />
      {admin && (
        <Button disabled={!dirty} onClick={async () => {
          const ok = await patch(agent.id, { messages_per_hour: value })
          if (ok) toast({ tone: 'success', title: value == null ? `${shown(agent.name)} uses the hive's message limit` : `${shown(agent.name)} may send ${value} messages an hour` })
        }}>Save</Button>
      )}
    </section>
  )
}

/**
 * The hive's defaults, which every mind and swarm without its own inherit (Settings, admins). An island of the settings
 * screen (settings.metta), so it draws its own panel and title, and nothing where this hive does not offer it.
 */
export function HiveThroughput() {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const res = useResource(() => need(client, 'hiveThroughput', 'Message limits')(), { isEmpty: () => false })
  const d = res.data?.defaults
  const [mind, setMind] = useState<number | null>(d?.mind ?? null)
  const [swarm, setSwarm] = useState<number | null>(d?.swarm ?? null)
  const [seen, setSeen] = useState<string | null>(null)
  const key = d ? `${d.mind}/${d.swarm}` : null
  if (key !== seen) {   // the defaults loaded or were saved: start from them
    setSeen(key)
    if (d) { setMind(d.mind); setSwarm(d.swarm) }
  }
  if (!d || !has(client, 'setHiveThroughput')) return null
  const dirty = mind !== d.mind || swarm !== d.swarm
  const save = async () => {
    try {
      await client!.setHiveThroughput!({ mind, swarm })
      res.reload()
      toast({ tone: 'success', title: 'Message limits saved' })
    } catch (e) {
      toast({ tone: 'error', title: 'Not saved', body: e instanceof Error ? e.message : String(e) })
    }
  }
  return (
    <section className="space-y-3 rounded-2xl border border-line bg-tint/[0.02] p-4" aria-labelledby="hive-throughput-h" data-hive-throughput>
      <h2 id="hive-throughput-h" className="eyebrow">Messages between minds</h2>
      <ThroughputField label="Each mind, unless set on the mind" value={mind} onChange={setMind} inherited={20} />
      <ThroughputField label="Each swarm's minds together, unless set on the swarm" value={swarm} onChange={setSwarm} inherited={100} />
      <p className="text-[12px] text-ink-4">
        Near a swarm's limit, minds that have sent less of their own go first.
      </p>
      <Button disabled={!dirty} onClick={() => void save()}>Save</Button>
    </section>
  )
}
