// Screenshot + console-error audit of the built app in sim mode.
// Usage: npm run build && npm run shots   (starts `vite preview` itself)
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { chromium } from 'playwright-core'

// a free port, so a preview server from another project cannot answer for us
const PORT = Number(process.env.SHOTS_PORT) || (await new Promise((resolve) => {
  const srv = createServer()
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address()
    srv.close(() => resolve(port))
  })
}))
const BASE = `http://localhost:${PORT}/?sim=1`
const OUT = new URL('../screenshots/', import.meta.url).pathname
const only = process.argv[2] // optional: "mobile" | "desktop" | "lab" | "programs" (only that feature, both sizes)

await mkdir(OUT, { recursive: true })

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe', detached: true })
server.stdout.resume()
server.stderr.resume()
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`http://localhost:${PORT}/`)).ok) break
  } catch {
    /* not up yet */
  }
  if (i > 60) throw new Error('vite preview did not start')
  await new Promise((r) => setTimeout(r, 300))
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const errors = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The Lab: overview, a live drift replay, the drift board, Epistemic Resolve, a case, history, a dimension. */
async function lab(page, shot, go, mobile) {
  const scroll = async (y) => {
    await page.evaluate((top) => {
      const el = [...document.querySelectorAll('section[role=dialog] .overflow-y-auto')].pop()
      if (el) el.scrollTop = top
    }, y)
    await sleep(500)
  }
  const dismiss = async () => {
    for (const b of await page.getByRole('button', { name: 'Dismiss' }).all()) await b.click().catch(() => undefined)
  }
  await go('#/lab')
  await sleep(2200)
  await dismiss()
  await shot('19-lab')
  await scroll(mobile ? 900 : 640)
  await shot('19a-lab-suites')
  // start the drift scenarios and watch them stream
  await go('#/lab/bench-drift')
  await sleep(1400)
  await page.getByRole('button', { name: 'Run Drift scenarios', exact: true }).first().click()
  await sleep(mobile ? 3200 : 3000)
  await dismiss()
  await shot('19b-lab-drift-live')
  await sleep(4000)
  await dismiss()
  await scroll(0)
  await shot('19c-lab-drift')
  await scroll(mobile ? 560 : 330)
  await shot('19d-lab-drift-scenarios')
  // scrub the echo storm back to an early step
  const slider = page.getByRole('slider').first()
  await slider.focus()
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowLeft')
  await sleep(400)
  await shot('19e-lab-drift-replay')
  await go('#/lab/bench-epistemic')
  await sleep(2000)
  await shot('19f-lab-epistemic')
  await scroll(mobile ? 900 : 520)
  await shot('19g-lab-epistemic-verdicts')
  // a benchmark case opened: metric tiles and charts
  await go('#/lab/bench-core')
  await sleep(2000)
  await page.getByRole('button', { name: /Publish throughput/ }).first().click()
  await sleep(700)
  await scroll(mobile ? 240 : 160)
  await shot('19h-lab-case')
  await go('#/lab/bench-core/history')
  await sleep(2000)
  await shot('19i-lab-history')
  await scroll(mobile ? 640 : 520)
  await shot('19j-lab-history-runs')
  await go('#/lab/dim/cost')
  await sleep(2200)
  await shot('19k-lab-dimension')
  await go('#/lab/tests-runtime')
  await sleep(2200)
  await page.getByPlaceholder('Search cases').fill('memory')
  await sleep(600)
  await shot('19l-lab-tests')
  await go('#/dot/a_vega01/model')
  await sleep(1500)
  await dismiss()
  await shot('19m-dot-lab-guards')
}

