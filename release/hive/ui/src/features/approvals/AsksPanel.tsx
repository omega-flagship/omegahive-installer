import { useCallback, useEffect, useState } from 'react'
import type { PersonAsk } from '../../api/types'
import { shown } from '../../lib/displayName'
import { need, useResource } from '../../lib/useResource'
import { hiveBus, useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Button } from '../../ui/primitives'

/** People's requests to the hive's admins: a mind, more allowance, access to a swarm (hive/core/person_requests.py).
 *  An admin answers each with Jon's five: Once, For a time, Always, No, Never. A member asks here and sees their own. */

type Answer = 'once' | 'for' | 'always' | 'no' | 'never'
const FOR_TIMES = [{ minutes: 60, label: '1 hour' }, { minutes: 24 * 60, label: '1 day' }, { minutes: 7 * 24 * 60, label: '7 days' }, { minutes: 30 * 24 * 60, label: '30 days' }]

function describeAsk(a: PersonAsk, swarmName: (id: string) => string): string {
  const p = a.payload as Record<string, string | number>
  if (a.kind === 'mind') return `a mind "${p.name}" in ${swarmName(String(p.swarm_id))}, up to $${Number(p.budget_usd).toFixed(0)}`
  if (a.kind === 'allowance') return `a monthly allowance of $${Number(p.monthly_usd).toFixed(0)}`
  return `access to ${swarmName(String(p.swarm_id))}`
}

