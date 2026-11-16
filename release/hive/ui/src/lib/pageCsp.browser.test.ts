// Purpose: tests in Chromium that srcdoc frames run under the page's CSP with the page's nonce, and not with another.
// Flagship review #111 (a CSP on the app document), in a real browser. A srcdoc frame inherits its page's CSP on top of
// its own, so the page's policy (hive/core/app.py page_csp, POLICY below; test_page_csp.py checks they are the same
// text) decides whether Create's apps, plan previews, Code's page and Flow's studio still run:
//   1. an app document bound with the page's nonce (frameNonce) runs: its nonce'd module script, its nonce'd style and
//      a style attribute all apply, under the page's policy and its own;
//   2. the same document with any other nonce does not run (the page's policy refuses its script and style);
//   3. Flow's studio document behaves the same.
// Needs a Chromium: PW_CHROMIUM, else /opt/pw-browsers/chromium; skipped when neither exists.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright-core'
import { appDocument } from './appFrame'
import { studioDocument } from '../features/flow/studioDocument'

const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { existsSync: (p: string) => boolean }
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const executablePath = env.PW_CHROMIUM || '/opt/pw-browsers/chromium'
const HOST = 'https://hive.example.test'
const PAGE_NONCE = '1f2e3d4c-5b6a-7980-a1b2-c3d4e5f60718'
const OTHER_NONCE = 'aaaaaaaa-1111-2222-3333-444444444444'
const CHANNEL = '12345678-1234-1234-1234-123456789abc'

// hive/core/app.py page_csp(nonce), word for word
const POLICY = (nonce: string) => `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`

const APP = {
  'index.html': '<html lang="en"><head><link rel="stylesheet" href="./style.css"></head><body><p id="p" style="font-weight:700">x</p><script type="module" src="./app.js"></script></body></html>',
  'style.css': 'p { color: rgb(0, 128, 0) }',
  'app.js': "const p = getComputedStyle(document.getElementById('p')); parent.postMessage({ ran: true, color: p.color, weight: p.fontWeight }, '*')",
}
const STUDIO = {
  html: '<html lang="en"><head><link rel="stylesheet" href="./style.css"></head><body><a class="brand" href="./">s</a><script type="module" src="./app.js"></script></body></html>',
  script: "parent.postMessage({ ran: true, studio: true }, '*')",
  style: 'a { color: rgb(0, 0, 255) }',
}

/** The page at HOST served with the page's policy and nonce, a sandboxed srcdoc frame holding `srcdoc`; what it posts. */
async function framed(browser: Browser, srcdoc: string): Promise<unknown[]> {
  const ctx = await browser.newContext()
  await ctx.route('**/*', (route) => route.request().url() === `${HOST}/`
    ? route.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': POLICY(PAGE_NONCE) },
      body: `<!doctype html><html><head><meta property="csp-nonce" nonce="${PAGE_NONCE}"></head><body></body></html>` })
    : route.fulfill({ status: 204, body: '' }))
  try {
    const tab = await ctx.newPage()
    await tab.goto(`${HOST}/`)
    await tab.evaluate((doc) => {
      const w = window as unknown as { msgs: unknown[] }
      w.msgs = []
      addEventListener('message', (e) => w.msgs.push(e.data))
      const f = document.createElement('iframe')
      f.setAttribute('sandbox', 'allow-scripts allow-downloads')
      f.srcdoc = doc
      document.body.appendChild(f)
    }, srcdoc)
    await tab.waitForTimeout(1200)
    return await tab.evaluate(() => (window as unknown as { msgs: unknown[] }).msgs)
  } finally {
    await ctx.close()
  }
}

describe.skipIf(!fs.existsSync(executablePath))('srcdoc frames under the page CSP (#111)', () => {
  let browser: Browser
  beforeAll(async () => { browser = await chromium.launch({ executablePath, headless: true }) }, 60_000)
  afterAll(async () => { await browser?.close() })

  it("an app document bound with the page's nonce runs, styled", async () => {
    const msgs = await framed(browser, appDocument(APP, HOST, CHANNEL, PAGE_NONCE).html)
    expect(msgs).toEqual([{ ran: true, color: 'rgb(0, 128, 0)', weight: '700' }])
  }, 30_000)

  it('the same document with another nonce is refused by the page policy it inherits', async () => {
    expect(await framed(browser, appDocument(APP, HOST, CHANNEL, OTHER_NONCE).html)).toEqual([])
  }, 30_000)

  it("Flow's studio document runs with the page's nonce and not without it", async () => {
    expect(await framed(browser, studioDocument(STUDIO, HOST, CHANNEL, PAGE_NONCE).html)).toEqual([{ ran: true, studio: true }])
    expect(await framed(browser, studioDocument(STUDIO, HOST, CHANNEL, OTHER_NONCE).html)).toEqual([])
  }, 30_000)
})
