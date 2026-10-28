/**
 * The look pack: "make it darker", "calmer", "top bar", "use Ember Forge", "switch to Still". A typed look command
 * applies at once with a visible Undo, because the person's own words are the acceptance (Host §5.1). What this build
 * cannot render yet (light looks) is said plainly and nothing changes. Pure: the runner applies the result.
 */
import { asOwnChoice, withExperience, wornVariant, type UiPrefs, type UiVariant } from '../../shell/uiVariant'
import type { Candidate, LookPatch, World } from './types'
import { accented, accentProblem, accentWords, ACCENT_WORDS, contrasted, temper } from './palette'

const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}' -]+/gu, ' ').replace(/\s+/g, ' ').trim()
/** Polite openings that do not change what is asked. */
const LEAD = /^(please |can you |could you |i want |i'd like |i would like |let's |)(to |)(make |set |turn |change |switch |put |move |give me |use |try |go |)(it |the (ui|look|screen|hive|theme|page|interface) |everything |things |this |me |)(to |into |a |an |the |)?/

const look = (key: string, label: string, patch: LookPatch, confidence = 0.95): Candidate => ({
  key: `look-${key}`,
  tag: 'Look',
  parts: [{ t: label, em: true }, { t: '. It changes now; Undo puts it back.' }],
  act: { do: 'look', patch, label },
  effect: 'look',
  confidence,
})
const cannot = (key: string, text: string): Candidate => ({ key: `look-limit-${key}`, tag: 'Can’t', limit: true, parts: [{ t: text }], confidence: 0.9 })

