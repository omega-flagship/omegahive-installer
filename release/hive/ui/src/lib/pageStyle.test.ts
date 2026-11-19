// Purpose: tests that every stylesheet the UI draws as a <style> element carries the page's CSP nonce: PageStyle draws
// it with the nonce the hive served the page with, and nothing else in the UI's source draws a <style> element itself.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageStyle } from './PageStyle'

/**
 * The hive serves every page with style-src 'self' 'nonce-…' (hive/core/app.py page_csp), and the browser drops a
 * <style> element without that nonce whole. Canvas's board styles and Flux's own were drawn that way, so none of their
 * rules applied, among them the one that hides Canvas's outline while it's closed.
 */

const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as {
  readFileSync: (p: string, e: 'utf8') => string
  readdirSync: (p: string, o: { recursive: true }) => string[]
}
const SRC = new URL('../', import.meta.url).pathname
const PAGE = '1f2e3d4c-5b6a-7980-a1b2-c3d4e5f60718'
/** A page whose csp-nonce meta holds this nonce, or one without the meta. */
const page = (nonce: string | null) => ({
  querySelector: (sel: string) => (sel === 'meta[property="csp-nonce"]' && nonce !== null ? { nonce, getAttribute: () => null } : null),
})
const drawn = () => renderToStaticMarkup(createElement(PageStyle, { css: '.cv-root{cursor:default}' }))

/** Each place a source file draws a <style> element itself, as `line: how`: a JSX <style>, or createElement('style'). */
function stylesDrawn(name: string, source: string): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, name.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: string[] = []
  const at = (node: ts.Node, how: string) => found.push(`${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${how}`)
  const visit = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(file) === 'style') at(node, 'jsx')
    else if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : ''
      const first = node.arguments[0]
      if (callee === 'createElement' && first && ts.isStringLiteralLike(first) && first.text === 'style') at(node, 'createElement')
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

// Time: one read of every source file + one parse of each file that mentions a style element, of its length.
const SOURCES = fs.readdirSync(SRC, { recursive: true })
  .filter((f) => /\.tsx?$/.test(f) && !/\.(test|testkit)\.|(^|\/)__/.test(f) && f !== 'lib/PageStyle.tsx')
  .sort()

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PageStyle', () => {
  it('carries the nonce the hive served the page with', () => {
    vi.stubGlobal('document', page(PAGE))
    expect(drawn()).toBe(`<style nonce="${PAGE}">.cv-root{cursor:default}</style>`)
  })

  it('goes without one where the page has none: the dev server, the demo or a test, or a slot left unfilled', () => {
    for (const nonce of [null, 'HIVE-CSP-NONCE']) {
      vi.stubGlobal('document', page(nonce))
      expect(drawn()).toBe('<style>.cv-root{cursor:default}</style>')
    }
  })
})

describe('nothing in the UI draws a <style> element but PageStyle', () => {
  it('catches each way a file could draw one', () => {
    const source = `
      import { createElement } from 'react'
      export const A = () => <div><style>{CSS}</style><style nonce={n}>{CSS}</style></div>
      export const B = () => createElement('style', null, CSS)
      export const C = () => document.createElement('style')
      export const D = () => <PageStyle css={CSS} />`
    expect(stylesDrawn('a.tsx', source).map((f) => f.replace(/^\d+: /, ''))).toEqual(['jsx', 'jsx', 'createElement', 'createElement'])
  })

  it('reads the whole UI, Canvas and Flux among it', () => {
    expect(SOURCES).toEqual(expect.arrayContaining(['experiences/canvas/index.tsx', 'experiences/flux/index.tsx', 'features/code/Editor.tsx']))
    expect(SOURCES.length).toBeGreaterThan(500)
  })

  it('finds none', () => {
    const found = SOURCES.flatMap((f) => {
      const text = fs.readFileSync(SRC + f, 'utf8')
      // the parse decides; this only skips the files that never mention a style element
      return /<style\b|createElement\(\s*['"`]style['"`]/.test(text) ? stylesDrawn(f, text).map((at) => `${f}:${at}`) : []
    })
    expect(found).toEqual([])
  })
})
