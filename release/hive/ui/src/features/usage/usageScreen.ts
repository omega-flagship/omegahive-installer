// Purpose: what the Usage screen (usage.metta) is told about the signed-in person's own month and about the spend and tokens over time by mind or model, with the part still an estimate marked, and the whole screen's data and facts joined from its parts (the held calls and limits state theirs in heldCallsScreen.ts and limitsScreen.ts). Pure: the lists, the names, the clock and the page's choices come in as arguments.
import type { AgentStatus, MySpendSummary, Usage } from '../../api/types'
import { shown } from '../../lib/displayName'
import { compact, money } from '../../lib/format'
import { SIM_COST_NOTE } from '../../lib/sim'
import { withResource, type ResourceLike } from '../../screens/resourceFacts'
import type { ScreenFacts } from '../../screens/screenSpace'
import { meterParts } from './limitsScreen'
import { ESTIMATE_WORDS } from './settle'

/** What a screen's part is told: its values, bound by path, and this moment's facts. */
export interface Composed { data: Record<string, unknown>; facts: ScreenFacts }

/** The screen's parts told as one: their data and their facts side by side (each part's names are its own). */
export function joinScreens(...parts: Composed[]): Composed {
  const out = { data: {} as Record<string, unknown>, facts: { counts: {} as Record<string, number>, flags: {} as Record<string, boolean>, values: {} as Record<string, string> } }
  for (const p of parts) {
    Object.assign(out.data, p.data)
    Object.assign(out.facts.counts, p.facts.counts)
    Object.assign(out.facts.flags, p.facts.flags)
    Object.assign(out.facts.values, p.facts.values)
  }
  return out
}

/** Below this share of the allowance left, counting what is held, the allowance is running low (Your spend says so). */
const LOW_SHARE = 0.2

/**
 * The person's own month from GET /api/usage/me, as the resource named mine: what the hive paid for them against their
 * allowance, with what is held, what their own keys paid, and where it went. Jon (2026-10-04): personalised costs,
 * $50/month per family member, then own keys.
 */
export function mySpendScreen(res: ResourceLike & { data?: MySpendSummary }): Composed {
  const me = res.data
  const allowance = me?.allowance_usd ?? null
  const held = me?.held_usd ?? 0
  const low = me !== undefined && allowance !== null && me.remaining_usd !== null && me.remaining_usd - held < allowance * LOW_SHARE
  return withResource(res, {
    data: me ? {
      'mine.summary': `$${me.hive_paid_usd.toFixed(2)}${allowance !== null ? ` of your $${allowance.toFixed(0)} allowance` : ' (no allowance cap)'}`
        + `${allowance !== null && held > 0 ? `, with $${held.toFixed(2)} held for calls not yet settled` : ''}`
        + `${me.own_keys_usd > 0 ? ` · $${me.own_keys_usd.toFixed(2)} on your own keys` : ''}`,
      'mine.parts': allowance !== null ? meterParts(me.hive_paid_usd, held, allowance) : [],
      'mine.mostly': me.by_mind.slice(0, 4).map((m) => `${shown(m.name)} $${m.cost_usd.toFixed(2)}`).join(' · '),
      'mine.key.words': `${low ? 'Your allowance is running low. ' : ''}Add your own AI key to work without an allowance limit; it is used only for your minds and sessions.`,
    } : {},
    facts: {
      flags: { 'mine.allowance': allowance !== null, 'mine.low': low },
      counts: { 'mine.minds': me?.by_mind.length ?? 0, 'mine.own-keys': me?.own_keys ?? 0 },
    },
  }, 'mine')
}

export type Range = '24h' | '7d' | '30d'
export type Group = 'agent' | 'model'
export type View = 'chart' | 'table'

/** Each range: how long it is, how wide one column is, and its words. */
export const RANGES: Record<Range, { ms: number; bucket: number; label: string }> = {
  '24h': { ms: 86_400_000, bucket: 3_600_000, label: 'last 24 hours' },
  '7d': { ms: 7 * 86_400_000, bucket: 86_400_000, label: 'last 7 days' },
  '30d': { ms: 30 * 86_400_000, bucket: 86_400_000, label: 'last 30 days' },
}

/**
 * Categorical slots: the dataviz reference palette's dark steps, validated with validate_palette.js against the spend
 * view's surface (#12132a): all checks pass. Slots go by all-time spend, so a colour follows its mind or model, never the
 * range.
 */
const SLOTS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9']
const OTHER = '#5f5e7c'
const OTHER_KEY = '__other'
const BAR = '#3987e5'

