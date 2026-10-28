/**
 * The shared fast path (Surface universal Ask, phase 1; UNIVERSAL_ASK_DESIGN §2): resolve(text, scope, world) →
 * Candidate[]. No model and no network: Still's understanding (understand.ts), plus the look pack (look.ts), the
 * mind- and swarm-scoped features (one clarifying question when the subject is missing), apps by name, an explicit
 * search, and the hand-off to the swarm's orchestrator when nothing local is confident (score.ts decides).
 *
 * It never constructs an app action: app acts only come from the host as `action-needs-confirm` (Host §3).
 */
import { plural } from '../plural'
import { featureById, FEATURES } from '../../features/registry'
import type { Route } from '../router'
import { guidedIntent, type GuideIntent } from '../../features/guided/match'
import { featureWords, foldWords, scoreFeatures } from './features'
import { shortIds } from './ident'
import { lookCandidates } from './look'
import { deleteSwarmCandidates } from './swarmDelete'
import { hiveMapCandidates } from './hiveMap'
import type { Candidate, Chip, Effect, IntentAct, IntentScope, Named, Suggestion, World } from './types'
import { CONSEQUENTIAL, understand } from './understand'
import { vocabularyFor } from './vocab'

export type { Candidate, Effect, IntentAct, IntentScope, Named, World } from './types'
export { decide, enterTakesFirst, type Decision } from './score'
export { applyLookPatch, lookCandidates, lookPatchProblem } from './look'
export { registerVocabulary, vocabularyFor } from './vocab'
export { examples, ghost, unsupported, CONSEQUENTIAL } from './understand'
export { deleteSwarmCandidates } from './swarmDelete'
export { hiveMapCandidates, type MapHive, type MapOp } from './hiveMap'

/** Feature ids that live on one mind's or one swarm's page (experiences/targets.ts), so they need a subject. */
export type ScopedFeatures = Record<string, 'mind' | 'swarm'>

const FEATURE_CONF: Record<number, number> = { 4: 0.95, 3: 0.86, 2: 0.62 }

/** How a Still act changes the world, for the policy. */
export function effectOf(act: IntentAct | undefined): Effect | undefined {
  if (!act) return undefined
  if (act.do === 'mind') return 'mind'
  if (act.do === 'look') return 'look'
  // a swarm with its minds: only ever opens its warning (swarmDelete.ts)
  if (act.do === 'deleteSwarm') return 'open-decision'
  if (act.do === 'map') return 'view'
  if (CONSEQUENTIAL.has(act.do as never)) return 'own-action'
  if (act.do === 'feature' || act.do === 'scoped') {
    const f = featureById(act.id)
    if (f && (f.decision || f.money)) return 'open-decision'
  }
  return 'view'
}

/** A whole-word name inside the words (for "Vega's memory", "the goals of Forge"). Several: all of them. */
function namedIn<T extends Named>(text: string, items: T[]): T[] {
  const t = ` ${foldWords(text)} `
  const out: T[] = []
  let best = 0
  for (const it of items) {
    const n = foldWords(it.name)
    if (!n) continue
    if (t.includes(` ${n} `) || t.includes(` ${n}'s `)) {
      if (n.length > best) {
        best = n.length
        out.length = 0
        out.push(it)
      } else if (n.length === best) out.push(it)
    }
  }
  return out
}

/** Routes a feature can carry a swarm on, so "goals for Forge" opens Forge's goals. */
function withSwarm(r: Route, swarm: string): Route {
  if (r.name === 'goals' || r.name === 'assets' || r.name === 'connect') return { ...r, swarm }
  if (r.name === 'boards') return { name: 'boards', swarm }
  return r
}

