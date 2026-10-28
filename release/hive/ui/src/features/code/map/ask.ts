/**
 * Workbench Map's Ask: plain words become ONE visible preset with its parameters, which the person sees and can edit
 * before anything runs (Surface reply §1.6). Deterministic and local: no model call, and never raw MeTTa (the
 * owner-reviewed pattern subset comes later). Presets and their parameter schemas are the hive's (GET …/presets, JSON
 * Schema); a preset the hive does not offer is not planned, and its oneOf ("exactly one of node_id or path") is kept.
 *
 * Direction follows the host's presets (e4008ac): `calls-expression` is the calls written IN the chosen node;
 * "what calls X" is `potential-dependents` (incoming imports and call expressions; static, transitive since host
 * r1.1, `max_depth` 1 = direct links only).
 */
import type { Preset } from '../../../api/repoMap'
import { TESTS_NOTE } from './model'

export interface Plan {
  preset: string
  params: Record<string, string>
  /** a plain note shown with the plan (the tests wording, or why a parameter still needs choosing) */
  note: string | null
}
export type PlanResult = { ok: true; plan: Plan } | { ok: false; why: string }
/** A name the person typed → the exact node id it names in what is on screen; null when none or several. */
export type Resolve = (name: string) => { id: string } | { many: number } | null

export const RAW_REFUSED = 'Raw MeTTa queries aren’t offered here yet. Choose a preset instead.'
export const NO_FIT = 'No preset fits these words. Choose one below and fill it in.'
export const DIRECT_ONLY = 'direct links only'

