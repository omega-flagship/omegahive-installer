// r17 "app frame parts" in a real browser, inside the same opaque-origin sandboxed srcdoc frame AppFrame uses, with
// the parent served from the host origin so the bridge's postMessage reaches it.
//  1. Order: the parts appDocument inlines as nonce'd module scripts run in their listed order at top level (Kimi
//     held otherwise; this measures it).
//  2. CSP: the policy is written ahead of all app markup (framePrefix), so no index.html can move or drop it. For
//     adversarial heads (the stand-in's <select><head>, <template>, <head> in an attribute, <frameset>, a second
//     <html>, a duplicate <head>, …) an inline script and an inline handler WITHOUT the nonce do not run and no
//     request leaves the frame. The 6614939 builder, run on the same inputs as a control, does lose the CSP.
//  3. Existing apps (Atlas, Design's Studio and its r3 parts proof, read from disk when present) still run.
// Needs a Chromium: PW_CHROMIUM, else /opt/pw-browsers/chromium; skipped when neither exists.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright-core'
import { appDocument, frameCsp, type FrameFiles } from './appFrame'
import { partTag } from './appFrameParts'

// node APIs by dynamic import, as the other source-reading tests do (the app tsconfig has no node types)
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as {
  existsSync: (p: string) => boolean; readFileSync: { (p: URL, e: string): string; (p: string, e: string): string }
}
const cases = JSON.parse(fs.readFileSync(new URL('../../../tests/fixtures/ui_parts_cases.json', import.meta.url), 'utf8')) as
  { html: { name: string; scripts: string[]; html: string; reason: string | null }[] }
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const executablePath = env.PW_CHROMIUM || '/opt/pw-browsers/chromium'
const HOST = 'https://hive.example.test'
const ch = '12345678-1234-1234-1234-123456789abc'
const nonce = '87654321-4321-4321-4321-cba987654321'
const parts = ['native-three.js', 'native-three-addons.js', 'app.js']
const LINK = '<link rel="stylesheet" href="./style.css">'
const page = (names: string[]) => `<html lang="en"><head>${LINK}</head><body>${names.map(partTag).join('')}</body></html>`

type Msg = { origin: string; data: unknown }
type Loaded = { msgs: Msg[]; leaked: string[]; consoleErrors: string[]; inspected: unknown }

/** Loads `html` as the srcdoc of `<iframe sandbox="allow-scripts allow-downloads">` in a page served at HOST. Every
 *  request other than that page is recorded as leaked (a CSP in force lets none out). */
async function load(browser: Browser, html: string, opts: { until?: (m: Msg[]) => boolean; wait?: number; inspect?: () => unknown } = {}): Promise<Loaded> {
  const ctx = await browser.newContext()
  const leaked: string[] = []
  await ctx.route('**/*', (route) => {
    const url = route.request().url()
    if (url === `${HOST}/`) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' })
    leaked.push(url)
    return route.fulfill({ status: 204, body: '' })
  })
  try {
    const tab = await ctx.newPage()
    const consoleErrors: string[] = []
    tab.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
    tab.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
    await tab.goto(`${HOST}/`)
    await tab.evaluate((srcdoc) => {
      const w = window as unknown as { msgs: unknown[] }
      w.msgs = []
      addEventListener('message', (e) => w.msgs.push({ origin: e.origin, data: e.data }))
      const f = document.createElement('iframe')
      f.setAttribute('sandbox', 'allow-scripts allow-downloads')
      f.srcdoc = srcdoc
      document.body.appendChild(f)
    }, html)
    const deadline = Date.now() + (opts.wait ?? 5_000)
    let msgs: Msg[] = []
    for (;;) {
      msgs = await tab.evaluate(() => (window as unknown as { msgs: Msg[] }).msgs)
      if (opts.until?.(msgs) || Date.now() > deadline) break
      await new Promise((r) => setTimeout(r, 50))
    }
    const frame = tab.frames().find((f) => f !== tab.mainFrame())
    const inspected = opts.inspect && frame ? await frame.evaluate(opts.inspect) : undefined
    return { msgs, leaked, consoleErrors, inspected }
  } finally {
    await ctx.close()
  }
}
const data = (l: Loaded) => l.msgs.map((m) => m.data)
const has = (key: string) => (m: Msg[]) => m.some((x) => typeof x.data === 'object' && x.data !== null && key in x.data)