export function resolve(text: string, scope: IntentScope, world: World, scoped: ScopedFeatures = {}): Candidate[] {
  const raw = text.replace(/\s+/g, ' ').trim()
  if (!raw) return []
  // a guided demo ("show me how belief revision works", "walk me through the Lab", "demo NAL"): only that
  const guided = guidedIntent(raw)
  if (guided) return [guideCandidate(guided, raw)]
  const vocab = vocabularyFor(scope.experience)
  const inPlace = new Set(vocab.inPlace ?? [])
  // own entries only: an inherited name ("constructor") is never a scoped feature
  const scopeOf = (id: string) => (Object.hasOwn(scoped, id) ? scoped[id] : undefined)
  const scores = new Map(scoreFeatures(raw, /^(show|see|view|open|go to|take me to|where)\b/i.test(raw)).map((x) => [x.f.id, x.s]))
  // "the memory of Vega", "Vega's memory", "goals for Lyra": score the words without the subject's name, too
  const subjects = [...namedIn(raw, world.minds).map((x) => ({ x, kind: 'mind' as const })), ...namedIn(raw, world.swarms).map((x) => ({ x, kind: 'swarm' as const }))]
  const subject = subjects.length === 1 ? subjects[0] : null
  if (subject) {
    const n = foldWords(subject.x.name)
    const bare = ` ${foldWords(raw)} `.replace(new RegExp(` (of |for |in |on |about )?${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}('s)? `), ' ').trim()
    for (const { f, s: sc } of scoreFeatures(bare, true)) if (sc > (scores.get(f.id) ?? 0)) scores.set(f.id, sc)
  }
  // a scope's own phrases for features
  const words = featureWords(raw)
  for (const [id, ps] of Object.entries(vocab.phrases ?? {})) if (ps.some((p) => foldWords(p) === words)) scores.set(id, 4)

  const sid = shortIds([...world.minds, ...world.swarms].map((x) => x.id))
  const who = (x: Named, kind: 'mind' | 'swarm') => `${kind === 'mind' ? (x.swarm ? `in ${x.swarm}` : 'no swarm') : 'swarm'} · #${sid.get(x.id) ?? x.id.slice(-6)}`

  const out: Candidate[] = []
  // ---- looks first: "darker", "top bar", "switch to Still"
  out.push(...lookCandidates(raw, world))

  // ---- "delete the Forge swarm": opens its warning, never deletes (swarmDelete.ts)
  out.push(...deleteSwarmCandidates(raw, world))

  // ---- the hive map's own words: "show me Ada's hive", "zoom out", "tidy the hives" (view only; hiveMap.ts)
  out.push(...hiveMapCandidates(raw, world))

  // ---- Still's understanding, with a confidence and an effect for each suggestion
  for (const s of understand(raw, world) as Suggestion[]) {
    const act = s.act as IntentAct | undefined
    let confidence = 0
    if (s.limit) confidence = s.key.startsWith('limit-') ? 0.9 : 0
    else if (!act) confidence = 0
    else if (act.do === 'search') confidence = 0.3
    else if (act.do === 'feature') confidence = FEATURE_CONF[scores.get(act.id) ?? 0] ?? (act.id === 'swarms.launch' ? 0.9 : 0.6)
    else if (act.do === 'scroll') confidence = /^(what needs me|what's happening|what is happening)\??$/i.test(raw) ? 0.9 : 0.7
    else if (act.do === 'gallery') confidence = 0.9
    else if (act.do === 'open' || act.do === 'swarm') confidence = 0.92
    else if (CONSEQUENTIAL.has(act.do as never)) confidence = 0.9
    const c: Candidate = { ...s, act, effect: effectOf(act), confidence }

    // a feature that lives on one mind's or swarm's page needs its subject, unless this scope does it in place
    const kind = act?.do === 'feature' && !inPlace.has(act.id) ? scopeOf(act.id) : undefined
    if (act?.do === 'feature' && kind) {
      const f = featureById(act.id)!
      const list = kind === 'mind' ? world.minds : world.swarms
      const named = namedIn(raw, list)
      if (named.length === 1) {
        const x = named[0]
        const scopedAct: IntentAct = kind === 'mind' ? { do: 'scoped', id: act.id, mind: x.id } : { do: 'scoped', id: act.id, swarm: x.id }
        out.push({ ...c, key: `scoped-${act.id}-${x.id}`, act: scopedAct, effect: effectOf(scopedAct), parts: [{ t: f.label, em: true }, { t: ` for ` }, { t: x.name, em: true }, { t: ` (${who(x, kind)})`, who: true }] })
        continue
      }
      const pick = kind === 'swarm' && scope.swarm ? list.find((x) => x.id === scope.swarm) : undefined
      const choices = (named.length ? named : list).slice(0, 6)
      const chips: Chip[] = choices.map((x) => ({ key: x.id, label: x.name, who: who(x, kind), act: kind === 'mind' ? { do: 'scoped', id: act.id, mind: x.id } : { do: 'scoped', id: act.id, swarm: x.id } }))
      if (pick) chips.sort((a) => (a.key === pick.id ? -1 : 1))
      out.push({ ...c, clarify: { question: named.length > 1 ? `Which one? ${named.length} are called ${named[0].name}.` : kind === 'mind' ? `${f.label}: which mind?` : `${f.label}: which swarm?`, chips } })
      continue
    }
    // a page that can carry a swarm ("goals for Forge", or the swarm the page is about)
    if (act?.do === 'feature') {
      const f = featureById(act.id)
      const sw = namedIn(raw, world.swarms)
      if (f?.classic && sw.length === 1 && withSwarm(f.classic, sw[0].id) !== f.classic) {
        const route = withSwarm(f.classic, sw[0].id)
        out.push({ ...c, key: `route-${act.id}-${sw[0].id}`, act: { do: 'route', route, label: `${f.label} in ${sw[0].name}` }, effect: effectOf(act), parts: [{ t: f.label, em: true }, { t: ' in ' }, { t: sw[0].name, em: true }, { t: ` (${who(sw[0], 'swarm')})`, who: true }] })
        continue
      }
    }
    out.push(c)
  }

  // ---- apps by name: "open Truth", "Design"
  const appText = raw.replace(/^(please |)(open|show|launch|start|go to|take me to|use)\s+(the\s+)?/i, '')
  for (const app of world.apps ?? []) {
    const n = foldWords(app.name)
    const t = foldWords(appText)
    if (n && (t === n || t === `${n} app`)) {
      out.unshift({ key: `app-${app.id}`, tag: 'App', parts: [{ t: 'Open the ' }, { t: app.name, em: true }, { t: ' app' }], act: { do: 'route', route: { name: 'program', id: app.id }, label: app.name }, effect: 'view', confidence: 0.93 })
    }
  }

  // ---- an explicit search: "search for X", "find X"
  const search = raw.match(/^(?:search(?: for| everything for)?|find|look for)\s+(.{2,})$/i)
  if (search) out.push({ key: 'search-explicit', tag: 'Search', parts: [{ t: 'Search everything for ' }, { t: search[1], q: true }], act: { do: 'search', text: search[1] }, effect: 'view', confidence: 0.9 })

  // ---- what the feature list understood well but Still's verbs did not reach (any feature, any wording it scores)
  for (const [id, s] of scores) {
    if (s < 3 || out.some((c) => c.act && 'id' in c.act && c.act.id === id)) continue
    const f = featureById(id)!
    if (scopeOf(id) && !inPlace.has(id)) {
      // the subject was named: open it for that mind or swarm
      if (subject && subject.kind === scopeOf(id)) {
        const x = subject.x
        const act: IntentAct = subject.kind === 'mind' ? { do: 'scoped', id, mind: x.id } : { do: 'scoped', id, swarm: x.id }
        out.push({ key: `scoped-${id}-${x.id}`, tag: 'Open', parts: [{ t: f.label, em: true }, { t: ' for ' }, { t: x.name, em: true }, { t: ` (${who(x, subject.kind)})`, who: true }], act, effect: effectOf(act), confidence: FEATURE_CONF[s] })
      }
      continue
    }
    out.push({ key: `feature-${id}`, tag: 'Open', parts: [{ t: f.label, em: true }, { t: ` — ${f.blurb[0].toLowerCase()}${f.blurb.slice(1)}` }], act: { do: 'feature', id }, effect: effectOf({ do: 'feature', id }), confidence: FEATURE_CONF[s] })
  }

  const seen = new Set<string>()
  return out.filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true))).sort((a, b) => Number(!!b.choice) - Number(!!a.choice) || Number(b.limit && b.confidence > 0) - Number(a.limit && a.confidence > 0) || b.confidence - a.confidence)
}

