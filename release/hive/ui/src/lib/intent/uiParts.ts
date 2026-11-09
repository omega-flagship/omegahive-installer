/**
 * The UI's named parts, asked about in words (Surface one-experience r1, CANDIDATE; read-only): "what parts are here",
 * "what plays the apps role here", "what plays the field role in any look", "explain the app orbit part". The answer
 * is read from the real MeTTa parts space when the act runs (experiences/parts); nothing here changes anything.
 * Only the known words of the space are matched (roles and part names), so a person's words never become a query.
 */
import type { Candidate, IntentAct } from './types'

/** What the Ask says when the parts space cannot answer (Kimi r1 #9): one calm sentence; the detail goes to the console. */
export const PARTS_UNAVAILABLE = 'The parts space couldn’t answer that just now. Nothing changed.'

export type PartsAct =
  | { do: 'parts'; op: 'list' }
  | { do: 'parts'; op: 'role'; role: PartRole; anywhere: boolean }
  | { do: 'parts'; op: 'explain'; name: string }

/** The roles every look shares (UiSharedRole), with the words a person may use for them. */
export type PartRole = 'ω' | 'question' | 'field' | 'apps' | 'pro-gesture' | 'power'
const ROLE_WORDS: [RegExp, PartRole][] = [
  [/^(?:ω|omega|the omega|o)$/, 'ω'],
  [/^question$/, 'question'],
  [/^(?:field|ask|ask field|input)$/, 'field'],
  [/^(?:apps?|app orbit)$/, 'apps'],
  [/^(?:pro|pro gesture|pro-gesture|pro control)$/, 'pro-gesture'],
  [/^power$/, 'power'],
]
export const roleOf = (w: string): PartRole | null => ROLE_WORDS.find(([re]) => re.test(w))?.[1] ?? null
/** Part names a person may say (the space's own names, spaced as words). */
const PART_NAMES = /^(?:ω|omega|question|name|field|app orbit|app-orbit|pro gesture|pro-gesture|power|galaxy|labels|deck|panels|back)$/

const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[’`]/g, "'").replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim()

const LIST = /^(?:(?:list|show|name)(?: me)? (?:the |all(?: the)? )?(?:ui |screen |named )?parts(?: (?:here|on screen|of this (?:look|view|screen|ui)))?|(?:what|which) (?:ui |named )?parts (?:are|is) (?:here|there|on (?:the )?screen|in this (?:look|view|ui)))$/
const ROLE = /^(?:what|which parts?|who) (?:plays|play|is playing|draws|fills) (?:the )?(.+?) (?:role|part)(?: (here|in (?:any|every|all|each|other) looks?|anywhere|everywhere))?$/
const EXPLAIN = /^(?:explain|describe|what is|what's|tell me about) (?:the )?(?:(.+?) (?:part|role)|(?:part|role) (.+))(?: here)?$/

const one = (key: string, act: PartsAct, parts: Candidate['parts']): Candidate[] => [{ key, tag: 'UI', parts, act: act as IntentAct, effect: 'view', confidence: 0.95 }]

export function uiPartsCandidates(text: string): Candidate[] {
  const t = fold(text)
  if (LIST.test(t)) return one('parts-list', { do: 'parts', op: 'list' }, [{ t: 'List the ' }, { t: 'named parts', em: true }, { t: ' here' }])
  const r = ROLE.exec(t)
  if (r) {
    const role = roleOf(r[1])
    if (!role) return []
    const anywhere = !!r[2] && r[2] !== 'here'
    return one(`parts-role-${role}`, { do: 'parts', op: 'role', role, anywhere }, [{ t: 'What plays ' }, { t: role, em: true }, { t: anywhere ? ' in every look' : ' here' }])
  }
  const e = EXPLAIN.exec(t)
  if (e) {
    const name = (e[1] ?? e[2] ?? '').trim()
    if (!PART_NAMES.test(name) && !roleOf(name)) return []
    return one(`parts-explain-${name}`, { do: 'parts', op: 'explain', name }, [{ t: 'Explain ' }, { t: name, em: true }])
  }
  return []
}
