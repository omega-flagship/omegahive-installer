/**
 * "Request an experience", step 1: words → a look, here and at once, with no mind and no network. The words are read
 * by the fast path's own look vocabulary (lib/intent lookCandidates), phrase by phrase and, inside a phrase, by the
 * longest run of words it understands, so "calmer and warmer, bigger text" and "calmer warmer bigger text" read alike.
 * What asks for more than a look (a new layout, a game, "like a city") is named back, never guessed at: building a
 * whole experience is a mind's work, and that is the next step.
 */
import { applyLookPatch, lookCandidates, lookPatchProblem } from '../../lib/intent'
import type { LookPatch, World } from '../../lib/intent/types'
import { wornVariant, type UiPrefs, type UiVariant } from '../../shell/uiVariant'

export interface LookPart {
  /** the words it came from */
  phrase: string
  patch: LookPatch
  /** what it does, in a few words ("Warmer colours") */
  label: string
}

export interface Described {
  words: string
  /** the look-level parts, in the order they apply */
  looks: LookPart[]
  /** words that ask for more than a look: a mind has to build them */
  beyond: string[]
  /** look words this build cannot do yet, each with its plain reason */
  cannot: { phrase: string; text: string }[]
  /** words that were not about the look, as far as this can tell */
  unclear: string[]
}

/** More than a look: new layouts, worlds, games, "like a …" (an analogy is a design brief, not a token). */
const BEYOND =
  /\b(like an?|like the|feels? like|looks? like|in the style of|game|games|city|town|map|world|3d|three d|layout|arrange|rearrange|grid|columns?|timeline|kanban|dashboard|spreadsheet|table|cards|tiles|windows|page|screen|view|panel|panels|widgets?|planet|planets|space ?ship|garden|island|story|comic|cartoon|newspaper|magazine|timetable|terminal|chat|tabs?|sidebar|split|scroll|swipe|drag|animate|animated|interactive|sound|music|voice)\b/