/** Dot programs: the index, the four stages of the fixture, the morph, sources, a correction, a task, a stale notice. */
async function programs(page, shot, go, mobile) {
  const node = (re) => page.getByRole('button', { name: re }).first()
  const dismiss = async () => {
    for (const b of await page.getByRole('button', { name: 'Dismiss' }).all()) await b.click().catch(() => undefined)
  }
  const drawer = async (open) => {
    if (!mobile) return
    const t = page.locator('section[aria-label="Inspector"] > button[aria-expanded]').first()
    if ((await t.getAttribute('aria-expanded')) !== String(open)) await t.click()
    await sleep(500)
  }
  const tool = (name) => page.getByRole('toolbar').getByRole('button', { name, exact: true }).first()
  await go('#/programs')
  await sleep(1600)
  await dismiss()
  await shot('20-programs')
  await go('#/program/contract-fixture/s_lyra')
  await sleep(2200)
  await dismiss()
  await shot('21-program-unfold')
  // pick the claim and unfold it: items move to their new rings; catch the morph mid-flight
  await node(/^Claim: The footbridge/).click()
  await sleep(300)
  await drawer(true)
  await tool('Unfold').click()
  await drawer(false)
  await sleep(mobile ? 160 : 220)
  await shot('21m-program-morph')
  await sleep(1600)
  await shot('21b-program-unfold-claim')
  // the sources rail: two council sources share one origin
  await drawer(true)
  await shot('22-program-sources')
  const open = page.getByRole('button', { name: /^Open source Council inspection report/ }).first()
  await open.click()
  await sleep(900)
  await shot('22b-program-source-opened')
  await drawer(false)
  // map: follow the counterevidence, then the rival hypothesis
  await node(/^Evidence: Engineer reports/).click()
  await sleep(300)
  await drawer(true)
  await tool('Follow').click()
  await drawer(false)
  await sleep(1800)
  await shot('23-program-map')
  await node(/^Hypothesis: The rating was reduced/).click()
  await sleep(300)
  await drawer(true)
  await tool('Follow').click()
  await drawer(false)
  await sleep(1800)
  await shot('23b-program-map-grown')
  // compare the claim with the rival hypothesis
  await node(/^Claim: The footbridge/).click()
  await sleep(250)
  if (mobile) {
    await drawer(true)
    await page.getByRole('button', { name: /Select more/ }).click()
    await drawer(false)
    await node(/^Hypothesis: The rating was reduced/).click()
  } else {
    await node(/^Hypothesis: The rating was reduced/).click({ modifiers: ['Shift'] })
  }
  await sleep(300)
  await drawer(true)
  await page.getByRole('button', { name: /^Compare 2$/ }).click()
  await drawer(false)
  await sleep(2000)
  await dismiss()
  await shot('24-program-compare')
  // detail: open the inspection evidence, correct it (needs_input, then the retry)
  await node(/^Evidence: Inspection report lists/).dblclick()
  await sleep(1600)
  await shot('25-program-detail')
  await page.getByRole('toolbar', { name: 'Actions for this item' }).getByRole('button', { name: 'Correct' }).click()
  await sleep(900)
  await page.locator('form textarea').first().fill('Inspection report lists a 5 t rating, valid until the 2025 flood')
  await page.locator('form input, form textarea').nth(1).fill('the rating expired with the flood damage')
  await sleep(300)
  await shot('25b-program-needs-input')
  await page.getByRole('button', { name: 'Send' }).click()
  await sleep(1600)
  const scrollDetail = async (y) => {
    await page.evaluate((top) => {
      const el = [...document.querySelectorAll('.overflow-y-auto')].find((x) => x.querySelector('[aria-label="Revisions"]'))
      if (el) el.scrollTop = top
    }, y)
    await sleep(500)
  }
  await scrollDetail(mobile ? 820 : 520)
  await shot('26-program-corrected')
  await scrollDetail(0)
  await page.getByRole('button', { name: /The footbridge is rated for 5 t.*Open it\.$/ }).first().click()
  await sleep(1600)
  await dismiss()
  await shot('26b-program-affected')
  // a long action becomes a swarm goal
  await go('#/program/contract-fixture/s_lyra')
  await page.getByRole('radio', { name: 'Unfold' }).click()
  await sleep(1400)
  await node(/^Gap: No inspection/).click()
  await sleep(300)
  await drawer(true)
  await tool('Investigate').click()
  await sleep(1400)
  await drawer(false)
  await shot('27-program-task')
  // someone else corrects behind our back: our next action is stale and reconciles
  await page.evaluate(async () => {
    const sim = window.__hiveSim
    const v = await sim.programView('contract-fixture', { swarm_id: 's_lyra' })
    await sim.programAct('contract-fixture', { swarm_id: 's_lyra', action: 'correct', items: ['e2'], base_revision: v.revision, params: { text: 'Press release repeats the 5 t rating (pre-flood)', note: 'dated' } })
  })
  await node(/^Claim: The footbridge/).click()
  await sleep(300)
  await drawer(true)
  await tool('Challenge').click()
  await drawer(false)
  await sleep(1500)
  await shot('28-program-stale')
  // the same program in a dot's own panel
  await go('#/dot/a_vega01/program/commons-explorer')
  await sleep(2600)
  await dismiss()
  await shot('29-program-in-dot')
}

