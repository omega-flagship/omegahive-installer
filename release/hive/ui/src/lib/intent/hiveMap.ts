/**
 * The hive map's own words (PLAN_HIVE_VIEW_SCALING r2 §2-§3, layout only): "show me Ada's hive", "my hive", "the cloud
 * hive", "zoom out", "zoom in", "show every hive", "tidy the hives". They move the view or the person's own
 * arrangement, nothing else: no membership, no permission, nothing on the hive. Only hives on this viewer's map
 * (scene/visibleSet's shown set, by the names the viewer may read) can be named.
 *
 * Split, merge and move change membership and need host routes no hive offers yet (Platform's; r2 §3). Until a hive
 * advertises them (scene/hiveActions), these words give nothing here and go on as ordinary words.
 */
import type { Candidate, Chip, IntentAct, World } from './types'

export type MapOp = 'overview' | 'zoomIn' | 'zoomOut' | 'galaxy' | 'resetLayout'

export interface MapHive {
  id: string
  name: string
  mine?: boolean
  cloud?: boolean
  /** other words the viewer may call it by (a person's name, first name, surname) */
  aliases?: string[]
}

const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[’`]/g, "'").replace(/[.!?]+$/, '').replace(/^please\s+|\s+please$/g, '').replace(/\s+/g, ' ').trim()

const OVERVIEW = /^(?:zoom (?:all the way )?out (?:fully|all the way|to (?:everything|every hive|the universe|all (?:the )?hives))|(?:show|see|view)(?: me| us)? (?:the )?(?:whole|entire|full) (?:universe|map|hive map)|(?:show|see|view)(?: me| us)? (?:all|every)(?: of)?(?: the)? (?:hives|galaxies)|(?:show|see|view)(?: me| us)? every hive|(?:the )?(?:whole )?universe(?: view)?|fit (?:everything|every hive|all (?:the )?hives))$/
const ZOOM_OUT = /^zoom out(?: a bit| a little| more)?$/
const ZOOM_IN = /^zoom in(?: a bit| a little| more)?$/
const RESET = /^(?:reset|tidy(?: up)?|rearrange|re-arrange|reorgani[sz]e|sort(?: out)?|straighten(?: out)?|unpin)(?: the| my| all(?: the)?)? (?:hives?|galaxies|universe|map|hive map|layout|arrangement)(?: layout)?$|^put (?:my|the|all(?: the)?) (?:hives|galaxies) (?:back|side by side|in order)$/
const GALAXY = /^(?:(?:show|bring|take)(?: me| us)?(?: to)? |go(?: back)? to |open |fly(?: me)? to |zoom (?:in )?(?:to|on|into) |visit |where is |find )?(?:the )?(.+?) hive$/

/** The hive the words name, among the hives on this viewer's map (ids of shown hives only). */
function named(words: string, hives: MapHive[]): MapHive[] {
  const w = fold(words).replace(/'s$/, '').replace(/^the /, '').trim()
  if (!w) return []
  if (/^(?:my|mine|my own|our|own)$/.test(w)) return hives.filter((h) => h.mine)
  if (/^(?:cloud|the cloud)$/.test(w)) return hives.filter((h) => h.cloud)
  // an unnamed hive ("A hive": a person this viewer may not see by name) can never be named
  return hives.filter((h) => !h.mine && !h.cloud && [...(/^a hive$/i.test(h.name) ? [] : [h.name.replace(/ hive$/i, '')]), ...(h.aliases ?? [])].some((a) => fold(a) === w))
}

const act = (op: MapOp, label: string, hive?: string): IntentAct => ({ do: 'map', op, label, ...(hive ? { hive } : {}) })

/** Candidates for the map's own words. Nothing when the map shows no hives (another experience, or no data yet). */
export function hiveMapCandidates(text: string, world: World): Candidate[] {
  const hives = world.hives ?? []
  if (!hives.length) return []
  const t = fold(text)
  const one = (key: string, op: MapOp, label: string, parts: Candidate['parts'], hive?: string): Candidate[] => [{ key, tag: 'Map', parts, act: act(op, label, hive), effect: 'view', confidence: 0.95 }]
  if (OVERVIEW.test(t)) return one('map-overview', 'overview', 'every hive', [{ t: 'Show ' }, { t: 'every hive', em: true }, { t: ' on the map' }])
  if (ZOOM_OUT.test(t)) return one('map-zoom-out', 'zoomOut', 'zoomed out', [{ t: 'Zoom the map out' }])
  if (ZOOM_IN.test(t)) return one('map-zoom-in', 'zoomIn', 'zoomed in', [{ t: 'Zoom the map in' }])
  if (RESET.test(t)) return one('map-reset', 'resetLayout', 'the hives back in their places', [{ t: 'Put ' }, { t: 'the hives', em: true }, { t: ' back in their own places (only your view changes)' }])
  const m = GALAXY.exec(t)
  if (!m) return []
  const hits = named(m[1], hives)
  if (hits.length === 1) {
    const h = hits[0]
    return one(`map-hive-${h.id}`, 'galaxy', h.name, [{ t: 'Show ' }, { t: h.name, em: true }, { t: ' on the map' }], h.id)
  }
  if (hits.length > 1) {
    const chips: Chip[] = hits.slice(0, 6).map((h) => ({ key: h.id, label: h.name, act: act('galaxy', h.name, h.id) }))
    return [{ key: 'map-hive-which', tag: 'Which', parts: [{ t: 'Which hive?' }], confidence: 0.9, clarify: { question: `Which one? ${hits.length} hives answer to that name.`, chips } }]
  }
  return []
}