export function AsksPanel() {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const swarms = useHive((s) => s.swarms)
  const swarmName = (id: string) => shown(swarms[id]?.name) || 'a swarm'
  const me = useResource(() => need(client, 'me')(), { isEmpty: () => false })
  const admin = me.data ? me.data.kind === 'password' || me.data.role === 'admin' : false
  const [asks, setAsks] = useState<PersonAsk[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [timeFor, setTimeFor] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)

  const load = useCallback(() => { void client?.listAsks?.().then(setAsks).catch(() => undefined) }, [client])
  useEffect(() => { load() }, [load])
  useEffect(() => hiveBus.on((e) => { if (e.type === 'person_request.created' || e.type === 'person_request.updated') load() }), [load])

  if (!client?.listAsks) return null
  const pending = asks.filter((a) => a.status === 'pending')
  const recent = asks.filter((a) => a.status !== 'pending').slice(0, 5)

  const answer = async (id: string, d: Answer, minutes?: number) => {
    setBusy(id)
    try { await client.answerAsk!(id, d, minutes); setTimeFor(null); load() }
    catch (e) { toast({ tone: 'error', title: 'Not answered', body: e instanceof Error ? e.message : String(e) }) }
    finally { setBusy(null) }
  }

  if (!admin && !asks.length && !asking) {
    return (
      <div className="mb-4 flex justify-end">
        <Button variant="subtle" icon="plus" onClick={() => setAsking(true)}>Ask the admins…</Button>
      </div>
    )
  }

  return (
    <section className="mb-4 space-y-2 rounded-[22px] border border-line bg-tint/[0.02] p-4" aria-label="Requests from people">
      <div className="flex items-center gap-2">
        <Icon name="people" size={16} className="text-ink-3" />
        <h2 className="flex-1 font-display text-[15px] font-semibold">{admin ? 'Requests from people' : 'Your requests'}</h2>
        {!admin && !asking && <Button variant="subtle" icon="plus" className="min-h-8 px-3 text-[12.5px]" onClick={() => setAsking(true)}>Ask…</Button>}
      </div>
      {asking && <AskForm onDone={() => { setAsking(false); load() }} />}
      {!pending.length && !asking && <p className="text-[12.5px] text-ink-4">{admin ? 'Nobody is waiting on an answer.' : 'Nothing waiting.'}</p>}
      {pending.map((a) => (
        <div key={a.id} className="rounded-xl border border-warn/40 bg-warn/[0.05] px-3 py-2.5">
          <p className="text-[13.5px] text-ink">
            {admin ? <span className="text-ink-2">{who(a.requested_by)} asks for </span> : <span className="text-ink-2">You asked for </span>}
            {describeAsk(a, swarmName)}
          </p>
          {a.note && <p className="mt-0.5 text-[12px] text-ink-3">{a.note}</p>}
          {String((a.payload as { purpose?: string }).purpose || '') && <p className="mt-0.5 text-[12px] text-ink-3">For: {String((a.payload as { purpose?: string }).purpose)}</p>}
          {admin && (
            <div className="mt-2 flex flex-wrap justify-end gap-1.5">
              <Button variant="danger" disabled={busy === a.id} className="min-h-8 px-3 text-[12.5px]" onClick={() => void answer(a.id, 'never')} title={`Decline, and decline this kind of request from ${who(a.requested_by)} from now on`}>Never</Button>
              <Button variant="danger" disabled={busy === a.id} className="min-h-8 px-3 text-[12.5px]" onClick={() => void answer(a.id, 'no')}>No</Button>
              <Button variant="subtle" disabled={busy === a.id} className="min-h-8 px-3 text-[12.5px]" onClick={() => setTimeFor(timeFor === a.id ? null : a.id)} aria-expanded={timeFor === a.id}
                title="Grant, and grant this kind of request from them automatically for a while">For a time…</Button>
              <Button variant="subtle" disabled={busy === a.id} className="min-h-8 px-3 text-[12.5px]" onClick={() => void answer(a.id, 'always')} title="Grant, and always grant this kind of request from them">Always</Button>
              <Button variant="primary" disabled={busy === a.id} className="min-h-8 px-3 text-[12.5px]" onClick={() => void answer(a.id, 'once')}>Once</Button>
              {timeFor === a.id && (
                <div className="flex w-full flex-wrap items-center justify-end gap-1.5 text-[12px]">
                  <span className="text-ink-3">Grant their requests like this automatically for</span>
                  {FOR_TIMES.map((t) => <Button key={t.minutes} variant="ghost" className="min-h-8 px-2.5 text-[12px]" onClick={() => void answer(a.id, 'for', t.minutes)}>{t.label}</Button>)}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      {recent.length > 0 && (
        <ul className="space-y-1 pt-1 text-[12px] text-ink-3">
          {recent.map((a) => (
            <li key={a.id}>
              <span className={a.status === 'granted' ? 'text-good' : 'text-bad'}>{a.status}</span>
              {' · '}{admin ? `${who(a.requested_by)}: ` : ''}{describeAsk(a, swarmName)}
              {a.decided_by?.startsWith('rule:') && ' (standing answer)'}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function who(principal: string) {
  return principal.replace(/^user:/, '')
}

function AskForm({ onDone }: { onDone: () => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const swarms = useHive((s) => s.swarms)
  const [kind, setKind] = useState<PersonAsk['kind']>('mind')
  const [name, setName] = useState('')
  const [swarm, setSwarm] = useState('')
  const [purpose, setPurpose] = useState('')
  const [budget, setBudget] = useState('5')
  const [monthly, setMonthly] = useState('100')
  const [swarmId, setSwarmId] = useState('')
  const [sending, setSending] = useState(false)
  const list = Object.values(swarms)

  const send = async () => {
    const payload = kind === 'mind' ? { name, swarm_id: swarm, purpose, budget_usd: Number(budget) }
      : kind === 'allowance' ? { monthly_usd: Number(monthly) } : { swarm_id: swarmId.trim() }
    setSending(true)
    try {
      const r = await client!.createAsk!({ kind, payload })
      toast({ tone: 'success', title: r.status === 'pending' ? 'Asked. An admin has been told.' : `Answered already: ${r.status}` })
      onDone()
    } catch (e) {
      toast({ tone: 'error', title: 'Not sent', body: e instanceof Error ? e.message : String(e) })
    } finally { setSending(false) }
  }
  const input = 'min-h-10 rounded-xl border border-line bg-shade/25 px-3 text-[13.5px] text-ink outline-none focus:border-line-2'
  return (
    <div className="space-y-2 rounded-xl border border-line p-3">
      <label className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-ink-3">I'd like</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as PersonAsk['kind'])} className={input}>
          <option value="mind">a new mind</option>
          <option value="allowance">a bigger monthly allowance</option>
          <option value="swarm_access">access to a swarm</option>
        </select>
      </label>
      {kind === 'mind' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <input className={input} placeholder="Its name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Mind name" />
          <select className={input} value={swarm} onChange={(e) => setSwarm(e.target.value)} aria-label="Swarm">
            <option value="">In which swarm…</option>
            {list.map((s) => <option key={s.id} value={s.id}>{shown(s.name)}</option>)}
          </select>
          <input className={`${input} sm:col-span-2`} placeholder="What it is for" value={purpose} onChange={(e) => setPurpose(e.target.value)} aria-label="Purpose" />
          <label className="flex items-center gap-2 text-[12.5px] text-ink-3">Spend up to $<input className={`${input} w-24`} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} aria-label="Budget" /> (from your allowance or key)</label>
        </div>
      )}
      {kind === 'allowance' && (
        <label className="flex items-center gap-2 text-[12.5px] text-ink-3">$<input className={`${input} w-28`} inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} aria-label="Monthly allowance" /> a month</label>
      )}
      {kind === 'swarm_access' && (
        <input className={`${input} w-full`} placeholder="The swarm's id (ask whoever shared its link)" value={swarmId} onChange={(e) => setSwarmId(e.target.value)} aria-label="Swarm id" />
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" className="min-h-9 px-3 text-[12.5px]" onClick={onDone}>Cancel</Button>
        <Button variant="primary" className="min-h-9 px-3 text-[12.5px]" disabled={sending || (kind === 'mind' && (!name.trim() || !swarm))} onClick={() => void send()}>Ask</Button>
      </div>
    </div>
  )
}
