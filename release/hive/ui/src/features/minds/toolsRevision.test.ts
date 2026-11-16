import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Agent } from '../../api/types'
import type { MindInventory } from './types'

// A tester opened a mind's Tools and its list's revision (sha256:…, one 71-character word) ran past the panel's edge.
// The inventory is the hive's answer as the page reads it; the health and activity reads stay loading. INVENTED mind.
const REV = 'sha256:cae251b4a8f9bb9ef7ff8647b3c4b23f339f9e90dadae46ba0c1d2e3f4a5b6c7'
const INV = {
  mind_id: 'a_pro', kind: 'omega', availability: 'boot-receipt', stale_reason: null, inventory_revision: REV, loaded_at: '2026-11-12T01:00:00Z',
  process: null, modules: [], core: null, skills: [], dynamic: [], dynamic_status: 'ok',
  provider: { model: 'stub/model', resolved_model: null, payer_kind: 'hive', budget_route: [], snapshot_at: '2026-11-12T01:00:00Z' }, snapshot_at: '2026-11-12T01:00:00Z',
} as unknown as MindInventory
vi.mock('../../lib/useResource', async (orig) => ({
  ...(await orig<typeof import('../../lib/useResource')>()),
  has: () => true,
  // the inventory read is the one keyed on the mind's status without polling (health polls, activity has no key)
  useResource: (_f: unknown, o?: { key?: unknown; poll?: number }) => (o?.key !== undefined && !o.poll ? { status: 'ready', data: INV, reload() {} } : { status: 'loading', reload() {} }),
}))
const { MindTools } = await import('./MindTools')

describe("a mind's Tools tab", () => {
  it('lets the list’s revision break inside its banner', () => {
    const html = renderToStaticMarkup(createElement(MindTools, { agent: { id: 'a_pro', name: 'Proponent', status: 'awake' } as Agent }))
    const at = html.indexOf(REV)
    expect(at).toBeGreaterThan(-1)
    // the element holding the revision carries a rule that lets a long word wrap
    const open = html.lastIndexOf('<', at)
    expect(html.slice(open, at)).toMatch(/overflow-wrap:anywhere|break-all/)
  })
})