/** A round top for the y axis and the ticks up to it: 1, 2, 2.5 or 5 times a power of ten, at most four steps. */
export function niceMax(v: number): { max: number; ticks: number[] } {
  if (v <= 0) return { max: 1, ticks: [0, 0.5, 1] }
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  let step = exp
  for (const s of [1, 2, 2.5, 5, 10]) {
    step = (s * exp) / 2
    if (v / step <= 4) break
  }
  const max = Math.ceil(v / step) * step
  const ticks: number[] = []
  for (let t = 0; t <= max + 1e-9; t += step) ticks.push(t)
  return { max, ticks }
}

const tickMoney = (n: number) => (n === 0 ? '$0' : n < 1 ? `$${n.toFixed(2)}` : n < 10 ? `$${n.toFixed(1)}` : `$${Math.round(n)}`)
/** A change against the period before, or none when there was nothing before. */
const pctDelta = (cur: number, prev: number): number | null => (prev ? (cur - prev) / prev : null)
const change = (d: number | null, upIsGood = true) =>
  d === null ? {} : { delta: `${Math.abs(d * 100).toFixed(0)}%`, delta_dir: d >= 0 ? 'up' : 'down', delta_tone: (d >= 0) === upIsGood ? 'good' : 'bad', delta_note: 'vs previous' }

export interface SpendInput {
  /** every metered call read, oldest first */
  usage: Usage[]
  range: Range
  group: Group
  view: View
  now: number
  /** a mind's or a model's name, for the grouping */
  name: (key: string) => string
  /** a mind, for its orb and its cap on the bars (grouped by mind only) */
  mind: (id: string) => { hue: number; status: AgentStatus; budget_usd: number } | undefined
  /** the simulator's made-up costs: every dollar figure is marked */
  sim: boolean
}

/**
 * The spend and tokens over time, as the resource named spend: the key figures against the range before, the columns
 * stacked by mind or model, spend and tokens per mind or model, and the same as a table. Time: u + c·s, u calls read, c
 * columns in the range, s series.
 */
