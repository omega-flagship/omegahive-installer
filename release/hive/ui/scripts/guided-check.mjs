// Guided demos by Ask: rendered checks (features/guided). SIMULATOR ONLY (?sim=1), invented data: no live hive, no
// provider call. Serve a production build (`npx vite preview --host 127.0.0.1 --port <port>`), then:
//   node scripts/guided-check.mjs <port> <outDir> [browserPath]
// In Classic and Still: say "show me how attention works" to the Ask; the sim's conductor drives the banked tour with
// tour.step acts, one at a time after each result; every step is shown, every banked step is labelled "banked /
// synthetic, not run now", the turn ends with its answer, and the page throws nothing. Also: a ready tour over real
// screens (the Lab), reduced motion (no travelling beacon), and temporal's honest "being built" answer.
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const require = createRequire(fileURLToPath(new URL('../package.json', import.meta.url)))
const { chromium } = require('playwright-core')
const PORT = process.argv[2] ?? '5492'
const OUT = process.argv[3] ?? '/tmp/guided-check'
const EXE = process.argv[4] ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
const BASE = `http://127.0.0.1:${PORT}`
await mkdir(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch({ executablePath: EXE, headless: true })
const results = []
const ok = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail).slice(0, 500) })

async function open(exp, { reduced = false } = {}) {
  const errors = []
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: reduced ? 'reduce' : 'no-preference' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
  await page.addInitScript((e) => {
    localStorage.setItem('omegahive.ui.look', JSON.stringify({ variant: null, layout: null, apps: null, experience: e === 'classic' ? null : e }))
    localStorage.setItem('omegadots.intro.welcome.v1', 'explore')
    localStorage.setItem('omegahive.rest', JSON.stringify({ minutes: 60 }))
  }, exp)
  await page.goto(`${BASE}/?sim=1`)
  await page.waitForFunction(() => !!window.__hiveSim, null, { timeout: 30000 })
  await page.evaluate(() => {
    window.__hiveSim.running = false
  })
  await sleep(2000)
  return { ctx, page, errors }
}

/** Say words to the Ask, in whichever form this experience shows it. */
async function say(page, words) {
  const field = page.locator('[data-ask-input]:visible, .st-ask-input:visible').first()
  if (!(await field.count())) {
    // Classic's capsule may need opening first
    await page.locator('#ask .ask-capsule').first().click({ timeout: 3000 }).catch(() => undefined)
  }
  await field.click()
  await field.fill(words)
  await sleep(250)
  await field.press('Enter')
}

const caption = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('.guide-caption')
    if (!c) return null
    const [title, count] = [...c.querySelectorAll('.guide-eyebrow span')].map((s) => s.textContent)
    return {
      title,
      count,
      text: c.querySelector('.guide-text')?.textContent ?? '',
      status: c.querySelector('.guide-status')?.textContent ?? '',
      banked: c.querySelector('.guide-banked')?.textContent ?? null,
      glow: !!document.querySelector('.guide-glow'),
      beacon: !!document.querySelector('.guide-beacon'),
      reduced: !!document.querySelector('.guide-layer[data-reduced]'),
      hash: location.hash,
    }
  })

/** Wait for the caption to show step `n` of `total` (ready: no "Moving there…"). */
async function stepShown(page, n, total, ms = 15000) {
  const end = Date.now() + ms
  for (;;) {
    const c = await caption(page)
    if (c && c.count === `${n} / ${total}` && !/Moving there/.test(c.status) && c.text && c.text !== '…') return c
    if (Date.now() > end) return c
    await sleep(150)
  }
}