const clean = (s: string) =>
  s
    .trim()
    .replace(/[?.!]+$/, '')
    .replace(/^(?:the\s+)?(?:function|file|module|class|def(?:inition)?)\s+/i, '')
    .replace(/^[`'"“‘]+|[`'"”’]+$/g, '')
    .trim()

/** Words → [preset, subject] (first match wins, most specific first). */
const RULES: [RegExp, string][] = [
  [/\b(?:what(?:'s| has| is)?\s+changed|changes|drift)\s+since\s+([0-9a-f]{4,64})\b/i, 'drift'],
  [/\b(?:which|what)\s+tests?\s+(?:cover|covers|test|tests|exercise|check)s?\s+(.+)/i, 'test-doc-links'],
  [/\b(?:tests?|docs?|documentation)\s+(?:for|of|about)\s+(.+)/i, 'test-doc-links'],
  [/\bwhere\s+is\s+(.+?)\s+documented\b/i, 'test-doc-links'],
  [/\bwhat\s+does\s+(.+?)\s+import\b/i, 'imports'],
  [/\bimports\s+(?:of|in)\s+(.+)/i, 'imports'],
  [/\bwhat\s+does\s+(.+?)\s+define\b/i, 'defines'],
  [/\b(?:definitions|defs)\s+in\s+(.+)/i, 'defines'],
  [/\bwhat\s+does\s+(.+?)\s+call\b/i, 'calls-expression'],
  [/\bcalls\s+(?:in|made\s+by|from)\s+(.+)/i, 'calls-expression'],
  [/\bwhat\s+(?:directly\s+)?calls\s+(.+)/i, 'potential-dependents'],
  [/\bwhere\s+is\s+(.+?)\s+called\b/i, 'potential-dependents'],
  [/\bcallers\s+of\s+(.+)/i, 'potential-dependents'],
  [/\b(?:what|who)\s+(?:directly\s+)?(?:depends\s+on|uses|imports|needs)\s+(.+)/i, 'potential-dependents'],
  [/\b(?:direct\s+)?dependents\s+of\s+(.+)/i, 'potential-dependents'],
  [/\b(?:find|search(?:\s+for)?|look\s+for|where\s+is)\s+(.+)/i, 'source-search'],
]

const looksLikeId = (s: string) => /^(?:file|def|doc|test|module|import):/.test(s)
const looksLikePath = (s: string) => s.includes('/') || /\.[a-z0-9]{1,6}$/i.test(s)

/** The parameter a subject fills in a preset without oneOf: its first required text parameter (its own name). */
export function subjectParam(p: Preset): string | null {
  return (p.params.find((x) => x.required && x.type === 'string') ?? p.params.find((x) => x.type === 'string'))?.name ?? null
}

export function planFromWords(words: string, presets: Preset[], resolve?: Resolve): PlanResult {
  const w = words.trim()
  if (!w) return { ok: false, why: NO_FIT }
  if (/^\s*!?\(/.test(w) || /\(\s*(?:match|let|let\*|superpose|import!|bind!|add-atom|remove-atom)\b/.test(w)) return { ok: false, why: RAW_REFUSED }
  for (const [re, name] of RULES) {
    const m = w.match(re)
    if (!m) continue
    const preset = presets.find((p) => p.name === name)
    if (!preset) continue
    const subject = clean(m[1] ?? '')
    if (!subject) continue
    const params: Record<string, string> = {}
    let note: string | null = name === 'test-doc-links' ? TESTS_NOTE : null
    const groups = preset.oneOf.map((g) => g.join(','))
    if (groups.includes('node_id') || groups.includes('path')) {
      if (looksLikeId(subject) && groups.includes('node_id')) params.node_id = subject
      else if (looksLikePath(subject) && groups.includes('path')) params.path = subject
      else {
        const r = resolve?.(subject) ?? null
        if (r && 'id' in r && groups.includes('node_id')) params.node_id = r.id
        else {
          params[groups.includes('node_id') ? 'node_id' : 'path'] = subject
          const which = r && 'many' in r ? `${r.many} nodes are named ${subject}` : `${subject} is a name, not a node id or path`
          note = `${which}: choose its exact node (open it on the map), or give a path.${note ? ` ${note}` : ''}`
        }
      }
    } else {
      const param = subjectParam(preset)
      if (!param) continue
      params[param] = subject
    }
    if (name === 'potential-dependents' && /\bdirect(?:ly)?\b/i.test(w) && preset.params.some((p) => p.name === 'max_depth')) params.max_depth = '1'
    return { ok: true, plan: { preset: name, params, note } }
  }
  return { ok: false, why: NO_FIT }
}

/**
 * The person's edited plan, as the body the hive takes: required parameters present, exactly one oneOf group given
 * (never more, never none), integers as numbers within their bounds; empty optional parameters left out.
 */
export function planBody(plan: Plan, presets: Preset[]): { ok: true; preset: string; params: Record<string, string | number | boolean> } | { ok: false; why: string } {
  const p = presets.find((x) => x.name === plan.preset)
  if (!p) return { ok: false, why: `This hive has no preset named ${plan.preset}.` }
  const filled = (k: string) => (plan.params[k] ?? '').trim() !== ''
  if (p.oneOf.length) {
    const given = p.oneOf.filter((g) => g.every(filled))
    const touched = p.oneOf.filter((g) => g.some(filled))
    if (given.length !== 1 || touched.length !== 1) return { ok: false, why: `Give exactly one of ${p.oneOf.map((g) => g.join(' + ')).join(' or ')}.` }
  }
  const params: Record<string, string | number | boolean> = {}
  for (const d of p.params) {
    const raw = (plan.params[d.name] ?? '').trim()
    if (!raw) {
      if (d.required) return { ok: false, why: `Fill in ${d.name} first.` }
      continue
    }
    if (d.type === 'integer') {
      const n = Number(raw)
      if (!Number.isInteger(n)) return { ok: false, why: `${d.name} must be a whole number.` }
      if ((d.minimum !== undefined && n < d.minimum) || (d.maximum !== undefined && n > d.maximum)) return { ok: false, why: `${d.name} must be between ${d.minimum ?? '…'} and ${d.maximum ?? '…'}.` }
      params[d.name] = n
    } else if (d.type === 'boolean') params[d.name] = raw === 'true'
    else params[d.name] = raw
  }
  return { ok: true, preset: p.name, params }
}

/** The name the UI gives a preset (potential-dependents is static and transitive, never "impact"). */
export const presetTitle = (name: string): string => (name === 'potential-dependents' ? 'potential dependents (static, transitive)' : name)
