import { describe, expect, it } from 'vitest'
import variantSource from './uiVariant.ts?raw'
import panelSource from '../features/requestExperience/RequestPanel.tsx?raw'
import gallerySource from './ChangeUi.tsx?raw'
import { applyLook, DEFAULT_VARIANT, densityVars, TEXT_SCALE } from './uiVariant'

// the stylesheet as text: vitest handles any .css import (?raw included) as CSS and hands back nothing, so read the file
// @ts-expect-error -- node's fs has no types in this browser project; vitest runs these tests in node
const { readFileSync } = await import('node:fs')
const css: string = readFileSync(new URL('../index.css', import.meta.url), 'utf8')

/**
 * Kimi r1g P1: a look's text size scales the type scale ONLY. The root rem (and so every Tailwind spacing, radius,
 * min-height and hit target) is never changed, so hit targets stay at least 44 px at every text size.
 */
describe('text size is the type scale only', () => {
  it('a density sets only --text-scale (bigger 1.125, smaller 0.9375, standard nothing)', () => {
    expect(densityVars('roomy')).toEqual({ '--text-scale': '1.125' })
    expect(densityVars('compact')).toEqual({ '--text-scale': '0.9375' })
    expect(densityVars('regular')).toEqual({})
    expect(TEXT_SCALE.regular).toBeNull()
  })

  it('the root rem is never touched by a look', () => {
    expect(variantSource).not.toMatch(/style\.fontSize|setProperty\(\s*'font-size'/)
  })

  it('index.css re-points the nine type tokens (and their line heights) at --text-scale, and nothing else', () => {
    const block = css.match(/html\[data-ui-density\]\s*\{([^}]*)\}/)
    expect(block).not.toBeNull()
    const props = [...block![1].matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])
    const steps = ['caption', 'meta', 'small', 'body', 'lead', 'title-sm', 'title', 'heading', 'display']
    expect(props.sort()).toEqual(steps.flatMap((s) => [`--text-${s}`, `--text-${s}--line-height`]).sort())
    for (const line of block![1].split(';').map((x) => x.trim()).filter(Boolean)) expect(line).toMatch(/var\(--text-scale, 1\)\)$/)
    // the values mirror @theme exactly, times the scale
    for (const s of steps) {
      const base = css.match(new RegExp(`--text-${s}:\\s*([\\d.]+rem);`))![1]
      expect(block![1]).toContain(`--text-${s}: calc(${base} * var(--text-scale, 1))`)
    }
  })

  // A static guard only (Kimi r1j #5): it reads one source line per <button>, so a class split across lines or a size
  // on a Button-primitive line would slip past it. The authority for "every visible panel button is at least 44 px" is
  // the browser smoke, which measures every visible button by name (receipts/request-experience/r1j).
  it('the request panel’s and Your looks’ own controls are 44 px (size-11 / min-h-11 / the Button primitive), at any text size', () => {
    for (const l of panelSource.split('\n').filter((x) => x.includes('<button'))) expect(l).not.toMatch(/\b(size-(?:[0-9]|10)|min-h-(?:[0-9]|10))\b/)
    const remove = gallerySource.split('\n').find((l) => l.includes('removeMyLook(l.variant.id)'))!
    expect(remove).toMatch(/\bmin-h-11\b/)
  })

  /**
   * Behavioural (Kimi r1h #6): applyLook is run on a stand-in root and what it actually writes is read back, so this
   * fails on the OLD behaviour (root font-size 112.5%) as an assertion, not as a missing export.
   */
  it('applying a bigger-text look writes --text-scale and leaves the root font size alone; standard text clears it', () => {
    const props = new Map<string, string>()
    const root = {
      dataset: {} as Record<string, string>,
      style: {
        fontSize: '',
        setProperty: (k: string, v: string) => void (k === 'font-size' ? (root.style.fontSize = v) : props.set(k, v)),
        removeProperty: (k: string) => void (k === 'font-size' ? (root.style.fontSize = '') : props.delete(k)),
      },
    }
    const doc = { documentElement: root }
    const had = 'document' in globalThis
    Object.assign(globalThis, { document: doc })
    try {
      applyLook({ variant: { ...DEFAULT_VARIANT, id: 'big', density: 'roomy' }, layout: null })
      expect(root.style.fontSize).toBe('')
      expect(props.get('--text-scale')).toBe('1.125')
      expect(root.dataset.uiDensity).toBe('roomy')
      applyLook({ variant: { ...DEFAULT_VARIANT, id: 'small', density: 'compact' }, layout: null })
      expect(root.style.fontSize).toBe('')
      expect(props.get('--text-scale')).toBe('0.9375')
      applyLook({ variant: { ...DEFAULT_VARIANT, id: 'std', density: 'regular' }, layout: null })
      expect(root.style.fontSize).toBe('')
      expect(props.has('--text-scale')).toBe(false)
      expect(root.dataset.uiDensity).toBeUndefined()
    } finally {
      if (!had) delete (globalThis as { document?: unknown }).document
    }
  })

  it('the request panel is on the type scale (no px text) and its voice controls are 44 px (Kimi r1h #5, #7)', () => {
    expect(panelSource).not.toMatch(/text-\[\d/)
    expect(panelSource).toMatch(/toggleClass="min-h-11 /)
    expect(panelSource).toMatch(/buttonClass="min-h-11 /)
  })
})