/** Look candidates for what was typed (none when it is not about the look). */
export function lookCandidates(input: string, w: World): Candidate[] {
  const whole = fold(input)
  if (whole.length < 3) return []
  const t = whole.replace(LEAD, '').trim()
  const out: Candidate[] = []
  const has = (re: RegExp) => re.test(t) || re.test(whole)

  if (has(/^(darker|dimmer|more dark|dark(er)? mode|night mode)$|\b(make it|a bit|much|even) darker\b/)) out.push(look('darker', 'Make it darker', { kind: 'darker' }))
  if (has(/^(lighter|brighter|light mode|light|day mode|light theme|white)$|\b(make it|a bit) (lighter|brighter)\b/))
    out.push(cannot('light', 'Light looks need the next colour update, so nothing changed. “Make it darker” and calmer looks work now.'))
  // text size: the type scale only (shell/uiVariant TEXT_SCALE); spacing and hit targets stay as they are
  if (has(/^(bigger|larger)( text| font| type| print| letters)?$|^(big|large|bigger|larger|easier to see) (text|font|type|print|letters)$/))
    out.push(look('roomy', 'Bigger text', { kind: 'density', density: 'roomy' }))
  if (has(/^(smaller)( text| font| type| print| letters)?$|^(small|smaller) (text|font|type|print|letters)$/))
    out.push(look('compact', 'Smaller text', { kind: 'density', density: 'compact' }))
  // spacing itself is not a look yet (it would move hit targets): said plainly, nothing changes
  if (has(/^(roomier|more room|more space|spacious|airier|airy|compact|denser|dense|tighter|more on (the )?screen|less space|less room)$/))
    out.push(cannot('spacing', 'Changing spacing needs the next look update, so nothing changed. “Bigger text” and “smaller text” work now.'))
  if (has(/^(normal|regular|standard|default) (text|font|type|text size|size|spacing)$/)) out.push(look('regular', 'The standard text size', { kind: 'density', density: 'regular' }))
  // colour temperature, contrast and accent (lib/intent/palette keeps every result legible)
  if (has(/^(warmer|warm|warm(er)? (colou?rs?|tones?)|cosier|cozier|cosy|cozy)$/)) out.push(look('warmer', 'Warmer colours', { kind: 'warmth', warmth: 'warmer' }))
  if (has(/^(cooler|cool|cool(er)? (colou?rs?|tones?)|colder|icier)$/)) out.push(look('cooler', 'Cooler colours', { kind: 'warmth', warmth: 'cooler' }))
  if (has(/^((more|higher|high|stronger|sharper|bolder) contrast|crisper|clearer|more readable|easier to read)$/)) out.push(look('contrast-more', 'More contrast', { kind: 'contrast', contrast: 'more' }))
  if (has(/^((less|lower|low|softer|gentler) contrast|softer|muted|subtler|subdued|gentler colou?rs?)$/)) out.push(look('contrast-less', 'Softer contrast', { kind: 'contrast', contrast: 'less' }))
  const accent = t.match(/^(?:an? |the )?((?:dark |deep |navy |forest )?[a-z]+)(?: (?:accents?|highlights?|accent colou?r))?$/) ?? t.match(/^(?:accents?|highlights?)(?: colou?r)?(?: in| to)? ((?:dark |deep |navy |forest )?[a-z]+)$/)
  const named = accent ? ACCENT_WORDS.get(accent[1]) : undefined
  if (named) out.push(look(`accent-${named}`, `A ${accentWords(named).said} accent`, { kind: 'accent', accent: named }, accent![0] === accent![1] ? 0.85 : 0.95))
  if (has(/^(calmer|calm|quieter|gentler|softer motion|less motion|less animation|slower)$/)) out.push(look('calm', 'Calmer motion', { kind: 'motion', motion: 'calm' }))
  if (has(/^(no motion|no animations?|stop (the )?(motion|animations?|moving)|still motion|reduce motion|reduced motion|motion off)$/)) out.push(look('still-motion', 'No motion', { kind: 'motion', motion: 'none' }))
  if (has(/^(livelier|lively|more motion|more animation|more alive)$/)) out.push(look('lively', 'Lively motion', { kind: 'motion', motion: 'lively' }))
  if (has(/^(rounder|round(ed)? corners|softer corners|round)$/)) out.push(look('round', 'Rounder corners', { kind: 'radius', radius: 'round' }))
  if (has(/^(square(r)?|sharp(er)? corners|square corners|sharper)$/)) out.push(look('square', 'Square corners', { kind: 'radius', radius: 'square' }))
  if (has(/^(pill|pill shaped|pills)$/)) out.push(look('pill', 'Pill-shaped corners', { kind: 'radius', radius: 'pill' }))

  // layout: "top bar", "navigation at the top", "side rail", "a dock"
  const nav = /\b(nav(igation)?|menu|bar|rail|dock|layout)\b/.test(t) || /^(top bar|topbar|side rail|rail|dock)$/.test(t)
  if (nav) {
    if (/\b(top( bar)?|topbar|across the top|at the top)\b/.test(t)) out.push(look('topbar', 'Navigation across the top', { kind: 'layout', layout: 'topbar' }))
    else if (/\b(dock|bottom|at the bottom)\b/.test(t)) out.push(look('dock', 'A floating dock at the bottom', { kind: 'layout', layout: 'dock' }))
    else if (/\b(side|rail|left|down the left)\b/.test(t)) out.push(look('rail', 'Navigation down the left side', { kind: 'layout', layout: 'rail' }))
  }

  if (has(/^(reset( the)? (look|theme|ui)|default (look|theme)|standard look|original look)$/)) out.push(look('reset', 'The OmegaHive look', { kind: 'reset' }))

  // a seed look by name: "Ember Forge", "use deep sea"
  for (const l of w.looks ?? []) {
    const n = fold(l.name)
    if (t === n || t === `${n} look` || t === `the ${n} look` || whole === n) out.push(look(`variant-${l.id}`, `The ${l.name} look`, { kind: 'variant', id: l.id }))
  }

  // a whole experience: "switch to Still", "the classic hive", "go back to classic"
  const exp = whole.match(/^(?:please )?(?:switch|change|go|move)?\s*(?:back\s+)?(?:to|use|try|open)?\s*(?:the\s+)?([\p{L} ]+?)(?:\s+(?:experience|ui|view|mode|hive))?$/u)
  const asked = exp?.[1]?.trim()
  const verb = /^(please )?(switch|change|go|move|use|try)\b/.test(whole) || /\b(experience|ui|view)$/.test(whole)
  if (asked && verb) {
    const offered = w.experiences ?? []
    const hit = offered.find((e) => fold(e.name) === asked || e.id === asked || (e.id === 'classic' && /^classic( hive)?$/.test(asked)))
    if (hit) out.push(look(`exp-${hit.id}`, hit.id === 'classic' ? 'Back to the Classic hive' : `Switch to ${hit.name}`, { kind: 'experience', id: hit.id === 'classic' ? null : hit.id }))
    else if (['cosmos', 'construct', 'flux', 'canvas', 'still'].includes(asked))
      out.push(cannot(`exp-${asked}`, `${asked[0].toUpperCase()}${asked.slice(1)} is not offered in this build yet, so nothing changed.`))
  }

  const seen = new Set<string>()
  return out.filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true)))
}