async function runPrograms(name, viewport, opts) {
  const ctx = await browser.newContext({ viewport, ...opts })
  const page = await ctx.newPage()
  page.on('console', (m) => m.type() === 'error' && errors.push(`[${name}] console: ${m.text()}`))
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror: ${e.message}`))
  const shot = async (label) => {
    const path = `${OUT}${label}-${name}.png`
    await page.screenshot({ path })
    console.log('saved', path)
  }
  await page.goto(`${BASE}#/`)
  await page.waitForSelector('canvas')
  await sleep(2500)
  await programs(page, shot, (h) => page.evaluate((x) => (window.location.hash = x), h), viewport.width < 768)
  await ctx.close()
}

async function runLab(name, viewport, opts) {
  const ctx = await browser.newContext({ viewport, ...opts })
  const page = await ctx.newPage()
  page.on('console', (m) => m.type() === 'error' && errors.push(`[${name}] console: ${m.text()}`))
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror: ${e.message}`))
  const shot = async (label) => {
    const path = `${OUT}${label}-${name}.png`
    await page.screenshot({ path })
    console.log('saved', path)
  }
  await page.goto(`${BASE}#/`)
  await page.waitForSelector('canvas')
  await sleep(2500)
  await lab(page, shot, (h) => page.evaluate((x) => (window.location.hash = x), h), viewport.width < 768)
  await ctx.close()
}

