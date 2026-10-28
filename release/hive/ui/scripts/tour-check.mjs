// End-to-end check of the guided tour in headless Chromium, where speechSynthesis has no voices:
// the captions-only fallback must run the whole tour, every chapter's targets must be found, and the
// app must be put back where it was. Plays at high speed.
// Usage: npm run build && node scripts/tour-check.mjs            (the app, ?sim=1)
//        npm run build:demo && node scripts/tour-check.mjs demo  (the published demo build)
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { chromium } from 'playwright-core'

const demo = process.argv[2] === 'demo'
const SPEED = Number(process.env.TOUR_SPEED) || 6
const PORT = await new Promise((resolve) => {
  const srv = createServer()
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address()
    srv.close(() => resolve(port))
  })
})
const ORIGIN = `http://localhost:${PORT}`
const BASE = demo ? `${ORIGIN}/` : `${ORIGIN}/?sim=1`

const args = ['vite', 'preview', '--port', String(PORT), '--strictPort', ...(demo ? ['--mode', 'demo'] : [])]
const server = spawn('npx', args, { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe', detached: true })
server.stdout.resume()
server.stderr.resume()
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${ORIGIN}/`)).ok) break
  } catch {
    /* not up yet */
  }
  if (i > 60) throw new Error('vite preview did not start')
  await new Promise((r) => setTimeout(r, 300))
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []

async function check(name, viewport, opts) {
  const ctx = await browser.newContext({ viewport, ...opts })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(e.message))
  // the artifact frame blocks these: the tour must never need them
  await page.addInitScript(() => {
    window.alert = () => {
      throw new Error('alert() called')
    }
    window.confirm = () => {
      throw new Error('confirm() called')
    }
    window.prompt = () => {
      throw new Error('prompt() called')
    }
  })
  await page.goto(BASE)
  await page.waitForSelector('canvas')
  // first visit: the welcome, over the live hive (in the demo, before the Lab)
  const welcome = page.getByRole('dialog', { name: /OmegaHive/ })
  await welcome.waitFor({ timeout: 15000 })
  const hashAtWelcome = await page.evaluate(() => window.location.hash)
  const voices = await page.evaluate(() => (window.speechSynthesis ? window.speechSynthesis.getVoices().length : -1))
  await page.getByRole('button', { name: /Watch the tour/ }).click()
  await page.waitForFunction(() => !!window.__hiveTour?.state(), null, { timeout: 15000 })
  await page.evaluate((s) => window.__hiveTour.setRate(s), SPEED)
  const t0 = Date.now()
  await page.waitForFunction(() => window.__hiveTour?.done === true, null, { timeout: 240000, polling: 250 })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const report = await page.evaluate(() => window.__hiveTour.report)
  await sleep(800)
  const after = await page.evaluate(() => ({ hash: window.location.hash, tourDom: !!document.querySelector('[data-tour-active]'), welcome: localStorage.getItem('omegadots.intro.welcome.v1') }))

  const chapters = [...new Set(report.map((r) => r.chapter))]
  const missing = report.flatMap((r) => r.targets.filter((t) => !t.found).map((t) => `${r.chapter}#${r.beat} ${t.name}`))
  const targets = report.reduce((n, r) => n + r.targets.length, 0)
  console.log(`\n[${name}] ${chapters.length} chapters, ${report.length} beats, ${targets} targets in ${secs}s at ${SPEED}x (voices: ${voices})`)
  console.log(`  chapters: ${chapters.join(' → ')}`)
  const expectHash = demo ? '#/lab' : hashAtWelcome || '#/'
  if (missing.length) failures.push(`[${name}] targets not found: ${missing.join(', ')}`)
  if (chapters.length < 9) failures.push(`[${name}] only ${chapters.length} chapters played`)
  if (after.tourDom) failures.push(`[${name}] tour overlay still mounted after the end`)
  if (after.hash !== expectHash) failures.push(`[${name}] route not restored: ${after.hash} (expected ${expectHash})`)
  if (after.welcome !== 'tour') failures.push(`[${name}] welcome choice not remembered`)
  if (errors.length) failures.push(`[${name}] console errors: ${errors.join(' | ')}`)
  console.log(`  missing: ${missing.length ? missing.join(', ') : 'none'} · restored to ${after.hash}`)

  // second visit: no welcome
  await page.reload()
  await page.waitForSelector('canvas')
  await sleep(2500)
  if (await page.getByRole('dialog', { name: /OmegaHive/ }).count()) failures.push(`[${name}] welcome shown again after it was answered`)

  // storage unavailable: the welcome shows every time, and the tour still runs
  const ctx2 = await browser.newContext({ viewport, ...opts })
  const p2 = await ctx2.newPage()
  await p2.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('SecurityError: storage disabled')
      },
    })
  })
  const errors2 = []
  p2.on('pageerror', (e) => errors2.push(e.message))
  await p2.goto(BASE)
  await p2.getByRole('dialog', { name: /OmegaHive/ }).waitFor({ timeout: 15000 })
  await p2.getByRole('button', { name: /Explore on my own/ }).click()
  await sleep(600)
  await p2.reload()
  await p2.getByRole('dialog', { name: /OmegaHive/ }).waitFor({ timeout: 15000 }).catch(() => failures.push(`[${name}] no welcome when storage is unavailable`))
  if (errors2.length) failures.push(`[${name}] errors with storage unavailable: ${errors2.join(' | ')}`)
  console.log(`  storage unavailable: welcome again on reload ✓`)
  await ctx2.close()
  await ctx.close()
}

try {
  await check('mobile', { width: 390, height: 844 }, { deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  await check('desktop', { width: 1440, height: 900 }, { deviceScaleFactor: 1 })
  await check('desktop-reduced', { width: 1440, height: 900 }, { deviceScaleFactor: 1, reducedMotion: 'reduce' })
} finally {
  await browser.close()
  try {
    process.kill(-server.pid)
  } catch {
    server.kill()
  }
}

if (failures.length) {
  console.log(`\n${failures.length} problem(s):`)
  for (const f of failures) console.log('  ✗', f)
  process.exit(1)
}
console.log('\nTour check passed: every chapter played and every target was found.')
process.exit(0)