/** Words that carry no look of their own. */
const FILLER = new Set(
  'a an the and or it its make made please more much very really quite bit little slightly somewhat with i i’d id want would like to be me my everything things whole hive ui look looks screen but so too that is feel feels kind sort of some can you could give let’s lets go set turn change use try overall generally also just all a lot lots way'.split(' '),
)
const SPLIT = /\s*(?:[,;.!?+&/]|\band\b|\bbut\b|\bplus\b|\balso\b|\bthen\b)\s*/i
const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[’']/g, '’').replace(/\s+/g, ' ').trim()

type Found = { kind: 'look'; part: LookPart } | { kind: 'cannot'; text: string } | null

function readOne(words: string, w: World): Found {
  const c = lookCandidates(words, w)
  const hit = c.find((x) => x.act?.do === 'look')
  if (hit && hit.act?.do === 'look') {
    if (hit.act.patch.kind === 'experience')
      return { kind: 'cannot', text: `“${words}” is a whole experience: pick it under Experiences above. A look keeps you where you are.` }
    return { kind: 'look', part: { phrase: words, patch: hit.act.patch, label: hit.act.label } }
  }
  const limit = c.find((x) => x.limit)
  if (limit) return { kind: 'cannot', text: limit.parts.map((p) => p.t).join('') }
  return null
}

/** Read a description into look parts, mind-sized wishes, limits and words not understood. Pure. */
export function describeLook(words: string, w: World = { minds: [], swarms: [], pending: 0 }): Described {
  const out: Described = { words: words.trim(), looks: [], beyond: [], cannot: [], unclear: [] }
  const seen = new Set<string>()
  const addLook = (p: LookPart) => {
    const key = JSON.stringify(p.patch)
    if (seen.has(key)) return
    seen.add(key)
    out.looks.push(p)
  }
  for (const phrase of fold(words).split(SPLIT).map((p) => p.trim()).filter(Boolean)) {
    // a whole phrase the fast path knows ("put the navigation at the top", "use ember forge")
    const whole = readOne(phrase, w) ?? readOne(phrase.replace(/^(?:like|similar to|as in) (?:the )?/, ''), w)
    if (whole?.kind === 'look') {
      addLook({ ...whole.part, phrase })
      continue
    }
    if (whole?.kind === 'cannot') {
      out.cannot.push({ phrase, text: whole.text })
      continue
    }
    // otherwise the longest runs of words it knows, left to right; what is left over is said back
    const ws = phrase.split(' ')
    const rest: string[][] = [[]]
    for (let i = 0; i < ws.length; ) {
      let took = 0
      for (let n = Math.min(4, ws.length - i); n >= 1 && !took; n--) {
        const chunk = ws.slice(i, i + n).join(' ')
        if (n === 1 && FILLER.has(chunk)) break
        const f = readOne(chunk, w)
        if (f?.kind === 'look') addLook(f.part)
        else if (f?.kind === 'cannot') out.cannot.push({ phrase: chunk, text: f.text })
        if (f) took = n
      }
      if (took) {
        rest.push([])
        i += took
      } else {
        rest[rest.length - 1].push(ws[i])
        i++
      }
    }
    for (const left of rest.map((r) => r.join(' ')).filter(Boolean)) {
      if (BEYOND.test(left)) out.beyond.push(left)
      else if (!left.split(' ').every((x) => FILLER.has(x))) out.unclear.push(left)
    }
  }
  out.beyond = [...new Set(out.beyond)]
  return out
}

/** A short name from the words that made the look: "Calmer, warmer, bigger text" (at most 31 letters). */
export function shortName(d: Described): string {
  const parts = d.looks.map((l) => l.phrase.replace(/^(?:make it|make|a bit|slightly|much|use|with|an?|the) /, ''))
  let name = ''
  for (const p of parts) {
    const next = name ? `${name}, ${p}` : p
    if (next.length > 31) break
    name = next
  }
  if (!name) name = (parts[0] ?? 'Mine').slice(0, 31).trim()
  return name.charAt(0).toUpperCase() + name.slice(1)
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/**
 * The look the words make, from what is on screen now: the parts applied in order (a named look or a reset first,
 * so "Ember Forge but calmer" is Ember Forge, calmer), named "My look: <short name>" with an id no other personal look
 * uses. The experience the person is in is kept: a look never moves them.
 */
export function buildLook(cur: UiPrefs | null, d: Described, base: UiVariant, seeds: UiVariant[], taken: string[] = []): UiPrefs | null {
  if (!d.looks.length) return null
  const order = [...d.looks].sort((a, b) => rank(a.patch) - rank(b.patch))
  let p: UiPrefs = cur ?? { variant: null, layout: null, apps: null, experience: null }
  for (const part of order) p = applyLookPatch(p, part.patch, base, seeds)
  const short = shortName(d)
  const stem = `my-${slug(short)}`.slice(0, 44).replace(/-+$/, '') || 'my-look'
  let id = stem
  for (let n = 2; taken.includes(id); n++) id = `${stem}-${n}`
  const variant: UiVariant = {
    ...(wornVariant(p) ?? base), // the look on screen: an experience's companion when the person has none (small things F1)
    id,
    name: `My look: ${short}`,
    blurb: `From your words: “${d.words.slice(0, 140)}”`,
  }
  delete variant.needs
  return { variant, layout: p.layout ?? null, apps: cur?.apps ?? null, experience: cur?.experience ?? null }
}
/**
 * The parts that cannot be applied to this look as asked (a named accent that cannot be read here) move from `looks`
 * to `cannot`, with the plain reason, checked in the order they would apply. Pure.
 */
export function settleLooks(cur: UiPrefs | null, d: Described, base: UiVariant, seeds: UiVariant[]): Described {
  const out: Described = { ...d, looks: [], cannot: [...d.cannot] }
  let p: UiPrefs = cur ?? { variant: null, layout: null, apps: null, experience: null }
  for (const part of [...d.looks].sort((a, b) => rank(a.patch) - rank(b.patch))) {
    const problem = lookPatchProblem(p, part.patch, base)
    if (problem) out.cannot.push({ phrase: part.phrase, text: problem })
    else {
      out.looks.push(part)
      p = applyLookPatch(p, part.patch, base, seeds)
    }
  }
  return out
}
const rank = (p: LookPatch) => (p.kind === 'reset' ? 0 : p.kind === 'variant' ? 1 : 2)
