import type { Agent, Belief, Swarm } from '../api/types'
import type { Route } from '../lib/router'
import { appUsable, pickProgramSwarm } from '../features/programs/pickSwarm'
import { sessionKey } from '../store/programSession'
import type { Store } from '../store/store'
import { meta } from './chapters'
import type { ChapterLike } from './machine'

/**
 * The guided tour, chapter by chapter. It drives the real app (router and store actions only, nothing
 * that changes the hive), points at real elements by their `data-tour` names, and every sentence
 * describes the app as it is built. Texts and targets are chosen for the device at build time.
 */

export type Rect = { x: number; y: number; w: number; h: number; round?: boolean }
export type TargetFn = (ctx: TourCtx) => Element | Rect | null
/** A `data-tour` name, or a function for things that are not elements (a mind on the canvas). */
export type Target = string | TargetFn

export interface Beat {
  text: string
  /** The pointer moves here and clicks, then `do` runs. */
  point?: Target
  /** Click the pointed element for real. Only for harmless UI toggles (a menu, a drawer). */
  press?: boolean
  do?: (ctx: TourCtx) => void | Promise<void>
  /** What the spotlight shows once `do` has run (defaults to `point`; null: no spotlight). */
  show?: Target | null
}

export interface Chapter extends ChapterLike {
  /** One line for the chapter list and the help sheet. */
  blurb: string
  setup(ctx: TourCtx): void | Promise<void>
  beats: Beat[]
}

export interface TourCtx {
  mobile: boolean
  sim: boolean
  store(): Store
  go(route: Route): void
  sleep(ms: number): Promise<void>
  /** The first visible element with this data-tour name. */
  find(name: string): HTMLElement | null
  /** Wait up to `ms` for it. */
  waitFor(name: string, ms?: number): Promise<HTMLElement | null>
  /** Open a program on a clean trail; the person's own trail comes back when the tour ends. */
  freshProgram(programId: string, swarmId: string): void
  scene: {
    overview(): void
    dot(id: string): { x: number; y: number; r: number } | null
    core(id: string): { x: number; y: number; r: number } | null
  }
}

// ---------------------------------------------------------------- choosing real things to show

export interface Picks {
  swarm: Swarm | null
  dot: Agent | null
  /** A second awake dot, to show what "asleep" looks like when there is one. */
  sleeper: Agent | null
  belief: Belief | null
  goalsSwarm: Swarm | null
  program: string | null
  explorer: string | null
}

export function pick(s: Store): Picks {
  const swarms = Object.values(s.swarms).sort((a, b) => a.created_at.localeCompare(b.created_at))
  const swarm = swarms[0] ?? null
  const agents = Object.values(s.agents)
  const members = swarm ? agents.filter((a) => a.swarm_id === swarm.id) : agents
  const dot = members.find((a) => a.status === 'awake') ?? agents.find((a) => a.status === 'awake') ?? members[0] ?? agents[0] ?? null
  const sleeper = members.find((a) => a.status === 'asleep') ?? agents.find((a) => a.status === 'asleep') ?? null
  const beliefs = swarm ? Object.values(s.beliefs[swarm.id] ?? {}) : []
  const belief = [...beliefs].sort((a, b) => b.sources.length - a.sources.length || b.tv.c - a.tv.c)[0] ?? null
  const goals = Object.values(s.goals)
  const goalsSwarmId = goals.find((g) => g.status === 'waiting')?.swarm_id ?? goals.find((g) => g.status === 'claimed')?.swarm_id ?? swarm?.id
  const enabled = (s.programs ?? []).filter((p) => p.enabled && !p.error)
  const program = enabled.find((p) => p.id === 'contract-fixture')?.id ?? enabled[0]?.id ?? null
  const explorer = enabled.find((p) => p.id === 'commons-explorer')?.id ?? enabled[0]?.id ?? null
  return { swarm, dot, sleeper, belief, goalsSwarm: (goalsSwarmId && s.swarms[goalsSwarmId]) || swarm, program, explorer }
}

// ---------------------------------------------------------------- small helpers

