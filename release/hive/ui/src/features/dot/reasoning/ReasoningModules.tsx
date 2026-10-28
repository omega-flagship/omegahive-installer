import { useEffect, useMemo, useRef, useState } from 'react'
import type { Agent } from '../../../api/types'
import { useIdentityEpoch } from '../../../lib/epochBound'
import { bindEpoch } from '../../../lib/identityEpoch'
import { useHive } from '../../../store/store'
import { useAskView } from '../../ask/view'
import { MODULES, type ModuleId } from './contract'
import { allAt, batchWrites, endBatch, loadReasoningModules, startBatch, type ReadBatch, type ViewState } from './load'
import { ModuleViewer } from './ModuleViewer'
import { REASONING_REGION, reasoningPageView } from './pageView'

/**
 * The six reasoning-module viewers on a mind's Tools tab. Each is an actual read of THIS mind, under the signed-in
 * person's own session, made only when this hive's Omega Tools app declares the `reasoning-module` read; otherwise
 * each says "Unavailable: no reader yet" and no module read is made (the one app-description GET still is). Demo data
 * never stands in for current state.
 * State is keyed by the identity epoch: a change of person starts it empty, and a late answer writes nothing.
 */
export function ReasoningModules({ agent }: { agent: Agent }) {
  const client = useHive((s) => s.client)
  const epoch = useIdentityEpoch()
  const [states, setStates] = useState<{ key: string; s: Record<ModuleId, ViewState> }>(() => ({ key: '', s: allAt({ kind: 'loading' }) }))
  const key = `${epoch}|${agent.id}|${agent.swarm_id ?? ''}`
  // one read batch per mount, client, person and mind; a StrictMode replay revives it rather than reading twice, and an
  // ended or aborted batch writes nothing (load.ts startBatch)
  const batch = useRef<ReadBatch | null>(null)
  useEffect(() => {
    const b = startBatch(batch.current, key, client, (nb) => {
      const binding = bindEpoch()
      void loadReasoningModules(client, agent, (m, s) => {
        if (batchWrites(nb)) setStates((prev) => ({ key, s: { ...(prev.key === key ? prev.s : allAt({ kind: 'loading' })), [m]: s } }))
      }, binding)
    })
    batch.current = b
    return () => endBatch(b)
    // agent fields read are in `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key])
  const shown = states.key === key ? states.s : allAt({ kind: 'loading' })
  const view = useMemo(() => reasoningPageView(agent.id, shown), [agent.id, shown])
  // the export's origin is this identity epoch (Root r5 intake, bounded Ask origin correction): the Ask's own
  // currentView() checks it synchronously, so a change of person drops this person's view at once, before effects run
  // (a render whose epoch is already behind binds nothing current)
  const origin = useMemo(() => {
    const b = bindEpoch()
    return () => b.epoch === epoch && b.current()
  }, [epoch])
  useAskView('mind-reasoning', view, origin)
  return <section className="space-y-3" aria-label="Reasoning modules" data-tour="reasoning-modules" data-presence-region={REASONING_REGION}>
    <div>
      <h2 className="text-lg font-medium">What {agent.name} is holding</h2>
      <p className="text-sm text-ink-3">Read-only views of this mind’s reasoning modules, read now from the hive under your own session. Where there is no reader yet, or the mind is not visible to you, each says so; nothing stands in for it.</p>
    </div>
    <div className="grid gap-3 md:grid-cols-2">
      {MODULES.map((m) => <ModuleViewer key={m} module={m} state={shown[m]} />)}
    </div>
  </section>
}