/** The 6614939 builder, verbatim in effect: CSP after the first literal `<head>`. The control for the CSP tests. */
function oldDocument(files: FrameFiles, scripts = ['app.js']): string {
  const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
  let html = files['index.html'].replace('<html', `<html data-app-host-origin="${esc(HOST)}" data-app-channel="${ch}"`)
  html = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${esc(frameCsp(nonce))}">`)
    .replace(LINK, () => `<style nonce="${nonce}">${files['style.css']}</style>`)
  for (const n of scripts) html = html.replace(partTag(n), () => `<script type="module" nonce="${nonce}">${files[n]}</script>`)
  return html
}

/** The nonce'd app: reports that it ran and whether the CSP meta is the head's first element, then tries a fetch. */
const PROBE = `const m = document.head && document.head.firstElementChild;
parent.postMessage({ ran: true, cspFirst: !!m && m.getAttribute('http-equiv') === 'Content-Security-Policy' }, '*');
fetch('https://probe.test/fetch').then(() => parent.postMessage({ fetch: 'allowed' }, '*'), () => parent.postMessage({ fetch: 'failed' }, '*'));`
/** Un-nonce'd script, a network image and an inline handler: none may run or load under the CSP. */
const EVIL = `<script>parent.postMessage({ unnonced: true }, '*')</script><img src="https://probe.test/img">` +
  `<img src="data:image/png;base64,AAAA" onerror="parent.postMessage({ handler: true }, '*')">`
const APP = partTag('app.js')
const ADVERSARIAL: [string, string][] = [
  ['stand-in r17-50d1dda: <select><head>', `<html><body><select><head>${LINK}</select>${EVIL}${APP}</body></html>`],
  ['<head> inside a <template>', `<html><body><template><head></template>${LINK}${EVIL}${APP}</body></html>`],
  ['<head> only inside an attribute', `<html><body><div title="<head>">${LINK}${EVIL}${APP}</div></body></html>`],
  ['<frameset>', `<html><frameset><head>${LINK}</frameset>${EVIL}${APP}</html>`],
  ['a second <html> after the body', `<html><body><p>x</p><html><head>${LINK}</head>${EVIL}${APP}</body></html>`],
  ['a duplicate <head> after scripts', `<html>${EVIL}<head>${LINK}</head><head></head><body>${APP}</body></html>`],
  ['<head> inside <svg> (breakout)', `<html><body><svg><head></svg>${LINK}${EVIL}${APP}</body></html>`],
  ['<head> inside <noscript>', `<html><body><noscript><head></noscript>${LINK}${EVIL}${APP}</body></html>`],
  ['<head> inside <textarea>', `<html><body><textarea><head></textarea>${LINK}${EVIL}${APP}</body></html>`],
  ['<head> inside a comment', `<html><body><!-- <head> -->${LINK}${EVIL}${APP}</body></html>`],
  ['no <head> at all', `<html><body>${LINK}${EVIL}${APP}</body></html>`],
  ['the app spoofs the channel attributes', `<html data-app-channel="spoof" data-app-host-origin="https://evil.test"><head>${LINK}</head><body>${EVIL}${APP}</body></html>`],
]
const legacy = (html: string): FrameFiles => ({ 'index.html': html, 'style.css': 'body{color:red}', 'app.js': PROBE })
const inspectFrame = () => ({
  channel: document.documentElement.dataset.appChannel, host: document.documentElement.dataset.appHostOrigin,
  lang: document.documentElement.lang, compat: document.compatMode,
})