const dotTarget = (id: string | undefined): TargetFn => (ctx) => {
  const p = id ? ctx.scene.dot(id) : null
  if (!p) return null
  const r = Math.max(26, p.r * 3.2)
  return { x: p.x - r, y: p.y - r, w: r * 2, h: r * 2, round: true }
}
const coreTarget = (id: string | undefined): TargetFn => (ctx) => {
  const p = id ? ctx.scene.core(id) : null
  if (!p) return null
  const r = Math.max(40, p.r * 1.25)
  return { x: p.x - r, y: p.y - r, w: r * 2, h: r * 2, round: true }
}
const starTarget = (statement: string | undefined): TargetFn => () => {
  if (!statement) return null
  const stars = document.querySelectorAll<SVGGElement>('[data-tour="star"]')
  for (const g of stars) if (g.getAttribute('data-statement') === statement) return g
  return stars[0] ?? null
}

async function setExpanded(ctx: TourCtx, name: string, open: boolean) {
  const el = ctx.find(name)
  if (el && (el.getAttribute('aria-expanded') === 'true') !== open) {
    el.click()
    await ctx.sleep(380)
  }
}

/** Show a program step without piling up trail steps when a beat is replayed. */
function programStep(ctx: TourCtx, programId: string, swarmId: string, stage: 'unfold' | 'map' | 'compare' | 'detail', focus: string | null) {
  const key = sessionKey(programId, swarmId)
  const s = ctx.store()
  const sess = s.programSessions[key]
  const cur = sess?.trail[sess.trail.length - 1]
  if (cur && cur.stage === stage && (cur.focus === focus || stage === 'map')) return
  s.programGo(key, { stage, focus })
}

// ---------------------------------------------------------------- the script

