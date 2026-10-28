import { useState } from 'react'
import { shown } from '../../lib/displayName'
import { navigate } from '../../lib/router'
import { actionFailure, errorMessage, has, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { Button, Orb } from '../../ui/primitives'

/**
 * R8: the one mind told of every health alert, so incidents have someone who answers them. Admins choose it; anyone
 * signed in sees who it is.
 */
export function HealthMind() {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const res = useResource(() => need(client, 'healthMind', 'The health mind')(), { isEmpty: () => false })
  const me = useResource(() => need(client, 'me')(), { isEmpty: () => false })
  const admin = me.data ? me.data.kind === 'password' || me.data.role === 'admin' : false
  const [editing, setEditing] = useState(false)
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  if (!has(client, 'healthMind') || res.status === 'unsupported') return null

  const current = res.data?.agent_id ?? null
  const mind = current ? agents[current] : undefined
  const candidates = Object.values(agents)
    .filter((a) => a.kind !== 'module' || a.connected)
    .sort((a, b) => a.name.localeCompare(b.name))

  const save = async (id: string | null) => {
    setBusy(true)
    try {
      const out = await need(client, 'setHealthMind', 'Choosing the health mind')(id)
      res.mutate(() => out)
      setEditing(false)
      toast({ tone: 'success', title: id ? `${shown(agents[id]?.name ?? id)} answers health alerts now` : 'No mind answers health alerts now', body: id ? undefined : 'Alerts still show here and in the hive.' })
    } catch (e) {
      toast(actionFailure(e, 'Could not change the health mind'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="hm-h" className="rounded-2xl border border-line bg-white/[0.03] p-4" data-tour="health-mind">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="hm-h" className="eyebrow">
            The health mind
          </h2>
          {res.status === 'loading' ? (
            <p className="mt-1 text-[13px] text-ink-4">Checking…</p>
          ) : res.status === 'error' ? (
            <p className="mt-1 text-[13px] text-bad">Could not read it: {errorMessage(res.error)}</p>
          ) : current ? (
            <div className="mt-1.5 flex items-center gap-2">
              {mind && <Orb hue={mind.hue} status={mind.status} size={22} />}
              <button className="text-[14px] font-medium text-ink hover:underline" onClick={() => mind && navigate({ name: 'dot', id: current })} disabled={!mind}>
                {shown(mind?.name ?? current)}
              </button>
              <span className="text-[12px] text-ink-3">
                {mind?.swarm_id ? `in ${shown(swarms[mind.swarm_id]?.name ?? mind.swarm_id)} · ` : ''}is told of every health alert
                {mind && mind.status !== 'awake' ? ` (it is ${mind.status}; it reads them when it wakes)` : ''}
              </span>
            </div>
          ) : (
            <p className="mt-1 text-[13px] text-ink-3">No mind is told of health alerts. They still show here and in the hive.</p>
          )}
        </div>
        {admin && has(client, 'setHealthMind') && !editing && res.status === 'ready' && (
          <Button variant="subtle" onClick={() => (setPick(current ?? ''), setEditing(true))}>
            Change…
          </Button>
        )}
      </div>
      {editing && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="min-w-[200px] flex-1">
            <span className="text-[12px] text-ink-3">Mind told of every health alert</span>
            <select value={pick} onChange={(e) => setPick(e.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-line bg-black/30 px-3 text-[13px] text-ink outline-none focus:border-line-2">
              <option value="">No mind</option>
              {candidates.map((a) => (
                <option key={a.id} value={a.id}>
                  {shown(a.name)}
                  {a.swarm_id ? ` · ${shown(swarms[a.swarm_id]?.name ?? '')}` : ''}
                </option>
              ))}
            </select>
          </label>
          <Button variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || (pick || null) === current} onClick={() => void save(pick || null)}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </section>
  )
}
