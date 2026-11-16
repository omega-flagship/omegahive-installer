import type { ProgramAction, ProgramDescription, ProgramStage } from '../types'
import type { ProgramCtx } from './programs'
import { verifySource } from '../../forms/designCanvas/native/source.mjs'

/**
 * SIM ONLY. An invented stand-in for Design (omegadesign) with the shape of its real data contract, so the living
 * canvas can be shown and tested without the hive. Every design here is INVENTED (no Design fixture is copied).
 *
 * Mirrors, by shape only (omegadesign program.py / source_io.py, release 0.4.4-sharing):
 *  - describe(): one `status` kind (role assessment); the Studio operations as `write` actions (agents may run them),
 *    plus `save-source`, the person's own save (`person_activity`, so the host confirm token applies, §9d);
 *  - view(focus = "studio-source:" + JSON(reference)): one item whose `data` is `{source, reference}`;
 *  - act("save-source", [], {editable_source_json | editable_source, source}): exactly one of the two (Design's
 *    `decode_source_input`; the canvas sends the JSON text, Design's source-save wire), then retains the loaded revision, the brief and the hard criteria,
 *    or refuses; a kept save is a new revision of the same artifact, `{status: done, data: {output, assets, adopted}}`.
 * Saves are checked with Design's own native verifier (`verifySource`). The invented designs' digests use Design's rule
 * (sha256 over the canonical JSON) through a small synchronous copy here, so view() stays synchronous; the tests check
 * each invented design against the native verifier.
 */

type Json = Record<string, unknown>
type Ref = { artifact_id: string; revision: number; digest: string }

// ------------------------------------------------------------------ sha256 (sync, sim only) and Design's canonical form

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])
export function sha256HexSync(text: string): string {
  const data = new TextEncoder().encode(text)
  const len = data.length
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6)
  padded.set(data)
  padded[len] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor((len * 8) / 2 ** 32))
  view.setUint32(padded.length - 4, (len * 8) >>> 0)
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('')
}
const canonical = (v: unknown): string =>
  Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical((v as Json)[k])).join(',') + '}' : JSON.stringify(v)
const digestOf = (v: unknown) => `sha256:${sha256HexSync(canonical(v))}`
const clone = <T,>(v: T): T => structuredClone(v)

// ------------------------------------------------------------------ invented designs

type El = Json & { id: string; kind: 'text' | 'rect' | 'image' }
const text = (id: string, x: number, y: number, width: number, height: number, t: string, fontSize: number, color: string, weight: 'normal' | 'bold' = 'normal', fontFamily?: string): El =>
  ({ id, kind: 'text', x, y, width, height, text: t, fontSize, color, weight, ...(fontFamily ? { fontFamily } : {}) })
const rect = (id: string, x: number, y: number, width: number, height: number, fill: string, radius?: number): El => ({ id, kind: 'rect', x, y, width, height, fill, ...(radius !== undefined ? { radius } : {}) })
const scene = (id: string, title: string, width: number, height: number, background: string, criteria: string[], elements: El[]) => ({ schema: 'omega-scene-1', id, title, width, height, background, criteria, elements })
type Scene = ReturnType<typeof scene>

/** A source with a short history: each step is a list of native `set` patches on the previous scene. */
function source(first: Scene, steps: [string, Json][][], brief: Json, directions: { id: string; label: string; rationale: string; scene: Scene }[], provenance: Ref) {
  const history: Json[] = []
  let cur = first
  history.push({ scene: clone(cur), revision: 1, digest: digestOf(cur), parent: null, changes: [] })
  for (const step of steps) {
    const next = clone(cur)
    const changes = step.map(([element, patch]) => {
      const i = next.elements.findIndex((e) => e.id === element)
      next.elements[i] = { ...next.elements[i], ...patch }
      return { op: 'set', element, patch }
    })
    const prev = history[history.length - 1]
    history.push({ scene: clone(next), revision: (prev.revision as number) + 1, digest: digestOf(next), parent: { scene_id: cur.id, revision: prev.revision, digest: prev.digest }, changes })
    cur = next
  }
  const briefDigest = digestOf(brief)
  return {
    schema: 'omega-studio-source-1',
    current: clone(history[history.length - 1]),
    history,
    feedback: [],
    project: {
      schema: 'omega-creative-project-1',
      brief,
      brief_digest: briefDigest,
      directions: directions.map((d) => ({ ...d, scene_digest: digestOf(d.scene), brief_digest: briefDigest, identity: null, assessment: 'unverified' })),
      selection: null,
    },
    provenance: { kind: 'native-direction-admission', source_reference: provenance, assessment: 'unverified', adopted: false },
  }
}