/** The one row for a guided-demo request: a ready demo, a stub's honest answer, no demo for that, or the list. */
export function guideCandidate(g: GuideIntent, text: string): Candidate {
  const act: IntentAct = { do: 'guide', text }
  const base = { key: 'guide', tag: 'Demo', act, effect: 'view' as const, confidence: 0.97 }
  if (g.kind === 'list') return { ...base, parts: [{ t: 'List the guided demos' }] }
  if (g.kind === 'unknown') return { ...base, confidence: 0.9, parts: [{ t: 'No guided demo for ' }, { t: g.topic, q: true }, { t: ' yet: see the nearest ones' }] }
  if (g.script.status === 'stub') return { ...base, parts: [{ t: g.script.title, em: true }, { t: ': not built yet. Hear what exists today' }] }
  return { ...base, parts: [{ t: 'Guided demo: ' }, { t: g.script.title, em: true }, { t: ` (${plural(g.script.steps.length, 'step')})` }] }
}

/** The hand-off row: the words go, as typed, to the orchestrator the host resolves. */
export function mindCandidate(text: string, answerer: string | null): Candidate {
  return {
    key: 'mind',
    tag: 'Ask',
    parts: answerer ? [{ t: 'Ask ' }, { t: answerer, em: true }, { t: ': ' }, { t: text.trim(), q: true }] : [{ t: 'Ask the swarm’s orchestrator: ' }, { t: text.trim(), q: true }],
    act: { do: 'mind', text: text.trim() },
    effect: 'mind',
    confidence: 0,
  }
}

/** Every feature, for tests and the reach proof. */
export const ALL_FEATURE_IDS = FEATURES.map((f) => f.id)
