import type { AgentOptions, CatalogModel, ModelOption, ProviderStatus } from '../../api/types'
import { fuzzy } from '../../lib/fuzzy'

/** One row of the picker: a featured model from /api/models, or an OpenRouter catalogue entry. */
export interface PickRow {
  id: string
  provider: string
  name: string
  /** The part after the provider prefix, e.g. "anthropic/claude-sonnet-5.5". */
  short: string
  local: boolean
  featured: boolean
  inPerM: number | null
  outPerM: number | null
  context: number
  inputs: string[]
  tools: boolean
  reasoning: boolean
  description: string
}

export const PROVIDER_LABEL: Record<string, string> = { openrouter: 'OpenRouter', anthropic: 'Anthropic', openai: 'OpenAI', local: 'Local', ollama: 'Local', mock: 'Offline' }

export const providerLabel = (name: string, providers?: ProviderStatus[] | null) =>
  providers?.find((p) => p.name === name)?.label ?? PROVIDER_LABEL[name] ?? name.charAt(0).toUpperCase() + name.slice(1)

export function prettyName(id: string): string {
  const short = id.split('/').slice(1).join('/') || id
  return short
    .replace(/[-_]/g, ' ')
    .replace(/\b(\d+)\s(\d+)\b/g, '$1.$2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bGpt\b/g, 'GPT')
    .replace(/\bGlm\b/g, 'GLM')
}

/** Merge the hive's featured list with the OpenRouter catalogue into one de-duplicated list. */
export function buildRows(models: ModelOption[], catalog: CatalogModel[] | null | undefined): PickRow[] {
  const rows = new Map<string, PickRow>()
  const byCatalog = new Map((catalog ?? []).map((m) => [m.id, m]))
  for (const m of models) {
    const short = m.id.split('/').slice(1).join('/')
    const cat = m.provider === 'openrouter' ? byCatalog.get(short) : undefined
    rows.set(m.id, {
      id: m.id,
      provider: m.provider,
      name: cat?.name ?? (m.provider === 'openrouter' ? prettyName(m.id) : m.label === short ? prettyName(m.id) : m.label),
      short,
      local: m.local,
      featured: true,
      inPerM: cat?.in_per_m ?? (m.local ? 0 : null),
      outPerM: cat?.out_per_m ?? (m.local ? 0 : null),
      context: cat?.context_length ?? 0,
      inputs: cat?.inputs ?? ['text'],
      tools: cat?.tools ?? true,
      reasoning: cat?.reasoning ?? false,
      description: cat?.description ?? '',
    })
  }
  for (const c of catalog ?? []) {
    const id = `openrouter/${c.id}`
    if (rows.has(id)) continue
    rows.set(id, {
      id,
      provider: 'openrouter',
      name: c.name,
      short: c.id,
      local: false,
      featured: false,
      inPerM: c.in_per_m,
      outPerM: c.out_per_m,
      context: c.context_length,
      inputs: c.inputs,
      tools: c.tools,
      reasoning: c.reasoning,
      description: c.description,
    })
  }
  return [...rows.values()]
}

const FLAGS: Record<string, (r: PickRow) => boolean> = {
  free: (r) => r.inPerM === 0 && r.outPerM === 0,
  vision: (r) => r.inputs.includes('image'),
  image: (r) => r.inputs.includes('image'),
  tools: (r) => r.tools,
  reasoning: (r) => r.reasoning,
  thinking: (r) => r.reasoning,
  local: (r) => r.local,
  cheap: (r) => r.inPerM != null && r.inPerM <= 1,
}

/**
 * Search: words that name a flag (free, vision, tools, reasoning, local, cheap) filter; the rest
 * fuzzy-match name and id. Featured models and better matches come first.
 */
export function searchRows(rows: PickRow[], query: string, provider: string | null): PickRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const flags = words.filter((w) => w in FLAGS)
  const text = words.filter((w) => !(w in FLAGS)).join(' ')
  const scored: { row: PickRow; score: number }[] = []
  for (const row of rows) {
    if (provider && row.provider !== provider) continue
    if (!flags.every((f) => FLAGS[f](row))) continue
    let score = 1
    if (text) {
      score = Math.max(fuzzy(text, row.name), fuzzy(text, row.short) * 0.9, fuzzy(text, row.id) * 0.8)
      if (!score) continue
    }
    scored.push({ row, score: score + (row.featured ? 0.5 : 0) })
  }
  scored.sort((a, b) => b.score - a.score || Number(b.row.featured) - Number(a.row.featured) || a.row.name.localeCompare(b.row.name))
  return scored.map((s) => s.row)
}

export function contextLabel(n: number): string {
  if (!n) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M ctx`
  return `${Math.round(n / 1000)}k ctx`
}

export function priceLabel(inPerM: number | null, outPerM: number | null): string {
  if (inPerM == null || outPerM == null) return 'no price'
  if (inPerM === 0 && outPerM === 0) return 'free'
  const f = (n: number) => (n >= 10 ? `$${Math.round(n)}` : n >= 1 ? `$${n.toFixed(n % 1 ? 2 : 0)}` : `$${n.toFixed(2)}`)
  return `${f(inPerM)} / ${f(outPerM)} per M`
}

/** A one-line summary of a mind's routing, for the create review and the mind panel. */
export function routeSummary(options: AgentOptions | undefined, endpointsLabel?: (tag: string) => string): string {
  const route = options?.route
  if (!route?.order?.length) return route?.sort ? `cheapest first` : 'OpenRouter picks'
  const names = route.order.map((t) => endpointsLabel?.(t) ?? t)
  return `${names.join(', then ')}${route.allow_fallbacks === false ? ' only' : ', then others'}`
}

export const DEFAULT_MODEL_KEY = 'omegadots.defaultModel'

export function readDefaultModel(): { model: string; options?: AgentOptions } | null {
  try {
    const raw = localStorage.getItem(DEFAULT_MODEL_KEY)
    return raw ? (JSON.parse(raw) as { model: string; options?: AgentOptions }) : null
  } catch {
    return null
  }
}

export function writeDefaultModel(value: { model: string; options?: AgentOptions } | null): void {
  try {
    if (value) localStorage.setItem(DEFAULT_MODEL_KEY, JSON.stringify(value))
    else localStorage.removeItem(DEFAULT_MODEL_KEY)
  } catch {
    /* storage unavailable */
  }
}