describe.skipIf(!fs.existsSync(executablePath))('app frame in a real browser (r17)', () => {
  let browser: Browser
  beforeAll(async () => { browser = await chromium.launch({ executablePath, headless: true }) }, 60_000)
  afterAll(async () => { await browser?.close() })

  describe('order', () => {
    it('runs three inline module parts in listed order, each reading the previous one\'s globals at top level', async () => {
      const files = {
        'index.html': page(parts), 'style.css': 'body{}',
        // a large first part, as Design's native core is: it still runs before the small ones after it
        'native-three.js': `/*${'x'.repeat(500_000)}*/ globalThis.order = ['core']; globalThis.THREE = { v: 1 }`,
        'native-three-addons.js': 'globalThis.order.push(\'addons:\' + globalThis.THREE.v); globalThis.ADDONS = { ok: true }',
        'app.js': 'globalThis.order.push(\'app:\' + globalThis.ADDONS.ok); parent.postMessage({ order: globalThis.order }, \'*\')',
      }
      const out = await load(browser, appDocument(files, HOST, ch, nonce, parts).html, { until: has('order') })
      expect(out.msgs[0]?.origin).toBe('null')     // the opaque origin is unchanged
      expect(data(out)).toEqual([{ order: ['core', 'addons:1', 'app:true'] }])
    }, 30_000)

    it('repeats in order across many loads', async () => {
      const tag = (i: number) => `globalThis.order = (globalThis.order || []).concat(${i});`
      const files = { 'index.html': page(parts), 'style.css': '', 'native-three.js': tag(0), 'native-three-addons.js': tag(1), 'app.js': `${tag(2)} parent.postMessage({ order: globalThis.order }, '*')` }
      const html = appDocument(files, HOST, ch, nonce, parts).html
      for (let i = 0; i < 10; i++) expect(data(await load(browser, html, { until: has('order') }))).toEqual([{ order: [0, 1, 2] }])
    }, 90_000)

    it('follows the listed (document) order, not file names: a reversed list runs reversed', async () => {
      const names = ['zz.js', 'aa.js', 'app.js']
      const push = (n: string) => `globalThis.order = (globalThis.order || []).concat('${n}');`
      const files = { 'index.html': page(names), 'style.css': '', 'zz.js': push('zz'), 'aa.js': push('aa'), 'app.js': `${push('app')} parent.postMessage({ order: globalThis.order }, '*')` }
      expect(data(await load(browser, appDocument(files, HOST, ch, nonce, names).html, { until: has('order') }))).toEqual([{ order: ['zz', 'aa', 'app'] }])
    }, 30_000)

    it('caveat (documented in PROGRAMS.md §9): a part that awaits at top level does not hold back the next part', async () => {
      const files = {
        'index.html': page(parts), 'style.css': '',
        'native-three.js': "globalThis.order = ['core:start']; await new Promise((r) => setTimeout(r, 50)); globalThis.order.push('core:end')",
        'native-three-addons.js': "globalThis.order.push('addons')",
        'app.js': "globalThis.order.push('app'); setTimeout(() => parent.postMessage({ order: globalThis.order }, '*'), 200)",
      }
      expect(data(await load(browser, appDocument(files, HOST, ch, nonce, parts).html, { until: has('order') })))
        .toEqual([{ order: ['core:start', 'addons', 'app', 'core:end'] }])
    }, 30_000)
  })

  describe('CSP comes first and holds, in both modes', () => {
    for (const [name, html] of ADVERSARIAL) {
      it(`no-list app, ${name}: nothing un-nonce'd runs, nothing leaves the frame`, async () => {
        const doc = appDocument(legacy(html), HOST, ch, nonce)
        expect(doc.html.startsWith('<!doctype html><html data-app-host-origin=')).toBe(true)
        const out = await load(browser, doc.html, { until: has('fetch'), wait: name === '<frameset>' ? 1_500 : 5_000, inspect: inspectFrame })
        expect(data(out)).not.toContainEqual({ unnonced: true })
        expect(data(out)).not.toContainEqual({ handler: true })
        expect(out.leaked).toEqual([])
        if (name !== '<frameset>') {          // a frameset drops the body's scripts; the CSP still holds
          expect(data(out)).toContainEqual({ ran: true, cspFirst: true })
          expect(data(out)).toContainEqual({ fetch: 'failed' })
          expect(out.inspected).toMatchObject({ channel: ch, host: HOST, compat: 'CSS1Compat' })
        }
      }, 30_000)
    }

    it('control: the 6614939 builder loses the CSP on these inputs', async () => {
      const lost: string[] = []
      for (const [name, html] of ADVERSARIAL) {
        if (!html.includes('<head>')) continue          // the old builder refused documents without one
        const out = await load(browser, oldDocument(legacy(html)), { until: has('fetch'), wait: 1_500 })
        if (data(out).some((d) => typeof d === 'object' && d !== null && ('unnonced' in d || 'handler' in d)) || out.leaked.length) lost.push(name)
      }
      expect(lost).toEqual(expect.arrayContaining(['stand-in r17-50d1dda: <select><head>', '<head> inside a <template>',
        '<head> only inside an attribute', 'a second <html> after the body', 'a duplicate <head> after scripts']))
    }, 120_000)

    // The accept direction of the shared table, against a real parser: every case the rules accept runs all of its
    // parts in order, with the CSP first and in force. (The host and client suites check the same table's reasons.)
    const partFiles = (c: { scripts: string[]; html: string }) => Object.fromEntries([
      ['index.html', c.html], ['style.css', ''],
      ...c.scripts.map((n) => [n, `globalThis.order = (globalThis.order || []).concat('${n}');` + (n === 'app.js' ? ` parent.postMessage({ order: globalThis.order }, '*'); ${PROBE}` : '')]),
    ]) as never
    for (const c of cases.html.filter((x) => x.reason === null)) {
      it(`parts, accepted case runs every part in order under the CSP: ${c.name}`, async () => {
        const out = await load(browser, appDocument(partFiles(c), HOST, ch, nonce, c.scripts).html, { until: has('fetch'), inspect: inspectFrame })
        expect(data(out)).toContainEqual({ order: c.scripts })
        expect(data(out)).toContainEqual({ ran: true, cspFirst: true })
        expect(data(out)).toContainEqual({ fetch: 'failed' })
        expect(out.leaked).toEqual([])
        expect(out.inspected).toMatchObject({ channel: ch, host: HOST })
      }, 30_000)
    }

    // And refusals were real: inlined anyway (by hand, bypassing the checks), their parts do not all run as listed
    // (a comment or textarea swallows every part; an open quote swallows the first; a frameset drops them all).
    for (const name of ['tags wrapped in a comment', 'tags swallowed by an open attribute quote', 'tags inside a textarea', 'frameset before the tags']) {
      it(`parts, refused case would not run as listed: ${name}`, async () => {
        const c = cases.html.find((x) => x.name === name)!
        expect(c.reason).not.toBeNull()
        const out = await load(browser, oldDocument(partFiles(c), c.scripts), { until: has('order'), wait: 1_500 })
        expect(data(out)).not.toContainEqual({ order: c.scripts })
      }, 30_000)
    }
  })

  describe('existing apps still run (read from disk when present; nothing is copied)', () => {
    const apps: { name: string; dir: string; scripts?: string[]; readyMessage: boolean }[] = [
      { name: 'Private app', dir: '/home/user/private-app/ui', readyMessage: true },
      { name: 'Design Studio', dir: '/home/user/OmegaDot/omegadesign/program/ui', readyMessage: true },
      { name: 'Design r3 parts proof', dir: '/home/user/OmegaDot/omegadesign/poc/studio_model_parts_root_cloud_r3_20261007/proof',
        scripts: ['native-three.js', 'native-three-addons.js', 'app.js'], readyMessage: false },
    ]
    const ready = (m: Msg[]) => m.some((x) => (x.data as { type?: string } | null)?.type === 'app-ready')
    for (const app of apps) {
      it.skipIf(!fs.existsSync(`${app.dir}/index.html`))(`${app.name}`, async () => {
        const read = (n: string) => fs.readFileSync(`${app.dir}/${n}`, 'utf8')
        const files = Object.fromEntries(['index.html', 'style.css', ...(app.scripts ?? ['app.js'])].map((n) => [n, read(n)])) as FrameFiles
        const inspect = () => ({
          channel: document.documentElement.dataset.appChannel, lang: document.documentElement.lang, compat: document.compatMode,
          title: document.title, bodyChildren: document.body ? document.body.children.length : -1,
          cspFirst: document.head.firstElementChild?.getAttribute('http-equiv') === 'Content-Security-Policy',
          parts: [typeof (globalThis as Record<string, unknown>).OmegaDesignNativeThreeR1, typeof (globalThis as Record<string, unknown>).OmegaDesignNativeThreeAddonsR1],
        })
        const opts = { until: app.readyMessage ? ready : undefined, wait: app.readyMessage ? 10_000 : 3_000, inspect }
        const now = await load(browser, appDocument(files, HOST, ch, nonce, app.scripts).html, opts)
        expect(now.leaked).toEqual([])
        expect(now.inspected).toMatchObject({ channel: ch, cspFirst: true })
        if (app.readyMessage) expect(ready(now.msgs)).toBe(true)
        if (app.scripts) {
          expect((now.inspected as { parts: string[] }).parts).toEqual(['object', 'object'])
          expect(now.consoleErrors.filter((e) => /Content Security Policy|pageerror/.test(e))).toEqual([])
        } else {
          // Same behaviour as the 6614939 document: same title, language, mode and body, no new console errors.
          const before = await load(browser, oldDocument(files), opts)
          if (app.readyMessage) expect(ready(before.msgs)).toBe(true)
          const pick = (l: Loaded) => { const { channel, lang, compat, title, bodyChildren } = l.inspected as Record<string, unknown>; return { channel, lang, compat, title, bodyChildren } }
          expect(pick(now)).toEqual(pick(before))
          const norm = (e: string) => e.replace(/nonce-[\w-]+/g, 'nonce-N')
          expect(now.consoleErrors.map(norm).filter((e) => !before.consoleErrors.map(norm).includes(e))).toEqual([])
        }
      }, 60_000)
    }
  })
})
