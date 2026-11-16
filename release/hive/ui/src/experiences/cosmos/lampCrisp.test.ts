import { describe, expect, it } from 'vitest'
import { omegaMarkLive, pacedFps } from './phaseRig'

/**
 * Jon, 3 Nov, on Cosmos: "the omega in the middle … shouldnt have that light behind it, and the background looks
 * blurry and not too good". No star, corona or glow behind a showing living Ω (the star stays the Ω only where the mark
 * can't run); the space crisp at DPR 1 and 2 (no adaptive drop from a paced frame rate, no soft bloom over the field).
 */
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string }
const src = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')

describe('no lamp behind the living Ω', () => {
  it('is live while either layer’s mark shows, through a cross-fade, and not after both go', () => {
    expect(omegaMarkLive.value).toBe(false)
    omegaMarkLive.set('rest', true)
    omegaMarkLive.set('awake', true)
    omegaMarkLive.set('rest', false)
    expect(omegaMarkLive.value).toBe(true)
    omegaMarkLive.set('awake', false)
    expect(omegaMarkLive.value).toBe(false)
  })
  it('the core draws no glow or body at rest or awake while it is live; Pro keeps its core', () => {
    const scene = src('./Scene.tsx')
    expect(scene).toMatch(/const lamp = !omegaMarkLive\.value/)
    expect(scene).toMatch(/intensity: lamp \? 0\.85 : 0, rays: 0\.42, body: lamp \? d \* 0\.0135 : 0/)
    expect(scene).toMatch(/intensity: lamp \? 0\.9 : 0, rays: 0\.8, body: lamp \? d \* 0\.008 : 0/)
    expect(scene).toMatch(/glow\.current\.visible = c\.intensity > 0\.002/)
    const phases = src('./phases.tsx')
    expect(phases.match(/onLive=\{markLive\}/g)).toHaveLength(2)
    // live only while its layer is in front, and the lamp goes out at once under a showing mark
    expect(phases).toMatch(/omegaMarkLive\.set\(layer, live && on\)/)
    expect(scene).toMatch(/if \(!lamp && phase !== 'pro'\) \{ c\.intensity = 0; c\.body = 0 \}/)
  })
})

describe('the space is crisp', () => {
  it('adaptive resolution runs only unpaced; paced phases draw at the screen’s own DPR up to 2', () => {
    const scene = src('./Scene.tsx')
    expect(scene).toMatch(/\{!reduced && !paced && <Adaptive max=\{maxDpr\} \/>\}/)
    expect(scene).toMatch(/\{paced && <PacedDpr max=\{maxDpr\} fps=\{pacedFps\(pacing\) \?\? 22\} \/>\}/)
    // the weakest device: below the floor the resolution steps down, never below 0.85
    expect(scene).toMatch(/if \(got < floor\) \{\s+next = Math\.max\(0\.85, a\.dpr - 0\.25\)/)
    expect(scene).toMatch(/paced \? Math\.min\(2, /)
    expect(pacedFps({ hidden: false, reduced: false, phased: true, phase: 'rest' })).not.toBeNull()
    expect(pacedFps({ hidden: false, reduced: false, phased: true, phase: 'awake' })).not.toBeNull()
    expect(pacedFps({ hidden: false, reduced: false, phased: true, phase: 'pro' })).toBeNull()
  })
  it('rest and awake bloom only bright cores, with no fringe or grain; Pro keeps its effects', () => {
    const scene = src('./Scene.tsx')
    const crisp = scene.slice(scene.indexOf('if (crisp)'), scene.indexOf('if (lite)'))
    expect(crisp).toMatch(/luminanceThreshold=\{0\.62\}/)
    expect(crisp).not.toMatch(/ChromaticAberration|Noise/)
    expect(scene).toMatch(/crisp=\{phased && phase !== 'pro'\}/)
  })
})

describe('review r1.1: stable resolution, and never an empty centre', () => {
  it('judged on delivered frames against the wall clock, never while hidden; neutral windows reset; recovery backs off', () => {
    const scene = src('./Scene.tsx')
    expect(scene).toMatch(/const got = \(a\.n \* 1000\) \/ \(now - a\.start\)/)
    expect(scene).toMatch(/if \(document\.hidden\) return/)
    expect(scene).toMatch(/\} else a\.good = 0/)
    expect(scene).toMatch(/a\.need = Math\.min\(8, a\.need \* 2\)/)
  })
  it('a lost mark brings the star back at once, and its stand-in shows without a fade', () => {
    expect(src('./Scene.tsx')).toMatch(/if \(lamp && !lampWas\.current && phase !== 'pro'\) \{ c\.intensity = t\.intensity; c\.body = t\.body \}/)
    const live = src('../../brand/LiveOmega.tsx')
    expect(live).toMatch(/const fail = \(\) => \{ setCut\(true\)/)
    expect(live).toMatch(/\$\{cut \? 'duration-0' : 'duration-300'\}/)
  })
})
