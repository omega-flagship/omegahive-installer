/**
 * The intent field's understanding (lifted from Still into the shared fast path, Surface universal Ask phase 1), entirely client-side and deliberately small: a handful of plain verbs,
 * names that autocomplete, and an honest preview of exactly what will happen before anything does.
 */
import { FEATURES } from '../../features/registry'
import { matchFeatures } from './features'
import { shortId, shortIds } from './ident'

export interface Named {
  id: string
  name: string
  /** minds only */
  awake?: boolean
  /** minds only: the name of the swarm it belongs to ('' when none) */
  swarm?: string
  /** minds only, the host's answers (Platform r2.4 may_remind / may_sleep / is_mine); absent is no */
  mayRemind?: boolean
  maySleep?: boolean
  isMine?: boolean
  /** minds only: a person's personal mind (is_mine, or in a personal-mind swarm); wording only */
  personal?: boolean
  /** minds only: awake by the one action rule (api/idleMinds isAwakeForAction: exactly `awake`) */
  awakeNow?: boolean
}

export type Act =
  | { do: 'send'; mind: Named; text: string }
  | { do: 'open'; mind: Named }
  | { do: 'wake'; mind: Named }
  | { do: 'sleep'; mind: Named }
  /** Health asks the mind its question now (what it owes, or why it is awake with no input): POST …/health/remind */
  | { do: 'remind'; mind: Named }
  | { do: 'goal'; swarm: Named; title: string }
  | { do: 'scroll'; to: 'needs' | 'now' | 'learned' }
  /** Any hive feature: Still's own sheet or passage when it has one, otherwise its classic page. */
  | { do: 'feature'; id: string; name?: string }
  | { do: 'swarm'; swarm: Named }
  | { do: 'gallery' }
  | { do: 'search'; text: string }

/** Acts that change something in the hive. They are only ever offered for exactly one, identified target. */
export const CONSEQUENTIAL: ReadonlySet<Act['do']> = new Set(['send', 'wake', 'sleep', 'remind', 'goal'])

export interface Suggestion {
  key: string
  /** Small-caps tag: Send, Wake, Task, Which, Can't… */
  tag: string
  /**
   * The sentence, in parts; `em` parts are the names and the quoted text; `who` parts say which one (swarm and a
   * short stable id), set quieter beside the name.
   */
  parts: { t: string; em?: boolean; q?: boolean; who?: boolean }[]
  /** Runs when ready; otherwise Enter or Tab fills `fill`. */
  act?: Act
  fill?: string
  /** One of several things with the same name: picking it fills the field with the name plus its id. */
  choice?: boolean
  /** Said instead of doing something, because Still cannot do what was asked as asked. */
  limit?: boolean
}

/** Text compared for names: normalised and lower-cased, but not trimmed, so slices line up. */
const fold = (s: string) => s.normalize('NFKC').toLowerCase()
const lower = (s: string) => s.toLowerCase()

type Lead<T> =
  | {
      hits: T[]
      /** what follows the name, tidied */
      rest: string
      /** what follows the name, exactly as typed */
      after: string
      /** characters of the input taken by the name (or name#id) */
      len: number
      /** the name (or name#id) exactly as typed, to put back into the field */
      token: string
      /** typed name, when the id was given and the thing has since been renamed */
      renamed?: string
    }
  | { partial: T[]; typed: string }
  | null

