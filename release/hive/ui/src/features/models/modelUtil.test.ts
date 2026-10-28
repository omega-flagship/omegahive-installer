import { describe, expect, it } from 'vitest'
import type { CatalogModel, ModelOption } from '../../api/types'
import { buildRows, contextLabel, priceLabel, routeSummary, searchRows } from './modelUtil'

const models: ModelOption[] = [
  { id: 'mock/echo', provider: 'mock', label: 'echo', local: true },
  { id: 'openrouter/anthropic/claude-sonnet-5.5', provider: 'openrouter', label: 'anthropic/claude-sonnet-5.5', local: false },
]
const catalog: CatalogModel[] = [
  { id: 'anthropic/claude-sonnet-5.5', name: 'Anthropic: Claude Sonnet 5.5', description: '', context_length: 1_000_000, in_per_m: 3, out_per_m: 15, inputs: ['text', 'image'], outputs: ['text'], tools: true, reasoning: true },
  { id: 'meta-llama/llama-4:free', name: 'Meta: Llama 4 (free)', description: '', context_length: 131_072, in_per_m: 0, out_per_m: 0, inputs: ['text'], outputs: ['text'], tools: false, reasoning: false },
  { id: 'qwen/qwen3.5-coder', name: 'Qwen: Qwen3.5 Coder', description: '', context_length: 262_144, in_per_m: 0.3, out_per_m: 1.2, inputs: ['text'], outputs: ['text'], tools: true, reasoning: false },
]

describe('model picker rows', () => {
  it('merges featured models with the catalogue without duplicates and keeps catalogue prices', () => {
    const rows = buildRows(models, catalog)
    expect(rows.map((r) => r.id)).toEqual(['mock/echo', 'openrouter/anthropic/claude-sonnet-5.5', 'openrouter/meta-llama/llama-4:free', 'openrouter/qwen/qwen3.5-coder'])
    const sonnet = rows[1]
    expect(sonnet.featured).toBe(true)
    expect(sonnet.inPerM).toBe(3)
    expect(sonnet.name).toBe('Anthropic: Claude Sonnet 5.5')
    expect(rows[0].inPerM).toBe(0)
  })

  it('searches by text and by flag words', () => {
    const rows = buildRows(models, catalog)
    expect(searchRows(rows, 'sonnet', null).map((r) => r.short)).toEqual(['anthropic/claude-sonnet-5.5'])
    expect(searchRows(rows, 'free', null).map((r) => r.short)).toEqual(['echo', 'meta-llama/llama-4:free'])
    expect(searchRows(rows, 'vision', 'openrouter').map((r) => r.short)).toEqual(['anthropic/claude-sonnet-5.5'])
    expect(searchRows(rows, 'coder tools', null).map((r) => r.short)).toEqual(['qwen/qwen3.5-coder'])
    expect(searchRows(rows, 'zzzz', null)).toEqual([])
  })

  it('puts featured models first when nothing is typed', () => {
    const rows = buildRows(models, catalog)
    const all = searchRows(rows, '', 'openrouter')
    expect(all[0].featured).toBe(true)
    expect(all.slice(1).every((r) => !r.featured)).toBe(true)
  })

  it('formats context, price and routing', () => {
    expect(contextLabel(1_000_000)).toBe('1M ctx')
    expect(contextLabel(200_000)).toBe('200k ctx')
    expect(priceLabel(3, 15)).toBe('$3 / $15 per M')
    expect(priceLabel(0.3, 1.2)).toBe('$0.30 / $1.20 per M')
    expect(priceLabel(0, 0)).toBe('free')
    expect(priceLabel(null, null)).toBe('no price')
    expect(routeSummary(undefined)).toBe('OpenRouter picks')
    expect(routeSummary({ route: { order: ['anthropic'], allow_fallbacks: false } })).toBe('anthropic only')
    expect(routeSummary({ route: { order: ['anthropic', 'google'] } })).toBe('anthropic, then google, then others')
  })
})