export function buildChapters(ctx: TourCtx): Chapter[] {
  const p = pick(ctx.store())
  const { mobile, sim } = ctx
  const swarm = p.swarm?.id
  const dotId = p.dot?.id
  const dotName = p.dot?.name ?? 'a mind'
  // the commons as stars: the Constellation's own target (followups-r5); a swarm with no beliefs draws no stars, so
  // there the tour shows the commons' frame (its empty sky) instead of waiting for stars that never come
  const skyTarget = p.belief ? 'swarm-constellation' : 'swarm-sky'
  const openDot = (tab?: 'mind' | 'memory' | 'schedule' | 'model') => () => {
    if (dotId) ctx.go({ name: 'dot', id: dotId, tab })
  }
  const goalsSwarm = p.goalsSwarm?.id
  const prog = p.program
  // the app opens where it is set up (its first home this person sees), else in the tour's swarm
  let progSwarm = swarm
  const closeOverlays = async () => {
    const s = ctx.store()
    if (s.stopAllOpen) s.setStopAll(false)
    if (s.paletteOpen) s.setPalette(false)
    await setExpanded(ctx, 'hud-more', false)
  }

  const chapters: Chapter[] = [
    {
      ...meta('hive'),
      async setup() {
        await closeOverlays()
        ctx.go({ name: 'hive' })
        await ctx.sleep(400)
        ctx.scene.overview()
        await ctx.sleep(700)
      },
      beats: [
        { text: 'This is your hive. Every glowing orb is a mind, an AI that stays on.', show: null },
        { text: 'Minds live in swarms, around a core of shared beliefs.', show: coreTarget(swarm) },
        { text: p.sleeper ? 'Bright minds are awake, dim ones asleep. A spinning ring means thinking.' : 'Bright minds are awake. A spinning ring means thinking.', show: dotTarget(dotId) },
      ],
    },
    {
      ...meta('swarm'),
      async setup() {
        await closeOverlays()
        // ?tab=commons: the commons as its constellation (it otherwise opens as a table), so the stars can be shown
        if (swarm) ctx.go({ name: 'swarm', id: swarm, tab: 'commons' })
        await ctx.waitFor(skyTarget)
      },
      beats: [
        { text: 'A swarm’s commons shows every belief it shares, as a star.', show: skyTarget },
        { text: 'Brighter and nearer the core means surer. Colour shows how often it holds.', show: starTarget(p.belief?.statement) },
      ],
    },
    {
      ...meta('dot'),
      async setup() {
        await closeOverlays()
        if (dotId) ctx.go({ name: 'dot', id: dotId })
        await ctx.waitFor('dot-header')
        await ctx.sleep(400)
      },
      beats: [
        { text: `This is ${dotName}. Wake it, rest it, or stop it here.`, show: 'dot-controls' },
        { text: 'Chat talks with it.', point: 'dot-tab-chat', do: openDot(), show: 'chat-composer' },
        { text: 'Thinking shows how it thinks, step by step.', point: 'dot-tab-mind', do: openDot('mind'), show: 'mind-replay' },
        { text: 'Memory is what it keeps.', point: 'dot-tab-memory', do: openDot('memory'), show: 'memory-spaces' },
        { text: 'Schedule is when it wakes.', point: 'dot-tab-schedule', do: openDot('schedule'), show: 'schedule-wakeups' },
        { text: 'Model sets its AI and its budget.', point: 'dot-tab-model', do: openDot('model'), show: 'model-list' },
      ],
    },
    {
      ...meta('commons'),
      async setup() {
        await closeOverlays()
        // ?tab=commons: the commons as its constellation (it otherwise opens as a table), so the stars can be shown
        if (swarm) ctx.go({ name: 'swarm', id: swarm, tab: 'commons' })
        await ctx.waitFor(skyTarget)
      },
      beats: [
        {
          text: 'Tap a belief to see its evidence, and how sure the swarm is.',
          point: starTarget(p.belief?.statement),
          do: async () => {
            if (swarm && p.belief) ctx.go({ name: 'swarm', id: swarm, statement: p.belief.statement })
            await ctx.waitFor('prov-truth')
          },
          show: 'prov-truth',
        },
        { text: 'Each report revises it. Shared evidence never counts twice.', show: 'prov-assertions' },
        { text: 'Minds can also lend each other memory, for a set time.', show: 'prov-sources' },
      ],
    },
    {
      ...meta('goals'),
      async setup() {
        await closeOverlays()
        ctx.go({ name: 'tasks', ...(goalsSwarm ? { swarm: goalsSwarm } : {}) })
        await ctx.waitFor('goals-add')
      },
      beats: [
        { text: 'Tasks are the work, posted by you or by minds. Each can serve one or more motivations: the why.', show: 'goals-add' },
        { text: 'A mind claims one on a lease. If the lease runs out, the task reopens.', show: 'goal-lease' },
        { text: 'Amber cards are waiting on you.', show: 'goal-waiting' },
      ],
    },
    {
      ...meta('approvals'),
      async setup() {
        await closeOverlays()
        ctx.go({ name: 'approvals' })
        await ctx.waitFor('approval-card', 4000)
      },
      beats: [
        { text: 'Before anything risky, a mind stops and asks you.', show: 'approval-card' },
        { text: 'Approve it once, or always, which adds a rule.', show: 'approval-actions' },
        {
          text: 'Rules choose allow, ask or deny, for the hive, a swarm, or one mind.',
          point: 'approvals-tab-rules',
          do: async () => {
            ctx.go({ name: 'approvals', tab: 'rules' })
            await ctx.waitFor('policy-rules', 4000)
          },
          show: 'policy-rules',
        },
      ],
    },
    {
      ...meta('lab'),
      async setup() {
        await closeOverlays()
        ctx.go({ name: 'lab' })
        await ctx.waitFor('lab-scorecard', 4000)
      },
      beats: [
        { text: sim ? 'The Lab tests the hive itself. Here, it shows recorded runs.' : 'The Lab tests the hive itself, and scores the latest runs.', show: 'lab-scorecard' },
        { text: 'Cost is projected from measured tokens. It isn’t money spent.', show: 'lab-dim-cost' },
        {
          text: 'Drift scenarios try to push the hive off course. The leak count must stay at zero.',
          do: async () => {
            ctx.go({ name: 'lab', suite: 'bench-drift' })
            await ctx.waitFor('drift-leaks', 4000)
          },
          show: 'drift-leaks',
        },
        {
          text: 'History shows every run.',
          point: 'lab-suite-tab-history',
          do: async () => {
            ctx.go({ name: 'lab', suite: 'bench-drift', tab: 'history' })
            await ctx.waitFor('lab-history', 4000)
          },
          show: 'lab-history',
        },
      ],
    },
    {
      ...meta('programs'),
      async setup() {
        await closeOverlays()
        ctx.go({ name: 'programs' })
        // the app's home as the page itself would open it automatically: usable, not archived, never private
        const s = ctx.store()
        const reply = prog && s.client?.programHomes ? await s.client.programHomes(prog).catch(() => null) : null
        if (reply) {
          const now = ctx.store()
          const home = pickProgramSwarm({ swarms: now.swarms, agents: now.agents, homes: reply.homes, usable: appUsable(reply.homes), remembered: null, defaultSwarm: null })
          if (home) progSwarm = home
        }
        await ctx.waitFor(p.explorer ? `program-card-${p.explorer}` : 'programs-list', 4000)
      },
      beats: [
        { text: p.explorer === 'commons-explorer' ? 'Apps turn work into maps, like Commons Explorer.' : 'Apps turn work into maps you can explore.', show: p.explorer ? `program-card-${p.explorer}` : 'programs-list' },
        {
          text: 'Unfold puts a question in the middle, with support on one side and doubt on the other.',
          do: async () => {
            if (!prog || !progSwarm) return
            ctx.freshProgram(prog, progSwarm)
            // the graph view: an app with its own form (the case file) keeps its unfold/map/compare/detail stages there
            ctx.go({ name: 'program', id: prog, swarm: progSwarm, view: 'graph' })
            await ctx.waitFor('node-q1', 5000)
          },
          show: 'program-stage-view',
        },
        {
          text: 'Pick an item, and its sources stay in view.',
          point: 'node-c1',
          do: async () => {
            if (prog && progSwarm) ctx.store().programSelect(sessionKey(prog, progSwarm), ['c1'])
            if (mobile) await setExpanded(ctx, 'program-drawer', true)
            await ctx.sleep(250)
          },
          show: 'program-sources',
        },
        {
          text: 'Map shows everything.',
          point: 'program-stage-map',
          do: async () => {
            if (mobile) await setExpanded(ctx, 'program-drawer', false)
            if (prog && progSwarm) programStep(ctx, prog, progSwarm, 'map', 'c1')
            await ctx.sleep(400)
          },
          show: 'program-stage-view',
        },
        {
          text: 'Compare sets agreement, conflict and gaps side by side.',
          point: 'program-stage-compare',
          do: async () => {
            if (prog && progSwarm) programStep(ctx, prog, progSwarm, 'compare', 'c1')
            await ctx.sleep(400)
          },
          show: 'program-stage-view',
        },
        {
          text: 'Detail gives one item’s uncertainty, in exact numbers.',
          point: 'program-stage-detail',
          do: async () => {
            if (prog && progSwarm) programStep(ctx, prog, progSwarm, 'detail', 'c1')
            await ctx.waitFor('detail-uncertainty', 3000)
          },
          show: 'detail-uncertainty',
        },
        {
          text: 'Your trail keeps every step, and Back retraces it.',
          point: 'program-back',
          do: () => {
            if (prog && progSwarm) ctx.store().programBack(sessionKey(prog, progSwarm))
          },
          show: 'program-bar',
        },
      ],
    },
    {
      ...meta('safety'),
      async setup() {
        await closeOverlays()
        ctx.go({ name: 'hive' })
        await ctx.waitFor('hud-more')
      },
      beats: [
        { text: 'Stop all is always one menu away.', point: 'hud-more', press: true, show: 'menu-stop-all' },
        {
          text: 'It halts every mind until you start them again. You type “stop all” to confirm.',
          do: async () => {
            await setExpanded(ctx, 'hud-more', false)
            ctx.store().setStopAll(true)
            await ctx.waitFor('stop-all-dialog')
          },
          show: 'stop-all-dialog',
        },
        {
          text: sim ? 'Each mind has a budget cap. Here, costs are simulated, and nothing is charged.' : 'Each mind has a budget cap, and calls over it are refused.',
          do: async () => {
            ctx.store().setStopAll(false)
            if (dotId) ctx.go({ name: 'dot', id: dotId })
            await ctx.waitFor('dot-budget')
            await ctx.sleep(300)
          },
          show: 'dot-budget',
        },
      ],
    },
    {
      ...meta('start'),
      async setup() {
        await closeOverlays()
        ctx.go({ name: 'hive' })
        await ctx.waitFor('nav-create')
        ctx.scene.overview()
      },
      beats: [
        { text: 'Your turn: make a mind of your own with the plus button.', show: 'nav-create' },
        mobile ? { text: 'Tap More for every other page.', show: 'nav-more' } : { text: 'Press Command K to jump anywhere.', show: 'hud-search' },
        mobile
          ? { text: 'Every view has a question mark that explains it. Replay this tour from the more menu.', show: 'info-hive' }
          : { text: 'Every view has a question mark that explains it. Press the question mark key to see this again.', show: 'info-hive' },
      ],
    },
  ]
  return chapters
}

/** Every target a beat uses, by name, for the end-to-end check. */
export function targetName(t: Target | null | undefined): string | null {
  if (t == null) return null
  return typeof t === 'string' ? t : t.name || 'canvas'
}