const LANTERN_CRITERIA = ['A clear invitation to an evening walk', 'Date, time and meeting place readable at a glance', 'Warm and welcoming to families']
function lanternWalk() {
  const s = scene('scene-lantern-walk', 'Lantern walk by the river', 1280, 720, '#F4EBDD', LANTERN_CRITERIA, [
    rect('band', 0, 0, 1280, 18, '#C8553D'),
    text('kicker', 96, 86, 900, 40, 'AN EVENING FOR NEIGHBOURS', 24, '#8A4B2A', 'bold'),
    text('headline', 96, 150, 980, 200, 'Lantern walk by the river', 76, '#2B2118', 'bold', 'Georgia'),
    text('details', 96, 420, 760, 110, 'Saturday 18 October, 6 pm\nMeet at the old boathouse steps', 30, '#3F332A'),
    rect('sun', 980, 420, 200, 200, '#D98F2B', 100),
    text('footer', 96, 610, 900, 50, 'Free for everyone. Lanterns to borrow at the start.', 24, '#5A4A3C'),
  ])
  const night = scene('scene-lantern-night', 'Lantern walk by the river', 1280, 720, '#14213D', LANTERN_CRITERIA, [
    rect('glow', 860, 120, 300, 300, '#F2C14E', 150),
    text('headline', 96, 140, 720, 260, 'Lanterns on the river', 88, '#FDF6E3', 'bold', 'Georgia'),
    text('details', 96, 450, 700, 110, 'Saturday 18 October, 6 pm\nOld boathouse steps', 32, '#E5DCC3'),
    text('footer', 96, 610, 900, 50, 'Free for everyone. Bring a light or borrow one.', 24, '#B9C3D6'),
  ])
  const quiet = scene('scene-lantern-quiet', 'Lantern walk by the river', 1280, 720, '#FFFFFF', LANTERN_CRITERIA, [
    text('headline', 120, 220, 1040, 120, 'Lantern walk', 96, '#1E3A34', 'bold'),
    text('details', 120, 380, 1040, 110, 'Saturday 18 October · 6 pm · Old boathouse steps', 34, '#1E3A34'),
    rect('rule', 120, 350, 160, 6, '#2F7D6D'),
  ])
  const brief = { id: 'lantern-walk', purpose: 'Invite neighbours to an evening lantern walk along the river', audience: 'Families and neighbours of all ages', criteria: LANTERN_CRITERIA }
  return source(s, [[['headline', { text: 'Bring a lantern. Walk the river with us.' }], ['sun', { fill: '#E9A23B' }]], [['details', { fontSize: 32 }]]], brief, [
    { id: 'warm-paper', label: 'Warm paper', rationale: 'Cream paper, a low sun and an editorial headline: friendly and calm.', scene: s },
    { id: 'night-river', label: 'Night river', rationale: 'Deep blue night with one warm glow: the lanterns are the light.', scene: night },
    { id: 'quiet-type', label: 'Quiet type', rationale: 'Mostly white space and one strong line: reads from across the street.', scene: quiet },
  ], { artifact_id: 'ar_simbrief', revision: 1, digest: digestOf('lantern-brief') })
}
function nightSky() {
  const crit = ['Name the festival and the date', 'Feel like a clear night sky', 'Readable on a phone screen']
  const s = scene('scene-night-sky', 'Night-sky festival', 900, 1200, '#0B1026', crit, [
    rect('moon', 560, 120, 220, 220, '#F5F1E3', 110),
    text('kicker', 80, 140, 440, 40, 'LYRA OBSERVATORY', 26, '#9FB3FF', 'bold'),
    text('headline', 80, 420, 740, 330, 'Night-sky festival', 104, '#FFFFFF', 'bold'),
    text('details', 80, 820, 740, 120, 'Friday 24 October', 34, '#D6DDFF'),
    rect('ticket', 80, 1010, 360, 90, '#3D4BD9', 18),
    text('cta', 110, 1032, 320, 50, 'Free · all ages', 32, '#FFFFFF', 'bold'),
  ])
  const dawn = scene('scene-night-dawn', 'Night-sky festival', 900, 1200, '#2E1F47', crit, [
    rect('horizon', 0, 860, 900, 340, '#F08A5D'),
    text('headline', 80, 300, 740, 330, 'Stay up for the stars', 104, '#FFF4E6', 'bold'),
    text('details', 80, 700, 740, 120, 'Friday 24 October · Lyra Observatory', 34, '#FFE3CC'),
  ])
  return source(s, [[['headline', { fontSize: 120 }]], [['ticket', { fill: '#5B6CFF' }]], [['details', { text: 'Friday 24 October, from dusk\nTelescopes, talks and warm drinks' }]]], { id: 'night-sky', purpose: 'Announce the observatory’s open night-sky festival', audience: 'Local families and students', criteria: crit }, [
    { id: 'deep-night', label: 'Deep night', rationale: 'A full moon on deep navy.', scene: s },
    { id: 'dusk', label: 'Dusk', rationale: 'Warm horizon, inviting people before dark.', scene: dawn },
  ], { artifact_id: 'ar_simbrief2', revision: 1, digest: digestOf('night-brief') })
}
function tideCard() {
  const crit = ['Explain what the sensor measures', 'Show who to contact']
  const s = scene('scene-tide-card', 'Tide-sensor field card', 1200, 800, '#E8F3F1', crit, [
    rect('wave', 0, 560, 1200, 240, '#2F7D6D'),
    text('headline', 80, 90, 1000, 120, 'Tide sensor K-7', 84, '#12332D', 'bold'),
    text('body', 80, 240, 900, 200, 'Measures water height every ten minutes. Please do not move or cover it.', 36, '#1F4A42'),
    text('contact', 80, 620, 1000, 60, 'Questions: ask the Kelp swarm', 32, '#E8F3F1', 'bold'),
  ])
  return source(s, [], { id: 'tide-card', purpose: 'A field card on a tide sensor', audience: 'People walking on the shore', criteria: crit }, [], { artifact_id: 'ar_simbrief3', revision: 1, digest: digestOf('tide-brief') })
}