export function spendScreen(res: ResourceLike, input: SpendInput): Composed {
  const { usage, range, group, view, now, name, sim } = input
  const keyOf = (u: Usage) => (group === 'agent' ? u.agent_id : u.model)
  // stable colour slots: by all-time spend for the grouping
  const all = new Map<string, number>()
  for (const u of usage) all.set(keyOf(u), (all.get(keyOf(u)) ?? 0) + u.cost_usd)
  const slot = new Map<string, number>()
  ;[...all.entries()].sort((a, b) => b[1] - a[1]).slice(0, SLOTS.length).forEach(([k], i) => slot.set(k, i))
  const colorOf = (k: string) => (k === OTHER_KEY ? OTHER : SLOTS[slot.get(k) ?? 0])
  const labelOf = (k: string) => (k === OTHER_KEY ? 'Other' : name(k))

  const { ms, bucket, label } = RANGES[range]
  const end = Math.ceil(now / bucket) * bucket
  const start = end - ms
  const prevStart = start - ms
  const n = Math.round(ms / bucket)
  const cols = Array.from({ length: n }, (_, i) => ({ t: start + i * bucket, v: new Map<string, number>(), total: 0 }))
  const byEntity = new Map<string, { cost: number; req: number; pt: number; ct: number; est: number }>()
  let [cost, est, req, tokens, prevCost, prevReq, prevTokens] = [0, 0, 0, 0, 0, 0, 0]
  for (const u of usage) {
    const t = Date.parse(u.created_at)
    if (t >= prevStart && t < start) {
      prevCost += u.cost_usd
      prevReq++
      prevTokens += u.prompt_tokens + u.completion_tokens
    }
    if (t < start || t >= end) continue
    const k = keyOf(u)
    const sk = slot.has(k) ? k : OTHER_KEY
    const col = cols[Math.min(n - 1, Math.floor((t - start) / bucket))]
    col.v.set(sk, (col.v.get(sk) ?? 0) + u.cost_usd)
    col.total += u.cost_usd
    const e = byEntity.get(k) ?? { cost: 0, req: 0, pt: 0, ct: 0, est: 0 }
    e.cost += u.cost_usd
    if (u.estimated) e.est += u.cost_usd
    e.req++
    e.pt += u.prompt_tokens
    e.ct += u.completion_tokens
    byEntity.set(k, e)
    cost += u.cost_usd
    if (u.estimated) est += u.cost_usd
    req++
    tokens += u.prompt_tokens + u.completion_tokens
  }
  const series = [...slot.keys(), ...(cols.some((c) => c.v.has(OTHER_KEY)) ? [OTHER_KEY] : [])]
  const entities = [...byEntity.entries()].map(([k, v]) => ({ k, ...v })).sort((a, b) => b.cost - a.cost)
  const axis = niceMax(Math.max(...cols.map((c) => c.total)))
  const x = (t: number) => (range === '24h' ? new Date(t).toLocaleTimeString([], { hour: '2-digit' }) : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }))
  const by = group === 'agent' ? 'by mind' : 'by model'
  const chip = sim ? { chip: 'sim', chip_title: SIM_COST_NOTE, chip_aria: 'simulated' } : {}

  return withResource(res, {
    data: {
      'spend.range': range,
      'spend.group': group,
      'spend.view': view,
      'spend.range.words': label,
      'spend.figures': [
        { id: 'spend', label: `Spend · ${label}`, value: money(cost), hero: true, ...chip,
          ...(est > 0 ? { note: `includes ${money(est)} estimated`, note_title: ESTIMATE_WORDS } : {}), ...change(pctDelta(cost, prevCost), false) },
        { id: 'requests', label: 'Requests', value: compact(req), ...change(pctDelta(req, prevReq)) },
        { id: 'tokens', label: 'Tokens', value: compact(tokens), ...change(pctDelta(tokens, prevTokens)) },
        { id: 'avg', label: 'Avg / request', value: req ? money(cost / req) : '$0', ...chip },
      ],
      'spend.columns': cols.map((c) => ({
        id: String(c.t), x: x(c.t), total: c.total, total_words: money(c.total), aria: `${x(c.t)}: ${money(c.total)}`,
        at: new Date(c.t).toLocaleString([], { month: 'short', day: 'numeric', hour: range === '30d' ? undefined : '2-digit' }),
        parts: series.filter((k) => (c.v.get(k) ?? 0) > 0).map((k) => ({ key: k, n: c.v.get(k)!, words: money(c.v.get(k)!) })),
      })),
      'spend.series': series.map((k) => ({ key: k, label: labelOf(k), color: colorOf(k) })),
      'spend.axis': { max: axis.max, ticks: axis.ticks.map((t) => ({ n: t, words: tickMoney(t) })) },
      'spend.chart.title': `Spend over time, ${by}`,
      'spend.chart.subtitle': `Per ${bucket >= 86_400_000 ? 'day' : bucket >= 6 * 3_600_000 ? '6 hours' : 'hour'}, US dollars`,
      'spend.bars': entities.slice(0, 12).map((r) => {
        const m = group === 'agent' ? input.mind(r.k) : undefined
        return {
          id: r.k, label: name(r.k), value: money(r.cost), parts: [{ key: 'cost', n: r.cost, color: BAR }],
          ...(m ? { orb: m.hue, status: m.status } : {}),
          detail: [`${r.req} requests`, `${compact(r.pt + r.ct)} tokens`, ...(r.est > 0 ? [`${money(r.est)} estimated`] : []), ...(m && m.budget_usd > 0 ? [`cap ${money(m.budget_usd)}`] : [])].join(' · '),
          aria: `${name(r.k)}: ${money(r.cost)}, ${r.req} requests`,
        }
      }),
      'spend.bars.title': group === 'agent' ? 'Spend by mind' : 'Spend by model',
      'spend.bars.subtitle': `${label}, US dollars`,
      'spend.tokens': entities.slice(0, 8).map((r) => ({
        id: r.k, label: name(r.k), value: compact(r.pt + r.ct), aria: `${name(r.k)}: ${r.pt} prompt, ${r.ct} completion tokens`,
        parts: [{ key: 'pt', n: r.pt, color: SLOTS[0] }, { key: 'ct', n: r.ct, color: SLOTS[1] }],
      })),
      'spend.tokens.subtitle': `Prompt vs completion, ${label}`,
      'spend.tokens.legend': [{ key: 'pt', label: 'Prompt', color: SLOTS[0] }, { key: 'ct', label: 'Completion', color: SLOTS[1] }],
      'spend.rows': entities.map((r) => ({
        id: r.k, name: name(r.k), requests: r.req.toLocaleString(), prompt: r.pt.toLocaleString(), completion: r.ct.toLocaleString(), spend: money(r.cost),
        share: cost ? `${((r.cost / cost) * 100).toFixed(1)}%` : '—',
        ...(r.est > 0 ? { mark: 'estimated', mark_title: `${money(r.est)} of this is estimated. ${ESTIMATE_WORDS}` } : {}),
      })),
      'spend.noun': group === 'agent' ? 'Mind' : 'Model',
      'spend.caption': `Usage ${by}`,
      'sim.note': SIM_COST_NOTE,
      'sim.chip': sim ? 'simulated' : '',
    },
    facts: { values: { 'spend.view': view }, flags: { 'spend.any': req > 0 || prevReq > 0, sim } },
  }, 'spend')
}
