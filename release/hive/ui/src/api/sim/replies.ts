import type { Belief } from '../types'
import type { SeedAgent } from './data'

type Voice = SeedAgent['voice']
type Rng = () => number

const pick = <T,>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]

const fmt = (b: Belief) => `${b.statement} ⟨f ${b.tv.f.toFixed(2)}, c ${b.tv.c.toFixed(2)}⟩`

const OPENERS: Record<Voice, string[]> = {
  precise: ['Noted.', 'Understood.', 'Checking the commons.', 'Right.'],
  warm: ['Oh, good question.', 'Happy to help.', 'Mm, let me think with you.', 'Of course.'],
  terse: ['Ack.', 'Ok.', 'Copy.', 'Yes.'],
  poetic: ['Listen:', 'Consider this.', 'A thought, half-formed:', 'Here is what the evidence whispers.'],
  wry: ['Well.', 'Funny you should ask.', 'Ah, the eternal question.', 'Sure, why not.'],
}

const CLOSERS: Record<Voice, string[]> = {
  precise: ['I will publish if new evidence lands.', 'Confidence will not move without new stamps.', ''],
  warm: ['Tell me if you want me to dig deeper.', 'We can revisit this together later.', ''],
  terse: ['', '', 'More later.'],
  poetic: ['Everything we believe is only the best revision so far.', 'The commons remembers what we forget.', ''],
  wry: ['No promises, but the stamps look honest.', 'I have been wrong before. Twice, by my count.', ''],
}

export interface ReplyContext {
  name: string
  voice: Voice
  model: string
  swarmName: string | null
  beliefs: Belief[]
  musings: string[]
  status: string
}

export function generateReply(rng: Rng, text: string, ctx: ReplyContext): string {
  if (ctx.model === 'mock/echo') return `echo: ${text}`
  const t = text.toLowerCase()
  const open = pick(rng, OPENERS[ctx.voice])
  const close = pick(rng, CLOSERS[ctx.voice])
  const top = [...ctx.beliefs].sort((a, b) => b.tv.c - a.tv.c)
  const shaky = [...ctx.beliefs].sort((a, b) => a.tv.c - b.tv.c)
  let body: string

  if (/^(hi|hey|hello|yo|good (morning|evening))\b/.test(t)) {
    body = `I'm ${ctx.name}${ctx.swarmName ? `, part of ${ctx.swarmName}` : ', roaming between swarms'}. ${
      top[0] ? `Right now I'm most sure that ${fmt(top[0])}.` : 'My commons is still empty.'
    }`
  } else if (/(believe|know|think|sure|confiden|belief)/.test(t)) {
    const a = top[0]
    const b = shaky[0]
    body = a
      ? `Strongest: ${fmt(a)}.${b && b !== a ? ` Weakest: ${fmt(b)}; I would not lean on that one yet.` : ''}`
      : 'I have nothing in the commons with enough evidence to quote.'
  } else if (/(status|doing|up to|busy|working)/.test(t)) {
    body = `${pick(rng, ctx.musings)} Status: ${ctx.status}, running on ${ctx.model}.`
  } else if (/(why|how|explain)/.test(t)) {
    const b = pick(rng, top.slice(0, 4).length ? top.slice(0, 4) : ctx.beliefs)
    body = b
      ? `Because the evidence for ${b.statement} comes from ${b.sources.length} source${b.sources.length === 1 ? '' : 's'} with ${b.stamp.length} stamp${b.stamp.length === 1 ? '' : 's'}. Revision pooled them to f ${b.tv.f.toFixed(2)}, c ${b.tv.c.toFixed(2)}.`
      : 'I would need more evidence before explaining anything.'
  } else if (/(conflict|disagree|choice|contradict)/.test(t)) {
    body = 'When two assertions share evidence they cannot be revised together, so the commons runs choice and keeps the more confident one. The loser stays in provenance.'
  } else if (t.endsWith('?')) {
    const b = ctx.beliefs.length ? pick(rng, ctx.beliefs) : null
    body = b
      ? `The closest thing I hold is ${fmt(b)}. ${b.tv.c < 0.55 ? 'Low confidence, treat it as a hunch.' : 'Decent evidence behind it.'}`
      : 'I do not know yet. I will watch for it.'
  } else {
    body = `${pick(rng, ctx.musings)}`
  }
  return [open, body, close].filter(Boolean).join(' ')
}

export const PEER_LINES = [
  'Can you double-check {s}? My stamps disagree.',
  'Publishing {s} soon, heads up.',
  'Your last revision on {s} moved me. Thanks.',
  'Seeing something odd near {s}. Want to look?',
]
export const PEER_REPLIES = ['On it.', 'Looked. Holding steady.', 'Agree, revising now.', 'Disagree, see my stamps.', 'Thanks, noted.']