function benchNight() {
  const crit = ['Say what happens and when', 'Feel friendly to beginners']
  const s = scene('scene-bench-night', 'Open bench night', 1200, 800, '#1B1B24', crit, [
    rect('bar', 0, 0, 1200, 24, '#E07A2E'),
    text('headline', 80, 120, 1040, 160, 'Open bench night', 96, '#F7F3EA', 'bold'),
    text('details', 80, 330, 1000, 120, 'Thursday evenings at the Forge workshop\nBring a broken gadget; leave with a fixed one', 34, '#D9D2C3'),
    text('footer', 80, 660, 1000, 60, 'Free · tools and tea provided', 30, '#E07A2E', 'bold'),
  ])
  return source(s, [], { id: 'bench-night', purpose: 'Invite people to a weekly repair evening', audience: 'Neighbours who like to tinker', criteria: crit }, [], { artifact_id: 'ar_simbrief4', revision: 1, digest: digestOf('bench-brief') })
}

// ------------------------------------------------------------------ invented decks (demo D3)

/** Design's deck schema (forms/designCanvas/model.ts DECK_SCHEMA): the canvas says decks open in the Studio. */
export const SIM_DECK_SCHEMA = 'omega-scene-deck-1'
/** An INVENTED deck: a title, the hard criteria, and slides that are each one scene. */
const deck = (id: string, title: string, criteria: string[], slides: Scene[]) => ({ schema: SIM_DECK_SCHEMA, id, title, criteria, slides })
function openDayDeck() {
  const crit = ['Date and time on the first slide', 'One idea per slide', 'Readable from the back of a hall']
  const bg = '#101A3A'
  return deck('deck-open-day', 'Observatory open day', crit, [
    scene('slide-1', 'Welcome', 1280, 720, bg, crit, [
      text('headline', 96, 200, 1088, 160, 'Open day at Lyra Observatory', 80, '#FFFFFF', 'bold'),
      text('details', 96, 420, 1088, 80, 'Saturday 1 November · 10 am to 4 pm', 36, '#C9D3FF'),
    ]),
    scene('slide-2', 'What you can see', 1280, 720, bg, crit, [
      text('headline', 96, 96, 1088, 110, 'What you can see', 64, '#FFFFFF', 'bold'),
      text('details', 96, 260, 1088, 300, 'Sunspots through the solar scope\nThe library of old star charts\nA tour of the dome', 36, '#C9D3FF'),
    ]),
    scene('slide-3', 'Getting here', 1280, 720, bg, crit, [
      text('headline', 96, 96, 1088, 110, 'Getting here', 64, '#FFFFFF', 'bold'),
      text('details', 96, 260, 1088, 200, 'Bus 12 to the hill stop, then a short walk\nFree entry, no booking needed', 36, '#C9D3FF'),
    ]),
  ])
}
function parserDeck() {
  const crit = ['Say what was reviewed', 'Say what it cost']
  const bg = '#1B1B24'
  return deck('deck-parser-review', 'Parser review summary', crit, [
    scene('slide-1', 'Summary', 1280, 720, bg, crit, [
      text('headline', 96, 200, 1088, 140, 'Parser review: second pass', 72, '#F7F3EA', 'bold'),
      text('details', 96, 400, 1088, 120, 'Passes on the recorded tides\nTwo small fixes still to make', 34, '#D9D2C3'),
    ]),
    scene('slide-2', 'Cost', 1280, 720, bg, crit, [
      text('headline', 96, 96, 1088, 110, 'What it cost', 64, '#F7F3EA', 'bold'),
      text('details', 96, 260, 1088, 120, 'Under half of the review budget', 36, '#D9D2C3'),
    ]),
  ])
}

