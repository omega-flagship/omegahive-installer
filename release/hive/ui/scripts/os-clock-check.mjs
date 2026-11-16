// OS clock: rendered checks (shell/OsClock.tsx). SIMULATOR ONLY (?sim=1), invented data: no live hive, no provider call.
// Serve a production build (`npx vite preview --host 127.0.0.1 --port <port>`), then:
//   node scripts/os-clock-check.mjs <port> <outDir> [browserPath]
// Every overlap of a control with the clock FAILS (no notes): the clock must be the topmost thing at its own points, and
// no visible control (fixed chrome or page content at its resting scroll) may sit under it.
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const require = createRequire(fileURLToPath(new URL('../package.json', import.meta.url)))
const { chromium } = require('playwright-core')
const PORT = process.argv[2] ?? '5491'
const OUT = process.argv[3] ?? '/tmp/os-clock-check'
const EXE = process.argv[4] ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
const BASE = `http://127.0.0.1:${PORT}`
await mkdir(`${OUT}/shots`, { recursive: true })
const EXPS = ['classic', 'still', 'canvas', 'cosmos', 'flux', 'construct']
const touch = { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
const VPS = {
  desk1440: { viewport: { width: 1440, height: 900 } },
  phone390: { viewport: { width: 390, height: 844 }, ...touch },
  phone360: { viewport: { width: 360, height: 780 }, ...touch },
  land844: { viewport: { width: 844, height: 390 }, ...touch },
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch({ executablePath: EXE, headless: true })
const results = []
const ok = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail).slice(0, 500) })

async function open(exp, vp, { rest = 60, hash = '', clock = null, locale = 'en-GB' } = {}) {
  const errors = []
  const ctx = await browser.newContext({ ...VPS[vp], locale })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
  await page.addInitScript(([e, m, c]) => {
    localStorage.setItem('omegahive.ui.look', JSON.stringify({ variant: null, layout: null, apps: null, experience: e === 'classic' ? null : e }))
    localStorage.setItem('omegadots.intro.welcome.v1', 'explore')
    localStorage.setItem('omegahive.rest', JSON.stringify({ minutes: m }))
    if (c) localStorage.setItem('omegahive.ui.clock', c)
  }, [exp, rest, clock])
  await page.goto(`${BASE}/?sim=1${hash}`)
  await page.waitForFunction(() => !!window.__hiveSim && !!document.querySelector('.os-clock'), null, { timeout: 30000 })
  await page.evaluate(() => { window.__hiveSim.running = false })
  await sleep(2200)
  // Construct: past its boot screen, so its command line row is on screen
  if (exp === 'construct') { await page.keyboard.press('Escape'); await sleep(1200) }
  return { ctx, page, errors }
}

/** The clock's box (null when hidden) and its semantics. */
const clockBox = (page) => page.evaluate(() => {
  const el = document.querySelector('.os-clock')
  if (!el || el.hidden) return null
  const r = el.getBoundingClientRect()
  if (!r.width) return null
  return { left: r.left, top: r.top, right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom), h: Math.round(r.height), w: Math.round(r.width), label: el.getAttribute('aria-label'), live: el.getAttribute('aria-live'), role: el.getAttribute('role'), kc: el.hasAttribute('data-xc-keep-clear'), text: el.querySelector('time')?.textContent }
})

