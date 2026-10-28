import { useEffect, useRef, useState } from 'react'
import type { HiveClient, Me } from '../../api/client'
import { errorMessage, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { askConfirm, ConfirmHost } from '../../ui/confirm'
import { needsConfirm } from '../../lib/hostConfirm'
import { Button } from '../../ui/primitives'
import { sessionKey } from '../../store/programSession'
import { reviewHumanForecast } from './fusionForecastActions'
import { ForecastComposer, type ForecastIntent, type ForecastState } from './fusionForecast'

export default function FusionComposer({ swarmId }: { swarmId: string }) {
  const client = useHive(s => s.client)
  const session = useHive(s => s.session)
  const inits = useHive(s => s.inits)
  const me = useResource(() => need(client,'me')(),{ poll:15000 })
  if (!client || !me.data || me.error || me.data.kind !== 'sso' || !me.data.person) return <p className="text-sm text-ink-3">Sign in as a named person to forecast.</p>
  // review B1: a new client, store session or init is a new composer (the old one is unmounted and fenced)
  return <Composer key={JSON.stringify([session, inits, me.data.principal, swarmId])} client={client} me={me.data} swarmId={swarmId} />
}

function Composer({ client, me, swarmId }: { client: HiveClient; me: Me; swarmId: string }) {
  const refresh = useHive(s => s.programRefresh)
  const [draft,setDraft] = useState({ market:'',probability_yes:'0.5',text:'',replaces:'' })
  const [error,setError] = useState('')
  const [busy,setBusy] = useState(false)
  // review B1: the identity this composer was opened under; nothing is minted, sent or shown once it moves or unmounts
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [alive] = useState(() => {
    const at = useHive.getState()
    return () => {
      const now = useHive.getState()
      return mounted.current && now.client === client && at.client === client && now.session === at.session && now.inits === at.inits
    }
  })
  const [controller] = useState(() => {
    const slot = `omegahive.fusion.intent.${encodeURIComponent(me.principal)}.${encodeURIComponent(swarmId)}`
    try {
      return new ForecastComposer(client,me.principal,swarmId,{
        read:() => { const value=localStorage.getItem(slot); return value ? JSON.parse(value) as ForecastIntent : null },
        write:value => localStorage.setItem(slot,JSON.stringify(value)),
        clear:() => localStorage.removeItem(slot),
      },undefined,(action) => needsConfirm(useHive.getState().programDetails.omegafusion?.describe, action),alive)
    } catch { return null }
  })
  const [state,setState] = useState<ForecastState>(controller?.state ?? { phase:'unknown' })
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError('')
    try {
      if (!navigator.locks) throw new Error('This browser cannot safely coordinate forecast recovery across tabs.')
      await navigator.locks.request(`omegahive.fusion.${me.principal}.${swarmId}`,fn)
    } catch(e) { if (alive()) setError(errorMessage(e)) }
    finally { if (alive()) { setBusy(false); if(controller) setState({...controller.state}) } }
    if(alive() && controller?.state.phase==='committed') void refresh(sessionKey('omegafusion',swarmId))
  }
  const locked = busy || state.phase==='unknown'
  const field = 'min-h-10 rounded-lg border border-line bg-abyss px-3 py-2 text-sm text-ink'
  return <details className="max-h-[50vh] shrink-0 overflow-y-auto rounded-xl border border-line p-3">
    <summary className="cursor-pointer text-sm font-semibold text-ink">Your synthetic forecast</summary>
    <ConfirmHost />
    <p className="mt-2 text-sm text-ink-2">{me.person?.name} · {swarmId}. App scope is checked on send. Read access grants no forecast authority.</p>
    {!controller && <p role="alert" className="mt-2 text-sm text-bad">Recovery storage is unavailable or invalid. No forecast can be sent.</p>}
    {controller && <div className="mt-3 grid gap-2 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm text-ink-2">Market ID<input className={field} value={draft.market} disabled={locked} onChange={e=>setDraft({...draft,market:e.target.value})} /></label>
      <label className="flex flex-col gap-1 text-sm text-ink-2">YES probability<input className={field} inputMode="decimal" value={draft.probability_yes} disabled={locked} onChange={e=>setDraft({...draft,probability_yes:e.target.value})} /></label>
      <label className="flex flex-col gap-1 text-sm text-ink-2 sm:col-span-2">Explanation<textarea className={field} maxLength={10000} value={draft.text} disabled={locked} onChange={e=>setDraft({...draft,text:e.target.value})} /></label>
      <label className="flex flex-col gap-1 text-sm text-ink-2 sm:col-span-2">Your forecast to correct (optional)<input className={field} value={draft.replaces} disabled={locked} onChange={e=>setDraft({...draft,replaces:e.target.value})} /></label>
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <Button disabled={locked} onClick={()=>void run(()=>reviewHumanForecast(controller,{market:draft.market,probability_yes:draft.probability_yes,text:draft.text,...(draft.replaces ? {replaces:draft.replaces} : {})}))}>Review forecast</Button>
        {state.phase==='unknown' && <Button disabled={busy} onClick={()=>void run(()=>controller.reconcile(message=>askConfirm(message,'Check receipt')))}>Recover receipt</Button>}
      </div>
    </div>}
    {state.message && <p role="status" className="mt-2 text-sm text-ink-2">{state.message}</p>}
    {state.intent && <p className="mt-2 break-all font-mono text-xs text-ink-3">Recovery key: {state.intent.key}</p>}
    {state.receipt && <p className="mt-2 break-all font-mono text-xs text-ink-3">Receipt: {state.receipt}</p>}
    {error && <p role="alert" className="mt-2 text-sm text-bad">{error}</p>}
  </details>
}