/** The designs this sim knows, by artifact id (the starter, plus the studio-source artifacts the sim's swarms own). */
const DESIGNS: Record<string, () => Json> = { ar_simstarter: lanternWalk, ar_simposter: nightSky, ar_simtidecard: tideCard, ar_simbenchcard: benchNight, ar_simdeck: openDayDeck, ar_simforgedeck: parserDeck }

/** SIM: the starter design the Ask opens when asked to make something (its exact reference). */
export function designStarter(): Ref {
  return { artifact_id: 'ar_simstarter', revision: 1, digest: digestOf(lanternWalk()) }
}

// ------------------------------------------------------------------ the program

const OPERATIONS = ['init', 'inspect', 'revise', 'direction', 'reuse-identity', 'select', 'svg', 'ui', 'react', 'merge', 'save-source', 'motion']

export function omegaDesign() {
  /** kept revisions: artifact id → revision number → source */
  const kept = new Map<string, Map<number, Json>>()
  const latest = (id: string) => Math.max(0, ...(kept.get(id)?.keys() ?? []))
  const sourceFor = (ref: Ref): Json => {
    const saved = kept.get(ref.artifact_id)?.get(ref.revision)
    if (saved) return clone(saved)
    const make = DESIGNS[ref.artifact_id]
    if (!make) throw new Error(`no such studio source ${ref.artifact_id}`)
    return make()
  }
  const keepRevision = (next: Json, base: Ref | undefined) => {
    const id = base?.artifact_id ?? `ar_simnew${kept.size + 1}`
    const revision = Math.max(latest(id), base?.revision ?? 0) + 1
    const raw = canonical(next)
    const output = { artifact_id: id, revision, digest: `sha256:${sha256HexSync(raw)}` }
    if (!kept.has(id)) kept.set(id, new Map())
    kept.get(id)!.set(revision, clone(next))
    const asset = { sha256: sha256HexSync(raw), mime: 'application/json', bytes: new TextEncoder().encode(raw).length }
    return { status: 'done', data: { output, assets: [asset], adopted: false } }
  }
  /**
   * Demo D3: a deck save. The sim has no deck verifier, so it checks the shape only: a title, one to forty slides that
   * are each a scene with elements, and (for a loaded deck) the same hard criteria as the revision it was loaded from.
   */
  const keepDeck = (next: Json, base: Ref | undefined) => {
    const slides = next.slides as Json[] | undefined
    if (typeof next.title !== 'string' || !next.title.trim()) throw new Error('A deck needs a title')
    if (!Array.isArray(slides) || slides.length < 1 || slides.length > 40) throw new Error('A deck has one to forty slides')
    if (slides.some((sl) => !sl || sl.schema !== 'omega-scene-1' || !Array.isArray(sl.elements))) throw new Error('Every slide is one scene')
    if (base) {
      const prior = sourceFor(base)
      if (prior.schema !== SIM_DECK_SCHEMA) throw new Error('Save must keep the kind of source it was loaded as')
      if (canonical(prior.criteria) !== canonical(next.criteria)) throw new Error('Save must retain hard criteria and brief')
    }
    return keepRevision(next, base)
  }
  return {
    manifest: { id: 'omegadesign', name: 'OmegaDesign', version: '0.4.4-sim', description: 'Editable creative canvas, exact source custody and sandboxed Studio actions (simulated)', icon: 'sparkles', capabilities: ['sandbox:run', 'goals:read', 'artifacts:read', 'artifacts:write'] },
    describe: (): ProgramDescription => ({
      contract: '0.1',
      kinds: [{ id: 'status', label: 'Creative validation', role: 'assessment' }],
      relations: [],
      actions: OPERATIONS.map((op) => ({ id: op, label: `Studio ${op}`, agents: op !== 'save-source', person_activity: op === 'save-source', effect: 'write', binding_params: ['goal_id', 'source', 'incoming_source'], revalidate: true,
        // the person's save names its params (Design's source-save wire), so the host can check a frame's save before asking
        ...(op === 'save-source' ? { params: { editable_source_json: 'The editable source, as JSON text', editable_source: 'The editable source, as an object', source: 'The exact revision it was loaded from' } } : {}) }) as ProgramAction),
    }),
    view(_ctx: ProgramCtx, focus: string | null, _stage: ProgramStage): Json {
      if (focus && focus.startsWith('studio-source:')) {
        const ref = JSON.parse(focus.slice('studio-source:'.length)) as Ref
        const src = sourceFor(ref)
        return { revision: ref.digest, items: [{ id: 'editable-source', kind: 'status', label: 'Editable source', meta: { design_source: { schema: src.schema, reference: ref } }, data: { source: src, reference: ref } }], links: [], focus: 'editable-source' }
      }
      return { revision: 'semantic-candidate-v1', items: [{ id: 'design-status', kind: 'status', label: 'Creative semantic validator candidate; host revision context required' }], links: [], focus: 'design-status' }
    },
    async act(ctx: ProgramCtx, action: string, _items: string[], params: Json): Promise<Json> {
      if (action !== 'save-source') return { status: 'refused', message: 'Studio operations run only for a mind holding a task (simulated).' }
      // a host that names the actor (contract 0.2) must name a person; without one, the host's person_activity confirm
      // (the token is minted only for a named person, api/sim/confirmTokens.ts) already established who acts
      const actor = (ctx as ProgramCtx & { actor?: { kind?: string; principal?: string } | null }).actor
      if (actor && (actor.kind !== 'person' || !actor.principal)) throw new Error('Trusted person action required')
      // Design's decode_source_input: exactly one editable source, as an object or as JSON text (fractions stay exact)
      if (('editable_source' in params) === ('editable_source_json' in params)) throw new Error('Exactly one editable source object or JSON string required')
      if ('editable_source_json' in params && typeof params.editable_source_json !== 'string') throw new Error('Editable source JSON must be a string')
      const decoded = 'editable_source_json' in params ? (JSON.parse(params.editable_source_json as string) as unknown) : params.editable_source
      const next = decoded as Json & { current: Json & { digest: string; scene: Json }; history: { digest: string }[]; project: { brief: unknown } }
      const base = params.source as Ref | undefined
      if (next && typeof next === 'object' && next.schema === SIM_DECK_SCHEMA) return keepDeck(next as unknown as Json, base)
      if (!next || typeof next !== 'object' || next.schema !== 'omega-studio-source-1') throw new Error('Exactly one editable source object required')
      if (base) {
        const prior = sourceFor(base) as typeof next
        if (!next.history.some((r) => r.digest === prior.current.digest)) throw new Error('Save must retain the loaded source revision')
        if (canonical(prior.current.scene.criteria) !== canonical(next.current.scene.criteria) || canonical(prior.project.brief) !== canonical(next.project.brief)) throw new Error('Save must retain hard criteria and brief')
      }
      // Design's own inspection: its native source verifier (vendored byte-exact, forms/designCanvas/native/PIN.json)
      try {
        await verifySource(next)
      } catch (e) {
        throw new Error(`Inspect refused: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
      }
      return keepRevision(next, base)
    },
  }
}