/** Rendered occlusion: what is topmost at 9 points inside the clock, and which visible controls intersect it. */
const occlusion = (page) => page.evaluate(() => {
  const clock = document.querySelector('.os-clock')
  if (!clock || clock.hidden) return { covered: ['(clock hidden)'], under: [] }
  const c = clock.getBoundingClientRect()
  const covered = []
  for (const fx of [0.1, 0.5, 0.9]) for (const fy of [0.15, 0.5, 0.85]) {
    const top = document.elementFromPoint(c.left + c.width * fx, c.top + c.height * fy)
    if (top && !clock.contains(top)) covered.push(`${top.tagName}.${String(top.className).slice(0, 40)}`)
  }
  // visible part of an element: clipped by every overflow-clipping ancestor
  const visible = (e) => {
    const r = e.getBoundingClientRect()
    let b = { l: r.left, t: r.top, r: r.right, b: r.bottom }
    for (let a = e.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (/(hidden|auto|scroll|clip)/.test(cs.overflowX + cs.overflowY)) {
        const ar = a.getBoundingClientRect()
        b = { l: Math.max(b.l, ar.left), t: Math.max(b.t, ar.top), r: Math.min(b.r, ar.right), b: Math.min(b.b, ar.bottom) }
      }
    }
    return b
  }
  const hit = (b) => b.r - b.l > 0.5 && b.b - b.t > 0.5 && b.l < c.right && b.r > c.left && b.t < c.bottom && b.b > c.top
  const under = [...document.querySelectorAll('button, a[href], input, select, textarea, [role=button], [data-xc-keep-clear], [data-omega-button], [data-toast-pill]')]
    // Canvas's board world pans and zooms under every fixed thing (Ω, the dock, the clock) by design: its items are not
    // in a fixed place, so they are not counted; everything else, fixed chrome and page content alike, is
    .filter((e) => !clock.contains(e) && !e.closest('.cv-world') && !e.closest('[inert],[aria-hidden="true"],[hidden]') && getComputedStyle(e).visibility !== 'hidden' && Number(getComputedStyle(e).opacity) > 0.05 && hit(visible(e)))
    .map((e) => `${e.tagName}.${(e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 30)}`)
  return { covered, under }
})
const clear = async (page, name) => {
  const o = await occlusion(page)
  ok(`${name}: the clock is topmost at its own points`, o.covered.length === 0, o.covered.join(' | '))
  ok(`${name}: no control under or over it`, o.under.length === 0, o.under.join(' | '))
}
const dateShown = async (page) => (await sleep(400), page.evaluate(() => getComputedStyle(document.querySelector('.os-clock-date')).opacity === '1'))

// ---- 1. the identical slot in all six, at every size, and nothing under it
for (const vp of Object.keys(VPS)) {
  const boxes = {}
  for (const exp of EXPS) {
    const { ctx, page, errors } = await open(exp, vp)
    const b = await clockBox(page)
    boxes[exp] = b
    ok(`${vp} ${exp}: 12 px in from the right and bottom, 36 px tall`, b && b.right === 12 && b.bottom === 12 && b.h === 36, JSON.stringify(b))
    ok(`${vp} ${exp}: timer semantics, not announced, kept clear`, b && b.role === 'timer' && b.live === 'off' && b.kc && /^Time: \d{1,2}:\d\d( [AP]M)?, /.test(b.label), JSON.stringify(b))
    await clear(page, `${vp} ${exp}`)
    // the widest real faces fit the fixed slot unclipped ("23:58"; on a desktop also "12:58 PM")
    const fit = await page.evaluate((desk) => {
      const t = document.querySelector('.os-clock-time')
      const keep = t.innerHTML
      const res = []
      for (const face of desk ? ['23:58', '12:58<span class="os-clock-ampm">PM</span>'] : ['23:58']) {
        t.innerHTML = face
        res.push({ face, fits: t.scrollWidth <= t.clientWidth + 0.5, w: Math.round(document.querySelector('.os-clock').getBoundingClientRect().width) })
      }
      t.innerHTML = keep
      return res
    }, vp === 'desk1440' || vp === 'land844')
    ok(`${vp} ${exp}: the widest faces fit the slot unclipped`, fit.every((f) => f.fits), JSON.stringify(fit))
    if (exp === 'construct') ok(`${vp} construct: its status bar keeps no clock of its own`, !/\b\d\d:\d\d:\d\d\b/.test(await page.locator('.cx-status').innerText()))
    await page.screenshot({ path: `${OUT}/shots/${exp}-${vp}.png` })
    ok(`${vp} ${exp}: no page errors`, errors.length === 0, errors.join(' | '))
    await ctx.close()
  }
  const all = Object.values(boxes).filter(Boolean)
  ok(`${vp}: identical spot in all six`, all.length === 6 && all.every((b) => b.right === all[0].right && b.bottom === all[0].bottom && b.h === all[0].h), JSON.stringify(boxes))
}

