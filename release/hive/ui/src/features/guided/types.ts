/**
 * Guided demos by Ask (Jon, 2026-10-07: "show me how temporal reasoning works" → the Ask pulls up the module and
 * guides us through it by controlling the screen). A demo is DATA: a declarative script of steps. Each step says one
 * plain sentence, moves the screen to a real place, points at a real thing (the presence protocol's
 * `data-presence-*` targets, or the app's `data-tour` names), and says what to wait for.
 *
 * Nothing in a script can decide, spend or change the hive. The only screen actions are navigation, opening a page,
 * tab, swarm, mind or app view, previewing an experience (a preview: never kept unless the person keeps it), and
 * opening or closing harmless UI (the Change UI gallery, search, help, a menu). Anything consequential the person does
 * themselves, through the normal confirm (a `you` step waits for them).
 */
import type { DotTab, Route, SwarmTab } from '../../lib/router'

/** What a step points at. Several are tried in order; the first on the page wins. */
export interface GuideTarget {
  /** a named region (`data-presence-region`): page, thread, now, needs, learned, code-editor… */
  region?: string
  /** a feature's nav target (`data-presence-feature`, registry id) */
  feature?: string
  /** the mind or swarm the demo picked (`data-presence-ref`) */
  entity?: 'mind' | 'swarm'
  /** the app's own tour names (`data-tour`) */
  tour?: string
  /** the Ask itself (its capsule or line) */
  ask?: true
}

/** How a step moves the screen. All of these are reads or harmless UI; none decides or spends. */
export type GuideAction =
  | { go: Route }
  /** the mind the demo picked (an awake one if any), at a tab of its panel */
  | { mind: DotTab }
  /** the swarm the demo picked, at a tab; `belief` opens its best-evidenced belief's detail */
  | { swarm: SwarmTab | 'home'; belief?: true }
  /** an app's view (a read); without the app on this hive, the Apps page and an honest note */
  | { app: string }
  /** the Coffee Room */
  | { room: 'coffee' }
  /** harmless UI: the Change UI gallery, search, help, or close them all */
  | { ui: 'gallery' | 'palette' | 'help' | 'close' }
  /** preview an experience (null: back to the person's own). Previews are never kept by the demo. */
  | { experience: string | null }
  /** open (or close) a menu or drawer by its tour name: only an element with aria-expanded is ever pressed */
  | { press: string; open?: boolean }

export type GuideWait =
  /** wait (up to ms) for the target to be on the page; the default when a step has a target */
  | { for: 'target'; ms?: number }
  /** a fixed pause */
  | { for: 'time'; ms: number }
  /** the person's turn: wait, as long as it takes, for the target to appear (their clicks are not a takeover) */
  | { for: 'you' }

export interface GuideStep {
  /** One or two plain sentences. `{mind}`, `{swarm}` and `{belief}` are filled with what the demo picked. */
  say: string
  /** short caption beside the target (defaults to the first sentence) */
  caption?: string
  do?: GuideAction
  target?: GuideTarget | GuideTarget[]
  wait?: GuideWait
  /**
   * A step for reading what it points at (a module's current-state viewer): while it shows, the Ask folds its thread to
   * its bar (the Ask stays on screen and the person reopens the thread with one press), and the caption sits outside
   * the region holding the target where there is room, never over it, and clear of the Ask's band (stand-in r5 P2).
   */
  read?: true
  /**
   * A banked step of a Tools catalogue demo (read from the hive's Omega Tools app, never written here): shown as
   * recorded, "banked / synthetic, not run now". Its recorded output is never shown as an actual result.
   */
  banked?: BankedStep
}

/**
 * One step of a Tools catalogue guided demo, exactly as Root's demo catalogue reads (contract 2026-10-06):
 * {id, explain, tool, skill, arguments, expected_native?, contains_native?, qualification:"synthetic", state_origin}.
 * Reading the script executes nothing (executed_now: false).
 */
export interface BankedStep {
  id: string
  explain: string
  tool: string
  skill: string
  arguments: unknown[]
  /** the recorded output, exactly (never shown as actual) */
  expected_native: unknown[] | null
  /** what the recorded output contains (never shown as actual) */
  contains_native: unknown[] | null
  qualification: 'synthetic'
  state_origin: string
}

export type GuideStatus = 'ready' | 'stub'

export interface GuideScript {
  id: string
  title: string
  /** what this demo is about, in one line (the list of demos, the "nearest" offers) */
  blurb: string
  /** whole phrases that start it ("show me how belief revision works") */
  triggers: string[]
  /** topic words and phrases matched after "show me how … works", "walk me through …", "demo …" */
  topics: string[]
  /** ready: a full demo. stub: the module or its viewer is not built; the honest answer plays instead. */
  status: GuideStatus
  steps: GuideStep[]
  /** stubs: what is missing ("module", "viewer"), the honest answer, and the nearest real demos */
  needs?: 'module' | 'viewer' | 'module and viewer'
  answer?: string
  nearest?: string[]
  /** stubs: the proposed demo hooks (Root's names, pending owner contracts); a script fills its steps when they land */
  hooks?: string[]
  /** where the feature list says it stands (Live, In review…), said honestly in the demo */
  standing?: string
  /**
   * A demo whose steps are a banked synthetic script in the Omega Tools catalogue (Root's ready hook, e.g.
   * `attention-demo-focus`). The steps are read from the hive when it starts; `steps` above are what exists today,
   * played instead (with an honest note) when the catalogue is not on this hive or the script cannot be read.
   */
  banked?: string
  /**
   * The module's current-state viewer on a mind's Tools tab (`data-tour="module-<viewer>"`). A banked tour ends by
   * moving the screen there: a page read under the person's own session, saying honestly what it can read today.
   */
  viewer?: 'attention' | 'self' | 'energy' | 'scratch' | 'assume' | 'temporal'
}
