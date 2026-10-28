import { describe, expect, it } from 'vitest'
import { FEATURES } from '../features/registry'
import { coverageReport, NATIVE, navGaps, reach, REQUIRED_OWN } from './coverage'
import { ALL_EXPERIENCES } from './registry'

// every experience in the tree, offered by this build or not
const ids = ALL_EXPERIENCES.filter((e) => e.id !== 'classic').map((e) => e.id)
/** Each experience's own navigation (missing files are reported by name, not as an import error). */
const NAVS = import.meta.glob<{ NAV_FEATURES: string[] }>('./*/nav.ts', { eager: true })

describe('every experience covers everything in the hive', () => {
  it('feature ids are unique', () => {
    expect(new Set(FEATURES.map((f) => f.id)).size).toBe(FEATURES.length)
  })
  it('every experience declares its native coverage, naming only real features', () => {
    for (const e of ids) {
      expect(NATIVE[e], e).toBeDefined()
      for (const id of NATIVE[e]) expect(FEATURES.some((f) => f.id === id), `${e}: ${id}`).toBe(true)
    }
  })
  it('the core loop is native everywhere: see minds, talk, wake/sleep, decide, change UI', () => {
    for (const e of ids) for (const id of ['minds.see', 'minds.talk', 'minds.wake', 'decide.approvals', 'hive.changeui']) expect(reach(e, FEATURES.find((f) => f.id === id)!), `${e}: ${id}`).toBe('native')
  })
  it('every feature that has any UI is reachable in every experience', () => {
    for (const e of ids) for (const f of FEATURES) if (f.classic) expect(reach(e, f), `${e}: ${f.id}`).not.toBe('gap')
  })
  it('every experience reaches everything from its OWN navigation (experiences/<id>/nav.ts NAV_FEATURES, not via Ω)', () => {
    const missing: string[] = []
    for (const e of ids) {
      const nav = NAVS[`./${e}/nav.ts`]?.NAV_FEATURES ?? null
      if (!nav) {
        missing.push(`${e}: no experiences/${e}/nav.ts exporting NAV_FEATURES`)
        continue
      }
      for (const id of nav) if (!FEATURES.some((f) => f.id === id)) missing.push(`${e}: NAV_FEATURES names unknown feature ${id}`)
      const gaps = navGaps(nav)
      if (gaps.length) missing.push(`${e}: own navigation misses ${gaps.join(', ')}`)
    }
    expect(missing, missing.join('\n')).toEqual([])
  })
  it('creating a swarm and a mind, and the core loop, are in every experience\'s own navigation', () => {
    const missing: string[] = []
    for (const e of ids) {
      const nav = new Set(NAVS[`./${e}/nav.ts`]?.NAV_FEATURES ?? [])
      for (const id of REQUIRED_OWN) if (!nav.has(id)) missing.push(`${e}: ${id}`)
    }
    expect(missing, missing.join('\n')).toEqual([])
  })
  it('writes the coverage grid', async () => {
    const md = coverageReport(ids)
    const out = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.COVERAGE_REPORT
    if (out) {
      const fsName = 'node:fs'
      const fs = (await import(/* @vite-ignore */ fsName)) as { writeFileSync: (p: string, d: string) => void }
      fs.writeFileSync(out, `# Experience coverage\n\n${md}`)
    }
    expect(md).toContain('Decisions waiting on you')
  })
})
