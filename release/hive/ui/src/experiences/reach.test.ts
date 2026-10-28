import { describe, expect, it, vi } from 'vitest'

// record where each feature really goes, instead of trusting its declared route (Review B1/B2)
const went: unknown[] = []
vi.mock('../lib/router', async (orig) => ({ ...(await orig<typeof import('../lib/router')>()), navigate: (r: unknown) => void went.push(r) }))
vi.mock('../shell/uiVariant', () => ({ openGallery: () => void went.push('action:changeui') }))
vi.mock('../tour/introStore', () => ({ useIntro: { getState: () => ({ setHelp: () => void went.push('action:help') }) } }))
vi.mock('../store/store', () => ({ useHive: { getState: () => ({ setPalette: () => void went.push('action:search'), setStopAll: () => void went.push('action:stopall') }) } }))

const { FEATURES } = await import('../features/registry')
const { AUDIT_ROWS } = await import('../features/auditMap')
const { openFeature, targetFor } = await import('./targets')

const f = (id: string) => FEATURES.find((x) => x.id === id)!

describe('every audit capability is in the registry (Review B2)', () => {
  it('all 49 audit rows are mapped to real features, Vocabulary included', () => {
    for (let row = 1; row <= 49; row++) {
      const m = AUDIT_ROWS[row]
      expect(m, `row ${row}`).toBeDefined()
      if (m !== 'not-person-facing') for (const id of m) expect(FEATURES.some((x) => x.id === id), `row ${row}: ${id}`).toBe(true)
    }
    expect(targetFor(f('swarms.vocabulary'))).toEqual({ kind: 'swarm', tab: 'vocab' })
  })
})

describe('every feature opens a real destination, not the bare hive (Review B1)', () => {
  it('no feature resolves to the experience home except seeing the hive itself and live activity', () => {
    const home = FEATURES.filter((x) => targetFor(x)?.kind === 'home').map((x) => x.id).sort()
    expect(home).toEqual(['minds.see', 'watch.activity'])
  })

  it.each([
    ['minds.memory', 'memory'],
    ['minds.schedule', 'schedule'],
    ['minds.model', 'model'],
    ['minds.traces', 'mind'],
    ['minds.shares', 'memory'],
    ['minds.inventory', 'model'],
  ])('%s asks which mind, then opens its %s tab', (id, tab) => {
    went.length = 0
    expect(openFeature(f(id))).toBe(false) // without a mind it must ask, not pretend
    expect(went).toEqual([])
    expect(openFeature(f(id), 'a_vega')).toBe(true)
    expect(went).toEqual([{ name: 'dot', id: 'a_vega', tab }])
  })

  it.each([
    ['swarms.vocabulary', { name: 'swarm', id: 's_lyra', tab: 'vocab' }],
    ['swarms.edit', { name: 'swarm', id: 's_lyra', tab: 'settings' }],
    ['swarms.services', { name: 'swarm', id: 's_lyra', tab: 'connections' }],
    ['swarms.requests', { name: 'swarm', id: 's_lyra', tab: 'requests' }],
    ['swarms.connections', { name: 'swarm', id: 's_lyra', tab: 'connections' }],
    ['swarms.beliefs', { name: 'swarm', id: 's_lyra', tab: 'commons' }],
    ['swarms.lifecycle', { name: 'lifecycle', swarm: 's_lyra' }],
  ])('%s asks which swarm, then opens the right place', (id, route) => {
    went.length = 0
    expect(openFeature(f(id))).toBe(false)
    expect(openFeature(f(id), undefined, 's_lyra')).toBe(true)
    expect(went).toEqual([route])
  })

  it.each([
    ['hive.help', 'action:help'],
    ['hive.search', 'action:search'],
    ['hive.changeui', 'action:changeui'],
    ['decide.stopall', 'action:stopall'],
  ])('%s runs its host action', (id, action) => {
    went.length = 0
    expect(openFeature(f(id))).toBe(true)
    expect(went).toEqual([action])
  })

  it('a page feature opens its page route', () => {
    went.length = 0
    expect(openFeature(f('work.goals'))).toBe(true)
    expect(went).toEqual([{ name: 'tasks' }])
  })
})
