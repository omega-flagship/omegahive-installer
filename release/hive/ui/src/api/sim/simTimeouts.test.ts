// Purpose: verify every test file that sets its own timeout is listed here with its measured worst, and keeps its cap
// within the bounds below.
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
 * The identity-switch files (named by their path under src): identityEpoch's and askViewEpoch's first tests boot the
 * worker's first two simulated hives, and motivations.r4b's person-switch test starts a whole simulated hive and reads
 * every swarm's goals. On hive-ui CI run 44162990720 (17 Nov), on a runner at about twice its usual time, each ran past
 * the 5 s default and was stopped there, so its worst is at least the time listed; the same runner's earlier green run
 * gave 2130, 3175 and 2647 ms, and the Mac mini, beside six heavy sim files on two workers at load 2, 496, 2267 and
 * 494 ms.
 * Two more ran past it on hive-ui run 44200540828 (18 Nov), on the same kind of runner: vibeIdentity's tests each run
 * the invented Code service's session across a real change of person (5018 ms for the first, then 3713 and 3880), and
 * askCustody's presence test is the first to load the Ask's echo into the console (5018 ms; the file's others took at
 * most 3199). On the Mac mini beside the same six heavy sim files, two workers at load 3 to 4, their slowest tests took
 * at most 1805 and 316 ms over two runs.
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
  // the Ask's screen against the whole screens space for every look, size and screen: two passes, 3 workers, load 95 to 165
  'features/ask/askScreen.test.ts': { worst: 10562 },
  'lib/identityEpoch.test.ts': { worst: 5157 },
  'lib/motivations.r4b.test.ts': { worst: 5008 },
  'features/dot/reasoning/askViewEpoch.test.ts': { worst: 5201 },
  'features/code/canvas/vibeIdentity.test.ts': { worst: 5018 },
  'experiences/construct/askCustody.test.ts': { worst: 5018 },
}
/**
 * r1.5: the screen and feature tests that share the standard 20 s cap (`vi.setConfig({ testTimeout: 20_000 })`). The
 * cap was copied, never measured. Measured here in r1.5 (`worst`, ms): all 40 timeout-setting files, two passes, 3 workers,
 * load 5-10, on the Mac mini. These files mount the simulator and a screen, and nothing in them may hang for minutes, so the
 * bound is a fixed cap: at least {FLOOR}x each file's worst, and never over SCREEN_CAP. The sim-heavy files above keep their
 * own measured caps. A file that outgrows the floor moves up to MEASURED with its own cap.
 * r1.6: the Create plan view joins, measured after it landed on main beside r1.5 (the two branches crossed).
 */
const SCREEN_CAP = 20000
const SCREEN_CAPPED: Record<string, number> = {
  'features/artifacts/artifacts.test.ts': 531,
  'features/ask/askStopped.screen.test.ts': 146, // the Ask's Continue (thread.metta), measured two passes at load 36-41
  'features/artifacts/creationReader.test.ts': 1066, // the Artifacts reader composed by MeTTa, measured two passes at load 135-175
  'features/createPlan/plan.screen.test.ts': 619, // r1.6: the Create plan view, measured two passes at load 4-7
  'features/dot/conversations.screen.test.ts': 1011,
  'features/dot/createOffer.mounted.test.ts': 3205, // a mind's Create offer in every look (its guards test), two passes, 3 workers (Linux, 12 threads)
  'features/explore/explore.screen.test.ts': 2333,
  'features/feedback/feedback.screen.test.ts': 2027, // the feedback area, measured two passes at load 136-149 (16 Nov)
  'features/firstlight/free.test.ts': 3048, // First Light's free inference (its guards test), two passes at load 40 (Linux, 32 threads)
  'features/flow/flow.screen.test.ts': 1123,
  'features/health/health.screen.test.ts': 649,
  'features/keys/profile.screen.test.ts': 1513,
  'features/keys/signOut.test.ts': 211,
  'features/lifecycle/lifecycle.screen.test.ts': 1573,
  'features/mind/mind.screen.test.ts': 1441,
  // the belief-link setting: two passes of the two files alone at load 119-175 on a 32-thread workstation
  'features/minds/BeliefLinkSetting.mounted.test.ts': 4130,
  'features/minds/beliefLink.test.ts': 4903,
  'features/models/models.screen.test.ts': 426,
  'features/people/clearGoogle.test.ts': 606,
  'features/people/people.screen.test.ts': 1455,
  'features/people/people.test.ts': 420,
  'features/programs/actForm.test.ts': 1274, // an app page's action form: measured two passes, 3 workers, load 9-23
  'features/programs/personAppPage.test.ts': 229,
  'features/programs/program.screen.test.ts': 1322,
  'features/programs/programs.screen.test.ts': 1076,
  'features/roles/roles.screen.test.ts': 1252,
  'features/settings/settings.test.ts': 920,
  'features/setup/setup.screen.test.ts': 908,
  'features/swarm/swarms.screen.test.ts': 1373,
  'features/tasks/motivations.screen.test.ts': 1414,
  'features/tasks/tasks.screen.test.ts': 1109,
  'features/tools/tools.test.ts': 298,
  'features/updates/updates.screen.test.ts': 1576,
  // the MeTTa views and the words every look draws, measured two passes, 3 workers, load 9-11
  'features/views/mettaView.test.ts': 3715,
  'features/views/viewHost.screen.test.ts': 1214,
  'features/views/wordsPlaces.test.ts': 454,
  'features/usage/Usage.mounted.test.ts': 1132, // the Usage screen, measured two passes at load 6-10 on the Mac mini
  'features/usage/usage.test.ts': 4642, // the same
  'screens/blocks.test.ts': 1060,
  'screens/dataBlocks.mounted.test.ts': 83, // the figure and chart blocks, measured two passes at load 6-10 on the Mac mini
  'screens/dataBlocks.test.ts': 903, // the same
  'screens/engine.test.ts': 2912,
  'screens/keyfield.mounted.test.ts': 46,
  'screens/rename.mounted.test.ts': 59,
  'screens/screenSpace.test.ts': 755,
  'ui/Belief.test.ts': 418,
}
/** a name is a file in api/sim; a path (with a slash) is a file under src */
const pathOf = (file: string) => (file.includes('/') ? `/src/${file}` : `/src/api/sim/${file}`)
const FLOOR = 2.5
const CEILING = 4

