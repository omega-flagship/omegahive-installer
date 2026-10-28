import { describe, expect, it } from 'vitest'
import guided from '../features/guided/identity.test.ts?raw'
import r11 from '../scene/hiveScale.r1_1.test.ts?raw'
import r12 from '../scene/hiveScale.r1_2.test.ts?raw'
import unavailable from '../features/programs/appUnavailable.test.ts?raw'

/**
 * followups-r6 item 8: the identity-switch tests (a real init or sign-in switch, then the store settles) ran over the 5 s
 * default under load. Each now carries its own timeout, about 3x its worst case MEASURED with the caps lifted (two
 * passes alone on 1 worker, two beside the nine sim files on 3 workers, load up to 9.3), written next to it. This keeps
 * each value tied to its measurement: between 2.5x and 4x, so it neither times out under load nor hides a hang.
 */
const FILES: Record<string, { src: string; tests: number }> = {
  'features/guided/identity.test.ts': { src: guided, tests: 4 },
  'scene/hiveScale.r1_1.test.ts': { src: r11, tests: 3 },
  'scene/hiveScale.r1_2.test.ts': { src: r12, tests: 1 },
  'features/programs/appUnavailable.test.ts': { src: unavailable, tests: 1 },
}
const MEASURED = /\}, (\d+)\) {3}\/\/ followups-r6: measured worst (\d+) ms/g

describe('identity-switch tests keep their measured per-test timeouts', () => {
  for (const [file, f] of Object.entries(FILES)) {
    it(`${file}: ${f.tests} measured, each within 2.5x-4x of its worst case`, () => {
      const found = [...f.src.matchAll(MEASURED)].map((m) => ({ timeout: Number(m[1]), worst: Number(m[2]) }))
      expect(found).toHaveLength(f.tests)
      for (const t of found) {
        expect(t.timeout, JSON.stringify(t)).toBeGreaterThanOrEqual(2.5 * t.worst)
        expect(t.timeout, JSON.stringify(t)).toBeLessThanOrEqual(4 * t.worst)
      }
    })
  }
})
