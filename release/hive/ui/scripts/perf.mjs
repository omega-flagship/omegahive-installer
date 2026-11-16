// Frame-rate check: ~52 dots, 4x event rate, phone viewport, optional CPU throttle.
// Usage: npm run build && node scripts/perf.mjs [throttle=4]
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const PORT = 4181
const throttle = Number(process.argv[2] ?? 4)
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore', detached: true })
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`http://localhost:${PORT}/`)).ok) break
  } catch {
    /* not up yet */
  }
  if (i > 60) throw new Error('vite preview did not start')
  await new Promise((r) => setTimeout(r, 300))
}
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })
  await page.goto(`http://localhost:${PORT}/?sim=1&dots=40&speed=4#/`)
  await page.waitForSelector('canvas')
  await new Promise((r) => setTimeout(r, 6000))
  const samples = []
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    samples.push(await page.$eval('canvas', (c) => ({ fps: Number(c.dataset.fps), dpr: Number(c.dataset.dpr), particles: Number(c.dataset.particles) })))
  }
  const dots = await page.evaluate(() => document.querySelectorAll('nav[aria-label="Dots"] button').length)
  await page.screenshot({ path: new URL('../screenshots/perf-52-dots-mobile.png', import.meta.url).pathname })
  const fps = samples.map((s) => s.fps)
  console.log(JSON.stringify({ throttle, dots, fps, avg: Math.round(fps.reduce((a, b) => a + b, 0) / fps.length), dpr: samples.at(-1).dpr, particles: samples.map((s) => s.particles) }))
} finally {
  await browser.close()
  try {
    process.kill(-server.pid)
  } catch {
    server.kill()
  }
}
process.exit(0)
