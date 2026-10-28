import { describe, expect, it } from 'vitest'
import viteConfig from '../../../vite.config.ts?raw'

/**
 * followups-r5 item 8, bounded in r6: the sim-heavy files boot the simulator (and its MeTTa engine) cold, and timed out
 * on an 8 GB Mac under load with their short fixed timeouts. Each sets about 3x its worst case MEASURED under load
 * (`worst`, ms: r5's two lifted-cap passes, 3 workers, load 9-11; missingUi.r5 re-measured in r6, hook included).
 * Floor AND ceiling: a value under 2.5x the worst times out under load again; one over 4x the worst would let a real hang
 * run for minutes. Every test file that sets its own timeouts must be listed here, so none escapes the bound.
 * Note: a file's `vi.setConfig` overrides the CLI's `--testTimeout` for that file, so a "60 s" full run is not a 60 s
 * cap everywhere; these bounds are what limits those files.
 * followups-r8 (P3): two files outside api/sim (named by their path under src), measured with six other heavy files in
 * parallel at load 7-8.5: approvalAnswers (its first test pays the cold transform) and dualP2 (a fresh simulated hive
 * per test).
 */
const MEASURED: Record<string, { worst: number; hookWorst?: number }> = {
  'agreements.test.ts': { worst: 14189 },
  'commons.parity.test.ts': { worst: 12373 },
  'demo.test.ts': { worst: 19534 },
  'demo3.test.ts': { worst: 54351 },
  'missingUi.r5.test.ts': { worst: 32564, hookWorst: 31587 },
  'phase2.test.ts': { worst: 36948 },
  'programs.test.ts': { worst: 17607 },
  'requestK.test.ts': { worst: 13408 },
  'sim.test.ts': { worst: 26606 },
  'experiences/approvalAnswers.test.ts': { worst: 7750 },
  'experiences/dualP2.test.ts': { worst: 26153 },
}
/** a name is a file in api/sim; a path (with a slash) is a file under src */
const pathOf = (file: string) => (file.includes('/') ? `/src/${file}` : `/src/api/sim/${file}`)
const FLOOR = 2.5
const CEILING = 4

const TESTS = import.meta.glob<string>(['/src/**/*.test.ts'], { query: '?raw', import: 'default', eager: true })
const SET_CONFIG = /vi\.setConfig\(\{ testTimeout: (\d+)(?:, hookTimeout: (\d+))? \}\)/
const SELF = '/src/api/sim/simTimeouts.test.ts'

describe('sim-heavy test files keep measured per-file timeouts, bounded both ways', () => {
  for (const [file, m] of Object.entries(MEASURED)) {
    it(`${file}: testTimeout within ${FLOOR}x-${CEILING}x of ${m.worst} ms${m.hookWorst ? `, hookTimeout of ${m.hookWorst} ms` : ''}`, () => {
      const src = TESTS[pathOf(file)]
      expect(src, file).toBeDefined()
      const got = src.match(SET_CONFIG)
      expect(got).not.toBeNull()
      const test = Number(got![1])
      expect(test).toBeGreaterThanOrEqual(FLOOR * m.worst)
      expect(test).toBeLessThanOrEqual(CEILING * m.worst)
      if (m.hookWorst) {
        const hook = Number(got![2] ?? 0)
        expect(hook).toBeGreaterThanOrEqual(FLOOR * m.hookWorst)
        expect(hook).toBeLessThanOrEqual(CEILING * m.hookWorst)
      } else {
        expect(got![2], 'a hook timeout needs a measured hook').toBeUndefined()
      }
    })
  }
  it('no other test file sets its own timeouts (each one must be measured and bounded above)', () => {
    const setters = Object.entries(TESTS).filter(([f, src]) => f !== SELF && /vi\.setConfig\(/.test(src)).map(([f]) => f)
    expect(setters.sort()).toEqual(Object.keys(MEASURED).map(pathOf).sort())
  })
  it('the global timeout is not changed (vite.config sets none)', () => {
    expect(viteConfig).toMatch(/test: \{/)
    expect(viteConfig).not.toMatch(/testTimeout|hookTimeout/)
  })
})