/** Darken a #rrggbb colour by `k` (0..1). Non-hex values are kept. */
function darken(c: string, k: number): string {
  const m = c.match(/^#([0-9a-f]{6})$/i)
  if (!m) return c
  const n = parseInt(m[1], 16)
  const ch = (s: number) => Math.round(((n >> s) & 255) * (1 - k)).toString(16).padStart(2, '0')
  return `#${ch(16)}${ch(8)}${ch(0)}`
}

/** The host's limits on a variant's id and name (hive/core/ui_prefs.py: SLUG, 1-40 characters). */
export const NAME_MAX = 40
const ID_MAX = 48

/**
 * A colour change names itself on the variant: " (warmer)" after the name. The name is cut AFTER tagging (Kimi K4), the
 * look's own name giving way so the tag stays whole; whatever came in, what goes out is at most 40 (and the id 48).
 */
export function tagged(v: UiVariant, tag: string): UiVariant {
  const id = v.id.endsWith(`-${tag}`) ? v.id : `${v.id}-${tag}`.slice(-ID_MAX).replace(/^-+/, '')
  const word = `(${tag})`
  const full = v.name.endsWith(` ${word}`) ? v.name : `${v.name} ${word}`
  const stem = full.slice(0, full.length - word.length - 1)
  const name = full.length <= NAME_MAX ? full : word.length + 1 >= NAME_MAX ? word.slice(0, NAME_MAX) : `${stem.slice(0, NAME_MAX - word.length - 1).trimEnd()} ${word}`
  return { ...v, id: /^[a-z0-9]/.test(id) ? id : `v${id}`.slice(0, ID_MAX), name: name.slice(0, NAME_MAX) }
}

/**
 * Why a look patch cannot be applied to this look as asked (a named accent that cannot be read here), or null. Say it,
 * and change nothing: the runners (features/ask/run, Request an experience) check this before applying.
 */
export function lookPatchProblem(cur: UiPrefs | null, patch: LookPatch, base: UiVariant): string | null {
  if (patch.kind !== 'accent') return null
  return accentProblem((wornVariant(cur ?? null) ?? base).colors, patch.accent) // the look on screen (small things F1)
}

/**
 * The prefs a patch produces from the current ones. `base` is the standard look (uiVariant DEFAULT_VARIANT) and
 * `seeds` the named looks; unknown seeds leave the look as it is.
 */
export function applyLookPatch(cur: UiPrefs | null, patch: LookPatch, base: UiVariant, seeds: UiVariant[]): UiPrefs {
  const prefs: UiPrefs = { variant: cur?.variant ?? null, layout: cur?.layout ?? null, apps: cur?.apps ?? null, experience: cur?.experience ?? null }
  // a tweak starts from the look on screen (an experience's companion when the person has no look of their own)
  const variant = wornVariant(prefs) ?? base
  switch (patch.kind) {
    case 'darker': {
      const c = variant.colors
      const id = variant.id.endsWith('-darker') ? variant.id : `${variant.id}-darker`
      return { ...prefs, variant: { ...variant, id, name: variant.name.endsWith(' (darker)') ? variant.name : `${variant.name} (darker)`, colors: { ...c, void: darken(c.void, 0.45), abyss: darken(c.abyss, 0.4) } } }
    }
    case 'warmth':
      return { ...prefs, variant: { ...tagged(variant, patch.warmth), colors: temper(variant.colors, patch.warmth) } }
    case 'contrast':
      return { ...prefs, variant: { ...tagged(variant, patch.contrast === 'more' ? 'contrast' : 'soft'), colors: contrasted(variant.colors, patch.contrast) } }
    case 'accent':
      return { ...prefs, variant: { ...tagged(variant, patch.accent), colors: accented(variant.colors, patch.accent) } }
    case 'density':
      return { ...prefs, variant: { ...variant, density: patch.density } }
    case 'motion':
      return { ...prefs, variant: { ...variant, motion: patch.motion } }
    case 'radius':
      return { ...prefs, variant: { ...variant, radius: patch.radius } }
    case 'layout':
      return { ...prefs, layout: patch.layout }
    case 'variant': {
      const v = seeds.find((s) => s.id === patch.id)
      return v ? { ...prefs, variant: asOwnChoice(v, prefs.experience), layout: null } : prefs
    }
    case 'experience':
      return withExperience(prefs, patch.id) // the same choice as Change UI (F2)
    case 'reset':
      return { variant: null, layout: null, apps: prefs.apps, experience: prefs.experience }
  }
}