async function run(name, viewport, opts) {
  const ctx = await browser.newContext({ viewport, ...opts })
  const page = await ctx.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${name}] console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror: ${e.message}`))
  const shot = async (label) => {
    const path = `${OUT}${label}-${name}.png`
    await page.screenshot({ path })
    console.log('saved', path)
  }
  const go = async (hash) => {
    await page.evaluate((h) => (window.location.hash = h), hash)
  }
  const mobile = viewport.width < 768

  // live mode without a server: the operator login screen
  await page.goto(`http://localhost:${PORT}/?sim=0#/`)
  await page.waitForSelector('form[aria-label="Operator login"]')
  await sleep(1200)
  await shot('00-login')

  await page.goto(`${BASE}#/`)
  await page.waitForSelector('canvas')
  await sleep(7000)
  await shot('01-hive')

  // hover (desktop) or tap (touch) a dot for its compact card
  const pos = await page.evaluate(() => window.__hiveScene?.screenPos('a_deneb2'))
  if (pos) {
    if (mobile) await page.touchscreen.tap(pos.x, pos.y)
    else await page.mouse.move(pos.x, pos.y)
    await sleep(700)
    await shot('01b-dot-card')
    if (mobile) await page.touchscreen.tap(10, 400)
    else await page.mouse.move(5, 450)
    await sleep(300)
  }

  // dot panel with chat: send a message and wait for the streamed reply
  await go('#/dot/a_vega01')
  await sleep(1500)
  const box = page.getByPlaceholder('Message Vega…')
  await box.fill('What do you believe most?')
  await box.press('Enter')
  await sleep(6500)
  await shot('02-dot-chat')

  // swarm view: the commons constellation, then provenance open
  await go('#/swarms/s_lyra')
  await sleep(2200)
  await shot('03a-swarm')
  await go(`#/swarms/s_lyra?b=${encodeURIComponent('(--> rr-lyrae variable)')}`)
  await sleep(2200)
  await shot('03-swarm-provenance')

  // create flow
  await go('#/new?swarm=s_kelp')
  await sleep(1000)
  await page.locator('#dot-name').fill('Lumen')
  await sleep(500)
  await shot('04-create')
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Continue' }).click()
    await sleep(450)
  }
  await page.getByRole('button', { name: /Bring Lumen to life/ }).click()
  await sleep(1300)
  await shot('05-birth')
  await sleep(1800)
  await shot('06-token')
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Done' }).click()
  await sleep(400)

  // usage
  await go('#/usage')
  await sleep(2200)
  await shot('07-usage')

  // command palette
  await go('#/')
  await sleep(1200)
  if (mobile) await page.getByRole('button', { name: 'Search and commands' }).first().click()
  else await page.keyboard.press('Control+k')
  await sleep(400)
  await page.keyboard.type('wa')
  await sleep(500)
  await shot('08-palette')
  await page.keyboard.press('Escape')
  await sleep(300)

  // ---------------------------------------------------------------- Phase 2
  const clearToasts = async () => {
    for (const b of await page.getByRole('button', { name: 'Dismiss' }).all()) await b.click().catch(() => undefined)
    await sleep(250)
  }
  const expandSheet = async () => {
    if (!mobile) return
    const b = page.getByRole('button', { name: 'Expand panel' })
    if (await b.count()) await b.first().click()
    await sleep(700)
  }

  // the approvals inbox with pending items, then the confirmation stamp
  await go('#/approvals')
  await sleep(1600)
  await clearToasts()
  await shot('10-approvals')
  await page.getByRole('button', { name: 'Approve', exact: true }).first().click()
  await sleep(mobile ? 420 : 380)
  await shot('10b-approval-stamp')
  await sleep(1200)
  await page.getByRole('radio', { name: 'History' }).click()
  await sleep(800)
  await clearToasts()
  await shot('10c-approvals-history')

  // policy rules editor with the defaults help open
  await go('#/approvals/rules')
  await sleep(1400)
  await clearToasts()
  await shot('11-policy')
  await page.getByRole('button', { name: /How the gate decides/ }).click()
  await sleep(600)
  await page.getByRole('button', { name: /How the gate decides/ }).scrollIntoViewIfNeeded()
  await sleep(300)
  await shot('11b-policy-help')

  // goals board in the swarm view, and as its own route
  await go('#/swarms/s_forge')
  await sleep(1500)
  await page.getByRole('radio', { name: 'Goals' }).click()
  await sleep(1200)
  await clearToasts()
  await shot('12-goals-swarm')
  await go('#/goals/s_lyra')
  await sleep(1500)
  await page.getByPlaceholder(/Add a goal for/).fill('Re-measure the Vega dust disk with the new spectra')
  await page.getByPlaceholder(/Add a goal for/).press('Enter')
  await sleep(5200)
  await clearToasts()
  await shot('12b-goals-page')

  // the Mind timeline ("watch it think")
  await go('#/dot/a_anvl09/mind')
  await sleep(1800)
  await expandSheet()
  await clearToasts()
  await shot('13-mind')
  await page.getByRole('radio', { name: 'Errors' }).click()
  await sleep(700)
  await shot('13b-mind-errors')

  // memory inspector with a search and a queued retirement
  await go('#/dot/a_vega01/memory')
  await sleep(1500)
  await expandSheet()
  await page.getByPlaceholder(/Search atoms/).fill('vega')
  await sleep(900)
  await page.getByRole('button', { name: /Retire atom/ }).first().click()
  await sleep(300)
  await page.getByRole('button', { name: 'Retire', exact: true }).click()
  await sleep(700)
  await clearToasts()
  await shot('14-memory')
  await page.getByRole('button', { name: 'Reset…' }).click()
  await sleep(400)
  await page.getByPlaceholder('Vega', { exact: true }).fill('Vega')
  await sleep(300)
  await shot('14b-memory-reset')
  await page.keyboard.press('Escape')
  await sleep(400)

  // wakeups + idle auto-sleep, then the composer
  await go('#/dot/a_anvl09/schedule')
  await sleep(1500)
  await expandSheet()
  await clearToasts()
  await shot('15-wakeups')
  await page.getByRole('button', { name: 'New wakeup' }).click()
  await sleep(600)
  await page.getByPlaceholder(/Pull fresh photometry/).fill('Check the retry queue and drain it if it is over 100.')
  await sleep(300)
  await shot('15b-wakeup-composer')

  // scene cues: gold task glyphs on claimants, amber halo on dots waiting for a human
  await go('#/')
  await sleep(1200)
  await page.evaluate(() => window.__hiveScene?.focus('a_anvl09'))
  await sleep(2500)
  await clearToasts()
  await shot('16-scene-cues')

  // a dot whose model calls are refused by the gateway (429 rate_limited)
  await go('#/dot/a_qnch11/model')
  await sleep(1500)
  await clearToasts()
  await shot('18-dot-gateway-error')
  await go('#/')
  await sleep(800)

  // global kill switch from the command palette
  if (mobile) await page.getByRole('button', { name: 'Search and commands' }).first().click()
  else await page.keyboard.press('Control+k')
  await sleep(400)
  await page.keyboard.type('stop all')
  await sleep(300)
  await page.keyboard.press('Enter')
  await sleep(600)
  await page.getByPlaceholder('stop all', { exact: true }).fill('stop all')
  await sleep(300)
  await shot('17-stop-all')
  await page.keyboard.press('Escape')
  await sleep(300)

  await lab(page, shot, go, mobile)
  await programs(page, shot, go, mobile)

  await ctx.close()
}