const tidy = (r: string) => r.replace(/^['’]s\b/, '').replace(/^[\s,:;—-]+/, '')
const BOUNDARY = [' ', ',', ':', '’', "'", ';', '.', '!', '?']

/**
 * The name the text starts with (whole word), with EVERY thing that carries that name, or the names the text is
 * still typing. `Name#abc123` picks one thing by the tail of its id.
 */
function lead<T extends Named>(text: string, items: T[]): Lead<T> {
  const src = text.normalize('NFKC')
  const t = lower(src)
  const byId = src.match(/^([^#\n]*?)#([A-Za-z0-9_-]+)(?=$|[\s,:;'’.!?])/)
  if (byId) {
    const tok = lower(byId[2])
    // a whole id wins; otherwise the tail (short ids are unique tails among everything Still knows)
    const exact = items.filter((it) => lower(it.id) === tok)
    const hits = exact.length ? exact : items.filter((it) => lower(it.id).endsWith(tok))
    if (!hits.length) return null
    const typed = byId[1].trim()
    const after = src.slice(byId[0].length)
    const renamed = hits.length === 1 && typed && fold(typed).trim() !== fold(hits[0].name).trim() ? typed : undefined
    return { hits, rest: tidy(after), after, len: byId[0].length, token: byId[0], renamed }
  }
  let len = -1
  let hits: T[] = []
  for (const it of items) {
    const n = fold(it.name).trim()
    if (!n) continue
    if (t === n || (t.startsWith(n) && BOUNDARY.includes(t[n.length]))) {
      if (n.length > len) {
        len = n.length
        hits = [it]
      } else if (n.length === len) hits.push(it)
    }
  }
  if (hits.length) {
    const after = src.slice(len)
    return { hits, rest: tidy(after), after, len, token: src.slice(0, len) }
  }
  if (!t) return { partial: items.slice(0, 4), typed: '' }
  const partial = items.filter((it) => fold(it.name).trim().startsWith(t))
  return partial.length ? { partial: partial.slice(0, 4), typed: text } : null
}

// ---------------------------------------------------------------- limits: what the field cannot do

/** Times and schedules. Still acts now or not at all. */
const SCHEDULE =
  /\b(later|tomorrow|tonight|this (morning|afternoon|evening|weekend)|next (week|month|time|morning|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in (\d+|a|an|a few) (seconds?|minutes?|mins?|hours?|days?|weeks?)|at \d{1,2}(:\d{2})?\s*(am|pm)?|every (day|hour|morning|night|week|\d+)|each (day|hour|morning|week)|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i
/** Conditions. Still cannot hold anything until something else happens. */
const CONDITION = /\b(only\s+(if|when|after|before|once|until|unless)|unless|until|as soon as|provided that)\b|([,;—–]\s*|\s-\s)(if|when|whenever|after|before|once)\b/i
/**
 * Goals: a condition word anywhere ("ship it after review"). Messages are spared this, because a message may
 * open with "if…" as a question and reaches the mind word for word.
 */
const ANYWHERE = /\b(if|when|whenever|after|before|once)\b/i
/** What may follow a name in wake/sleep without changing what it means. */
const PLAIN = /^(up|now|please|right now|now please|please now|again)?[\s.!]*$/i

/**
 * The phrase asking for a time or a condition that Still cannot honour, if any. `strict` (wake, sleep): anything
 * after the name beyond "up" or "now" is refused. `words` (messages): times and clear conditions. `goal`: the
 * same, and for goals any condition word.
 */
export function unsupported(text: string, mode: 'strict' | 'words' | 'goal'): string | null {
  const t = text.trim()
  if (!t) return null
  if (mode === 'strict') return PLAIN.test(t) ? null : t.replace(/[.!]+$/, '')
  const s = t.match(SCHEDULE)
  if (s) return s[0]
  const c = t.match(CONDITION) ?? (mode === 'goal' ? t.match(ANYWHERE) : null)
  if (c) return t.slice(c.index ?? 0).replace(/^[\s,;—–-]+/, '').replace(/[.!?]+$/, '')
  return null
}

/** What the person probably means to send, shown verbatim before it goes. */
function phrase(rest: string, verb: string): string {
  let r = rest.trim()
  const about = r.match(/^about\s+(.+)$/i)
  if (about) return `What can you tell me about ${about[1].replace(/[?.!]+$/, '')}?`
  const to = r.match(/^to\s+(.+)$/i)
  if (to && verb !== 'say') return `Please ${to[1].replace(/[.!]+$/, '')}.`
  const that = r.match(/^that\s+(.+)$/i)
  if (that) r = that[1]
  if (!r) return ''
  const first = r[0].toUpperCase() + r.slice(1)
  if (verb === 'ask' && /^(if|whether|what|why|how|when|where|who|which|is|are|can|could|do|does|did|will|would|should)\b/i.test(r) && !/[?.!]$/.test(r)) return first + '?'
  return first
}

const VERBS: { words: string[]; tag: string; hint: string; fill: string }[] = [
  { words: ['ask', 'tell', 'message', 'write to'], tag: 'Send', hint: 'ask a mind something', fill: 'ask ' },
  { words: ['talk to', 'open'], tag: 'Open', hint: 'open a conversation', fill: 'talk to ' },
  { words: ['wake'], tag: 'Wake', hint: 'wake a mind', fill: 'wake ' },
  { words: ['sleep', 'rest'], tag: 'Sleep', hint: 'let a mind sleep', fill: 'sleep ' },
  { words: ['remind'], tag: 'Remind', hint: 'Health reminds a mind what it owes', fill: 'remind ' },
  { words: ['new task for', 'task for', 'new goal for', 'goal for'], tag: 'Task', hint: 'give a swarm a task', fill: 'new task for ' },
  { words: ['what needs me'], tag: 'Decide', hint: 'see what needs you', fill: 'what needs me' },
  { words: ['show'], tag: 'Open', hint: 'open a page, like usage', fill: 'show ' },
]

export interface World {
  minds: Named[]
  swarms: Named[]
  pending: number
}

export function understand(input: string, w: World): Suggestion[] {
  const raw = input.replace(/\s+/g, ' ').replace(/^\s+/, '')
  const t = lower(raw).trim()
  const out: Suggestion[] = []
  if (!t) return out

  // ---- identity: every target is named with its swarm and a short, stable piece of its id
  const sid = shortIds([...w.minds, ...w.swarms].map((x) => x.id))
  const tail = (x: Named) => `#${sid.get(x.id) ?? shortId(x.id)}`
  const was = (renamed?: string) => (renamed ? `, was “${renamed}”` : '')
  const whoMind = (m: Named, renamed?: string) => ({ t: ` (${m.swarm ? `in ${m.swarm}` : 'no swarm'} · ${tail(m)}${was(renamed)})`, who: true })
  const whoSwarm = (x: Named, renamed?: string) => ({ t: ` (swarm · ${tail(x)}${was(renamed)})`, who: true })
  const limit = (key: string, parts: Suggestion['parts'], fill?: string): Suggestion => ({ key: `limit-${key}`, tag: 'Can’t', limit: true, parts, fill })
  /** The host said this viewer may not (may_remind / may_sleep false or absent): say so plainly; nothing is offered to run. */
  const notAllowed = (m: Named, renamed: string | undefined, what: 'remind' | 'sleep'): Suggestion => {
    const it = what === 'remind' ? 'remind it' : 'put it to sleep'
    return limit(`${what}-not-yours-${m.id}`, m.personal && m.isMine !== true
      ? [{ t: m.name, em: true }, whoMind(m, renamed), { t: ` is someone else’s personal mind; only they can ${it}.` }]
      : [{ t: `The hive does not let you ${what === 'remind' ? 'remind' : 'put'} ` }, { t: m.name, em: true }, whoMind(m, renamed), { t: what === 'remind' ? '. Only its owner or an admin can.' : ' to sleep. Only its owner or an admin can.' }])
  }

  type Hit = Exclude<Lead<Named>, null | { partial: Named[] }>
  /** Several things share the name: say so, list each with its identity, and let the person pick. Nothing runs. */
  const choose = (prefix: string, hits: { x: Named; kind: 'mind' | 'swarm'; what: string }[], after: string) => {
    out.push({
      key: 'which-head',
      tag: 'Which',
      limit: true,
      parts: [{ t: `${cap1(spell(hits.length))} things are called ` }, { t: hits[0].x.name, em: true }, { t: '. Pick one; nothing happens until you do.' }],
    })
    for (const { x, kind, what } of hits)
      out.push({
        key: `which-${kind}-${x.id}`,
        tag: 'Which',
        choice: true,
        parts: [{ t: `${what} ` }, { t: x.name, em: true }, kind === 'mind' ? whoMind(x) : whoSwarm(x)],
        fill: `${prefix}${x.name}${tail(x)}${after || ' '}`,
      })
  }

  /** A message, or (when it asks for a time or a condition) an honest refusal first and the plain send second. */
  const sendOffer = (m: Named, text: string, typed: string, renamed?: string): Suggestion[] => {
    const base: Suggestion = { key: `send-${m.id}`, tag: 'Send', parts: [{ t: 'Send to ' }, { t: m.name, em: true }, whoMind(m, renamed), { t: ': ' }, { t: text, q: true }], act: { do: 'send', mind: m, text } }
    const lim = unsupported(typed, 'words')
    if (!lim) return [base]
    return [
      limit(`send-${m.id}`, [{ t: `I can’t hold a message for a time or a condition yet. “${lim}” would only be words in it, and it would go now.` }]),
      { ...base, key: `send-now-${m.id}`, parts: [{ t: 'Send it now anyway, word for word, to ' }, { t: m.name, em: true }, whoMind(m, renamed), { t: ': ' }, { t: text, q: true }] },
    ]
  }

  const goalOffer = (x: Named, title: string, renamed?: string): Suggestion[] => {
    const tt = cap1(title)
    const base: Suggestion = { key: `goal-${x.id}`, tag: 'Task', parts: [{ t: 'Give ' }, { t: x.name, em: true }, whoSwarm(x, renamed), { t: ' a task: ' }, { t: tt, q: true }], act: { do: 'goal', swarm: x, title: tt } }
    const lim = unsupported(title, 'goal')
    if (!lim) return [base]
    return [
      limit(`goal-${x.id}`, [{ t: `I can’t make a task wait for a time or a condition yet. “${lim}” would only be words in its title, and it would start now.` }]),
      { ...base, key: `goal-now-${x.id}`, parts: [{ t: 'Make it now anyway, word for word, for ' }, { t: x.name, em: true }, whoSwarm(x, renamed), { t: ': ' }, { t: tt, q: true }] },
    ]
  }

  /** A verb that takes one mind: the mind (exactly one), the choice (several), or the names still being typed. */
  const mindOr = (rest: string, prefix: string, what: string, make: (m: Named, r: Hit) => Suggestion[]) => {
    const r = lead(rest, w.minds)
    if (!r) return
    if ('hits' in r) {
      if (r.hits.length > 1) choose(prefix, r.hits.map((x) => ({ x, kind: 'mind' as const, what })), r.after)
      else out.push(...make(r.hits[0], r))
    } else {
      for (const m of r.partial) out.push({ key: `${what}-${m.id}`, tag: what.split(' ')[0], parts: [{ t: `${what} ` }, { t: m.name, em: true }, whoMind(m), { t: '…' }], fill: `${prefix}${m.name} ` })
    }
  }
  const token = (r: Hit) => r.token

  // ---- ask / tell / message: send a message
  const send = raw.match(/^(ask|tell|message|msg|write to|say to|send)\s+(.*)$/i)
  if (send) {
    const verb = lower(send[1]).startsWith('ask') ? 'ask' : lower(send[1]).startsWith('say') ? 'say' : 'tell'
    const prefix = `${send[1]} `
    mindOr(send[2], prefix, cap1(lower(send[1])), (m, r) => {
      const text = phrase(r.rest, verb)
      if (!text) return [{ key: `send-${m.id}`, tag: 'Send', parts: [{ t: 'Send to ' }, { t: m.name, em: true }, whoMind(m, r.renamed), { t: ': keep typing what to say…' }], fill: `${prefix}${token(r)} ` }]
      return sendOffer(m, text, r.rest, r.renamed)
    })
  }

  // ---- talk to / open / chat with a mind
  const talk = raw.match(/^(talk to|talk with|chat with|open|show|go to|visit)\s+(.*)$/i)
  if (talk) {
    const rest = talk[2]
    const prefix = `${talk[1]} `
    mindOr(rest, prefix, 'Open', (m, r) => [{ key: `open-${m.id}`, tag: 'Open', parts: [{ t: 'Open your conversation with ' }, { t: m.name, em: true }, whoMind(m, r.renamed)], act: { do: 'open', mind: m } }])
    const sw = lead(rest, w.swarms)
    if (sw && 'hits' in sw) {
      if (sw.hits.length > 1) choose(prefix, sw.hits.map((x) => ({ x, kind: 'swarm' as const, what: 'Open the swarm' })), sw.after)
      else out.push({ key: `swarm-${sw.hits[0].id}`, tag: 'Open', parts: [{ t: 'Open the ' }, { t: sw.hits[0].name, em: true }, whoSwarm(sw.hits[0], sw.renamed), { t: ' swarm' }], act: { do: 'swarm', swarm: sw.hits[0] } })
    }
    featureSugs(rest, out, true)
  }

  // ---- wake / sleep: nothing may follow the name but "up" or "now"; conditions and times are refused, not dropped
  const wake = raw.match(/^(wake up|wake)\s+(.*)$/i)
  if (wake) {
    const prefix = `${wake[1]} `
    mindOr(wake[2], prefix, 'Wake', (m, r) => {
      const lim = unsupported(r.rest, 'strict')
      if (lim) return [limit(`wake-${m.id}`, [{ t: 'I can’t do conditions or timing yet, so I won’t wake ' }, { t: m.name, em: true }, whoMind(m, r.renamed), { t: ` “${lim}”. Tab keeps only “${prefix}${token(r)}”.` }], `${prefix}${token(r)}`)]
      return [m.awake
        ? { key: `open-${m.id}`, tag: 'Open', parts: [{ t: m.name, em: true }, whoMind(m, r.renamed), { t: ' is already awake. Open the conversation' }], act: { do: 'open', mind: m } }
        : { key: `wake-${m.id}`, tag: 'Wake', parts: [{ t: 'Wake ' }, { t: m.name, em: true }, whoMind(m, r.renamed)], act: { do: 'wake', mind: m } }]
    })
  }
  const sleep = raw.match(/^(sleep|rest|pause|put)\s+(.*?)(\s+to sleep)?$/i)
  if (sleep) {
    const prefix = `${sleep[1]} `
    mindOr(sleep[2], prefix, 'Sleep', (m, r) => {
      const to = r.rest.match(/^to sleep\b\s*/i)
      const suffix = sleep[3] ?? (to ? ' to sleep' : '')
      const lim = unsupported(to ? r.rest.slice(to[0].length) : r.rest, 'strict')
      if (lim) return [limit(`sleep-${m.id}`, [{ t: 'I can’t do conditions or timing yet, so I won’t put ' }, { t: m.name, em: true }, whoMind(m, r.renamed), { t: ` to sleep “${lim}”. Tab keeps only “${prefix}${token(r)}${suffix}”.` }], `${prefix}${token(r)}${suffix}`)]
      // the one awake rule (api/idleMinds isAwakeForAction): exactly `awake`; may_sleep alone is permission only
      if (m.awakeNow !== true)
        return [{ key: `noop-${m.id}`, tag: 'Sleep', parts: [{ t: m.name, em: true }, whoMind(m, r.renamed), { t: m.awake ? ' is still starting. Sleep works once it is awake.' : ' is already asleep.' }], act: { do: 'open', mind: m } }]
      if (m.maySleep !== true) return [notAllowed(m, r.renamed, 'sleep')]
      return [{ key: `sleep-${m.id}`, tag: 'Sleep', parts: [{ t: 'Let ' }, { t: m.name, em: true }, whoMind(m, r.renamed), { t: ' sleep' }], act: { do: 'sleep', mind: m } }]
    })
  }

  // ---- remind: Health asks an awake mind its own question now; the person adds no words, and Health never wakes one
  const remind = raw.match(/^(remind)\s+(.*)$/i)
  if (remind) {
    const prefix = `${remind[1]} `
    mindOr(remind[2], prefix, 'Remind', (m, r) => {
      const lim = unsupported(r.rest, 'strict')
      if (lim) return [limit(`remind-${m.id}`, [{ t: 'Health asks its own question, so I won’t add “' }, { t: lim, q: true }, { t: '” to it. Tab keeps only “' }, { t: `${prefix}${token(r)}` }, { t: '”.' }], `${prefix}${token(r)}`)]
      if (m.awakeNow === true && m.mayRemind !== true) return [notAllowed(m, r.renamed, 'remind')]
      return [m.awakeNow === true
        ? { key: `remind-${m.id}`, tag: 'Remind', parts: [{ t: 'Have Health remind ' }, { t: m.name, em: true }, whoMind(m, r.renamed), { t: ' now: what it owes, or why it is awake with no input' }], act: { do: 'remind', mind: m } }
        : { key: `noop-remind-${m.id}`, tag: 'Remind', parts: [{ t: m.name, em: true }, whoMind(m, r.renamed), { t: m.awake ? ' is still starting. Health only asks awake minds. Open the conversation' : ' is asleep. Health only asks awake minds and never wakes one. Open the conversation' }], act: { do: 'open', mind: m } }]
    })
  }

  // ---- goals
  const goal = raw.match(/^((?:(?:new|add|create|set|make)\s+(?:a\s+)?)?(?:goal|task)\s+(?:for|in|to)\s+)(.*)$/i)
  if (goal) {
    const r = lead(goal[2], w.swarms)
    if (r && 'hits' in r) {
      if (r.hits.length > 1) choose(goal[1], r.hits.map((x) => ({ x, kind: 'swarm' as const, what: 'A task for' })), r.after)
      else {
        const x = r.hits[0]
        const title = r.rest.replace(/^(to\s+)/i, '').trim()
        if (title) out.push(...goalOffer(x, title, r.renamed))
        else out.push({ key: `goal-${x.id}`, tag: 'Task', parts: [{ t: 'Give ' }, { t: x.name, em: true }, whoSwarm(x, r.renamed), { t: ' a task: keep typing what it is…' }], fill: `${goal[1]}${token(r)}: ` })
      }
    } else if (r) {
      for (const x of r.partial) out.push({ key: `goal-${x.id}`, tag: 'Task', parts: [{ t: 'A task for ' }, { t: x.name, em: true }, whoSwarm(x), { t: '…' }], fill: `${goal[1]}${x.name}: ` })
    }
  }

  // ---- start a swarm: "start a swarm", "new swarm called X", "make a private swarm for X". Opens the launch flow,
  // where the person chooses who can see it (Private first) and nothing is made until they confirm there.
  const launch = !send && !talk && !wake && !sleep && !remind && !goal ? raw.match(/^(?:please\s+)?(?:start|new|create|make|launch|set up|add)\b(?:\s+(?:a|an|me a|my))?(?:\s+(?:new|private|shared|top[- ]level))*\s+swarm\b(?:\s+(?:called|named|for)\s+(.+?))?[.!]?$/i) : null
  if (launch) {
    const named = launch[1]?.trim()
    const priv = /\bprivate\b/i.test(raw)
    out.push({
      key: 'launch',
      tag: 'Swarm',
      parts: [
        { t: `Start a new ${priv ? 'private ' : ''}swarm` },
        ...(named ? [{ t: ' called ' }, { t: named, q: true }] : []),
        { t: `. You name it, give it a purpose and choose who can see it (${priv ? 'Private is chosen' : 'Private first'}); nothing is made until you confirm there.` },
      ],
      act: { do: 'feature', id: 'swarms.launch', name: named },
    })
  }

  // ---- led by a name: "Mira, …", "@Mira …", "Forge should …", or just a name. A mind and a swarm may share it.
  let named = false
  if (!send && !talk && !wake && !sleep && !remind && !goal && !launch) {
    const at = raw.startsWith('@') ? '@' : ''
    const body = raw.slice(at.length)
    const dm = lead(body, w.minds)
    const ds = lead(body, w.swarms)
    let mh = dm && 'hits' in dm ? dm : null
    let sh = ds && 'hits' in ds ? ds : null
    if (mh && sh) {
      if (mh.len > sh.len) sh = null
      else if (sh.len > mh.len) mh = null
    }
    const SHOULD = /^(should|needs to|must|could)\s+(.+)$/i
    named = !!(mh || sh)
    if ((mh?.hits.length ?? 0) + (sh?.hits.length ?? 0) > 1) {
      choose(at, [
        ...(mh?.hits ?? []).map((x) => ({ x, kind: 'mind' as const, what: mh!.rest ? 'Send to the mind' : 'Open the mind' })),
        ...(sh?.hits ?? []).map((x) => ({ x, kind: 'swarm' as const, what: SHOULD.test(sh!.rest) ? 'A task for the swarm' : 'Open the swarm' })),
      ], (mh ?? sh)!.after)
    } else if (mh) {
      const m = mh.hits[0]
      if (mh.rest) out.push(...sendOffer(m, phrase(mh.rest, 'say'), mh.rest, mh.renamed))
      else {
        out.push({ key: `open-${m.id}`, tag: 'Open', parts: [{ t: 'Open your conversation with ' }, { t: m.name, em: true }, whoMind(m, mh.renamed)], act: { do: 'open', mind: m } })
        out.push({ key: `fill-ask-${m.id}`, tag: 'Send', parts: [{ t: 'Ask ' }, { t: m.name, em: true }, whoMind(m, mh.renamed), { t: ' something…' }], fill: `ask ${token(mh)} ` })
        if (!m.awake) out.push({ key: `wake-${m.id}`, tag: 'Wake', parts: [{ t: 'Wake ' }, { t: m.name, em: true }, whoMind(m, mh.renamed)], act: { do: 'wake', mind: m } })
      }
    } else if (sh) {
      const x = sh.hits[0]
      const sm = sh.rest.match(SHOULD)
      if (sm) out.push(...goalOffer(x, sm[2], sh.renamed))
      else if (!sh.rest) out.push({ key: `swarm-${x.id}`, tag: 'Open', parts: [{ t: 'Open the ' }, { t: x.name, em: true }, whoSwarm(x, sh.renamed), { t: ' swarm' }], act: { do: 'swarm', swarm: x } })
    } else if (dm && 'partial' in dm && t.length >= 2) {
      for (const m of dm.partial) out.push({ key: `name-${m.id}`, tag: 'Mind', parts: [{ t: m.name, em: true }, whoMind(m), { t: m.awake ? ', awake' : ', asleep' }], fill: `${at}${m.name} ` })
    }
  }

  // ---- any hive feature by its name or plain words ("show usage", "people", "settle calls", "move a mind")
  if (!talk && !send && !wake && !sleep && !remind && !goal && !launch && !named) featureSugs(t, out, /^(show|see|view|open|go to|take me to|where)\b/.test(t))
  // a feature's own name that happens to start with a verb ("Talk to a mind", "Open an app"), when the verb found no target
  else if (!out.some((x) => x.choice || (x.act && CONSEQUENTIAL.has(x.act.do)))) featureSugs(t, out, false)

  // ---- what needs me / happening / learned
  if (/(need|needs)\s+(me|you|my)|approv|decision|decide|inbox|waiting|anything for me|to do\b/.test(t)) {
    out.push({ key: 'needs', tag: 'Decide', parts: [{ t: w.pending ? `${w.pending === 1 ? 'One thing needs' : `${w.pending} things need`} you. Take them one at a time` : 'Nothing needs you right now. Look anyway' }], act: { do: 'scroll', to: 'needs' } })
  }
  if (/happening|going on|who is (awake|thinking)|busy|status|what.*doing/.test(t)) out.push({ key: 'now', tag: 'Look', parts: [{ t: 'See what is happening now' }], act: { do: 'scroll', to: 'now' } })
  if (/learn|belie|know|discover|found/.test(t)) out.push({ key: 'learned', tag: 'Read', parts: [{ t: 'Read what the hive learned lately' }], act: { do: 'scroll', to: 'learned' } })
  if (/^(change|switch)\s+(ui|look|theme|design|experience)|^(ui|theme|look)s?$/.test(t)) out.push({ key: 'gallery', tag: 'Change', parts: [{ t: 'Choose a different way to see the hive' }], act: { do: 'gallery' } })


  // ---- verbs still being typed
  if (!out.length || t.length < 6) {
    for (const v of VERBS) {
      if (v.words.some((x) => x.startsWith(t) && x !== t)) out.push({ key: `verb-${v.fill}`, tag: v.tag, parts: [{ t: v.fill.trim(), em: true }, { t: ` — ${v.hint}` }], fill: v.fill })
    }
  }

  // ---- always: search everything, in place, for exactly what was typed
  out.push({ key: 'search', tag: 'Search', parts: [{ t: 'Search everything for ' }, { t: raw.trim(), q: true }], act: { do: 'search', text: raw.trim() } })

  const seen = new Set<string>()
  const most = out.some((s) => s.choice) ? 9 : 5
  return out.filter((s) => (seen.has(s.key) ? false : (seen.add(s.key), true))).slice(0, most)
}

const NUM = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']
const spell = (n: number) => (n < NUM.length ? NUM[n].toLowerCase() : String(n))

const cap1 = (s: string) => s[0].toUpperCase() + s.slice(1)

/** Suggestions for hive features the words ask for: Still's own sheet when it has one, otherwise the classic page. */
function featureSugs(t: string, out: Suggestion[], explicit: boolean) {
  for (const f of matchFeatures(t, explicit)) {
    if (f.id === 'swarms.launch' && out.some((x) => x.key === 'launch')) continue
    const blurb = f.blurb[0].toLowerCase() + f.blurb.slice(1)
    out.push({ key: `feature-${f.id}`, tag: 'Open', parts: [{ t: f.label, em: true }, { t: ` — ${blurb}` }], act: { do: 'feature', id: f.id } })
  }
}

/** Every feature id the field can open (for tests and the Everything passage). */
export const FIELD_FEATURES = FEATURES.map((f) => f.id)

/** The completion still to type for the top suggestion, for the ghost text in the field. */
export function ghost(input: string, s: Suggestion | undefined): string {
  if (!s?.fill || !input) return ''
  return lower(s.fill).startsWith(lower(input)) ? s.fill.slice(input.length) : ''
}

/** Example asks, from the real hive, for the empty field. */
export function examples(w: World): string[] {
  const awake = w.minds.filter((m) => m.awake)
  const asleep = w.minds.filter((m) => !m.awake)
  const out: string[] = []
  if (awake[0]) out.push(`ask ${awake[0].name} about what it noticed today`)
  if (w.pending) out.push('what needs me')
  if (asleep[0]) out.push(`wake ${asleep[0].name}`)
  if (w.swarms[0]) out.push(`new task for ${w.swarms[0].name}: `)
  out.push('show usage')
  return out.slice(0, 4)
}