// ---- 2. sheets and panels keep clear of it (desktop side sheet, phone bottom sheet, Flux's mind panel, Cosmos's deck)
for (const [exp, vp] of [['classic', 'desk1440'], ['classic', 'phone390'], ['cosmos', 'desk1440'], ['still', 'phone390']]) {
  const { ctx, page } = await open(exp, vp)
  const id = await page.evaluate(() => [...window.__hiveSim.agents.keys()][0])
  await page.evaluate((id) => { location.hash = `#/dot/${id}` }, id)
  await sleep(1500)
  const sheet = await page.evaluate(() => { const s = document.querySelector('[role="dialog"][aria-modal="false"]'); return s ? s.getBoundingClientRect().toJSON() : null })
  ok(`${exp} ${vp}: a mind's sheet is open`, !!sheet, JSON.stringify(sheet))
  await clear(page, `${exp} ${vp} with a mind's sheet open`)
  // the sheet's content scrolled to its end stays clear of the clock
  await page.evaluate(() => document.querySelectorAll('[role="dialog"][aria-modal="false"] *').forEach((e) => { if (e.scrollHeight > e.clientHeight + 4) e.scrollTop = e.scrollHeight }))
  await sleep(500)
  await clear(page, `${exp} ${vp} with the sheet scrolled to its end`)
  await page.screenshot({ path: `${OUT}/shots/${exp}-${vp}-sheet.png` })
  await ctx.close()
}
{
  const { ctx, page } = await open('flux', 'desk1440')
  const talk = page.locator('button[aria-label^="Talk to"]').first()
  if (await talk.count()) await talk.click()
  await sleep(1500)
  await clear(page, "flux desk1440 with a mind's panel open")
  await page.screenshot({ path: `${OUT}/shots/flux-desk1440-panel.png` })
  await ctx.close()
}
{
  const { ctx, page } = await open('cosmos', 'phone390')
  await page.locator('button[aria-label^="Flight deck"]').first().tap()
  await sleep(1500)
  await clear(page, 'cosmos phone390 with the flight deck open')
  await page.screenshot({ path: `${OUT}/shots/cosmos-phone390-deck.png` })
  await ctx.close()
}

// ---- 2b. pages: Goals and the Code page over Classic and over an experience, desktop and phone
for (const [exp, vp, hash] of [['classic', 'desk1440', '#/goals'], ['cosmos', 'desk1440', '#/goals'], ['classic', 'desk1440', '#/code'], ['classic', 'phone390', '#/code'], ['flux', 'desk1440', '#/code']]) {
  const { ctx, page } = await open(exp, vp, { hash })
  await sleep(1200)
  const b = await clockBox(page)
  ok(`${exp} ${vp} ${hash}: clock in the same spot`, b && b.right === 12 && b.bottom === 12 && b.h === 36, JSON.stringify(b))
  await clear(page, `${exp} ${vp} ${hash}`)
  await page.screenshot({ path: `${OUT}/shots/${exp}-${vp}-page-${hash.slice(2)}.png` })
  await ctx.close()
}

