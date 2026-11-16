/**
 * Banked synthetic tours (Root's contract, 2026-10-06/07). Four brain modules with no screen of their own yet have a
 * guided demonstration in the Omega Tools catalogue: attention-demo-focus, skill-demo-nominate, energy-demo-reserve,
 * scratch-demo-promotion. Each is a fixed, ordered script of steps
 *
 *   {id, explain, tool, skill, arguments, expected_native?, contains_native?, qualification:"synthetic", state_origin}
 *
 * recorded earlier. The tour READS that script through the hive's own app view (POST /api/programs/omega-tools/view,
 * focus `demo:<hook>`), the same read the app page makes, and shows each step as recorded: "banked / synthetic, not
 * run now". A recorded output is never shown as an actual result. The temporal demos are explicitly unavailable
 * (`available: false`) and stay an honest "being built" answer.
 *
 * Screen-only (tour.step): nothing here runs a step, calls run-native, borrows a mind's token or invents a person
 * action. Running a step fresh waits on Platform's decision; `freshRunHook` is the one place it will plug in.
 */
import { plural } from '../../lib/plural'
import type { HiveClient } from '../../api/client'
import type { BankedStep, GuideScript, GuideStep } from './types'

/** The Tools catalogue app's id on a hive. */
export const TOOLS_APP = 'omega-tools'
/** What every banked step says about itself, wherever it is shown. */
export const BANKED_LABEL = 'Banked / synthetic, not run now'
/** The full qualification, as one phrase: every banked transcript entry and announcement carries it (stand-in r2). */
export const BANKED_QUALIFICATION = `${BANKED_LABEL}; executed now: false`

export interface BankedDemo {
  id: string
  title: string
  module: string
  qualification: string
  steps: BankedStep[]
}

export type BankedRead = { demo: BankedDemo } | { missing: 'app' | 'demo' | 'unavailable' | 'unreadable' }

const str = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const list = (v: unknown): v is unknown[] => Array.isArray(v) && v.length <= 64
const STEP_KEYS = new Set(['id', 'explain', 'tool', 'skill', 'arguments', 'expected_native', 'contains_native', 'qualification', 'state_origin', 'example'])

/** One step, strictly: anything not in the contract's shape (or not synthetic) is not shown at all. */
export function readBankedStep(v: unknown): BankedStep | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (Object.keys(o).some((k) => !STEP_KEYS.has(k))) return null
  if (!str(o.id, 120) || !str(o.explain) || !str(o.tool, 200) || !str(o.skill, 200) || !str(o.state_origin, 400)) return null
  if (o.qualification !== 'synthetic' || !list(o.arguments)) return null
  const expected = o.expected_native ?? null
  const contains = o.contains_native ?? null
  if ((expected !== null && !list(expected)) || (contains !== null && !list(contains))) return null
  // a step with no recorded output to show is fine; one claiming both is not guessed at
  if (expected !== null && contains !== null) return null
  return { id: o.id, explain: o.explain, tool: o.tool, skill: o.skill, arguments: o.arguments, expected_native: expected, contains_native: contains, qualification: 'synthetic', state_origin: o.state_origin }
}

/** A demo card's `meta` (the catalogue entry), strictly. `unavailable`: the catalogue itself says it is not built. */
export function readBankedDemo(meta: unknown, hook: string): BankedDemo | 'unavailable' | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const o = meta as Record<string, unknown>
  if (o.id !== hook) return null
  if (o.available === false) return 'unavailable'
  if (o.available !== true || !str(o.title, 200) || !str(o.module, 80) || !str(o.qualification, 400) || !list(o.steps) || !o.steps.length) return null
  const steps = o.steps.map(readBankedStep)
  if (steps.some((s) => !s)) return null
  return { id: hook, title: o.title, module: o.module, qualification: o.qualification, steps: steps as BankedStep[] }
}

