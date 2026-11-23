// The picture's fonts (acceptance-tests #11): modern-screenshot, left to find the page's web fonts itself, reads them through
// a <style> it makes without the page's nonce; the page CSP (hive/core/app.py page_csp) refuses that element, its sheet
// stays null and the library throws, so no picture was ever drawn on a served hive. capturePage hands the library the
// fonts itself, or tells it to embed none, so that path never runs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const domToPng = vi.fn(async (_node: unknown, _options: Record<string, unknown>) => 'data:image/png;base64,iVBORw0KGgo=')
vi.mock('modern-screenshot', () => ({ domToPng }))
const { capturePage, fontFaceCss } = await import('./capture')

const FONT_FACE_RULE = 5
const BYTES = new Uint8Array([0x77, 0x4f, 0x46, 0x32]) // "wOF2"
const B64 = btoa(String.fromCharCode(...BYTES))

/** A @font-face rule as the browser lists it: its text, its family and its sheet. */
function face(family: string, url: string, href: string | null = 'https://hive.invalid/assets/index.css') {
  const cssText = `@font-face { font-family: "${family}"; font-style: normal; src: url("${url}") format("woff2"); }`
  return { type: FONT_FACE_RULE, cssText, style: { getPropertyValue: (p: string) => (p === 'font-family' ? `"${family}"` : '') }, parentStyleSheet: { href } }
}

function page({ sheets, loaded }: { sheets: unknown[]; loaded: string[] }) {
  const body = {}
  return {
    body,
    baseURI: 'https://hive.invalid/',
    defaultView: { innerWidth: 1280, innerHeight: 800, getComputedStyle: () => ({ backgroundColor: 'rgb(5, 5, 15)' }) },
    styleSheets: sheets,
    fonts: loaded.map((family) => ({ family: `"${family}"`, status: 'loaded' })),
  } as unknown as Document
}

let fetched: string[]
let fetchFails: boolean
beforeEach(() => {
  domToPng.mockClear()
  fetched = []
  fetchFails = false
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetched.push(String(url))
    if (fetchFails) throw new TypeError('network')
    return { ok: true, headers: { get: () => 'font/woff2' }, arrayBuffer: async () => BYTES.buffer.slice(0) }
  }))
})
afterEach(() => vi.unstubAllGlobals())

const fontOption = () => domToPng.mock.calls[0][1].font as false | { cssText: string }

describe('capturePage never leaves modern-screenshot to read the fonts itself (acceptance-tests #11)', () => {
  it('passes the page’s own @font-face for a font in use, its file inlined, so the text keeps its shape', async () => {
    const doc = page({ sheets: [{ cssRules: [face('Inter Variable', '/assets/inter-latin.woff2')] }], loaded: ['Inter Variable'] })
    await expect(capturePage(doc)).resolves.toMatch(/^data:image\/png/)
    const font = fontOption()
    expect(font).not.toBe(false)
    expect((font as { cssText: string }).cssText).toContain(`url("data:font/woff2;base64,${B64}")`)
    expect((font as { cssText: string }).cssText).not.toContain('/assets/inter-latin.woff2')
    expect(fetched).toEqual(['https://hive.invalid/assets/inter-latin.woff2'])
  })

  it('finds a @font-face inside @media or @layer, as the library would have', async () => {
    const doc = page({ sheets: [{ cssRules: [{ cssRules: [face('Inter Variable', '/assets/inter-latin.woff2')] }] }], loaded: ['Inter Variable'] })
    await capturePage(doc)
    expect((fontOption() as { cssText: string }).cssText).toContain(`base64,${B64}`)
  })

  it('leaves out a family the page is not drawing with, and fetches nothing for it', async () => {
    const doc = page({
      sheets: [{ cssRules: [face('Inter Variable', '/assets/inter-latin.woff2'), face('IBM Plex Mono', '/assets/plex.woff2')] }],
      loaded: ['Inter Variable'],
    })
    await capturePage(doc)
    expect((fontOption() as { cssText: string }).cssText).not.toContain('IBM Plex Mono')
    expect(fetched).toEqual(['https://hive.invalid/assets/inter-latin.woff2'])
  })

  it('reads nothing from another site: a font file elsewhere is left out, a sheet it may not read is passed over', async () => {
    const closed = { get cssRules(): never { throw new DOMException('cross-origin', 'SecurityError') } }
    const doc = page({ sheets: [closed, { cssRules: [face('Inter Variable', 'https://fonts.elsewhere.invalid/inter.woff2')] }], loaded: ['Inter Variable'] })
    await capturePage(doc)
    expect(fontOption()).toBe(false)
    expect(fetched).toEqual([])
  })

  it('a page with no web fonts asks for none', async () => {
    await capturePage(page({ sheets: [{ cssRules: [] }], loaded: [] }))
    expect(fontOption()).toBe(false)
  })

  it('when a font cannot be fetched, the picture is still drawn, in the fonts the browser falls back to', async () => {
    fetchFails = true
    const doc = page({ sheets: [{ cssRules: [face('Inter Variable', '/assets/inter-latin.woff2')] }], loaded: ['Inter Variable'] })
    await expect(capturePage(doc)).resolves.toMatch(/^data:image\/png/)
    expect(fontOption()).toBe(false)
  })

  it('keeps the rest of the picture as it was: the screen’s size, one pixel per CSS pixel, the page’s background', async () => {
    await capturePage(page({ sheets: [], loaded: [] }))
    expect(domToPng.mock.calls[0][1]).toMatchObject({ width: 1280, height: 800, scale: 1, backgroundColor: 'rgb(5, 5, 15)' })
  })
})

describe('fontFaceCss', () => {
  it('is empty when nothing can be inlined', async () => {
    await expect(fontFaceCss(page({ sheets: [], loaded: ['Inter Variable'] }))).resolves.toBe('')
  })
})
