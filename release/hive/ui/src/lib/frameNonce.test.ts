// Purpose: tests that srcdoc frames take the page's CSP nonce, or a fresh one where the page has none.
import { describe, expect, it } from 'vitest'
import { appDocument, frameNonce, pageNonce } from './appFrame'

/**
 * Flagship review #111 (a CSP on the app document): a srcdoc frame inherits the page's CSP, so its inline scripts and
 * styles must carry the nonce the hive served the page with (hive/core/app.py page_csp, the csp-nonce meta vite's
 * html.cspNonce writes); a page served without one (the dev server, the demo, a test) gives the frame a fresh nonce.
 */

const PAGE = '1f2e3d4c-5b6a-7980-a1b2-c3d4e5f60718'
const meta = (attrs: { nonce?: string; attribute?: string }) => ({
  querySelector: (sel: string) => (sel === 'meta[property="csp-nonce"]' ? { nonce: attrs.nonce ?? '', getAttribute: () => attrs.attribute ?? null } : null),
}) as unknown as Pick<Document, 'querySelector'>
const UUIDISH = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

describe('frameNonce', () => {
  it("is the page's nonce when the hive filled the slot", () => {
    expect(frameNonce(meta({ nonce: PAGE }))).toBe(PAGE)
    expect(frameNonce(meta({ attribute: PAGE }))).toBe(PAGE)   // a browser that keeps the attribute readable
  })

  it('pageNonce is the filled slot or nothing (the editor adds no nonce of its own)', () => {
    expect(pageNonce(meta({ nonce: PAGE }))).toBe(PAGE)
    expect(pageNonce(meta({ nonce: 'HIVE-CSP-NONCE' }))).toBeNull()
    expect(pageNonce(undefined)).toBeNull()
  })

  it('is fresh, and different each time, where the page has no filled slot', () => {
    for (const doc of [undefined, meta({}), meta({ nonce: 'HIVE-CSP-NONCE' }), meta({ nonce: 'not a nonce' }), { querySelector: () => null } as unknown as Pick<Document, 'querySelector'>]) {
      const a = frameNonce(doc), b = frameNonce(doc)
      expect(a).toMatch(UUIDISH)
      expect(a).not.toBe(b)
      expect(a).not.toBe('HIVE-CSP-NONCE')
    }
  })

  it('binds an app document that the page nonce passes, in its own CSP and on its tags', () => {
    const files = { 'index.html': '<html><head><link rel="stylesheet" href="./style.css"></head><body><script type="module" src="./app.js"></script></body></html>', 'app.js': 'console.log(1)', 'style.css': 'p{}' }
    const html = appDocument(files, 'https://hive.example.test', 'aaaaaaaa-1111-2222-3333-444444444444', frameNonce(meta({ nonce: PAGE }))).html
    expect(html).toContain(`script-src &#39;nonce-${PAGE}&#39;`)   // the meta's content, attribute-escaped
    expect(html).toContain(`<script type="module" nonce="${PAGE}">`)
    expect(html).toContain(`<style nonce="${PAGE}">`)
  })
})
