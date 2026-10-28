/**
 * uifix-r3 (UI review 2026-10-12 S3, a11y-07): the ONE belief-to-sentence helper. Every place a person is shown a belief
 * or a truth value goes through here, so the commons, swarm beliefs, chat, Health, the Ask, mind pages, Lab and every
 * experience say the same thing the same way.
 *
 * Laws:
 *  - Never invent meaning. Only forms whose English reading is fixed by the logic are turned into sentences:
 *    inheritance (-->), similarity (<->), implication (==>), equivalence (<=>), and (&&), or (||), not (--), the
 *    product relation ((× a b) rel). Anything else reads "A belief about vega and star", never a guessed sentence.
 *  - The written form is never lost: `asWritten` gives the exact statement and numbers for the "Show as written"
 *    disclosure (ui/Belief.tsx), the only place notation is rendered outside developer views.
 *  - Truth values become words ("fairly sure"); the numbers stay one step away (`truthNumbers`, on hover and in the
 *    disclosure), labelled in words, never as bare "f" and "c".
 */

export interface Truth {
  f: number
  c: number
}

type Node = string | Node[]

// ------------------------------------------------------------------ reading the notation

/**
 * The statement's tokens, every character accounted for: null when anything is left over, so an unclosed quote
 * (`(--> vega "star)`) is malformed rather than silently dropped into a different belief (uifix-r3.1).
 */
function tokenize(text: string): string[] | null {
  const re = /\s+|"(?:[^"\\]|\\.)*"|[()]|[^\s()"]+/y
  const out: string[] = []
  for (let i = 0; i < text.length; i = re.lastIndex) {
    re.lastIndex = i
    const m = re.exec(text)
    if (!m) return null
    if (!/^\s/.test(m[0])) out.push(m[0])
  }
  return out
}

/** A small reader for s-expressions (atoms and lists; quoted strings keep their text). Null when malformed. */
export function parseBelief(text: string): Node | null {
  const tokens = tokenize(text)
  if (!tokens || !tokens.length) return null
  let pos = 0
  const read = (): Node | null => {
    const t = tokens[pos++]
    if (t === undefined || t === ')') return null
    if (t !== '(') return t
    const out: Node[] = []
    while (tokens[pos] !== ')') {
      if (pos >= tokens.length) return null
      const n = read()
      if (n === null) return null
      out.push(n)
    }
    pos++
    return out
  }
  const node = read()
  return node !== null && pos === tokens.length ? node : null
}

