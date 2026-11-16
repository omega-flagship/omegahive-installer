import { createElement, lazy } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { useHive } from '../../store/store'
import { PresenceLazy } from '../../ui/PresenceLazy'
import { SwarmSheetSkeleton } from './SwarmSheetSkeleton'

/**
 * demo-polish r1 item 5: the swarm sheet opens at once. Its view is a lazy chunk; while it loads, the sheet shows a
 * frame with the swarm's name (SwarmSheetSkeleton, in the main bundle) instead of the bare map. Invented data only.
 */

// A server render reads a zustand store through its server snapshot (the initial state); read the live one instead
// (the same shim as forms/readability.test.ts).
vi.mock('zustand', async (orig) => {
  const z = await orig<typeof import('zustand')>()
  const build = (init: never) => {
    const api = z.createStore(init)
    ;(api as { getInitialState: unknown }).getInitialState = api.getState
    return Object.assign((sel?: never) => z.useStore(api, sel as never), api)
  }
  return { ...z, create: ((init?: never) => (init ? build(init) : build)) as never }
})

const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string }
const src = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')

// a view whose chunk never arrives (a cold, slow connection)
const NeverLoads = lazy(() => new Promise<{ default: () => null }>(() => undefined))

describe('item 5: the swarm sheet while its view loads', () => {
  it('shows the open sheet with the swarm name, busy, before the view arrives', () => {
    useHive.setState({ swarms: { s_inv: { id: 's_inv', name: 'Invented Lyre', hue: 220, member_ids: [], description: '', created_at: '2026-10-01T00:00:00Z' } } } as never)
    const html = renderToStaticMarkup(createElement(PresenceLazy, { fallback: createElement(SwarmSheetSkeleton, { id: 's_inv' }), children: createElement(NeverLoads) }))
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-label="Invented Lyre swarm"')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('Invented Lyre</h1>')
  })

  it('a lazy view without a fallback still shows nothing while it loads (unchanged for other pages)', () => {
    expect(renderToStaticMarkup(createElement(PresenceLazy, { children: createElement(NeverLoads) }))).toBe('')
  })

  it('App gives the swarm route the loading frame, and the Swarms page warms the sheet ahead of a click', () => {
    const app = src('../../App.tsx')
    expect(app).toMatch(/<Lazy key=\{`swarm-\$\{route\.id\}`\} fallback=\{<SwarmSheetSkeleton id=\{route\.id\} \/>\}>/)
    const index = src('./SwarmsIndex.tsx')
    expect(index).toMatch(/useEffect\(\(\) => warmSwarmView\(\), \[\]\)/)
    // the cards are composed by MeTTa now: the frame around them warms the sheet when a card is hovered or focused
    expect(index).toMatch(/onPointerOver=\{warmSwarmView\} onFocus=\{warmSwarmView\}/)
  })
})