// ---- 3. a framed app (the frame-ops fixture over the sim's INVENTED ledger app, as scripts/.omegaui/frame-fit-shots.mjs):
// the lane follows the clock when it hides, returns, or changes width (no viewport change); full-bleed hides the clock
{
  const { readFile } = await import('node:fs/promises')
  // the fixture lives with the dev scripts (scripts/.omegaui/frame-ops); a release tree without them points FRAME_OPS at a copy
  const dir = process.env.FRAME_OPS ? new URL(`file://${process.env.FRAME_OPS.replace(/\/?$/, '/')}`) : new URL('./.omegaui/frame-ops/', import.meta.url)
  const files = Object.fromEntries(await Promise.all(['index.html', 'app.js', 'style.css'].map(async (f) => [f, await readFile(new URL(f, dir), 'utf8')])))
  const ctx = await browser.newContext(VPS.desk1440)
  const page = await ctx.newPage()
  await page.addInitScript(({ files }) => {
    if (window.top !== window) return
    localStorage.setItem('omegadots.intro.welcome.v1', 'explore')
    localStorage.setItem('omegahive.rest', JSON.stringify({ minutes: 60 }))
    let held
    Object.defineProperty(window, '__hiveSim', {
      configurable: true,
      get: () => held,
      set: (sim) => {
        held = sim
        sim.simSession = 'person'
        sim.programsHost.installInvented('ledger-fixture')
        const list = sim.programs.bind(sim)
        sim.programs = async () => (await list()).map((p) => (p.id === 'ledger-fixture' ? { ...p, ui: true } : p))
        sim.programUi = async (id) => ({ program: id, files })
      },
    })
  }, { files })
  await page.goto(`${BASE}/?sim=1#/program/ledger-fixture/s_lyra`)
  const TITLE = 'iframe[title="ledger-fixture interface"]'
  await page.locator(TITLE).waitFor({ timeout: 60000 })
  await page.waitForSelector('[data-toast-place="framed"]', { timeout: 30000 }).catch(() => null)
  await sleep(1500)
  const lane = () => page.evaluate(() => { const l = document.querySelector('[data-toast-place="framed"]'); return l ? parseFloat(l.style.right) : null })
  const room = () => page.evaluate(() => { const c = document.querySelector('.os-clock'); const r = c.getBoundingClientRect(); return r.width ? Math.ceil(innerWidth - r.left + 8) : 0 })
  const b = await clockBox(page)
  ok('framed app: clock in the same spot', b && b.right === 12 && b.bottom === 12, JSON.stringify(b))
  await clear(page, 'framed app')
  const r0 = await room()
  ok('framed app: the notice lane ends before the clock', (await lane()) >= r0 && r0 > 0, `lane=${await lane()} room=${r0}`)
  await page.screenshot({ path: `${OUT}/shots/classic-desk1440-framed-app.png` })
  await page.evaluate(() => { const d = document.createElement('div'); d.id = 'fake-modal'; d.setAttribute('aria-modal', 'true'); document.body.appendChild(d) })
  await sleep(600)
  ok('framed app: clock hidden under a modal; the lane lets go of its room', !(await clockBox(page)) && (await lane()) === 12, `lane=${await lane()}`)
  await page.evaluate(() => document.getElementById('fake-modal').remove())
  await sleep(600)
  ok('framed app: clock back; the lane takes its room again (no resize)', !!(await clockBox(page)) && (await lane()) >= (await room()), `lane=${await lane()} room=${await room()}`)
  await page.addStyleTag({ content: '.os-clock { padding: 0 40px !important }' })
  await sleep(600)
  const r1 = await room()
  ok('framed app: a wider clock widens the lane clearance (no resize)', r1 > r0 && (await lane()) >= r1, `lane=${await lane()} room=${r1} was ${r0}`)
  const full = page.frameLocator(TITLE).locator('#full')
  if (await full.count()) {
    await full.evaluate((b) => b.click())
    await sleep(1500)
    ok('full-bleed app: the clock steps aside (the frame owns the whole stage by contract)', !(await clockBox(page)), await page.evaluate(() => document.documentElement.dataset.appStage))
  } else ok('full-bleed app: fixture has a full-bleed switch', false)
  await ctx.close()
}

// ---- 4. focus, tap, hover: the date; keyboard reach
{
  const { ctx, page } = await open('classic', 'desk1440')
  let reached = false
  for (let i = 0; i < 120 && !reached; i++) {
    await page.keyboard.press('Tab')
    reached = await page.evaluate(() => document.activeElement?.classList.contains('os-clock'))
  }
  ok('keyboard: Tab reaches the clock', reached)
  ok('keyboard focus shows the date', reached && (await dateShown(page)))
  await page.screenshot({ path: `${OUT}/shots/classic-desk1440-focus-date.png` })
  await ctx.close()
}
{
  const { ctx, page } = await open('flux', 'phone390', { clock: '12', locale: 'en-US' })
  await page.locator('.os-clock').tap()
  await sleep(300)
  ok('phone: a tap shows the date (with the day period the phone face drops)', await dateShown(page), await page.locator('.os-clock-date').innerText())
  await page.screenshot({ path: `${OUT}/shots/flux-phone390-tap-date.png` })
  await ctx.close()
}

