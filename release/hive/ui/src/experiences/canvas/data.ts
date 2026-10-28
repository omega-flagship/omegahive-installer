import { useEffect, useState } from 'react'
import type { Agent, Goal, Message } from '../sdk'

export function useClock(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return ''
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 45) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

export const agentIdOf = (ref: string | null | undefined): string | null => (ref ? (ref.startsWith('agent:') ? ref.slice(6) : ref) : null)

export const shortModel = (m: string) => m.replace(/^[^/]+\//, '')

export interface Link {
  key: string
  from: string
  to: string
  count: number
  /** ms epoch of the newest message on this link */
  last: number
  lastId: string
}

/** Who messaged whom recently (a peer message is filed under the receiver with sender agent:<from>). */
export function recentLinks(messages: Record<string, Message[]>, now: number, windowMs = 20 * 60_000): Link[] {
  const map = new Map<string, Link>()
  for (const to in messages) {
    const list = messages[to]
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      const t = Date.parse(m.created_at)
      if (now - t > windowMs) break
      if (m.direction !== 'in' || !m.sender.startsWith('agent:')) continue
      const from = m.sender.slice(6)
      if (from === to) continue
      const key = `${from}>${to}`
      const l = map.get(key)
      if (l) {
        l.count++
        if (t > l.last) {
          l.last = t
          l.lastId = m.id
        }
      } else map.set(key, { key, from, to, count: 1, last: t, lastId: m.id })
    }
  }
  return [...map.values()]
}

export interface MindGlance {
  /** Latest thing it said. */
  said: Message | null
  /** Latest thing it heard (from you or a peer). */
  heard: Message | null
}

export function glance(list: Message[] | undefined): MindGlance {
  let said: Message | null = null
  let heard: Message | null = null
  if (list) {
    for (let i = list.length - 1; i >= 0 && (!said || !heard); i--) {
      const m = list[i]
      if (m.direction === 'out') said ??= m
      else heard ??= m
    }
  }
  return { said, heard }
}

export const isAwake = (a: Agent) => a.status === 'awake' || a.status === 'starting'

export const STATUS_LABEL: Record<string, string> = {
  created: 'New',
  starting: 'Waking',
  awake: 'Awake',
  asleep: 'Asleep',
  stopped: 'Stopped',
  error: 'Error',
}

export const GOAL_LABEL: Record<string, string> = {
  open: 'Open',
  claimed: 'In progress',
  waiting: 'Waiting on you',
  stalled: 'Stalled',
  submitted: 'Review',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/** Sticky paper per goal status (dark ink on all). */
export const GOAL_PAPER: Record<string, string> = {
  open: '#fff1a8',
  claimed: '#d6e2ff',
  waiting: '#ffd9a8',
  stalled: '#ffcfc4',
  submitted: '#e6d9ff',
  done: '#d5f0dc',
  failed: '#ececea',
  cancelled: '#ececea',
}

export const RISK_PAPER = { high: '#ff9b8c', medium: '#ffcf5c', low: '#fff07a' } as const

export function goalHolder(g: Goal): string | null {
  if (g.status === 'claimed' || g.status === 'waiting' || g.status === 'submitted') return agentIdOf(g.claimed_by) ?? agentIdOf(g.assignee)
  return agentIdOf(g.assignee)
}