const NUMBER = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/
const OPERATORS = new Set(['-->', '<->', '==>', '<=>', '=/>', '=\\>', '=|>', '&&', '||', '&', '|', '--', '×', '*', '&/', '&|', '{--', '--]', '{-]', 'stv'])
const isVar = (t: string) => /^[$?#]/.test(t)
/** Placeholders and image markers: part of the notation, not things a belief is about. */
const NOT_TERMS = new Set(['/', '\\', '_'])

/** The things a statement is about (its atoms, operators, variables and numbers left out), in order, once each. */
export function beliefTerms(statement: string): string[] {
  const node = parseBelief(statement)
  const out: string[] = []
  const walk = (n: Node) => {
    if (Array.isArray(n)) n.forEach(walk)
    else if (!OPERATORS.has(n) && !NOT_TERMS.has(n) && !NUMBER.test(n) && !isVar(n)) {
      const w = word(n)
      if (w && !out.includes(w)) out.push(w)
    }
  }
  if (node !== null) walk(node)
  else for (const t of statement.match(/[A-Za-z][\w-]*/g) ?? []) if (!OPERATORS.has(t) && t !== 'stv' && !out.includes(word(t))) out.push(word(t))
  return out
}

// ------------------------------------------------------------------ words

/*
 * Atoms as words (uifix-r3.4, stand-in P1 on r3.3): closed BY CONSTRUCTION, with no word list. An atom is said as plain
 * words only when it is ONE simple token: letters with optional digits after them, or digits, in a script that puts
 * spaces between words. No `-` `_` `.`, no spaces, no punctuation, no quotes (a quoted atom is never plain). A single
 * token cannot carry grammar of its own, so it can never add a claim to the sentence.
 * Every other atom, quoted or not, is one name, shown exactly as written inside ‘…’ with no article and no guessed
 * grammar: `safe-although-backup-failed` → ‘safe-although-backup-failed’, `rr-lyrae` → ‘rr-lyrae’. That is the
 * conservative trade, on purpose. An atom holding quote marks (it could close early on screen) is not shown at all.
 * A run of Han, kana, Thai, Lao, Khmer, Myanmar or Tibetan letters is one token but can be a whole sentence (those
 * scripts write words without spaces), so it is a name too.
 */
const SIMPLE_TOKEN = /^(\p{L}+\d*|\d+)$/u
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u
const QUOTE_MARKS = /[‘’“”"'`‹›«»]/
/** What an atom with quote marks inside reads as in the "A belief about …" list; in a sentence it is not read. */
const UNSHOWN_WORDS = 'some quoted text'

type Atom = { kind: 'plain' | 'name' | 'unshown'; text: string }
const isQuoted = (t: string) => t.startsWith('"')

/** How an atom is said: plain words (one simple token), a ‘name’ exactly as written, or not shown. */
function atomOf(t: string): Atom {
  const quoted = isQuoted(t)
  const raw = quoted ? t.slice(1, -1) : t
  if (QUOTE_MARKS.test(raw)) return { kind: 'unshown', text: UNSHOWN_WORDS }
  if (!quoted && SIMPLE_TOKEN.test(raw) && !UNSPACED_SCRIPT.test(raw)) return { kind: 'plain', text: raw }
  return { kind: 'name', text: `‘${raw}’` }
}

/** An atom as words: `vega` → "vega"; `rr-lyrae` → ‘rr-lyrae’. */
const word = (t: string): string => atomOf(t).text
const isPlain = (t: string) => atomOf(t).kind === 'plain'
const isUnshown = (t: string) => atomOf(t).kind === 'unshown'

export const capFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/**
 * Verbs a predicate may be read as ("has", "recovers"): a known list, never "any word ending in s"
 * ("gas", "atlas", "news" are things, uifix-r3.1). A word not listed reads as "is a …", which says what --> says.
 */
const VERBS = new Set(['has', 'needs', 'recovers', 'grazes', 'rotates', 'eats', 'contains', 'causes', 'holds', 'requires', 'produces', 'emits', 'orbits', 'hosts', 'owns', 'uses', 'makes', 'feeds', 'grows', 'blocks', 'supports', 'follows', 'precedes', 'knows', 'sees', 'wants', 'fails', 'works', 'runs', 'shines', 'pulses', 'flares', 'dims', 'hunts', 'protects', 'shelters', 'depletes', 'restores'])
const looksVerb = (w: string) => VERBS.has(w)

const ADJ_ENDINGS = /(ous|ary|ble|ic|al|ed|ing|ful|ive|less|ish|ile|lar|ant|ent|y)$/
/** Nouns with an adjective's ending: they take an article ("a supergiant", "an agent", "a deployment"). */
const NOUN_WORDS = new Set(['giant', 'supergiant', 'agent', 'client', 'event', 'element', 'component', 'student', 'patient', 'plant', 'parent', 'incident', 'accident', 'resident', 'servant', 'tenant', 'merchant', 'elephant', 'variant', 'constant', 'gradient', 'current', 'talent', 'continent', 'animal', 'signal', 'portal', 'journal', 'terminal', 'festival', 'mineral', 'crystal', 'metal', 'canal', 'capital', 'hospital', 'manual', 'interval', 'arrival', 'arsenal', 'rival', 'spiral', 'pedal', 'petal', 'satellite', 'reptile', 'missile', 'profile', 'file', 'tile', 'mile', 'smile', 'pile', 'bed', 'seed', 'reed', 'weed', 'feed', 'speed', 'thing', 'ring', 'king', 'wing', 'string', 'spring', 'building', 'meeting', 'painting', 'clinic', 'topic', 'logic', 'music', 'basic', 'public', 'cable', 'table', 'label', 'cycle', 'bubble', 'marble', 'tentacle', 'sanctuary', 'library', 'dictionary', 'boundary', 'summary', 'diary', 'ally', 'body', 'city', 'party', 'family', 'colony', 'galaxy', 'army', 'story', 'study', 'entry', 'query', 'policy', 'key', 'day', 'way'])
const ADJ_WORDS = new Set(['barren', 'green', 'red', 'blue', 'high', 'low', 'safe', 'unsafe', 'fast', 'slow', 'hot', 'cold', 'warm', 'calm', 'open', 'closed', 'down', 'up', 'on', 'off', 'in', 'out', 'true', 'false', 'clean', 'dark', 'bright', 'new', 'old', 'big', 'small', 'present', 'absent', 'dominant', 'abundant', 'relevant', 'significant', 'different', 'urgent', 'stable', 'unstable', 'late', 'early',
  // irregular past participles ("rumour is heard")
  'heard', 'known', 'seen', 'done', 'gone', 'shown', 'broken', 'given', 'taken', 'written', 'made', 'built', 'found', 'lost', 'held', 'kept', 'sold', 'told', 'won', 'hidden', 'frozen', 'stolen', 'chosen', 'grown', 'thrown', 'worn', 'torn', 'born', 'shut', 'set', 'hit', 'cut', 'put', 'read', 'run'])
/** "star" → "a star", "luminous" stays "luminous": an article only for a word that looks like a noun. */
function predicate(p: string): string {
  const w = word(p)
  // a name is said as it is written: no article and no guessing at its grammar
  if (!isPlain(p)) return w
  // a verb as an inheritance predicate: "Backup is ‘fails’.", never the event "Backup fails." nor "is a fails"
  if (looksVerb(w)) return `‘${w}’`
  // a plain atom is one token, so this is the article for one word, never grammar read from inside a name
  const adjective = ADJ_WORDS.has(w) || (ADJ_ENDINGS.test(w) && !/ment$/.test(w) && !NOUN_WORDS.has(w))
  if (adjective || /\d/.test(w)) return w
  return (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + w
}

const ADVERB = {
  certain: 'almost certainly',
  sure: 'very likely',
  likely: 'probably',
  unsure: 'perhaps',
  doubtful: 'probably not',
} as const

// ------------------------------------------------------------------ truth in words

export type Sureness = keyof typeof ADVERB

/** NAL expectation, c·(f − ½) + ½: the reasoner's own decision value (NAL/ONA), 0..1. The Classic table sorts by it. */
export const expectation = (t: Truth): number => t.c * (t.f - 0.5) + 0.5

/**
 * Below this confidence a belief rests on less than half an observation's worth of evidence (c = w/(w+1), so
 * c < 0.3 means w < 0.43): whatever its likelihood, it says almost nothing yet, and reads "tentative".
 */
export const NO_EVIDENCE_C = 0.3
/** The scale step for too little evidence: the one SURENESS_WORD calls "tentative" (Kimi, r3.2: named, not a bare key). */
export const NO_EVIDENCE: Sureness = 'unsure'

/**
 * How sure, from NAL's own semantics (uifix-r3.1, Platform's NAL rule): frequency is how often the evidence agreed,
 * confidence how much evidence there is. Too little evidence is "tentative" whatever the frequency; otherwise the
 * expectation decides, so "doubts it" needs real evidence against (a low frequency and enough confidence).
 */
export function sureness(f: number, c: number): Sureness {
  if (c < NO_EVIDENCE_C) return NO_EVIDENCE
  // rounded so a boundary such as 0.55 is not lost to floating point (0.5 × 0.1 + 0.5 = 0.5499999…)
  const e = Math.round(expectation({ f, c }) * 1e9) / 1e9
  if (e >= 0.85) return 'certain'
  if (e >= 0.7) return 'sure'
  if (e >= 0.55) return 'likely'
  if (e > 0.45) return 'unsure'
  return 'doubtful'
}

/**
 * uifix-r3.5 (stand-in P1 and Kimi 1 on r3.4): THE sureness decision. The words, every colour (core, glow, dots,
 * scene particles), every meter and every brightness are derived from this one judgement, so they can never disagree:
 *  - `band`: the step the words name (SURENESS_WORD[band]);
 *  - `direction`: against ("doubts it"), none ("tentative", including everything below the no-evidence floor), for;
 *  - `tone`: the value a certainty visual draws, 0..1 with 0.5 neutral. It is the expectation when the band has a
 *    direction, and exactly 0.5 when it has none: a tentative belief is drawn neutral, never faintly red or blue.
 *  - `e`: the raw NAL expectation, for ordering only (sorting is not a sureness claim), never for drawing.
 */
export interface SurenessJudgement {
  band: Sureness
  direction: 'against' | 'none' | 'for'
  tone: number
  e: number
}
export const NEUTRAL_TONE = 0.5
export function surenessOf(t: Truth): SurenessJudgement {
  const band = sureness(t.f, t.c)
  const e = expectation(t)
  const direction = band === 'doubtful' ? 'against' : band === NO_EVIDENCE ? 'none' : 'for'
  return { band, direction, tone: direction === 'none' ? NEUTRAL_TONE : e, e }
}

const RANK = { against: 0, none: 1, for: 2 } as const
/**
 * uifix-r3.6 (Kimi 1 and "sharpest" on r3.5): ONE order for how sure, from the same decision as the words and the
 * visuals. Direction first (against < none < for), then expectation within a direction. Ascending; a "most sure first"
 * list uses compareSureness(b, a): every "yes" row, then every tentative one, then every doubt. Raw expectation alone
 * would put a neutral {f 1, c 0.29} (e 0.65) above a faintly blue {f 0.6, c 0.5} (e 0.55).
 */
export function compareSureness(a: Truth, b: Truth): number {
  const x = surenessOf(a)
  const y = surenessOf(b)
  return RANK[x.direction] - RANK[y.direction] || x.e - y.e
}

/** The words people read for a truth value. One scale, everywhere. */
export const SURENESS_WORD: Record<Sureness, string> = {
  certain: 'near certain',
  sure: 'confident',
  likely: 'fairly sure',
  unsure: 'tentative',
  doubtful: 'doubts it',
}

const valid = (t: Truth | null | undefined): t is Truth => !!t && Number.isFinite(t.f) && Number.isFinite(t.c)

/** "fairly sure". */
export function truthWords(t: Truth | null | undefined): string {
  return valid(t) ? SURENESS_WORD[surenessOf(t).band] : 'not yet weighed'
}

/** The numbers, labelled in words: "likelihood 0.58, confidence 0.47". */
export function truthNumbers(t: Truth | null | undefined): string {
  return valid(t) ? `likelihood ${t.f.toFixed(2)}, confidence ${t.c.toFixed(2)}` : 'no numbers yet'
}

/** "fairly sure (likelihood 0.58, confidence 0.47)": for screen readers and hover titles. */
export function truthPhrase(t: Truth | null | undefined): string {
  return valid(t) ? `${truthWords(t)} (${truthNumbers(t)})` : truthWords(t)
}

// ------------------------------------------------------------------ statements as sentences

export interface Said {
  /** The sentence, capitalised, with a full stop. */
  text: string
  /** The same reading as a clause to embed in other prose: no full stop, first letter as written. */
  clause: string
  /** False when the form was not one we can read: the text is then "A belief about …", never a guess. */
  recognised: boolean
}

class Unknown extends Error {}
const fail = (): never => {
  throw new Unknown()
}

interface Vars {
  /** variable → how it is said ("something", then "it"). */
  said: Map<string, string>
}

function term(n: Node, v: Vars): string {
  if (typeof n !== 'string') return fail()
  if (OPERATORS.has(n)) return fail()
  if (isVar(n)) {
    const seen = v.said.get(n)
    if (seen) return seen
    if (v.said.size > 0) return fail() // two different unknowns: "something … something else" is too easy to misread
    v.said.set(n, 'it')
    return 'something'
  }
  return isUnshown(n) ? fail() : word(n)
}

const isProduct = (n: Node): n is Node[] => Array.isArray(n) && (n[0] === '×' || n[0] === '*') && n.length === 3

/** The in-place negation of a plain statement ("deploy is not safe"), used inside and / or and rules. */
const NOT = 'not'

/** "kelp recovers", with the adverb before the verb, or in front when it is a negation ("probably not recovers" is not English). */
function verbal(subject: string, rest: string, adverb: string): string {
  // "kelp not recovers" is not English, and "does not recover" would need the verb's base form: not read
  if (adverb === NOT) return fail()
  if (adverb === ADVERB.doubtful) return `it is probably not true that ${subject} ${rest}`
  return `${subject} ${adverb ? `${adverb} ` : ''}${rest}`
}

/**
 * One plain statement (inheritance, similarity, a product relation) as a clause, or Unknown. `adverb` goes where
 * English wants it ("is probably a star"; NOT gives "is not a star"). A bare atom is a clause only on its own.
 */
function clause(n: Node, v: Vars, adverb = ''): string {
  if (!Array.isArray(n)) return adverb ? fail() : term(n, v)
  const adv = adverb ? `${adverb} ` : ''
  const [op, ...a] = n
  if (op === '-->' && a.length === 2) {
    const [s, p] = a
    if (typeof p === 'string' && isUnshown(p)) return fail()
    // (--> (× a b) has)  →  "a has b"; another relation  →  "a and b are linked by “rel”"
    if (isProduct(s) && typeof p === 'string' && !isVar(p) && !OPERATORS.has(p)) {
      const x = term(s[1], v)
      const y = term(s[2], v)
      return looksVerb(p) ? verbal(x, `${p} ${y}`, adverb) : `${x} and ${y} are ${adv}linked by ${isPlain(p) ? `“${word(p)}”` : word(p)}`
    }
    // (--> a (× grows fast))  →  "a grows fast" (only when the product opens with a verb)
    if (isProduct(p) && typeof p[1] === 'string' && looksVerb(p[1]) && typeof p[2] === 'string') return verbal(term(s, v), `${p[1]} ${term(p[2], v)}`, adverb)
    if (typeof p !== 'string') return fail()
    const subject = term(s, v)
    if (isVar(p)) return adverb === NOT ? fail() : `${subject} is ${adv}${term(p, v)}`
    if (OPERATORS.has(p)) return fail()
    // uifix-r3.5 (Kimi 4): no bare-predicate verb reading. `(--> backup fails)` is inheritance, not an event:
    // "Backup fails." would assert an occurrence it does not, so a verb here is shown as a name (predicate()).
    return `${subject} is ${adv}${predicate(p)}`
  }
  if (op === '<->' && a.length === 2) return `${term(a[0], v)} is ${adv}similar to ${term(a[1], v)}`
  return fail()
}

/*
 * Compounds keep their grouping in the words (uifix-r3.1): (-- (&& A B)) and (&& (-- A) B) never read the same.
 *  - Inside and / or, each part is a plain statement or a plain statement negated in place: "deploy is not safe and
 *    backup is ready". Anything deeper (an and inside an or, a rule inside an and) is not read.
 *  - Under a negation, "both … and …" and "either … or …" mark what is negated: "it is not true that both deploy is
 *    safe and backup is ready". Three or more parts under a negation are not read.
 *  - In a rule, each side is a plain statement, a negated one, or an and / or of those ("if both A and B, then C").
 */

/** A plain statement, or one negated in place. */
function literal(n: Node, v: Vars): string {
  if (Array.isArray(n) && n[0] === '--' && n.length === 2) return clause(n[1], v, NOT)
  return clause(n, v)
}

type Scope = 'free' | 'rule' | 'negated'

/** and / or over literals, its grouping said when it sits in a rule or under a negation; null when not and / or. */
function junction(n: Node, v: Vars, scope: Scope): string | null {
  if (!Array.isArray(n)) return null
  const [op, ...a] = n
  const and = op === '&&' || op === '&'
  if (!(and || op === '||' || op === '|') || a.length < 2) return null
  const parts = a.map((x) => literal(x, v))
  if (!and) return `either ${parts.join(' or ')}`
  if (parts.length === 2) return scope === 'free' ? `${parts[0]} and ${parts[1]}` : `both ${parts[0]} and ${parts[1]}`
  if (scope === 'negated') return fail()
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** One side of a rule. */
const side = (n: Node, v: Vars): string => junction(n, v, 'rule') ?? literal(n, v)

/**
 * Forms whose sureness goes in front ("Very likely, if …"): rules, not, and, or. `negated` when the whole is said
 * under "it is (probably) not true that", so its grouping must be said. Null when the form is a plain statement.
 */
function compound(n: Node, v: Vars, negated: boolean): string | null {
  if (!Array.isArray(n)) return null
  const [op, ...a] = n
  if (op === '==>' && a.length === 2) return `if ${side(a[0], v)}, then ${side(a[1], v)}`
  // "it is not true that A exactly when B" can be heard as "(not A) exactly when B": not read
  if (op === '<=>' && a.length === 2) return negated ? fail() : `${side(a[0], v)} exactly when ${side(a[1], v)}`
  if (op === '--' && a.length === 1) {
    if (!Array.isArray(a[0])) return fail() // (-- dry-run): not a statement
    return `it is not true that ${compound(a[0], v, true) ?? clause(a[0], v)}`
  }
  return junction(n, v, negated ? 'negated' : 'free')
}

const FRONT: Record<Sureness, (x: string) => string> = {
  certain: (x) => `almost certainly, ${x}`,
  sure: (x) => `very likely, ${x}`,
  likely: (x) => `probably, ${x}`,
  unsure: (x) => `perhaps ${x}`,
  doubtful: (x) => `it is probably not true that ${x}`,
}

/** "A belief about vega and star": the honest reading of a form we cannot read. */
function about(statement: string): string {
  const t = beliefTerms(statement)
  if (!t.length) return 'a belief we cannot put into words'
  const shown = t.length > 4 ? [...t.slice(0, 4), `${t.length - 4} more`] : t
  const list = shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
  return `a belief about ${list}`
}

const memo = new Map<string, Said>()

/**
 * A belief statement as a sentence. With `tv`, a sureness adverb is placed in the sentence ("Vega is very likely a
 * star"); without it the sentence states the claim alone and sureness is shown beside it.
 */
export function sayBelief(statement: string, tv?: Truth | null): Said {
  const key = `${valid(tv) ? sureness(tv.f, tv.c) : '-'}\u0000${statement}`
  const hit = memo.get(key)
  if (hit) return hit
  const out = say(statement.trim(), valid(tv) ? tv : null)
  if (memo.size > 4000) memo.clear()
  memo.set(key, out)
  return out
}

function say(statement: string, tv: Truth | null): Said {
  const n = parseBelief(statement)
  const s = tv ? sureness(tv.f, tv.c) : null
  try {
    if (!Array.isArray(n)) fail()
    const v: Vars = { said: new Map() }
    // "it is probably not true that …" is a negation too: the compound under it says its grouping
    const c = compound(n as Node[], v, s === 'doubtful')
    let body: string
    if (c !== null) body = s ? FRONT[s](c) : c
    else body = clause(n as Node, v, s ? ADVERB[s] : '')
    body = body.replace(/\s+/g, ' ').trim()
    return { text: `${capFirst(body)}.`, clause: body, recognised: true }
  } catch (e) {
    if (!(e instanceof Unknown)) throw e
    const body = about(statement)
    return { text: `${capFirst(body)}.`, clause: body, recognised: false }
  }
}

/** The plain sentence alone (no sureness adverb), for lists and labels. */
export const beliefText = (statement: string): string => sayBelief(statement).text

/** "whether the ring nebula is planetary": a belief as the object of a thought. */
export function beliefTopic(statement: string): string {
  const s = sayBelief(statement)
  if (!s.recognised) return s.clause
  return s.clause.startsWith('if ') ? `the rule that ${s.clause}` : `whether ${s.clause}`
}

/** One line for a screen reader or a title: "Vega is a star. Fairly sure (likelihood 0.58, confidence 0.47)." */
export function beliefLine(statement: string, tv?: Truth | null): string {
  const s = sayBelief(statement).text
  return valid(tv) ? `${s} ${capFirst(truthPhrase(tv))}.` : s
}

/** Exactly as the mind wrote it, for the "Show as written" disclosure: "(--> vega star) ⟨f 0.58, c 0.47⟩". */
export function asWritten(statement: string, tv?: Truth | null): string {
  return valid(tv) ? `${statement} ⟨f ${tv.f.toFixed(2)}, c ${tv.c.toFixed(2)}⟩` : statement
}

// ------------------------------------------------------------------ free text (chat, activity) with notation inside

export type Piece = { t: string; raw?: undefined } | { t: string; raw: string; kind: 'belief' | 'truth' }

const STATEMENT_START = /^\((-->|==>|<->|<=>|=\/>|=\\>|=\|>|&&|\|\||--)\s/
/** A truth tag after a statement: ⟨f 0.59, c 0.38⟩, <f 0.59, c 0.38>, (stv 0.59 0.38). */
const TAG = /^\s*(?:[⟨<]\s*f\s*[=:]?\s*(-?\d*\.?\d+(?:e-?\d+)?)\s*[,;·]?\s*c\s*[=:]?\s*(-?\d*\.?\d+(?:e-?\d+)?)\s*[⟩>]|\(stv\s+(-?\d*\.?\d+(?:e-?\d+)?)\s+(-?\d*\.?\d+(?:e-?\d+)?)\))/i
/** Truth numbers inside a sentence: "f 0.89, c 0.71", "f=0.9 c=0.8", "(stv 0.5 0.4)". */
// a number ends the match only where the number ends: "c=0.80ms" is not "c=0" (uifix-r3.1)
const INLINE_TRUTH = /\bf\s*[=:]?\s*(\d*\.\d+|[01])\s*[,;·]?\s*(?:and\s+)?c\s*[=:]?\s*(\d*\.\d+|[01])(?!\.?\w)|\(stv\s+(-?\d*\.?\d+(?:e-?\d+)?)\s+(-?\d*\.?\d+(?:e-?\d+)?)\)/i

const num = (...xs: (string | undefined)[]) => xs.map((x) => (x === undefined ? NaN : Number(x)))

function truthPieces(text: string, out: Piece[]) {
  let rest = text
  for (let m = INLINE_TRUTH.exec(rest); m; m = INLINE_TRUTH.exec(rest)) {
    if (m.index > 0) out.push({ t: rest.slice(0, m.index) })
    const [f, c] = m[1] !== undefined ? num(m[1], m[2]) : num(m[3], m[4])
    out.push(valid({ f, c }) ? { t: `“${truthWords({ f, c })}”`, raw: m[0], kind: 'truth' } : { t: m[0] })
    rest = rest.slice(m.index + m[0].length)
  }
  if (rest) out.push({ t: rest })
}

/**
 * Free text with statements and truth numbers said in English. A statement becomes its quoted sentence ("“Vega is a
 * star”"), a truth tag after it becomes its sureness in brackets, loose truth numbers become their word. Each changed
 * piece keeps its `raw` text; `hasNotation` tells the caller to offer the "Show as written" disclosure.
 */
export function plainPieces(text: string): Piece[] {
  const out: Piece[] = []
  let i = 0
  let from = 0
  while (i < text.length) {
    if (text[i] === '(' && STATEMENT_START.test(text.slice(i, i + 5))) {
      const j = statementEnd(text, i)
      // no end (an unclosed bracket or quote): the rest stays exactly as written, never part-read (uifix-r3.1)
      if (j < 0) break
      const node = parseBelief(text.slice(i, j + 1))
      // only a statement it can read, or a full one it cannot: "Use (-- dry-run) first." is prose, left alone
      if (node !== null && Array.isArray(node) && (node.length >= 3 || sayBelief(text.slice(i, j + 1)).recognised)) {
        if (from < i) truthPieces(text.slice(from, i), out)
        const st = text.slice(i, j + 1)
        let k = j + 1
        const tag = text.slice(k).match(TAG)
        let tv: Truth | null = null
        if (tag) {
          const [f, c] = tag[1] !== undefined ? num(tag[1], tag[2]) : num(tag[3], tag[4])
          if (valid({ f, c })) {
            tv = { f, c }
            k += tag[0].length
          }
        }
        const s = sayBelief(st)
        out.push({ t: `“${capFirst(s.clause)}”${tv ? ` (${truthWords(tv)})` : ''}`, raw: text.slice(i, k), kind: 'belief' })
        i = from = k
        continue
      }
      // a closed statement it will not rewrite is skipped whole: nothing inside it is read as a belief of its own
      i = j + 1
      continue
    }
    i++
  }
  if (i < text.length) {
    // stopped at an unclosed statement: what came before is read, the rest is kept as written
    if (from < i) truthPieces(text.slice(from, i), out)
    out.push({ t: text.slice(i) })
  } else if (from < text.length) truthPieces(text.slice(from), out)
  return out
}

/** Where the statement opened at `i` closes: brackets inside quoted atoms do not count. -1 when it never closes. */
function statementEnd(text: string, i: number): number {
  let depth = 0
  let quoted = false
  for (let j = i; j < text.length; j++) {
    const ch = text[j]
    if (quoted) {
      if (ch === '\\') j++
      else if (ch === '"') quoted = false
    } else if (ch === '"') quoted = true
    else if (ch === '(') depth++
    else if (ch === ')' && --depth === 0) return j
  }
  return -1
}

/** Free text, said plainly, as one string (for titles, toasts and screen-reader labels). */
export const plainText = (text: string): string => plainPieces(text).map((p) => p.t).join('')

/** True when the text carries notation or truth numbers that `plainPieces` rewrites. */
export const hasNotation = (text: string): boolean => plainPieces(text).some((p) => p.raw !== undefined)

/**
 * Raw belief notation as people would see it on screen: a statement opener, a truth tag, an stv, or "f 0.58, c 0.47".
 * The standing guard and the render smoke use this; anything it finds outside "Show as written" and developer views
 * is a bug.
 */
export const RAW_NOTATION = /\((-->|==>|<->|<=>)\s|⟶|⟨\s*f\s*[\d.]|\(stv\s|\bf\s*[=:]?\s*\d*\.\d+\s*[,;·]\s*c\s*[=:]?\s*\d*\.\d+/
