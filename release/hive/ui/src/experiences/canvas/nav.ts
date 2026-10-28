import { FEATURES, targetFor, type Feature } from '../sdk'

/**
 * Canvas's own navigation. The board does the core loop; the "Hive" panel (top bar) lists every feature in the hive,
 * grouped, and opens each one the Canvas way: on the board, as a Canvas card, or as its page in Canvas chrome. The
 * panel renders exactly HIVE_ENTRIES, so NAV_FEATURES is what a person can actually reach (coverage.test.ts).
 */
export type CanvasWay = 'board' | 'card' | 'page' | 'mind'

/** Done on the board itself. */
export const BOARD: Record<string, string> = {
  'minds.see': 'Shows the whole canvas',
  'swarms.see': 'Shows the whole canvas',
  'watch.activity': 'Live on the canvas',
  'minds.talk': 'Opens the canvas outline',
  'minds.wake': 'Opens the canvas outline',
  'work.goals': 'Opens the canvas outline',
  'decide.approvals': 'Goes to the decisions lane',
  'hive.search': 'Searches the canvas',
}

/** Built as Canvas cards in the Hive panel. */
export const CARDS = ['swarms.beliefs', 'work.motivations', 'decide.history', 'money.usage', 'people.manage'] as const
export type CardId = (typeof CARDS)[number]

export function wayFor(f: Feature): CanvasWay | null {
  if (BOARD[f.id]) return 'board'
  if ((CARDS as readonly string[]).includes(f.id)) return 'card'
  const t = targetFor(f)
  if (!t) return null
  return t.kind === 'mind' ? 'mind' : 'page'
}

/** Everything the Hive panel lists. */
export const HIVE_ENTRIES: Feature[] = FEATURES.filter((f) => wayFor(f) !== null)

/** Also on the toolbar: start a swarm, new mind (the owner, 2026-10-05). */
export const TOOLBAR = ['swarms.launch', 'minds.create']

export const NAV_FEATURES: string[] = [...new Set([...HIVE_ENTRIES.map((f) => f.id), ...TOOLBAR])]
