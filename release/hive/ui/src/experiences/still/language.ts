/**
 * Still speaks in sentences. Everything the hive holds (beliefs, approvals, time, status) is turned into plain
 * English here, so the components only ever lay out prose.
 */
import type { Approval, Belief } from '../sdk'
import { sayBelief } from '../../lib/beliefSentence'

// ---------------------------------------------------------------- time

export function greeting(d: Date): string {
  const h = d.getHours()
  if (h < 5) return 'Hello, night owl.'
  if (h < 12) return 'Good morning.'
  if (h < 17) return 'Good afternoon.'
  return 'Good evening.'
}

const DATE = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
export const dateLine = (d: Date): string => DATE.format(d)

export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, (now - t) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return m === 1 ? 'a minute ago' : `${m} minutes ago`
  const h = Math.round(m / 60)
  if (h < 24) return h === 1 ? 'an hour ago' : `${h} hours ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

// ---------------------------------------------------------------- lists

const NUM = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
export const spell = (n: number) => (n < NUM.length ? NUM[n] : String(n))
export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

// ---------------------------------------------------------------- beliefs

// uifix-r3 (S3, a11y-07): Still's belief words are the one shared helper (lib/beliefSentence), not a copy of their own.
export { beliefTopic, sureness, SURENESS_WORD, type Sureness } from '../../lib/beliefSentence'

/** A belief as one English sentence, sureness in it ("Vega is very likely a star"); "A belief about …" when unreadable. */
export function beliefSentence(b: Pick<Belief, 'statement' | 'tv'>, withAdverb = true): string {
  return sayBelief(b.statement, withAdverb ? b.tv : null).text
}

// ---------------------------------------------------------------- approvals

export interface Explained {
  /** "run a command on the computer" (follows "Vega would like to"). */
  wants: string
  /** The exact thing, quoted. */
  detail: string | null
  /** Why a person is asked, in plain words. */
  why: string
  stakes: string
  /** The detail is a sentence, not code. */
  sentence?: boolean
}

function args(command: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(command))) out.push(m[1].replace(/\\n/g, ' ↵ ').replace(/\\"/g, '"'))
  return out
}

const verbOf = (command: string) => command.match(/^\(\s*([^\s()]+)/)?.[1] ?? ''

export function explainApproval(a: Pick<Approval, 'skill' | 'command' | 'reason' | 'risk'>): Explained {
  const v = verbOf(a.command) || a.skill
  const q = args(a.command)
  const bare = a.command.replace(/^\(\s*\S+\s*/, '').replace(/\)\s*$/, '').trim()
  let wants = `use its “${a.skill}” skill`
  let detail: string | null = q[0] ?? (bare || null)
  let sentence = false
  if (/^shell/.test(v)) wants = 'run a command on the computer'
  else if (/^write-file/.test(v)) {
    wants = `write a file called ${q[0] ?? 'something'}`
    detail = q[1] ?? null
  }
  else if (/^append-file/.test(v)) {
    wants = `add a line to ${q[0] ?? 'a file'}`
    detail = q[1] ?? null
  }
  else if (/^read-file/.test(v)) wants = 'read a file'
  else if (/^remove-atom/.test(v)) {
    wants = 'forget something it believes'
    const st = bare.match(/\((?:-->|==>)[\s\S]*\)/)?.[0]
    detail = st ? `“${beliefSentence({ statement: st, tv: { f: 0.7, c: 0.5 } }, false)}”` : bare || null
    sentence = !!st
  }
  else if (/^space-transform/.test(v)) wants = 'rewrite part of its memory'
  else if (/^space-commit/.test(v)) {
    wants = 'save its notes for good'
    detail = bare || null
  }
  else if (/^codex/.test(v) || /^code-/.test(v)) wants = 'change some code'
  else if (/^send-file/.test(v)) {
    wants = `send the file ${q[0] ?? ''} out of the hive`.replace('  ', ' ')
    detail = q[1] ? `to ${q[1]}` : null
  }
  else if (/^(transfer-funds|pay|purchase)/.test(v)) {
    wants = 'spend money'
    detail = bare || null
  }
  else if (/^web-search|^search/.test(v)) wants = 'search for something'
  else if (/^program:/.test(a.skill)) wants = `take an action in the ${a.skill.slice(8)} app`
  const why = a.reason === 'human-only' ? 'Only a person is allowed to do this.' : a.reason ? `The rule says: ${a.reason.replace(/\.$/, '')}.` : 'A rule asks a person to check this first.'
  const stakes = a.risk === 'high' ? 'High stakes. Read it carefully.' : a.risk === 'medium' ? 'Worth a moment’s thought.' : 'Low stakes.'
  return { wants, detail, why, stakes, sentence }
}

// ---------------------------------------------------------------- the exact request, beside the prose

export interface Facts {
  /** Scope, as label and value, always shown on the card. */
  rows: [string, string][]
  /** The complete request, exactly as the mind sent it. Never shortened. */
  raw: string
}

/**
 * Prose can make two different requests read alike, so the card also shows what was actually asked: the complete
 * command and its scope (who asked, in which swarm, which skill, how risky, which rule, which request).
 */
export function decisionFacts(
  a: Pick<Approval, 'id' | 'agent_id' | 'skill' | 'command' | 'reason' | 'risk'>,
  mind: { name: string } | undefined,
  swarm: { id: string; name: string } | undefined,
  short: (id: string) => string,
): Facts {
  const who = `${mind?.name || 'Unknown mind'} · #${short(a.agent_id)}`
  return {
    rows: [
      ['Asked by', who],
      ['Swarm', swarm ? `${swarm.name || 'Unnamed swarm'} · #${short(swarm.id)}` : 'No swarm'],
      ['Skill', a.skill],
      ['Risk', a.risk],
      ['Rule', a.reason || 'none given'],
      ['Request', `#${short(a.id)}`],
    ],
    raw: a.command,
  }
}
