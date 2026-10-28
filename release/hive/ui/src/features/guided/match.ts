/**
 * Recognising a guided-demo request in the Ask's words (pure; no model, no network). Explicit demo phrasing ("show me
 * how X works", "walk me through X", "demo X", "give me a tour of X") is always a demo request: a known topic starts
 * its demo (or a stub's honest answer); an unknown one gets an honest "no demo for that" with the nearest real ones.
 * Softer phrasing ("how does X work", "explain X") is a demo request only when X is a known topic; otherwise the words
 * go on to the orchestrator as a question. While a demo plays, a few words control it ("next", "back", "stop").
 */
import { GUIDE_SCRIPTS } from './scripts'
import type { GuideScript } from './types'

export type GuideIntent =
  | { kind: 'script'; script: GuideScript; topic: string }
  | { kind: 'unknown'; topic: string; near: GuideScript[] }
  | { kind: 'list'; near: GuideScript[] }

export type GuideControl = 'next' | 'back' | 'pause' | 'resume' | 'stop' | 'restart'

export function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/'s\b/g, '')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/'/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const POLITE = "(?:hey |ok |okay |so |now |can you |could you |would you |will you |please |pls )*"
const ART = '(?:the |a |an |our |my |your )?'
const ENDING = '(?: works?| is done| happens| runs| operates| fits together)?(?: please)?'
const EXPLICIT: RegExp[] = [
  new RegExp(`^${POLITE}show (?:me|us) how ${ART}(?:to )?(.+?)${ENDING}$`),
  new RegExp(`^${POLITE}(?:walk|take|guide|talk) (?:me|us) through ${ART}(.+?)(?: please)?$`),
  new RegExp(`^${POLITE}(?:give (?:me|us) |do |run |start |play )?(?:a |the )?(?:guided )?(?:demo|tour|walkthrough|walk through|guided demo) (?:of |on |for |about )?${ART}(.+?)(?: please)?$`),
  new RegExp(`^${POLITE}demonstrate ${ART}(.+?)(?: please)?$`),
  new RegExp(`^${POLITE}teach (?:me|us) (?:about |how )?${ART}(.+?)${ENDING}$`),
]
const SOFT: RegExp[] = [new RegExp(`^${POLITE}how (?:does|do|is|are) ${ART}(.+?) (?:work|works|done|happen)$`), new RegExp(`^${POLITE}explain (?:how )?${ART}(.+?)${ENDING}$`)]
const LIST = /^(?:what|which) (?:guided )?(?:demos|tours|walkthroughs)(?: (?:are there|do you have|can you (?:show|do|give)|exist))?$|^(?:list|show me) (?:the |all |your )?(?:guided )?(?:demos|tours)$/

const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'my', 'our', 'your', 'its', 'how', 'does', 'do', 'is', 'are', 'works', 'work', 'working', 'what', 'me', 'us', 'with', 'and', 'this', 'that', 'it', 'be', 'about', 'please', 'one', 'mind', 'minds'])
const stem = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)
const tokens = (s: string, keepMind = false) => norm(s).split(' ').filter((w) => w && (!STOP.has(w) || (keepMind && (w === 'mind' || w === 'minds')))).map(stem)

/** How well a topic names a script, 0..1: exact phrase 1; else the best of overlap and containment over its phrases. */
export function topicScore(topic: string, s: GuideScript): number {
  const t = norm(topic)
  const tt = tokens(topic, true)
  if (!t || !tt.length) return 0
  let best = 0
  for (const phrase of [s.title, ...s.topics]) {
    const p = norm(phrase)
    if (p === t) return 1
    const pt = tokens(phrase, true)
    if (!pt.length) continue
    const inter = pt.filter((w) => tt.includes(w)).length
    const union = new Set([...pt, ...tt]).size
    const jaccard = inter / union
    // the whole phrase inside the topic ("belief revision" in "belief revision in a swarm")
    const contained = inter === pt.length ? pt.length / tt.length : 0
    best = Math.max(best, jaccard, contained * 0.95)
  }
  return best
}

export const MATCH_AT = 0.5
const DEFAULT_NEAR = ['hive', 'beliefs', 'experiences']

/** The best script for a topic, if one is good enough; ties go to ready demos, then to the earlier one. */
export function bestScript(topic: string, scripts: GuideScript[] = GUIDE_SCRIPTS): { script: GuideScript; score: number } | null {
  let best: { script: GuideScript; score: number } | null = null
  for (const s of scripts) {
    const score = topicScore(topic, s)
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && best.script.status === 'stub' && s.status === 'ready')) best = { script: s, score }
  }
  return best && best.score >= MATCH_AT ? best : null
}

/** Real demos near a topic (for "no demo for that"), or the usual first three. */
export function nearest(topic: string, scripts: GuideScript[] = GUIDE_SCRIPTS, n = 3): GuideScript[] {
  const ready = scripts.filter((s) => s.status === 'ready')
  const scored = ready.map((s) => ({ s, x: topicScore(topic, s) })).filter((x) => x.x > 0).sort((a, b) => b.x - a.x)
  const out = scored.slice(0, n).map((x) => x.s)
  for (const id of DEFAULT_NEAR) if (out.length < n && !out.some((s) => s.id === id)) out.push(ready.find((s) => s.id === id)!)
  return out.filter(Boolean)
}

/** Is this a demo request, and for what? null: not one (the words go on to the rest of the Ask). */
export function guidedIntent(text: string, scripts: GuideScript[] = GUIDE_SCRIPTS): GuideIntent | null {
  const t = norm(text)
  if (!t) return null
  if (LIST.test(t)) return { kind: 'list', near: scripts.filter((s) => s.status === 'ready') }
  for (const s of scripts) if (s.triggers.some((x) => norm(x) === t)) return { kind: 'script', script: s, topic: t }
  for (const re of EXPLICIT) {
    const m = t.match(re)
    if (!m) continue
    const topic = m[1].trim()
    if (!topic) continue
    const hit = bestScript(topic, scripts)
    return hit ? { kind: 'script', script: hit.script, topic } : { kind: 'unknown', topic, near: nearest(topic, scripts) }
  }
  for (const re of SOFT) {
    const m = t.match(re)
    if (!m) continue
    const hit = bestScript(m[1].trim(), scripts)
    if (hit) return { kind: 'script', script: hit.script, topic: m[1].trim() }
  }
  return null
}

/** Words that control a demo while it plays. */
export function guideControl(text: string): GuideControl | null {
  const t = norm(text)
  if (/^(?:next|next step|go on|continue|carry on|keep going|onward|forward)$/.test(t)) return 'next'
  if (/^(?:back|go back|previous|previous step|step back)$/.test(t)) return 'back'
  if (/^(?:pause|wait|hold on|hold|pause (?:the )?(?:demo|tour))$/.test(t)) return 'pause'
  if (/^(?:resume|play|go|unpause|resume (?:the )?(?:demo|tour))$/.test(t)) return 'resume'
  if (/^(?:stop|end|exit|quit|cancel|enough|stop (?:the )?(?:demo|tour)|end (?:the )?(?:demo|tour)|exit (?:the )?(?:demo|tour))$/.test(t)) return 'stop'
  if (/^(?:restart|start over|again|from the top)$/.test(t)) return 'restart'
  return null
}