// ---- 5. Still: the question row's controls never sit under the clock, at any scroll, by pointer or keyboard
// (the row's rightmost control: "speak" where voice is in, else the field itself)
for (const vp of ['land844', 'phone390', 'phone360']) {
  const { ctx, page } = await open('still', vp)
  const pick = `(() => { const row = document.querySelector('.st-ask-line'); const cs = [...row.querySelectorAll('button, input, a[href]')]; return cs.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0] })()`
  const rowClear = () => page.evaluate(() => {
    const s = document.querySelector('.st-ask-line').getBoundingClientRect()
    const c = document.querySelector('.os-clock').getBoundingClientRect()
    return s.right <= c.left - 4
  })
  const name = await page.evaluate(`(${pick}).getAttribute('aria-label') || (${pick}).textContent || (${pick}).tagName`)
  ok(`still ${vp}: the question row (rightmost control: ${String(name).trim().slice(0, 20)}) ends before the clock's column`, await rowClear())
  await page.evaluate(() => {
    const sc = document.querySelector('.still-scroll')
    const line = document.querySelector('.st-ask-line').getBoundingClientRect()
    sc.scrollTop += line.bottom - (innerHeight - 30)
  })
  await sleep(600)
  const atPoint = await page.evaluate(`(() => { const b = ${pick}; const s = b.getBoundingClientRect(); const t = document.elementFromPoint(Math.min(s.right - 4, s.left + s.width / 2), s.top + s.height / 2); return !!t && (t === b || b.contains(t)) })()`)
  ok(`still ${vp}: with the row on the clock's row, a pointer reaches its rightmost control`, atPoint)
  await clear(page, `still ${vp} with the question row on the bottom row`)
  await page.screenshot({ path: `${OUT}/shots/still-${vp}-row-at-bottom.png` })
  ok(`still ${vp}: keyboard focus lands on it, not under the clock`, await page.evaluate(`(() => { const b = ${pick}; b.focus(); return document.activeElement === b })()`) && (await rowClear()))
  await ctx.close()
}

