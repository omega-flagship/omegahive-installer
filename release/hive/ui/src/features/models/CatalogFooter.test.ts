import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Catalog } from '../../api/types'
import { CatalogFooter } from './CatalogFooter'

const model = { id: 'x/y', name: 'Y', description: '', context_length: 1000, in_per_m: null, out_per_m: null, inputs: [], outputs: [], tools: false, reasoning: false }
const html = (catalog: Catalog) => renderToStaticMarkup(createElement(CatalogFooter, { catalog, loading: false, onRefresh: () => {} }))

describe('CatalogFooter (keyview R12, sol on 81359cdf)', () => {
  it('an off-route member: the count only, no age and no Refresh', () => {
    const out = html({ models: [model], fetched_at: null, error: null, can_refresh: false })
    expect(out).toContain('1 OpenRouter models')
    expect(out).not.toContain('prices')
    expect(out).not.toContain('Invalid')
    expect(out).not.toContain('Refresh')
  })
  it('an older host that says nothing about refreshing: no Refresh', () => {
    expect(html({ models: [model], fetched_at: null, error: null })).not.toContain('Refresh')
  })
  it('someone on the default route: the age and Refresh', () => {
    const out = html({ models: [model], fetched_at: Date.now() / 1000 - 120, error: null, can_refresh: true })
    expect(out).toContain('prices')
    expect(out).toContain('Refresh')
  })
})
