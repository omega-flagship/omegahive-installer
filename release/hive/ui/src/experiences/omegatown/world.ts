import type { Agent, Swarm } from '../sdk'

export const WIDTH = 1200
export const HEIGHT = 780
export type Point = { x: number; y: number }
export type PlaceId = 'code' | 'design' | 'hall' | 'house' | 'personal-lab'
export const PLACES: { id: PlaceId; label: string; point: Point; copy: string }[] = [
  { id: 'code', label: 'Code hack den', point: { x: 585, y: 190 }, copy: 'A cyberpunk workshop. Choose your real workspace in Code.' },
  { id: 'design', label: 'Design studio', point: { x: 950, y: 295 }, copy: 'An airy maker space. Open Design with the swarm you choose.' },
  { id: 'hall', label: 'Town Hall', point: { x: 605, y: 400 }, copy: 'Motivations, tasks and decisions belong to the same Hive in every experience.' },
  { id: 'house', label: 'Personal house', point: { x: 215, y: 585 }, copy: 'Your personal house isn’t connected yet. This doorway is a preview of that future place.' },
  { id: 'personal-lab', label: 'Sophia AI Lab', point: { x: 975, y: 580 }, copy: 'Your personal lab isn’t connected yet. Your personal Omega and future SAIL entrance will belong here.' },
]

/** Stable placement from exact authorized IDs; a visual seed is never a native reference or presence. */
export function visualSeed(id: string): number {
  let n = 2166136261
  for (let i = 0; i < id.length; i++) n = Math.imul(n ^ id.charCodeAt(i), 16777619) >>> 0
  return n
}
/** Door clearances are reserved before residents are placed; the directory still contains every mind. */
export const RESIDENT_SLOTS: Point[] = [110, 360, 520, 720].flatMap((y) => [90, 260, 430, 600, 770, 940, 1110].map((x) => ({ x, y }))).filter((p) => PLACES.every((place) => Math.abs(p.x - place.point.x) >= 105 || Math.abs(p.y - (place.point.y + 22)) >= 115))
export function residentPlacements(agents: Agent[], swarms: Swarm[]): { agent: Agent; point: Point }[] {
  const free = [...RESIDENT_SLOTS]
  const teams = new Map(swarms.map((s) => [s.id, districtPoint(s)]))
  const ordered = [...agents].sort((a, b) => (a.swarm_id ?? '').localeCompare(b.swarm_id ?? '') || a.id.localeCompare(b.id))
  return ordered.slice(0, free.length).map((agent) => {
    const home = teams.get(agent.swarm_id ?? '') ?? { x: WIDTH / 2, y: HEIGHT / 2 }
    free.sort((a, b) => Math.hypot(a.x - home.x, a.y - home.y) - Math.hypot(b.x - home.x, b.y - home.y) || a.y - b.y || a.x - b.x)
    return { agent, point: free.shift()! }
  })
}
export const robotAnimal = (a: Agent) => visualSeed(a.id) % 3 === 0
export const districtPoint = (s: Swarm): Point => ({ x: 330 + (visualSeed(s.id) % 4) * 150, y: 480 })
export function nearest(p: Point): (typeof PLACES)[number] | null {
  const sorted = PLACES.map((place) => ({ place, distance: Math.hypot(p.x - place.point.x, p.y - place.point.y) })).sort((a, b) => a.distance - b.distance)
  return sorted[0]?.distance < 110 ? sorted[0].place : null
}
export const bounded = (p: Point): Point => ({ x: Math.max(70, Math.min(WIDTH - 70, p.x)), y: Math.max(100, Math.min(HEIGHT - 55, p.y)) })
