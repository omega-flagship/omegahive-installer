/**
 * The hive as a universe of galaxies (PLAN_HIVE_VIEW_SCALING r2 §2): one galaxy per person's hive, the cloud hive in
 * the middle. Pure and deterministic: the same input always gives the same places.
 *
 * The input is the SHOWN set only (scene/visibleSet): nothing hidden from the viewer reaches this module, so nothing
 * hidden can change a galaxy's existence, size, count or position (§4 P-1). Authorised "Private" placeholders are
 * placed afterwards, outside every galaxy, so they cannot move one either (§4 P-2).
 *
 * Cost: a sort plus a packing pass per galaxy and one for the universe. Each candidate place is checked only against
 * nearby circles through a uniform grid (measured in the plan: 0.6 ms at 150 swarms, 12 ms at 3,000).
 */

/** The cloud hive's id: swarms owned by no named person (the operator's, shared and team swarms). */
export const CLOUD_HIVE = 'hive:cloud'
/** A person's hive id, from their principal (`user:…`). */
export const personHive = (principal: string): string => `hive:${principal}`

export interface Circle {
  id: string
  r: number
}
export interface Placed extends Circle {
  x: number
  y: number
}

/** World radius a swarm needs: its outermost orbit (engine setData: 44 + 15·√n + jitter ≤ 12) plus a margin. */
export const slotRadius = (members: number): number => 44 + Math.sqrt(Math.max(1, members)) * 15 + 12 + 22
/** The slot reserved at a galaxy's centre for the viewer's own mind ("You") and any minds without a swarm. */
export const centreRadius = (minds: number): number => 34 + Math.sqrt(Math.max(1, minds)) * 15 + 12 + 18
/** A placeholder's fixed size: it never depends on what it stands for. */
export const PLACEHOLDER_R = 30

const GOLDEN = Math.PI * (3 - Math.sqrt(5))

/**
 * Pack circles (in the order given; callers sort biggest first) along a golden-angle spiral, pushing each outward
 * until it overlaps none already placed. `fixed` circles are placed first, where they are, and avoided.
 */
export function packCircles(items: Circle[], fixed: Placed[] = []): { places: Placed[]; radius: number } {
  const out: Placed[] = []
  if (!items.length) return { places: out, radius: 0 }
  const maxR = Math.max(...items.map((i) => i.r), ...fixed.map((f) => f.r))
  const cell = maxR * 2
  const grid = new Map<string, Placed[]>()
  const key = (gx: number, gy: number) => `${gx},${gy}`
  const put = (p: Placed) => {
    const k = key(Math.floor(p.x / cell), Math.floor(p.y / cell))
    const list = grid.get(k)
    if (list) list.push(p)
    else grid.set(k, [p])
  }
  const fits = (x: number, y: number, r: number) => {
    const gx = Math.floor(x / cell)
    const gy = Math.floor(y / cell)
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const p of grid.get(key(gx + dx, gy + dy)) ?? []) if (Math.hypot(p.x - x, p.y - y) < p.r + r) return false
    return true
  }
  for (const f of fixed) put(f)
  let spiral = 0
  for (const it of items) {
    let p: Placed | null = null
    for (let step = spiral; !p; step++) {
      const rad = Math.sqrt(step) * maxR * 0.9
      const x = Math.cos(step * GOLDEN) * rad
      const y = Math.sin(step * GOLDEN) * rad
      if (fits(x, y, it.r)) {
        spiral = Math.max(0, step - 8)
        p = { id: it.id, x, y, r: it.r }
      }
    }
    out.push(p)
    put(p)
  }
  const radius = Math.max(...out.map((p) => Math.hypot(p.x, p.y) + p.r))
  return { places: out, radius }
}

/** One swarm of the shown set, as the layout needs it: its id, its member count and the hive it belongs to. */
export interface UniverseSwarm {
  id: string
  members: number
  hive: string
}

export interface UniverseInput {
  swarms: UniverseSwarm[]
  /** A reserved centre slot (the viewer's own mind "You", and any minds without a swarm) in this hive, if any. */
  centre?: { hive: string; minds: number } | null
  /** Where the person put galaxies (world units), by hive id. Ids not in the shown set are ignored. */
  pinned?: Readonly<Record<string, { x: number; y: number }>>
  /** How many authorised "Private" placeholders to draw. They are placed last and move nothing (§4 P-2). */
  placeholders?: number
}

export interface Galaxy {
  id: string
  x: number
  y: number
  /** the galaxy's drawn radius (its outline) */
  r: number
  /** how many shown swarms it holds */
  swarms: number
  cloud: boolean
  /** placed where the person dragged it */
  pinned: boolean
}

