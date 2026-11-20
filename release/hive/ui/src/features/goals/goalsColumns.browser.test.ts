// Purpose: the Tasks board's desktop columns as a browser lays them out from the board's own classes, compiled by Tailwind
// as the build compiles them: in a 614 px page window, about what a page gets beside the half-size Ask, each column keeps
// 13rem and the board scrolls sideways; in a 1344 px window all five fit, each wider. Jon's review of #564 asked for this
// in place of a check on the class names.
// Needs a Chromium: PW_CHROMIUM, else /opt/pw-browsers/chromium; skipped when neither exists, as appFrame.browser.test.ts is.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright-core'

// node APIs by dynamic import, as the other source-reading tests do (the app tsconfig has no node types)
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { existsSync: (p: string) => boolean; readFileSync: (p: URL, e: string) => string }
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const executablePath = env.PW_CHROMIUM || '/opt/pw-browsers/chromium'

/** The board's desktop classes, read from GoalsBoard.tsx itself so the test follows the board. */
const COLUMNS = /export const COLUMNS_WIDE = '([^']+)'/.exec(fs.readFileSync(new URL('./GoalsBoard.tsx', import.meta.url), 'utf8'))?.[1] ?? ''

/** The CSS Tailwind writes for these classes, from the same compiler the Vite plugin uses (@tailwindcss/node). */
async function cssFor(classes: string): Promise<string> {
  const nodeName = '@tailwindcss/node'
  const { compile } = (await import(/* @vite-ignore */ nodeName)) as {
    compile: (css: string, opts: { base: string; onDependency: (path: string) => void }) => Promise<{ build: (candidates: string[]) => string }>
  }
  const compiler = await compile('@import "tailwindcss";', { base: new URL('../../..', import.meta.url).pathname, onDependency: () => undefined })
  return compiler.build(classes.split(/\s+/))
}

describe.skipIf(!fs.existsSync(executablePath))('the Tasks board’s desktop columns, laid out by a browser', () => {
  let browser: Browser
  let css = ''
  beforeAll(async () => {
    css = await cssFor(COLUMNS)
    browser = await chromium.launch({ executablePath })
  })
  afterAll(async () => {
    await browser?.close()
  })

  /** Lays the board out with five columns of card text inside a page window `width` px wide, and measures it. */
  async function laidOut(width: number) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const columns = Array.from({ length: 5 }, (_, i) => `<div>Column ${i + 1}: a card whose title runs to several words</div>`).join('')
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div style="width:${width}px"><div id="board" class="${COLUMNS}">${columns}</div></div></body></html>`)
    const out = await page.evaluate(() => {
      const board = document.getElementById('board') as HTMLElement
      return {
        widths: [...board.children].map((c) => c.getBoundingClientRect().width),
        scrolls: board.scrollWidth > board.clientWidth,
        rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
      }
    })
    await page.close()
    return out
  }

  it('reads the board’s classes from its source', () => {
    expect(COLUMNS).toMatch(/\S/)
  })

  it('in a 614 px page window each column keeps 13rem and the board scrolls sideways', async () => {
    const { widths, scrolls, rem } = await laidOut(614)
    expect(widths).toHaveLength(5)
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(13 * rem - 0.5)
    expect(scrolls).toBe(true)
  })

  it('in a 1344 px page window all five columns fit, each wider than 13rem', async () => {
    const { widths, scrolls, rem } = await laidOut(1344)
    expect(widths).toHaveLength(5)
    for (const w of widths) expect(w).toBeGreaterThan(13 * rem)
    expect(scrolls).toBe(false)
  })
})