async function tour(exp, { reduced = false } = {}) {
  const tag = `${exp}${reduced ? '-reduced' : ''}`
  const { ctx, page, errors } = await open(exp, { reduced })
  await say(page, 'show me how attention works')
  const seen = []
  for (let n = 1; n <= 5; n++) {
    const c = await stepShown(page, n, 5, 20000)
    seen.push(c)
    ok(`${tag}: step ${n} of 5 shown by the conductor`, c && c.count === `${n} / 5`, JSON.stringify(c))
    if (n === 1) ok(`${tag}: the Tools app (invented stand-in) is open`, c && /#\/program\/omega-tools/.test(c.hash), c?.hash)
    if (n >= 2 && n <= 4) ok(`${tag}: step ${n} is labelled banked / synthetic, not run now, executed now: false; output never as actual`, c && /Banked \/ synthetic, not run now/.test(c.banked ?? '') && /executed now: false/.test(c.banked ?? '') && /expected, not actual/.test(c.banked ?? ''), c?.banked)
    if (n === 5) ok(`${tag}: the last step says nothing ran now`, c && /Nothing ran now/.test(c.text), c?.text)
    if (reduced) ok(`${tag}: step ${n}: no travelling beacon under reduced motion`, c && !c.beacon && c.reduced, JSON.stringify(c))
    if (n === 1 || n === 3 || n === 5) await page.screenshot({ path: `${OUT}/${tag}-attention-step${n}.png` })
  }
  // the conductor's turn ends with its answer once the last step was shown
  const answered = await page
    .waitForFunction(() => [...document.querySelectorAll('.ask-log')].some((l) => /That was Attention \(ECAN\), in 5 steps/.test(l.textContent ?? '')), null, { timeout: 15000 })
    .then(() => true, () => false)
  ok(`${tag}: the turn ends with the orchestrator's answer`, answered)
  // stand-in r2: every banked entry in the thread's transcript carries its qualification
  const said = await page.evaluate(() => [...document.querySelectorAll('.guide-card .guide-said li')].map((li) => ({ banked: li.hasAttribute('data-banked'), text: li.textContent ?? '' })))
  ok(`${tag}: the thread transcript labels each banked entry (banked / synthetic, not run now; executed now: false)`, said.filter((e) => e.banked).length === 3 && said.every((e) => e.banked === e.text.startsWith('Banked / synthetic, not run now; executed now: false')), JSON.stringify(said))
  await page.screenshot({ path: `${OUT}/${tag}-attention-done.png` })
  ok(`${tag}: no page errors`, errors.length === 0, errors.join(' | '))
  await ctx.close()
}

await tour('classic')
await tour('still')
await tour('classic', { reduced: true })

// a tour over real screens: the Lab (four steps, the conductor drives it too)
{
  const { ctx, page, errors } = await open('classic')
  await say(page, 'walk me through the lab')
  for (let n = 1; n <= 2; n++) {
    const c = await stepShown(page, n, 4, 20000)
    ok(`lab: step ${n} of 4 shown, over the real Lab page`, c && c.count === `${n} / 4` && /#\/lab/.test(c.hash), JSON.stringify(c))
    if (n === 1) await page.screenshot({ path: `${OUT}/classic-lab-step1.png` })
  }
  // the person always wins: Pause holds the conductor, so it does not move to the next step
  await page.locator('.guide-caption button', { hasText: 'Pause' }).click()
  await sleep(9000)
  const held = await caption(page)
  ok('lab: paused by the person, the conductor moves nothing more', held && held.count === '2 / 4' && /Paused/.test(held.status), JSON.stringify(held))
  const said = await page
    .waitForFunction(() => [...document.querySelectorAll('.ask-log')].some((l) => /stopped guiding The Lab and benchmarks at step 2 of 4: you took over/.test(l.textContent ?? '')), null, { timeout: 15000 })
    .then(() => true, () => false)
  ok('lab: the orchestrator says it stopped because the person took over', said)
  await page.screenshot({ path: `${OUT}/classic-lab-paused.png` })
  ok('lab: no page errors', errors.length === 0, errors.join(' | '))
  await ctx.close()
}

// stand-in r1 P2: Back, Next and Finish are the person's too; the conductor's scheduled step never overrides them
{
  const { ctx, page, errors } = await open('classic')
  await say(page, 'walk me through the lab')
  const c2 = await stepShown(page, 2, 4, 20000)
  ok('lab back: step 2 of 4 shown by the conductor', c2 && c2.count === '2 / 4', JSON.stringify(c2))
  await page.locator('.guide-caption button', { hasText: 'Back' }).click()
  await sleep(9000)
  const back = await caption(page)
  ok('lab back: Back holds, the conductor’s next step does not override it', back && back.count === '1 / 4', JSON.stringify(back))
  // Next twice, then Finish: never rewound, never restarted
  for (const n of [2, 3, 4]) {
    await page.locator('.guide-caption button', { hasText: 'Next' }).click()
    const c = await stepShown(page, n, 4, 15000)
    ok(`lab next: the person’s Next reaches step ${n} of 4`, c && c.count === `${n} / 4`, JSON.stringify(c))
  }
  await page.locator('.guide-caption button', { hasText: 'Finish' }).click()
  await sleep(9000)
  const fin = await page.evaluate(() => ({ text: document.querySelector('.guide-caption .guide-text')?.textContent ?? '', again: !!document.querySelector('.guide-caption button[aria-keyshortcuts="ArrowRight"]') }))
  ok('lab finish: finished, and not restarted by the conductor', /^That’s the lab and benchmarks/i.test(fin.text) && !fin.again, JSON.stringify(fin))
  const said = await page
    .waitForFunction(() => [...document.querySelectorAll('.ask-log')].some((l) => /stopped guiding The Lab and benchmarks at step \d of 4: you took over/.test(l.textContent ?? '')), null, { timeout: 15000 })
    .then(() => true, () => false)
  ok('lab back: the orchestrator says it stopped because the person took over', said)
  await page.screenshot({ path: `${OUT}/classic-lab-finished.png` })
  ok('lab back/next/finish: no page errors', errors.length === 0, errors.join(' | '))
  await ctx.close()
}

// temporal: unavailable, an honest "being built" answer, nothing moves
for (const exp of ['classic', 'still']) {
  const { ctx, page, errors } = await open(exp)
  const before = await page.evaluate(() => location.hash)
  await say(page, 'show me how temporal reasoning works')
  const text = await page
    .waitForSelector('.guide-answer', { timeout: 8000 })
    .then((el) => el.textContent(), () => '')
  ok(`${exp} temporal: the honest being-built answer`, /Temporal reasoning is being built\./.test(text ?? ''), text)
  ok(`${exp} temporal: nothing moved`, (await page.evaluate(() => location.hash)) === before)
  await page.screenshot({ path: `${OUT}/${exp}-temporal.png` })
  ok(`${exp} temporal: no page errors`, errors.length === 0, errors.join(' | '))
  await ctx.close()
}

await browser.close()
const failed = results.filter((r) => !r.pass)
await writeFile(`${OUT}/results.json`, JSON.stringify({ at: new Date().toISOString(), base: BASE, total: results.length, failed: failed.length, results }, null, 2))
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `  — ${r.detail}`}`)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
