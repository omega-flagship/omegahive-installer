import { memo, useMemo } from 'react'
import { shown, useHive, type Agent } from '../sdk'
import { ChatCard } from './chat'
import { agentIdOf, glance, goalHolder, isAwake, recentLinks, useClock } from './data'
import type { Lod } from './engine'
import type { IslandBox, Item, Layout } from './layout'
import { Cursors, Links, type CursorSpec } from './overlays'
import { GoalSticky, Island, MindCard } from './parts'
import type { Mode } from './theme'
import { NO_MOTIVES } from './motives'

/**
 * Slots subscribe to exactly the slice of the hive they draw, so a live message re-renders one card, not the board.
 */

interface MindSlotProps {
  it: Item
  lod: Lod
  now: number
  selected: boolean
  open: boolean
  reduced: boolean
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  /** the conversation's X (home) */
  onCloseX: () => void
  /** Esc on the conversation (closes just it) */
  onDismiss: () => void
  onFocusItem: (key: string) => void
}

export const MindSlot = memo(function MindSlot(p: MindSlotProps) {
  const id = p.it.id
  const agent = useHive((s) => s.agents[id])
  const phase = useHive((s) => s.thinking[id])
  const list = useHive((s) => s.messages[id])
  const gl = useMemo(() => glance(list), [list])
  const fromId = gl.heard && gl.heard.sender.startsWith('agent:') ? agentIdOf(gl.heard.sender) : null
  const fromName = useHive((s) => (fromId ? s.agents[fromId]?.name ?? 'A mind' : null))
  if (!agent) return null
  if (p.open) return <ChatCard r={p.it} agent={agent} phase={phase} now={p.now} reduced={p.reduced} onCloseX={p.onCloseX} onDismiss={p.onDismiss} />
  return (
    <MindCard
      r={p.it}
      agent={agent}
      lod={p.lod}
      phase={phase}
      said={gl.said}
      heard={gl.heard}
      heardFrom={fromName}
      now={p.now}
      selected={p.selected}
      onSelect={p.onSelect}
      onOpen={p.onOpen}
      onFocusItem={p.onFocusItem}
    />
  )
})

export const GoalSlot = memo(function GoalSlot({ it, lod, selected, mode, onSelect, onFocusItem }: { it: Item; lod: Lod; selected: boolean; mode: Mode; onSelect: (k: string) => void; onFocusItem: (k: string) => void }) {
  const goal = useHive((s) => s.goals[it.id])
  const hid = goal ? goalHolder(goal) : null
  const holder = useHive((s) => (hid ? s.agents[hid] ?? null : null))
  const motivations = useHive((s) => s.taskLinks[it.id] ?? NO_MOTIVES)
  if (!goal) return null
  return <GoalSticky r={it} goal={goal} lod={lod} holder={holder} motivations={motivations} selected={selected} mode={mode} onSelect={onSelect} onFocusItem={onFocusItem} />
})

export const IslandSlot = memo(function IslandSlot({ box, members, goalCount, openGoals, coordinator, mode, lod, selected, onSelect, onFocusItem }: { box: IslandBox; members: Agent[]; goalCount: number; openGoals: number; coordinator: string | null; mode: Mode; lod: Lod; selected: boolean; onSelect: (k: string) => void; onFocusItem: (k: string) => void }) {
  const beliefCount = useHive((s) => {
    const b = s.beliefs[box.id]
    let n = 0
    for (const _ in b) n++
    return n
  })
  const key = `island:${box.id}`
  return (
    <Island
      r={box}
      id={box.id}
      swarm={box.swarm}
      name={box.name}
      hue={box.hue}
      mode={mode}
      lod={lod}
      members={members}
      goalCount={goalCount}
      openGoals={openGoals}
      beliefCount={beliefCount}
      coordinator={coordinator}
      selected={selected}
      hidden={box.doneHidden}
      onSelect={() => onSelect(key)}
      onFocusItem={() => onFocusItem(key)}
    />
  )
})

const EMPTY = {}

export function LiveLinks({ layout, reduced, focus }: { layout: Layout; reduced: boolean; focus: string | null }) {
  const messages = useHive((s) => s.messages)
  const agents = useHive((s) => s.agents)
  const now = useClock(4000)
  const links = useMemo(() => recentLinks(messages ?? EMPTY, now), [messages, now])
  return <Links links={links} items={layout.items} agents={agents} now={now} reduced={reduced} focus={focus} />
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t)

export function LiveCursors({ layout, reduced, lod }: { layout: Layout; reduced: boolean; lod: Lod }) {
  const messages = useHive((s) => s.messages)
  const agents = useHive((s) => s.agents)
  const thinking = useHive((s) => s.thinking)
  const goals = useHive((s) => s.goals)
  const now = useClock(4000)
  const list = useMemo<CursorSpec[]>(() => {
    const links = recentLinks(messages ?? EMPTY, now, 45_000)
    const held = new Map<string, string>()
    for (const id in goals) {
      const g = goals[id]
      const h = goalHolder(g)
      if (h && (g.status === 'claimed' || g.status === 'waiting') && layout.items.has(`goal:${g.id}`)) held.set(h, g.id)
    }
    const out: CursorSpec[] = []
    for (const id in agents) {
      const a = agents[id]
      if (!isAwake(a)) continue
      const phase = thinking[id]
      const working = phase === 'llm' || phase === 'skills'
      const goalId = held.get(id)
      let talk: (typeof links)[number] | undefined
      for (const l of links) if (l.from === id && (!talk || l.last > talk.last)) talk = l
      if (!working && !goalId && !talk) continue
      const target = (talk && layout.items.get(`mind:${talk.to}`)) || (goalId && layout.items.get(`goal:${goalId}`)) || layout.items.get(`mind:${id}`)
      if (!target) continue
      const label = talk ? `→ ${shown(agents[talk.to]?.name ?? '')}` : goalId ? clip(goals[goalId]?.title ?? '', 20) : phase === 'skills' ? 'using skills' : 'thinking'
      out.push({ id, name: a.name, hue: a.hue, label, target: { x: target.x, y: target.y, w: target.w, h: target.h } })
    }
    return out
  }, [messages, agents, thinking, goals, layout, now])
  return <Cursors list={list} reduced={reduced} detail={lod === 'far' ? 0 : lod === 'overview' ? 1 : 2} />
}
