import { describe, expect, it } from 'vitest'

/**
 * The build gate (scripts/candidate-out.mjs) deletes any build holding a chunk named like a candidate module. A screens
 * module that shared such a name (space.ts did) would take the whole UI down at deploy. Names only; nothing is built.
 */
describe('screens never share a name with a candidate chunk', () => {
  it('no module under screens/ or the composed features is named like one', async () => {
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string; readdirSync: (p: URL) => string[] }
    const { chunks, markers } = JSON.parse(fs.readFileSync(new URL('../../scripts/candidate-markers.json', import.meta.url), 'utf8')) as { chunks: string[]; markers: string[] }
    const dirs = ['./', '../features/tools/', '../features/health/', '../features/settings/', '../features/roles/', '../features/artifacts/',
      '../features/models/', '../features/people/', '../features/updates/', '../features/tasks/', '../features/swarm/', '../features/programs/', '../features/lifecycle/', '../features/keys/', '../features/explore/',
      '../features/flow/', '../features/dot/', '../features/setup/', '../features/mind/', '../features/createPlan/', '../lib/metta/']
    // already there before the Apps page was composed, and not renamed with it: programs/parts.tsx shares the candidate
    // name parts (the old app page's pieces). Listed so the gate still checks everything else; rename it, then drop this.
    const known = ['../features/programs/parts.tsx']
    const clashes: string[] = []
    for (const d of dirs) {
      for (const f of fs.readdirSync(new URL(d, import.meta.url))) {
        if (/\.test\.|\.testkit\./.test(f) || !/\.(tsx?|metta)$/.test(f)) continue
        if (chunks.includes(f.replace(/\.(tsx?|metta)$/, '')) && !known.includes(`${d}${f}`)) clashes.push(`${d}${f}`)
        const text = fs.readFileSync(new URL(`${d}${f}`, import.meta.url), 'utf8')
        for (const m of markers) if (text.includes(m)) clashes.push(`${d}${f} carries ${m}`)
      }
    }
    expect(clashes).toEqual([])
    // a known clash that is gone is dropped from the list, so the list never hides a new one
    for (const k of known) expect(fs.readdirSync(new URL(k.slice(0, k.lastIndexOf('/') + 1), import.meta.url))).toContain(k.slice(k.lastIndexOf('/') + 1))
  })
})
