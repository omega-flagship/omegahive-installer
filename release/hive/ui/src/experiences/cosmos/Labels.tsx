import { useEffect, useRef } from 'react'
import { hsl, shown, useHive, type Agent } from '../sdk'
import { cosmicClock, planetPos, statusWord, type CosmosLayout, type PlanetLayout, type SystemLayout } from './layout'
import { labels, useCosmos } from './state'

/** Registers a DOM element to follow a point in space (the scene writes its transform every frame). */
function useAnchor(key: string, at: (o: { x: number; y: number; z: number }) => boolean, maxDist: number, minDist = 0) {
  const ref = useRef<HTMLDivElement>(null)
  const atRef = useRef(at)
  useEffect(() => {
    atRef.current = at
  })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    labels.set(key, { el, at: (o) => atRef.current(o), maxDist, minDist })
    return () => {
      labels.delete(key)
    }
  }, [key, maxDist, minDist])
  return ref
}

function SystemLabel({ sys, agents, current, hide }: { sys: SystemLayout; agents: Record<string, Agent>; current: boolean; hide: boolean }) {
  const go = useCosmos((s) => s.go)
  const hot = useCosmos((s) => s.hovered === sys.id)
  const lit = sys.members.filter((id) => agents[id]?.status === 'awake').length
  const ref = useAnchor(
    `sys:${sys.id}`,
    (o) => {
      o.x = sys.center[0]
      o.y = sys.center[1] - 1.6
      o.z = sys.center[2]
      return !current && !hide
    },
    1600,
    sys.frame * 0.55,
  )
  return (
    <div ref={ref} className="cx-label">
      <button className="cx-tag cx-focus" data-presence-ref={`swarm:${sys.id}`} data-hot={hot ? '1' : '0'} onClick={() => go({ kind: 'system', id: sys.id })} aria-label={`Fly to ${shown(sys.name)} system`} style={{ color: hsl(sys.hue, 90, 78) }}>
        <span className="cx-tag-name cx-wide" style={{ fontSize: 12, color: '#eef4ff', letterSpacing: '0.36em', paddingLeft: '0.36em' }}>
          {shown(sys.name)}
        </span>
        <span className="cx-tag-line" />
        <span className="cx-mono" style={{ fontSize: 10.5, marginTop: 4, color: '#b9c8e6' }}>
          {String(sys.members.length).padStart(2, '0')} WORLDS · {String(lit).padStart(2, '0')} LIT
        </span>
      </button>
    </div>
  )
}

function PlanetLabel({ p, agent, asking, selected }: { p: PlanetLayout; agent: Agent; asking: number; selected: boolean }) {
  const go = useCosmos((s) => s.go)
  const hot = useCosmos((s) => s.hovered === agent.id)
  const thinking = useHive((s) => s.thinking[agent.id])
  const ref = useAnchor(
    `pl:${agent.id}`,
    (o) => {
      planetPos(p, cosmicClock.t, o)
      o.y -= p.size * 1.25
      return !selected
    },
    p.systemId ? 64 : 230,
  )
  const word = statusWord(agent, thinking)
  const busy = thinking === 'llm' || thinking === 'skills'
  return (
    <div ref={ref} className="cx-label">
      <button className="cx-tag cx-focus" data-presence-ref={`mind:${agent.id}`} data-hot={hot ? '1' : '0'} onClick={() => go({ kind: 'mind', id: agent.id })} aria-label={`Open transmission with ${shown(agent.name)} (${word.toLowerCase()})`} style={{ color: hsl(agent.hue, 90, 74) }}>
        <span className="flex items-center gap-1.5">
          {asking > 0 && (
            <span className="cx-mono cx-blink" style={{ fontSize: 9.5, color: '#1a1000', background: '#ffc36b', padding: '1px 4px', fontWeight: 600 }}>
              ASK {asking}
            </span>
          )}
          <span className="cx-tag-name cx-caps" style={{ fontSize: 11.5, color: '#eef4ff', letterSpacing: '0.2em' }}>
            {shown(agent.name)}
          </span>
        </span>
        <span className="cx-tag-line" />
        <span className="cx-mono flex items-center gap-1" style={{ fontSize: 9.5, marginTop: 3, color: busy ? hsl(agent.hue, 95, 80) : '#a9b9d8', letterSpacing: '0.16em' }}>
          {busy && (
            <span className="flex items-end gap-[2px]" aria-hidden>
              {[0, 1, 2].map((i) => (
                <i key={i} className="cx-bar" style={{ height: 8, animationDelay: `${i * 0.12}s` }} />
              ))}
            </span>
          )}
          {word}
        </span>
      </button>
    </div>
  )
}

export function Labels({ layout }: { layout: CosmosLayout }) {
  const agents = useHive((s) => s.agents)
  const approvals = useHive((s) => s.approvals)
  const view = useCosmos((s) => s.view)
  const asking: Record<string, number> = {}
  for (const id in approvals) if (approvals[id].status === 'pending') asking[approvals[id].agent_id] = (asking[approvals[id].agent_id] ?? 0) + 1
  const currentSystem = view.kind === 'system' ? view.id : view.kind === 'mind' ? (layout.planetById[view.id]?.systemId ?? null) : null
  return (
    <div className="pointer-events-none absolute inset-0" style={{ zIndex: 2 }}>
      {layout.systems.map((s) => (
        <SystemLabel key={s.id} sys={s} agents={agents} current={currentSystem === s.id} hide={view.kind === 'mind'} />
      ))}
      {layout.planets.map((p) =>
        agents[p.id] ? <PlanetLabel key={p.id} p={p} agent={agents[p.id]} asking={asking[p.id] ?? 0} selected={view.kind === 'mind' && view.id === p.id} /> : null,
      )}
    </div>
  )
}
