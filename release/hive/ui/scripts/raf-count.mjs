// Counted rAF smoke for Cosmos rest/awake (contract R1.1 §9.4): rAF callbacks per second by source, awake then rest.
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const [ui, url, out] = process.argv.slice(2)
const { chromium } = await import(pathToFileURL(resolve(ui, 'node_modules/playwright-core/index.mjs')))
const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
// the welcome dismissed, so it neither covers the shots nor draws frames of its own (Dot 3 Nov)
await ctx.addInitScript(() => { try { localStorage.setItem('omegadots.intro.welcome.v1', '1') } catch { } })
const page = await ctx.newPage()
const errors = []; page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(url); await page.waitForTimeout(3000)
const res = await page.evaluate(async () => {
  const m = await import('/src/shell/uiVariant.ts'); const st = await import('/src/store/store.ts'); const p = await import('/src/shell/phase.ts')
  await m.keepLook(st.useHive.getState().client, m.withExperience(m.lookState().saved, 'cosmos'))
  await new Promise((r) => setTimeout(r, 6000))
  const count = async (ms) => {
    const src = new Map(); let n = 0; const orig = window.requestAnimationFrame
    window.requestAnimationFrame = (cb) => { const k = ((new Error().stack || '').split('\n')[2] || '').match(/\/src\/[^?]+:\d+|node_modules\/\.vite\/deps\/[^?:]+/)?.[0] || 'other'; src.set(k, (src.get(k) || 0) + 1); return orig((t) => { n++; cb(t) }) }
    await new Promise((r) => setTimeout(r, ms)); window.requestAnimationFrame = orig
    return { perSec: +(n * 1000 / ms).toFixed(1), bySource: Object.fromEntries([...src].map(([k, v]) => [k, +(v * 1000 / ms).toFixed(1)])) }
  }
  const before = p.usePhase.getState()
  const awake = await count(5000)
  await p.usePhase.getState().send('power'); await new Promise((r) => setTimeout(r, 4000))
  const restPhase = p.usePhase.getState().phase
  const rest = await count(5000)
  return { phased: before.phased, awakePhase: before.phase, awake, restPhase, rest }
})
await page.screenshot({ path: `${out}/cosmos-rest.png` })
await page.evaluate(async () => { const p = await import('/src/shell/phase.ts'); await p.usePhase.getState().send('omega-tap') })
await page.waitForTimeout(3000); await page.screenshot({ path: `${out}/cosmos-awake.png` })
console.log(JSON.stringify({ ...res, errors }, null, 1))
await browser.close()
