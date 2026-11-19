// Purpose: rendered checks of the feedback entry and area (features/feedback). SIMULATOR ONLY (?sim=1), invented data:
// no live hive, no provider call, nothing sent. Serve a production build (`npx vite preview --host 127.0.0.1 --port
// <port>`), then:
//   node scripts/feedback-check.mjs <port> <outDir> [browserPath]
// For every experience, at desktop, upright-tablet, phone and landscape-phone sizes, on every page the router lists: the
// entry is shown, named, inside the window, topmost at its own points, hiding no control. Once per experience and size,
// pressing it opens the area, which shows the whole report (its first and last lines) and what goes with it, attaches
// no picture until the person adds one, then draws it, and holds the ways out until the person has written something;
// Show the logs shows the hive's logs whole, and Save the logs saves exactly the text shown.
// Exit 1 when any check fails; results.json lists them all.
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const require = createRequire(fileURLToPath(new URL('../package.json', import.meta.url)))
const { chromium } = require('playwright-core')
const PORT = process.argv[2] ?? '5491'
const OUT = process.argv[3] ?? 'feedback-check'
const EXE = process.argv[4] ?? process.env.CHROME ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
const BASE = `http://127.0.0.1:${PORT}`
await mkdir(`${OUT}/shots`, { recursive: true })

// every experience the registry offers; CHECK_LOOKS and CHECK_SIZES (comma lists) narrow a run while iterating
const EXPS = (process.env.CHECK_LOOKS ?? 'classic,professional,still,canvas,cosmos,flux,construct').split(',')
const touch = { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
const VPS = {
  desk1440: { viewport: { width: 1440, height: 900 } },
  desk1024: { viewport: { width: 1024, height: 768 } },
  tab768: { viewport: { width: 768, height: 1024 }, ...touch },
  phone390: { viewport: { width: 390, height: 844 }, ...touch },
  phone360: { viewport: { width: 360, height: 780 }, ...touch },
  land844: { viewport: { width: 844, height: 390 }, ...touch },
}
// every page the router names (lib/router.ts PAGE_ROUTES, read from the source so the list cannot drift), the hive
// itself, a mind's chat and a swarm (their ids come from the simulator)
const router = await readFile(new URL('../src/lib/router.ts', import.meta.url), 'utf8')
const listed = JSON.parse(router.match(/export const PAGE_ROUTES[^=]*=\s*(\[[^\]]*\])/)[1].replace(/'/g, '"'))
const NEEDS_ID = new Set(['swarm', 'program', 'lifecycle'])
const PAGES = ['', ...listed.filter((n) => !NEEDS_ID.has(n)).map((n) => `#/${n}`), 'swarm', 'dot']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const results = []
const ok = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail).slice(0, 2000) })