const TESTS = import.meta.glob<string>(['/src/**/*.test.ts'], { query: '?raw', import: 'default', eager: true })
// digits may be grouped with underscores (20_000)
const SET_CONFIG = /vi\.setConfig\(\{ testTimeout: ([\d_]+)(?:, hookTimeout: ([\d_]+))? \}\)/
const ms = (v: string) => Number(v.replace(/_/g, ''))
const SELF = '/src/api/sim/simTimeouts.test.ts'

describe('sim-heavy test files keep measured per-file timeouts, bounded both ways', () => {
  for (const [file, m] of Object.entries(MEASURED)) {
    it(`${file}: testTimeout within ${FLOOR}x-${CEILING}x of ${m.worst} ms${m.hookWorst ? `, hookTimeout of ${m.hookWorst} ms` : ''}`, () => {
      const src = TESTS[pathOf(file)]
      expect(src, file).toBeDefined()
      const got = src.match(SET_CONFIG)
      expect(got).not.toBeNull()
      const test = ms(got![1])
      expect(test).toBeGreaterThanOrEqual(FLOOR * m.worst)
      expect(test).toBeLessThanOrEqual(CEILING * m.worst)
      if (m.hookWorst) {
        const hook = ms(got![2] ?? '0')
        expect(hook).toBeGreaterThanOrEqual(FLOOR * m.hookWorst)
        expect(hook).toBeLessThanOrEqual(CEILING * m.hookWorst)
      } else {
        expect(got![2], 'a hook timeout needs a measured hook').toBeUndefined()
      }
    })
  }
  it('no other test file sets its own timeouts (each one must be measured and bounded above)', () => {
    const setters = Object.entries(TESTS).filter(([f, src]) => f !== SELF && /vi\.setConfig\(/.test(src)).map(([f]) => f)
    expect(setters.sort()).toEqual([...Object.keys(MEASURED), ...Object.keys(SCREEN_CAPPED)].map(pathOf).sort())
  })
  it('no file is listed both as measured and as screen-capped', () => {
    for (const f of Object.keys(SCREEN_CAPPED)) expect(Object.keys(MEASURED).map(pathOf), f).not.toContain(pathOf(f))
  })
  for (const [file, worst] of Object.entries(SCREEN_CAPPED)) {
    it(`${file}: the screen cap (${SCREEN_CAP} ms) is at least ${FLOOR}x its worst of ${worst} ms, and no higher`, () => {
      const got = TESTS[pathOf(file)]?.match(SET_CONFIG)
      expect(got, file).not.toBeNull()
      const test = ms(got![1])
      expect(test).toBeGreaterThanOrEqual(FLOOR * worst)
      expect(test).toBeLessThanOrEqual(SCREEN_CAP)
      expect(got![2], 'a hook timeout needs a measured hook (list it in MEASURED)').toBeUndefined()
    })
  }
  it('the global timeout is not changed (vite.config sets none)', () => {
    expect(viteConfig).toMatch(/test: \{/)
    expect(viteConfig).not.toMatch(/testTimeout|hookTimeout/)
  })
})