/** Read one demo's script from the hive's Tools app (a read; the same view the app page asks for). */
export async function loadBanked(hook: string, client: HiveClient | null, appEnabled: boolean, swarm: string | null): Promise<BankedRead> {
  if (!client || !appEnabled || !swarm) return { missing: 'app' }
  let items
  try {
    items = (await client.programView(TOOLS_APP, { swarm_id: swarm, focus: `demo:${hook}`, stage: 'detail' })).items
  } catch {
    return { missing: 'unreadable' }
  }
  const item = Array.isArray(items) ? items.find((i) => i && i.id === `demo:${hook}` && i.kind === 'demo') : undefined
  if (!item) return { missing: 'demo' }
  const d = readBankedDemo(item.meta, hook)
  if (d === 'unavailable') return { missing: 'unavailable' }
  return d ? { demo: d } : { missing: 'unreadable' }
}

const ON_APP = [{ tour: 'program-stage-view' }, { region: 'page' }]

/**
 * A step to a module's current-state viewer on the mind's Tools tab. Screen-only (a `mind` tab and a `data-tour`
 * target); a `read` step, so the viewer stays readable: the Ask folds its thread to its bar (still on screen) and the
 * caption sits outside the viewers (stand-in r5 P2). Every tour that ends on a viewer, banked or stub, uses this.
 */
export function toViewer(viewer: NonNullable<GuideScript['viewer']>, say: string): GuideStep {
  return { say, do: { mind: 'tools' }, target: [{ tour: `module-${viewer}` }, { tour: 'reasoning-modules' }, { region: 'page' }], read: true }
}

/**
 * The last step of a module's tour: move the screen to its current-state viewer. The viewer itself reads under the
 * person's own session, and says "unavailable: no reader yet" where the hive has none. The banked steps are never
 * shown there.
 */
export function viewerStep(base: GuideScript): GuideStep[] {
  if (!base.viewer) return []
  return [toViewer(base.viewer, 'This is where its current state will show, read from the mind itself. Where the hive has no reader yet, it says so; the banked demo never stands in for it.')]
}

/**
 * The tour a banked demo plays. Read: open the Tools app, one step per banked step (said in its own words, shown as
 * recorded), and a last step that says nothing ran. Not read: an honest note, then what exists today.
 */
export function bankedScript(base: GuideScript, r: BankedRead): GuideScript {
  if ('demo' in r) {
    const d = r.demo
    const steps: GuideStep[] = [
      {
        say: `${base.title} has no screen of its own yet. Its guided demo is a banked script in the Omega Tools catalogue: ${plural(d.steps.length, 'step')} recorded earlier, synthetic, and not run now.`,
        do: { app: TOOLS_APP },
        target: ON_APP,
        wait: { for: 'target', ms: 6000 },
      },
      ...d.steps.map((s): GuideStep => ({ say: s.explain, banked: s, target: ON_APP })),
      { say: 'That was the banked script, shown as recorded. Nothing ran now: running a step fresh waits on a Platform decision.', target: ON_APP },
      ...viewerStep(base),
    ]
    return { ...base, steps }
  }
  const why =
    r.missing === 'app'
      ? 'Its banked demo lives in the Omega Tools catalogue, which is not on this hive yet.'
      : r.missing === 'unavailable'
        ? 'The catalogue says its demo is not built yet.'
        : 'Its banked demo could not be read from the Omega Tools catalogue just now.'
  const [first, ...rest] = base.steps
  const steps: GuideStep[] = [...(first ? [{ ...first, say: `${why} ${first.say}` }, ...rest] : [{ say: why, target: { region: 'page' } }]), ...viewerStep(base)]
  return { ...base, title: `${base.title}: what exists today`, steps }
}

/**
 * TODO(platform-fresh-run-decision): running a banked step FRESH. Root (20261006-235125Z) asks Platform to choose
 * the existing authenticated mind delegation path, or to authorise a fixed-input person-demo action. Until Platform
 * decides, nothing calls this and it does nothing: the browser never calls run-native, never borrows a mind's
 * token and never invents a person action. Wire the chosen host route here and show its result as executed_now: true
 * beside (never in place of) the banked one.
 */
export function freshRunHook(_hook: string, _stepId: string): { status: 'waiting-on-platform' } {
  return { status: 'waiting-on-platform' }
}

/** A short, safe rendering of a recorded value (arguments, outputs) for the caption. */
export function shortValue(v: unknown, max = 160): string {
  let s: string
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v)
  } catch {
    s = String(v)
  }
  s = (s ?? '').replace(/\s+/g, ' ')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
