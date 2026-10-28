import { describe, expect, it } from 'vitest'
import { ALL_EXPERIENCES, CLASSIC, EXPERIENCES, offeredExperiences, resolveExperience, UNREVIEWED_ALLOWED } from './registry'

/**
 * A production build offers only experiences OmegaReview has SHIPped as a whole. Changing this list needs a verdict:
 * classic is the platform's own UI; Still and Canvas: SURFACE_78fe891_BROWSER_VERDICT_20261005; Cosmos, Construct and
 * Flux: SURFACE_O_Q_27B9992_REVIEW_VERDICT_20261006 (O + Q); OmegaTown: SURFACE_REVIEW_OMEGATOWN_PROFESSIONAL_R5_20261008
 * plus the r3b owner integration SHIPs (stand-in and Kimi), released by the owner 2026-10-08; Professional: the whole-experience
 * round professional-release-r1, SURFACE_PROFESSIONAL_RELEASE_R1_STANDIN_VERDICT.md and _KIMI_VERDICT.md (both SHIP). The
 * gate itself is checked with a synthetic unreviewed one.
 */
const REVIEWED = ['classic', 'professional', 'omegatown', 'cosmos', 'construct', 'still', 'flux', 'canvas']
const UNREVIEWED = { ...CLASSIC, id: 'unreviewed-probe', reviewed: undefined }
const WITH_PROBE = [...ALL_EXPERIENCES, UNREVIEWED]
const ids = (l: { id: string }[]) => l.map((e) => e.id)

describe('only reviewed experiences are reachable by default', () => {
  it('exactly the experiences with a whole-experience verdict are marked reviewed', () => {
    expect(ids(ALL_EXPERIENCES.filter((e) => e.reviewed === true))).toEqual(REVIEWED)
  })

  it('a production build (no dev, no preview, no explicit flag) offers reviewed experiences only', () => {
    const offered = offeredExperiences(WITH_PROBE, { allowUnreviewed: false, preview: false })
    expect(ids(offered)).toEqual(REVIEWED)
    expect(ids(offered)).not.toContain('unreviewed-probe')
  })

  it('a saved, linked or unknown experience the build does not offer resolves to classic (never a blank stage)', () => {
    const offered = offeredExperiences(WITH_PROBE, { allowUnreviewed: false, preview: false })
    for (const id of ['unreviewed-probe', 'nope', '', null, undefined]) expect(resolveExperience(offered, id)).toBe(CLASSIC)
    for (const id of REVIEWED) expect(resolveExperience(offered, id).id).toBe(id)
  })

  it('the explicit dev/preview switch offers the rest, and classic is always offered', () => {
    expect(ids(offeredExperiences(WITH_PROBE, { allowUnreviewed: true, preview: false }))).toEqual(ids(WITH_PROBE))
    for (const allowUnreviewed of [true, false]) for (const preview of [true, false]) {
      expect(ids(offeredExperiences(ALL_EXPERIENCES, { allowUnreviewed, preview }))).toContain('classic')
    }
  })

  it('this test run is a dev-mode build, so it sees every experience (the coverage tests rely on ALL_EXPERIENCES anyway)', () => {
    expect(UNREVIEWED_ALLOWED).toBe(true)
    expect(ids(EXPERIENCES)).toEqual(ids(ALL_EXPERIENCES))
  })
})