// ---- 6. 12-hour preference; modal; rest
{
  const { ctx, page } = await open('still', 'desk1440', { clock: '12', locale: 'en-US' })
  const b = await clockBox(page)
  ok('12-hour preference: "9:43" with a day period', b && /^\d{1,2}:\d\d(AM|PM)$/.test(b.text.replace(/\s/g, '')) && /(AM|PM),/.test(b.label), JSON.stringify(b))
  await page.screenshot({ path: `${OUT}/shots/still-desk1440-12h.png` })
  await ctx.close()
}
for (const exp of ['classic', 'cosmos']) {
  const { ctx, page } = await open(exp, 'desk1440', { rest: 0.05 })
  const rested = await page.waitForSelector('[data-rest]', { timeout: 20000 }).then(() => true, () => false)
  // sampled together, every frame for 3 s: whenever the rest is up, the clock is hidden
  const samples = await page.evaluate(() => new Promise((done) => {
    const out = []
    const t0 = performance.now()
    const tick = () => {
      out.push({ rest: !!document.querySelector('[data-rest]'), clock: !document.querySelector('.os-clock')?.hidden })
      if (performance.now() - t0 < 3000) requestAnimationFrame(tick)
      else done(out)
    }
    tick()
  }))
  const up = samples.filter((x) => x.rest)
  ok(`${exp}: hidden while resting (every frame the rest is up)`, rested && up.length > 0 && up.every((x) => !x.clock), `rested=${rested} restFrames=${up.length} clockShownDuringRest=${up.filter((x) => x.clock).length}`)
  await page.mouse.move(300, 300)
  await page.mouse.move(360, 340)
  await sleep(800)
  ok(`${exp}: back after waking`, !!(await clockBox(page)))
  await ctx.close()
}
// ---- 7. frame by frame (r3): the Ask on the clock's row never overlaps it, through a modal closing, the clock widening
// (hour cycle switched in place, a forced wider style) and a rotation. Every animation frame is sampled; zero may overlap.
/** Samples every frame for `ms`, running `act` (a page-side function body) at 250 ms; returns overlapping frames. */
const frames = (page, act, ms = 1800) => page.evaluate(([act, ms]) => new Promise((done) => {
  const run = new Function(act)
  const out = { frames: 0, overlap: 0, clockFrames: 0, askFrames: 0, worst: 0 }
  const t0 = performance.now()
  let acted = false
  const tick = () => {
    const now = performance.now() - t0
    if (!acted && now >= 250) { acted = true; run() }
    const clock = document.querySelector('.os-clock')
    const c = clock && !clock.hidden ? clock.getBoundingClientRect() : null
    const asks = [...document.querySelectorAll('.ask-dock, .ask-still-line')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0)
    out.frames++
    if (c && c.width) out.clockFrames++
    if (asks.length) out.askFrames++
    if (c && c.width) for (const a of asks) {
      const ov = Math.max(0, Math.min(a.right, c.right) - Math.max(a.left, c.left)) * Math.max(0, Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top))
      if (ov > 0) { out.overlap++; out.worst = Math.max(out.worst, ov) }
    }
    if (now < ms) requestAnimationFrame(tick)
    else done(out)
  }
  requestAnimationFrame(tick)
}), [act, ms])
const onRow = (page) => page.evaluate(() => {
  const a = [...document.querySelectorAll('.ask-dock, .ask-still-line')].map((e) => e.getBoundingClientRect()).find((r) => r.width > 0)
  return a ? Math.round(innerHeight - a.bottom) : null
})
for (const [exp, vp] of [['classic', 'phone390'], ['classic', 'phone360'], ['still', 'phone390']]) {
  const { ctx, page } = await open(exp, vp, { locale: 'en-US' })
  // a phone route without the tab bar: a mind's sheet (classic); Still's own line once its question box is scrolled away
  if (exp === 'classic') {
    const id = await page.evaluate(() => [...window.__hiveSim.agents.keys()][0])
    await page.evaluate((id) => { location.hash = `#/dot/${id}` }, id)
  } else await page.evaluate(() => { document.querySelector('.still-scroll').scrollTop = 1400 })
  await sleep(1500)
  const row = await onRow(page)
  ok(`${exp} ${vp}: the Ask sits on the clock's row (no tab bar)`, row !== null && row <= 60, `ask bottom gap=${row}`)
  const name = `${exp} ${vp}`
  const m = await frames(page, "const d = document.createElement('div'); d.id = 'fm'; d.setAttribute('aria-modal', 'true'); document.body.appendChild(d); setTimeout(() => d.remove(), 600)")
  ok(`${name}: through a modal opening and closing, 0 frames overlap`, m.overlap === 0 && m.clockFrames > 0 && m.askFrames > 0, JSON.stringify(m))
  const c12 = await frames(page, "window.__osClock.setHourCycle('12')")
  const c24 = await frames(page, "window.__osClock.setHourCycle('24')")
  ok(`${name}: switching the hour cycle in place (12, then 24: wider), 0 frames overlap`, c12.overlap === 0 && c24.overlap === 0 && c24.clockFrames > 0, JSON.stringify({ c12, c24 }))
  const wide = await frames(page, "const s = document.createElement('style'); s.textContent = '.os-clock { letter-spacing: .4em !important; font-size: 22px !important }'; document.head.appendChild(s)")
  const w = await page.evaluate(() => Math.round(document.querySelector('.os-clock').getBoundingClientRect().width))
  ok(`${name}: a forced wider clock stays inside its slot (${w} px) and 0 frames overlap`, wide.overlap === 0 && w <= 60, JSON.stringify(wide))
  await page.screenshot({ path: `${OUT}/shots/${exp}-${vp}-ask-on-row.png` })
  await ctx.close()
}
{
  // rotation: 390x844 to 844x390 and back, the Ask and clock both re-placed; overlap frames are counted and reported
  const { ctx, page } = await open('classic', 'phone390')
  const id = await page.evaluate(() => [...window.__hiveSim.agents.keys()][0])
  await page.evaluate((id) => { location.hash = `#/dot/${id}` }, id)
  await sleep(1500)
  const pending = frames(page, '', 2400)
  await sleep(300)
  await page.setViewportSize({ width: 844, height: 390 })
  await sleep(900)
  await page.setViewportSize({ width: 390, height: 844 })
  const r = await pending
  ok('classic phone: through a rotation and back, 0 frames overlap', r.overlap === 0, JSON.stringify(r))
  await ctx.close()
}
await browser.close()
const pass = results.filter((r) => r.pass).length
await writeFile(`${OUT}/browser-results.json`, JSON.stringify(results, null, 1))
await writeFile(`${OUT}/browser-results.md`, `# OS clock rendered checks (simulator, invented data)\n\n${pass}/${results.length} passed\n\n` + results.map((r) => `- ${r.pass ? 'PASS' : 'FAIL'} ${r.name}${r.pass ? '' : ` — ${r.detail}`}`).join('\n') + '\n')
console.log(`${pass}/${results.length}`)
results.filter((r) => !r.pass).forEach((r) => console.log('FAIL', r.name, '—', r.detail))
process.exitCode = pass === results.length ? 0 : 1
