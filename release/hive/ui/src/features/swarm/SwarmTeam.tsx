import type { Agent, Swarm } from '../../api/types'
import { money } from '../../lib/format'
import { navigate } from '../../lib/router'
import { useHive } from '../../store/store'
import { SimChip } from '../../ui/SimChip'
import { Orb, StatusPill } from '../../ui/primitives'
import { ancestorPath, teamStructure } from './team'
import { shown } from '../../lib/displayName'
import { plural } from '../../lib/plural'

export function SwarmBreadcrumbs({ swarm }: { swarm: Swarm }) {
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const parentMind = swarm.parent_mind_id ? agents[swarm.parent_mind_id] : undefined
  const { ancestors, incomplete } = ancestorPath(swarm, swarms)
  return (
    <nav aria-label="Swarm hierarchy" className="px-1 pb-3 text-small text-ink-3">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <li><button onClick={() => navigate({ name: 'swarms' })} className="min-h-11 underline-offset-4 hover:underline">Swarms</button></li>
        {incomplete && <li> / Parent hierarchy unavailable</li>}
        {ancestors.map((s) => <li key={s.id}> / <button onClick={() => navigate({ name: 'swarm', id: s.id })} className="min-h-11 underline-offset-4 hover:underline">{shown(s.name)}</button></li>)}
        {swarm.parent_mind_id && <li> / {parentMind ? <button onClick={() => navigate({ name: 'dot', id: parentMind.id })} className="min-h-11 underline-offset-4 hover:underline">{shown(parentMind.name)}</button> : 'Parent mind unavailable'}</li>}
        <li aria-current="page"> / {shown(swarm.name)}</li>
      </ol>
    </nav>
  )
}

export function SwarmServices({ swarm }: { swarm: Swarm }) {
  return (
    <section aria-label="Offered services" className="space-y-2">
      <h2 className="text-small font-semibold">Services for other swarms</h2>
      {swarm.services === undefined ? <p className="text-small text-ink-3">Service information unavailable.</p> : !swarm.services.length ? <p className="text-small text-ink-3">No public services offered.</p> : (
        <ul className="flex flex-wrap gap-2">{swarm.services.map((kind) => <li key={kind} className="max-w-full break-all rounded-lg border border-line-2 px-2 py-1 font-mono text-meta">{kind}</li>)}</ul>
      )}
    </section>
  )
}

export function SwarmTeam({ swarm }: { swarm: Swarm }) {
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const { coordinator, workers, children } = teamStructure(swarm, agents, swarms)
  const childrenOf = (mind: Agent) => children.filter((s) => s.parent_mind_id === mind.id)
  return (
    <section aria-label="Minds in this swarm" data-tour="swarm-members" className="space-y-4">
      <h2 className="text-lead font-semibold">{plural(swarm.member_ids.length, 'mind')} in this swarm</h2>
      <div className="rounded-2xl border border-control p-2">
        <h3 className="px-2 pt-1 text-meta font-semibold text-ink-2">Coordinating mind</h3>
        {coordinator ? <><MindRow mind={coordinator} /><ChildTeams swarms={childrenOf(coordinator)} /></> : <p className="px-2 py-3 text-small text-ink-3">{swarm.coordinator_id ? 'Coordinator information unavailable.' : 'No coordinator designated.'}</p>}
      </div>
      {workers.length > 0 && <ul className="ml-3 space-y-1 border-l border-line-2 pl-3">{workers.map((mind) => <li key={mind.id}><MindRow mind={mind} /><ChildTeams swarms={childrenOf(mind)} /></li>)}</ul>}
      {!swarm.member_ids.length && <p className="text-small text-ink-3">No minds in this swarm yet.</p>}
      {swarm.member_ids.some((id) => !agents[id] || agents[id].swarm_id !== swarm.id) && <p className="text-small text-ink-3">Some member information is unavailable.</p>}
      {(swarm.child_swarm_ids?.length ?? 0) > children.length && <p className="text-small text-ink-3">Some nested swarm information is unavailable.</p>}
      <SwarmServices swarm={swarm} />
    </section>
  )
}

function MindRow({ mind }: { mind: Agent }) {
  const thinking = useHive((s) => s.thinking[mind.id])
  return (
    <button onClick={() => navigate({ name: 'dot', id: mind.id })} className="flex min-h-14 w-full items-center gap-2 rounded-xl p-2 text-left hover:bg-white/[0.05]">
      <Orb hue={mind.hue} status={mind.status} thinking={thinking} size={28} />
      <span className="min-w-0 flex-1"><span className="block break-words text-body font-medium">{shown(mind.name)}</span><span className="block text-meta text-ink-3">{mind.kind} · {money(mind.spent_usd)} <SimChip /></span></span>
      <StatusPill status={mind.status} thinking={thinking} />
    </button>
  )
}

function ChildTeams({ swarms }: { swarms: Swarm[] }) {
  if (!swarms.length) return null
  return <ul aria-label="Nested swarms" className="ml-5 space-y-1 border-l border-line-2 pl-3">{swarms.map((s) => <li key={s.id}><button onClick={() => navigate({ name: 'swarm', id: s.id })} className="min-h-11 w-full rounded-lg px-2 py-2 text-left text-small hover:bg-white/[0.05]"><span className="block break-words font-medium">{shown(s.name)}</span><span className="text-meta text-ink-3">Nested swarm · {plural(s.member_ids.length, 'mind')}</span></button></li>)}</ul>
}