async function open(exp, vp) {
  const errors = []
  // the clipboard granted, as a person's browser grants it on their press, so Copy can be pressed and checked
  const ctx = await browser.newContext({ ...VPS[vp], locale: 'en-GB', reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
  await page.addInitScript(([e]) => {
    localStorage.setItem('omegahive.ui.look', JSON.stringify({ variant: null, layout: null, apps: null, experience: e === 'classic' ? null : e }))
    localStorage.setItem('omegadots.intro.welcome.v1', 'explore')
    localStorage.setItem('omegahive.rest', JSON.stringify({ minutes: 60 }))
  }, [exp])
  await page.goto(`${BASE}/?sim=1`)
  await page.waitForFunction(() => !!window.__hiveSim && !!document.querySelector('.feedback-entry'), null, { timeout: 60000 })
  await page.evaluate(() => { window.__hiveSim.running = false })
  await sleep(1500)
  if (exp === 'construct') { await page.keyboard.press('Escape'); await sleep(800) }
  return { ctx, page, errors }
}

/** The entry's state on the page as it stands: shown, named, inside the window, topmost, and nothing under it. */
const entryState = (page, selector = '.feedback-entry') => page.evaluate((selector) => {
  const el = document.querySelector(selector)
  if (!el) return { missing: true }
  const r = el.getBoundingClientRect()
  if (el.hidden || !r.width) return { hidden: true }
  const visible = (e) => {
    const b0 = e.getBoundingClientRect()
    let b = { l: b0.left, t: b0.top, r: b0.right, b: b0.bottom }
    for (let a = e.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (/(hidden|auto|scroll|clip)/.test(cs.overflowX + cs.overflowY)) {
        const ar = a.getBoundingClientRect()
        b = { l: Math.max(b.l, ar.left), t: Math.max(b.t, ar.top), r: Math.min(b.r, ar.right), b: Math.min(b.b, ar.bottom) }
      }
    }
    return b
  }
  const desc = (e) => `${e.tagName}.${(e.getAttribute('aria-label') || e.textContent || String(e.className)).trim().slice(0, 30)}`
  const covered = []
  for (const fx of [0.15, 0.5, 0.85]) for (const fy of [0.2, 0.5, 0.8]) {
    const top = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy)
    if (top && !el.contains(top) && !covered.includes(desc(top))) covered.push(desc(top))
  }
  const overlap = (b) => ({ l: Math.max(b.l, r.left), t: Math.max(b.t, r.top), r: Math.min(b.r, r.right), b: Math.min(b.b, r.bottom) })
  const hit = (b) => b.r - b.l > 0.5 && b.b - b.t > 0.5
  // what the entry hides: at a point of their overlap, the first thing below the entry is that element; a control a
  // sheet or panel already covers there is hidden by the sheet, whatever stands above it
  // Time: 9 elementsFromPoint calls per overlapping candidate, each walking the stack at that point.
  const hidden = (e, b) => {
    for (const fx of [0.2, 0.5, 0.8]) for (const fy of [0.2, 0.5, 0.8]) {
      const below = document.elementsFromPoint(b.l + (b.r - b.l) * fx, b.t + (b.b - b.t) * fy).find((x) => x !== el && !el.contains(x))
      if (below && (e === below || e.contains(below))) return true
    }
    return false
  }
  // Canvas's board world pans under every fixed thing by design (os-clock-check.mjs does not count it either)
  const under = [...document.querySelectorAll('button, a[href], input, select, textarea, [role=button], [data-xc-keep-clear], [data-omega-button], [data-toast-pill], .os-clock')]
    .filter((e) => e !== el && !el.contains(e) && !e.closest('.cv-world') && !e.closest('[inert],[aria-hidden="true"],[hidden]')
      && getComputedStyle(e).visibility !== 'hidden' && Number(getComputedStyle(e).opacity) > 0.05)
    .filter((e) => { const b = overlap(visible(e)); return hit(b) && hidden(e, b) })
    .map((e) => {
      // where it is, and the scroller holding it (its class), so a failure says which page end to look at
      const b = e.getBoundingClientRect()
      let s = e.parentElement
      while (s && !/(auto|scroll)/.test(getComputedStyle(s).overflowY)) s = s.parentElement
      return `${desc(e)} [${Math.round(b.top)}..${Math.round(b.bottom)}] in ${s ? String(s.className).split(' ').slice(0, 2).join('.') || s.tagName : 'the page'}`
    })
  return {
    name: el.getAttribute('aria-label'), word: !!el.querySelector('.feedback-entry-word') && getComputedStyle(el.querySelector('.feedback-entry-word')).display !== 'none',
    // the word whole, never cut to "Feedb…" by a skin's wider type
    wordFits: !el.querySelector('.feedback-entry-word') || el.querySelector('.feedback-entry-word').scrollWidth <= el.querySelector('.feedback-entry-word').clientWidth + 1,
    box: { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, covered, under,
  }
}, selector)

const go = async (page, where) => {
  const hash = where === 'swarm' ? `#/swarm/${await page.evaluate(() => [...window.__hiveSim.swarms.keys()][0])}`
    : where === 'dot' ? `#/dot/${await page.evaluate(() => [...window.__hiveSim.agents.keys()][0])}` : where
  await page.evaluate((h) => { location.hash = h }, hash)
  await sleep(900)
  return hash || '#/'
}

async function run(exp, vp) {
  const { ctx, page, errors } = await open(exp, vp)
  // ---- 1. on every page: shown, named, inside the window, topmost, nothing under it
  for (const where of PAGES) {
    const hash = await go(page, where)
    let s = await entryState(page)
    const name = `${exp} ${vp} ${hash}`
    // a page's content may pass under host chrome at rest, as under the Ask; scrolled to its end it must be clear (every
    // page and sheet ends its scroll area above the Ask's and the corner's reserve: ui/overlays ASK_RESERVE, osClock.css lift)
    const atRest = s.under
    if (!s.missing && !s.hidden && s.under.length) {
      // every scroller to its end at once, and measured once none is short of its end; when one is short again after the
      // measure, the page grew meanwhile (what the simulator loads after a page opens lengthens it: the swarms page grows
      // 233 px about a second in, on a fast machine after the first pass) and it is measured again from its new end. At
      // most 8 passes, so a page that keeps growing fails with the number of scrollers still short
      const toEnd = (scroll) => {
        let n = 0
        document.querySelectorAll('*').forEach((e) => {
          if (e.scrollHeight > e.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollTop + e.clientHeight < e.scrollHeight - 2) {
            if (scroll) e.scrollTo({ top: e.scrollHeight, behavior: 'instant' })
            n++
          }
        })
        return n
      }
      let short = 0
      for (let i = 0; i < 8; i++) {
        short = await page.evaluate(toEnd, true)
        await sleep(400)
        if (short) continue
        s = { ...(await entryState(page)), atRest }
        short = await page.evaluate(toEnd, false)
        if (!short) break
      }
      s = { ...s, atRest, short }
    }
    // named, with the drafts waiting after the name when there are some ("…, 1 draft waiting")
    const pass = !s.missing && !s.hidden && /^Send feedback or report a bug(, \d+ drafts? waiting)?$/.test(s.name ?? '') && s.inside && s.covered.length === 0 && s.under.length === 0
    // the clock beside it, measured the same way: what a page leaves under the host's corner whatever stands there
    const clock = pass ? null : await entryState(page, '.os-clock')
    ok(`${name}: the entry is shown, named, inside the window, topmost and clear`, pass, JSON.stringify({ entry: s, clock: clock && { under: clock.under, covered: clock.covered, hidden: clock.hidden } }))
    if (!pass) await page.screenshot({ path: `${OUT}/shots/${exp}-${vp}-${hash.replace(/[^a-z0-9]/gi, '_')}.png`, timeout: 90000, animations: 'disabled' }).catch(() => {})
  }
  // ---- 2. it says its word beside the clock and stays an icon standing on it
  const s = await entryState(page)
  // the entry's breakpoint (shell/clockModel FEEDBACK_BESIDE_MIN): 1024 px and wider, beside the clock with its word
  ok(`${exp} ${vp}: the word shows whole from 1024 px, the icon alone below`, s.word === (VPS[vp].viewport.width >= 1024) && s.wordFits, JSON.stringify(s))
  // ---- 3. it opens the area, which shows the whole report and holds the ways out until something is written
  await go(page, '')
  // the simulator's mind has drafted one report (api/sim/SimClient feedbackDrafts): the entry counts it
  const counted = await page.evaluate(() => ({ name: document.querySelector('.feedback-entry')?.getAttribute('aria-label'), count: document.querySelector('.feedback-entry-count')?.textContent }))
  ok(`${exp} ${vp}: the entry counts the drafts waiting`, counted.name === 'Send feedback or report a bug, 1 draft waiting' && counted.count === '1', JSON.stringify(counted))
  const centre = await page.evaluate(() => {
    const el = document.querySelector('.feedback-entry')
    const r = el.getBoundingClientRect()
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { hidden: el.hidden, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], top: top ? `${top.tagName}.${String(top.className).slice(0, 60)}` : null }
  })
  try {
    await page.locator('.feedback-entry').click({ timeout: 10000 })
  } catch (e) {
    ok(`${exp} ${vp}: the entry takes a press`, false, `${JSON.stringify(centre)} ${String(e).split('\n').slice(0, 6).join(' | ')}`)
    await page.screenshot({ path: `${OUT}/shots/${exp}-${vp}-press.png`, timeout: 90000, animations: 'disabled' }).catch(() => {})
    await ctx.close()
    return
  }
  const area = page.locator('[role="dialog"][aria-label="Send feedback or report a bug"]')
  try {
    await area.waitFor({ timeout: 15000 })
  } catch (e) {
    ok(`${exp} ${vp}: a press opens the area`, false, `${JSON.stringify(centre)} ${String(e).split('\n')[0]}`)
    await page.screenshot({ path: `${OUT}/shots/${exp}-${vp}-noarea.png`, timeout: 90000, animations: 'disabled' }).catch(() => {})
    await ctx.close()
    return
  }
  const text = await area.innerText()
  const report = await page.locator('[data-feedback-area] pre').innerText()
  ok(`${exp} ${vp}: the area shows what goes with the report`, /What goes with it/.test(text) && /Version/.test(text) && /Page/.test(text), text.slice(0, 300))
  ok(`${exp} ${vp}: the whole report shows, its first and last lines as the board reads them`,
    /^Omega report HR-[0-9a-f]{8} · bug · /.test(report) && /\nOriginal feedback ID: HR-[0-9a-f]{8}$/.test(report), report)
  // the picture is the person's to add: none on opening, an offer that says what a picture shows, then the picture
  const add = page.locator('[data-feedback-area] button', { hasText: 'Add a picture of this page' }).first()
  ok(`${exp} ${vp}: no picture goes until the person adds one, and the offer says what it shows`,
    (await page.locator('[data-feedback-area] img[src^="data:image/png"]').count()) === 0 && (await add.count()) === 1
    && /other people's names and messages included/.test(text), text.slice(0, 300))
  await add.click({ timeout: 10000 }).catch(() => {})
  await page.waitForFunction(() => {
    const a = document.querySelector('[data-feedback-area]')
    return !!a && (!!a.querySelector('img[src^="data:image/png"]') || /could not draw a picture/.test(a.textContent))
  }, null, { timeout: 30000 }).catch(() => {})
  ok(`${exp} ${vp}: added, a picture of the hive's own page, or a word that it could not be drawn`,
    (await page.locator('[data-feedback-area] img[src^="data:image/png"]').count()) === 1
    || /could not draw a picture/.test(await area.innerText()))
  const copy = page.locator('[data-feedback-area] button', { hasText: "Copy for the testers' group" }).first()
  ok(`${exp} ${vp}: nothing can leave before something is written`, await copy.isDisabled())
  await page.locator('[data-feedback-area] textarea').first().fill('The Ask stopped answering after I opened Settings.')
  await sleep(300)
  ok(`${exp} ${vp}: written, the report can be copied`, !(await copy.isDisabled()))
  // pressed by a mouse, Copy copies and says so (a press lost in a 3D look's transforms did nothing: index.css)
  await copy.click({ timeout: 10000 }).catch(() => {})
  await sleep(500)
  ok(`${exp} ${vp}: a press on Copy copies the report and says so`, /Copied\. Paste it in the group/.test(await page.locator('[data-feedback-area]').innerText()))
  ok(`${exp} ${vp}: the words are in the report as it goes`, /Summary: The Ask stopped answering after I opened Settings\./.test(await page.locator('[data-feedback-area] pre').innerText()))
  await page.screenshot({ path: `${OUT}/shots/${exp}-${vp}-area.png`, timeout: 90000, animations: 'disabled' }).catch(() => {})
  // a draft waits in the area to be used: its words start a report that says who drafted it, and nothing went
  const use = page.locator('[data-feedback-area] button', { hasText: 'Use it' }).first()
  const listed = (await page.locator('[data-feedback-area]').innerText()).includes('Drafted for you') && (await use.count()) === 1
  if (listed) await use.click()
  await sleep(400)
  const fromDraft = listed ? await page.locator('[data-feedback-area] pre').innerText() : ''
  ok(`${exp} ${vp}: a mind's draft is listed, and used it starts a report naming who drafted it`, listed && /Drafted by: .+, a mind/.test(fromDraft)
    && /Started from a draft by/.test(await page.locator('[data-feedback-area]').innerText()), fromDraft.slice(0, 300))
  // the hive's logs: gathered on a press, shown whole, and the file saved is the text shown
  const logsPre = page.locator('[data-feedback-area] pre[aria-label="Your hive\'s logs, as they go"]')
  await page.locator('[data-feedback-area] button', { hasText: 'Show the logs' }).first().click({ timeout: 10000 }).catch(() => {})
  await logsPre.waitFor({ timeout: 15000 }).catch(() => {})
  const shownLogs = (await logsPre.count()) === 1 ? await logsPre.innerText() : ''
  ok(`${exp} ${vp}: a press on Show the logs shows them whole`, /^Omega hive logs · /.test(shownLogs) && /\nRequests to the hive, newest first:\n/.test(shownLogs), shownLogs.slice(0, 300))
  const saving = page.waitForEvent('download', { timeout: 15000 }).catch(() => null)
  await page.locator('[data-feedback-area] button', { hasText: 'Save the logs' }).first().click({ timeout: 10000 }).catch(() => {})
  const download = await saving
  const savedLogs = download ? await readFile(await download.path(), 'utf8').catch(() => '') : ''
  ok(`${exp} ${vp}: Save the logs saves the text shown, under the time it was made`,
    !!download && /^omega-hive-logs-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ\.txt$/.test(download.suggestedFilename()) && savedLogs === `${shownLogs}\n`,
    `${download?.suggestedFilename()} ${savedLogs.length} vs ${shownLogs.length}`)
  await page.locator('button[aria-label="Close feedback"]').click()
  await sleep(600)
  ok(`${exp} ${vp}: closing it brings the entry back`, !(await entryState(page)).hidden)
  ok(`${exp} ${vp}: no page errors`, errors.length === 0, errors.join(' | '))
  await ctx.close()
}

const SIZES = process.env.CHECK_SIZES ? process.env.CHECK_SIZES.split(',') : Object.keys(VPS)
const jobs = EXPS.flatMap((exp) => SIZES.map((vp) => [exp, vp]))
const pool = Array.from({ length: Number(process.env.CHECK_JOBS ?? 4) }, async () => {
  for (let job = jobs.shift(); job; job = jobs.shift()) {
    try {
      await run(...job)
    } catch (e) {
      ok(`${job.join(' ')}: ran to the end`, false, String(e))
    }
  }
})
await Promise.all(pool)
await browser.close()
const failed = results.filter((r) => !r.pass)
await writeFile(`${OUT}/results.json`, JSON.stringify({ pages: PAGES, passed: results.length - failed.length, failed: failed.length, results }, null, 1))
console.log(`feedback-check: ${results.length - failed.length} passed, ${failed.length} failed (${PAGES.length} pages x ${EXPS.length} looks x ${SIZES.length} sizes)`)
for (const f of failed.slice(0, 40)) console.log(`FAIL ${f.name}\n     ${f.detail}`)
process.exit(failed.length ? 1 : 0)