try {
  if (only === 'programs') {
    await runPrograms('mobile', { width: 390, height: 844 }, { deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    await runPrograms('desktop', { width: 1440, height: 900 }, { deviceScaleFactor: 1 })
  } else if (only === 'lab') {
    await runLab('mobile', { width: 390, height: 844 }, { deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    await runLab('desktop', { width: 1440, height: 900 }, { deviceScaleFactor: 1 })
  } else if (only !== 'desktop') await run('mobile', { width: 390, height: 844 }, { deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  if (only !== 'mobile' && only !== 'lab' && only !== 'programs') await run('desktop', { width: 1440, height: 900 }, { deviceScaleFactor: 1 })
  if (!only) {
    // prefers-reduced-motion: the scene should be calm (no dust storm, no glitch jitter)
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errors.push(`[reduced] pageerror: ${e.message}`))
    page.on('console', (m) => m.type() === 'error' && errors.push(`[reduced] console: ${m.text()}`))
    await page.goto(`${BASE}#/`)
    await sleep(5000)
    await page.screenshot({ path: `${OUT}09-hive-reduced-motion-desktop.png` })
    console.log('saved', `${OUT}09-hive-reduced-motion-desktop.png`)
    await ctx.close()
  }
} finally {
  await browser.close()
  try {
    process.kill(-server.pid)
  } catch {
    server.kill()
  }
}

if (errors.length) {
  console.log(`\n${errors.length} console error(s):`)
  for (const e of errors) console.log(' ', e)
  process.exitCode = 1
} else {
  console.log('\nNo console errors.')
}
process.exit(process.exitCode ?? 0)
