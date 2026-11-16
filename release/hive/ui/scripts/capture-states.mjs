// Side-by-side captures of a look's rest, awake and Pro (Ask-and-apps quality bar; Dot 3 Nov), on the dev server's
// simulator: welcome dismissed, the look chosen and landing awake through the app's own modules, then each state.
//   node scripts/capture-states.mjs <hive/ui> <url> <look> <outdir> [browser executable]
// The simulator's First Light notice ("progress could not be read") is unrelated to the look and is hidden in the shots;
// each file says so in its name list (notes.txt).
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
const [ui, url, look, out, exe = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'] = process.argv.slice(2)
const { chromium } = await import(pathToFileURL(resolve(ui, 'node_modules/playwright-core/index.mjs')))
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] })
const notes = []
const hideNotice = () => {
  for (const el of document.querySelectorAll('[role=status], [role=alert], div')) {
    if (el.childElementCount < 6 && /First Light progress could not be read/.test(el.textContent ?? '') && el.getBoundingClientRect().height < 200) { el.style.visibility = 'hidden' }
  }
}
for (const [w, h] of [[1440, 900], [390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w < 600 ? 2 : 1 })
  await ctx.addInitScript(() => { try { localStorage.setItem('omegadots.intro.welcome.v1', '1') } catch { } })
  const page = await ctx.newPage()
  await page.goto(url)
  // poll in the page: waitForFunction would take an async predicate's promise as truthy
  await page.evaluate(async () => { const { useHive } = await import('/src/store/store.ts'); for (let i = 0; i < 240 && !useHive.getState().client?.setUiPrefs; i++) await new Promise((r) => setTimeout(r, 250)) })
  await page.evaluate(async (look) => {
    const { useHive } = await import('/src/store/store.ts'); const ui = await import('/src/shell/uiVariant.ts')
    await ui.keepLook(useHive.getState().client, { variant: null, layout: null, apps: null, experience: look, landing: 'awake' })
  }, look)
  // no reload: the simulator keeps its saved look in memory, and the save applies live
  await page.waitForTimeout(20000)
  const phase = (ev) => page.evaluate(async (ev) => { const { usePhase } = await import('/src/shell/phase.ts'); usePhase.getState().send(ev); return usePhase.getState().phase }, ev)
  const shot = async (name) => { await page.evaluate(hideNotice); const f = join(out, `${look}-${name}-${w}x${h}.png`); await page.screenshot({ path: f }); notes.push(f) }
  await shot('awake')
  notes.push('pro: ' + (await phase('pro'))); await page.waitForTimeout(6000); await shot('pro')
  notes.push('back: ' + (await phase('back'))); await page.waitForTimeout(4000)
  notes.push('rest: ' + (await phase('power'))); await page.waitForTimeout(6000); await shot('rest')
  await ctx.close()
}
await browser.close()
writeFileSync(join(out, 'notes.txt'), notes.join('\n') + '\nThe simulator\'s First Light notice is hidden in every shot (unrelated to the look).\n')
console.log(notes.join('\n'))