export interface UniverseLayout {
  /** every shown swarm's place and slot radius */
  places: Map<string, { x: number; y: number; r: number }>
  galaxies: Galaxy[]
  /** the reserved centre slot's place, when there is one */
  centre: { x: number; y: number; hive: string } | null
  /** the placeholders' unattributed cluster, beside the universe (never inside a galaxy) */
  privateCluster: { x: number; y: number; r: number; slots: { x: number; y: number }[] } | null
}

/** Space between neighbouring galaxies, and between a galaxy's swarms and its outline. */
const GALAXY_GAP = 90
const GALAXY_MARGIN = 36
const CENTRE_ID = '\u0000centre'

/**
 * A universe of galaxies. Inside a galaxy: the reserved centre slot (if any) first, so it sits at the centre, then the
 * swarms biggest first. The galaxies: the cloud hive first (the middle), then the biggest; a galaxy the person pinned
 * stays where they put it, and the others pack around it.
 */
export function universeLayout(input: UniverseInput): UniverseLayout {
  const byHive = new Map<string, UniverseSwarm[]>()
  for (const s of input.swarms) {
    const list = byHive.get(s.hive)
    if (list) list.push(s)
    else byHive.set(s.hive, [s])
  }
  const centre = input.centre && input.centre.minds > 0 ? input.centre : null
  if (centre && !byHive.has(centre.hive)) byHive.set(centre.hive, [])
  const local = new Map<string, { places: Placed[]; radius: number }>()
  for (const [hive, list] of byHive) {
    const sorted = [...list].sort((a, b) => b.members - a.members || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const items: Circle[] = sorted.map((s) => ({ id: s.id, r: slotRadius(s.members) }))
    if (centre && centre.hive === hive) items.unshift({ id: CENTRE_ID, r: centreRadius(centre.minds) })
    local.set(hive, packCircles(items))
  }
  const radiusOf = (h: string) => Math.max(140, local.get(h)!.radius + GALAXY_MARGIN)
  const order = [...byHive.keys()].sort((a, b) => Number(b === CLOUD_HIVE) - Number(a === CLOUD_HIVE) || radiusOf(b) - radiusOf(a) || (a < b ? -1 : a > b ? 1 : 0))
  const pins = input.pinned ?? {}
  const pinnedIds = order.filter((h) => Object.hasOwn(pins, h) && Number.isFinite(pins[h]?.x) && Number.isFinite(pins[h]?.y))
  const fixed: Placed[] = pinnedIds.map((h) => ({ id: h, x: pins[h].x, y: pins[h].y, r: radiusOf(h) + GALAXY_GAP / 2 }))
  const packed = packCircles(
    order.filter((h) => !pinnedIds.includes(h)).map((h) => ({ id: h, r: radiusOf(h) + GALAXY_GAP / 2 })),
    fixed,
  )
  const places = new Map<string, { x: number; y: number; r: number }>()
  const galaxies: Galaxy[] = []
  let centreAt: UniverseLayout['centre'] = null
  for (const g of [...fixed, ...packed.places]) {
    for (const p of local.get(g.id)!.places) {
      if (p.id === CENTRE_ID) centreAt = { x: p.x + g.x, y: p.y + g.y, hive: g.id }
      else places.set(p.id, { x: p.x + g.x, y: p.y + g.y, r: p.r })
    }
    galaxies.push({ id: g.id, x: g.x, y: g.y, r: radiusOf(g.id), swarms: byHive.get(g.id)!.length, cloud: g.id === CLOUD_HIVE, pinned: pinnedIds.includes(g.id) })
  }
  // keep the galaxies in one stable order (the packing order), whatever was pinned
  galaxies.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))

  let privateCluster: UniverseLayout['privateCluster'] = null
  const n = Math.max(0, Math.floor(input.placeholders ?? 0))
  if (n > 0) {
    const pack = packCircles(Array.from({ length: n }, (_, i) => ({ id: String(i), r: PLACEHOLDER_R + 8 })))
    const r = Math.max(90, pack.radius + GALAXY_MARGIN)
    // beside the universe, level with the cloud hive: placed after every galaxy, so it moves none of them
    let maxX = 0
    for (const g of galaxies) maxX = Math.max(maxX, g.x + g.r)
    const cloud = galaxies.find((g) => g.cloud)
    const cx = maxX + GALAXY_GAP + r
    const cy = cloud ? cloud.y : 0
    privateCluster = { x: cx, y: cy, r, slots: pack.places.map((p) => ({ x: p.x + cx, y: p.y + cy })) }
  }
  return { places, galaxies, centre: centreAt, privateCluster }
}
