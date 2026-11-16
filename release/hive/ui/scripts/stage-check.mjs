/**
 * Purpose: the stage end to end on a running local hive, in a real Chromium: a mind answering a person's Ask shows a
 * photo it made, brings the description back beside it, the person drags the split to a third, the mind compares the
 * photo with its description, a new picture and text side by side open at the third the person chose, a tall picture
 * is shown tall, and with the Ask's thread open the photo is arranged above it; then the same over the Canvas look. It
 * checks each arrangement on the page (centred at the photo's size, side by side, image over text, the learned split,
 * the picture's own shape, clear of the thread) and writes screenshots at 1440x900 into --out, with stage-check.json
 * beside them.
 *
 * The mind here is a module mind that runs outside the hive and answers the Ask itself, so its statements take the path
 * of its own hive-show, hive-recall and hive-compare skills (POST /api/agent/stage). Run the hive with
 * HIVE_ASK_CONDUCTOR=0 so the Ask reaches it; where the conductor answers the Ask, the mind it speaks as makes the same
 * statements through its tools by the same rule and frame (hive/tests/test_stage.py drives that with a scripted model).
 *
 * Usage (a disposable hive with invented content; the operator password in HIVE_CHECK_PASSWORD):
 *   node scripts/stage-check.mjs --hive http://127.0.0.1:8872 --browser <chromium> --out <dir>
 * Exits non-zero, naming every failed check, when any check fails.
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] }
const hive = (flag('--hive') ?? '').replace(/\/+$/, '')
const browserPath = flag('--browser')
const out = resolve(flag('--out') ?? 'stage-check-out')
const password = process.env.HIVE_CHECK_PASSWORD
assert(hive && browserPath && password, 'needs --hive, --browser and HIVE_CHECK_PASSWORD')
// waits are generous: the check runs on shared, loaded hosts where the first page also compiles its screens
const WAIT = 90_000

const results = []
let page = null
const check = async (name, fn) => {
  try { await fn(); results.push({ name, ok: true }); console.log(`ok    ${name}`) }
  catch (e) {
    results.push({ name, ok: false, error: String(e?.message ?? e) })
    console.log(`FAIL  ${name}: ${e?.message ?? e}`)
    await page?.screenshot({ path: resolve(out, `failed-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`), animations: 'disabled' }).catch(() => undefined)
  }
}

async function api(method, path, token, body) {
  const res = await fetch(hive + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

// a photo the mind made, as an image saved as SVG text: low sun over a harbour, two boats
const photoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"><defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#1b2a4a"/><stop offset="0.55" stop-color="#e98d58"/><stop offset="1" stop-color="#f6c98a"/></linearGradient></defs>
<rect width="640" height="480" fill="url(#sky)"/><circle cx="420" cy="250" r="46" fill="#ffd9a0"/>
<rect y="290" width="640" height="190" fill="#24476b"/><path d="M0 300 Q160 285 320 300 T640 300 V310 H0Z" fill="#ffd9a0" opacity="0.35"/>
<path d="M150 330 h90 l-14 22 h-62z" fill="#13253a"/><path d="M190 330 v-52 l32 52z" fill="#f2efe6"/>
<path d="M380 360 h70 l-11 18 h-48z" fill="#13253a"/><path d="M410 360 v-40 l24 40z" fill="#f2efe6"/></svg>`
const sketchSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"><rect width="640" height="480" fill="#f3efe4"/>
<path d="M40 380 C200 220 420 420 600 260" stroke="#333" stroke-width="6" fill="none"/><circle cx="480" cy="140" r="50" fill="none" stroke="#333" stroke-width="5"/></svg>`
// a tall picture, twice as high as it is wide: a lighthouse at night
const tallSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 600"><rect width="300" height="600" fill="#101d33"/>
<path d="M0 520 Q150 500 300 520 V600 H0Z" fill="#1d3a5c"/><path d="M128 180 h44 l14 340 h-72z" fill="#e9e4d8"/>
<path d="M121 250 h58 v24 h-58z M117 360 h66 v24 h-66z" fill="#b8423a"/><path d="M134 140 h32 v40 h-32z" fill="#ffd97a"/>
<path d="M150 160 L300 120 V200z" fill="#ffd97a" opacity="0.3"/></svg>`

await mkdir(out, { recursive: true })
// a named person, as a tester signs in, and the mind of their swarm that answers their Ask
const operatorToken = (await api('POST', '/api/auth/login', null, { password })).token
const email = `stage-check-${Date.now()}@example.test`
const member = await api('POST', '/api/people/members', operatorToken, { email, name: 'Sam' })
const person = (await api('POST', '/api/auth/login', null, { email, password: member.password })).token
// the person set First Light aside before (its Not now, which the hive records), so it never opens by itself on the
// hive's landing over the stage (tour/firstRun.ts)
await api('PATCH', '/api/me/onboarding', person, { status: 'skipped' })
const swarm = await api('POST', '/api/swarms', person, { name: 'Harbour photos' })
const wren = await api('POST', '/api/agents', person, { name: 'Wren', kind: 'module', swarm_id: swarm.id })
// choosing a swarm's coordinator is an admin's: the hive's operator does it here, as a tester's admin would
await api('PATCH', `/api/swarms/${swarm.id}`, operatorToken, { coordinator_id: wren.id })
const photo = await api('POST', '/api/agent/artifacts', wren.token, { kind: 'image', title: 'Harbour at dusk', body: photoSvg })
const words = await api('POST', '/api/agent/artifacts', wren.token, { kind: 'note', title: 'What I wrote about it',
  body: 'Low sun over the harbour, two boats heading in, the light laid across the water like a path.' })
const sketch = await api('POST', '/api/agent/artifacts', wren.token, { kind: 'image', title: 'Second sketch', body: sketchSvg })
const notes = await api('POST', '/api/agent/artifacts', wren.token, { kind: 'note', title: 'Notes on the sketch', body: 'A road and the moon, drawn quickly.' })
const tall = await api('POST', '/api/agent/artifacts', wren.token, { kind: 'image', title: 'Lighthouse', body: tallSvg })

// the Ask must reach the mind itself, not the conductor
const caps = (await api('GET', '/api/me/ask', person))?.capabilities ?? {}
assert(caps.conductor === false, 'the hive answers the Ask with its conductor: run it with HIVE_ASK_CONDUCTOR=0')
// a module mind runs outside the hive: it is awake once it connects to the hub with its own token
const hub = new WebSocket(hive.replace(/^http/, 'ws') + '/agent-hub', { headers: { authorization: `Bearer ${wren.token}` } })
await new Promise((ok, no) => { hub.onopen = ok; hub.onerror = () => no(new Error('the mind could not reach the hub')) })
let awake = false
for (let i = 0; i < 60 && !awake; i++) {
  const a = await api('GET', `/api/agents/${wren.id}`, person)
  awake = a.status === 'awake'
  if (!awake) await new Promise((r) => setTimeout(r, 500))
}
assert(awake, 'the mind did not come awake on the hub')
let op = 0
// the person asks; the mind serves the turn: it says what it shows, then answers in words, which closes the turn
const ask = async (text, ...statements) => {
  const turn = await api('POST', '/api/ask', person, { operation_id: `op-stage-${Date.now()}-${++op}`, text, context: { swarm_id: swarm.id } })
  for (const [s, ...items] of statements) await say(s, ...items)
  await api('POST', '/api/agent/messages', wren.token, { text: 'Here it is.', conversation_id: `ask:${turn.turn_id}` })
}
const say = (s, ...items) => api('POST', '/api/agent/stage', wren.token, { say: s, items: items.map((x) => x.id) })

const browser = await chromium.launch({ executablePath: resolve(browserPath), headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.route('**/*', (route) => (route.request().url().startsWith(hive) ? route.continue() : route.fulfill({ status: 204, body: '' })))
page = await context.newPage()
page.setDefaultTimeout(WAIT)
page.on('pageerror', (e) => console.log(`page error: ${e.message}`))
// a page hears the stage once its events socket is open and the stage has read where its hearing starts: what a mind
// said before that was said before the page opened, and is never replayed, so a person's Ask always comes after it
const hearing = async (go) => {
  const socket = page.waitForEvent('websocket', (ws) => ws.url().includes('/api/events'))
  const start = page.waitForResponse((r) => r.url().includes('/api/me/stage'))
  await go()
  await Promise.all([socket, start])
}
await page.goto(hive + '/')
// the person signs in and picks Never in the rest setting, so a slow step never leaves a press under the rest screen
await page.evaluate((t) => { localStorage.setItem('omegadots.hive.token', t); localStorage.setItem('omegahive.rest', JSON.stringify({ minutes: 0 })) }, person)
await hearing(() => page.goto(hive + '/'))

const box = async (id) => {
  const el = page.locator(`[data-stage-item="${id}"]`)
  await el.waitFor({ state: 'visible' })
  return el.boundingBox()
}
const shot = (name) => page.screenshot({ path: resolve(out, name), animations: 'disabled' })
const near = (a, b, what, tol = 2) => assert(Math.abs(a - b) <= tol, `${what}: ${a} is not ${b}`)

await check('a mind answering the Ask shows a photo in the middle of the screen, at its own size', async () => {
  await ask('Show me the harbour photo you made', ['show', photo])
  const p = await box(photo.id)
  const view = page.viewportSize()
  near(p.x + p.width / 2, view.width / 2, 'the photo is centred across')
  assert(p.width <= 640 + 2 && p.width / p.height > 1.3 && p.width / p.height < 1.37, `the photo keeps its shape and size: ${p.width}x${p.height}`)
  await page.locator(`[data-stage-item="${photo.id}"] img`).waitFor({ state: 'visible' })
  await shot('40-stage-show-desktop.png')
})

await check('asked for the description back, the mind puts the two side by side and the rest away', async () => {
  await ask('And what you wrote about it?', ['recall', words])
  const p = await box(photo.id)
  const w = await box(words.id)
  near(p.y, w.y, 'side by side, the same top')
  assert(p.x + p.width < w.x, 'the photo is left of the description')
  near(p.width, w.width, 'equal halves before any drag', 3)
  await shot('41-stage-recall-desktop.png')
})

await check('the person drags the split to a third, and the stage keeps it', async () => {
  const sep = page.locator('[role="separator"]').first()
  const s = await sep.boundingBox()
  const p = await box(photo.id)
  const w = await box(words.id)
  const target = p.x + (p.width + w.width + (w.x - p.x - p.width)) / 3
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) await page.mouse.move(s.x + s.width / 2 + ((target - (s.x + s.width / 2)) * i) / 12, s.y + s.height / 2)
  await page.mouse.up()
  await page.waitForFunction(() => document.querySelector('[role="separator"]')?.getAttribute('aria-valuenow') === '33')
  const p2 = await box(photo.id)
  const w2 = await box(words.id)
  near(p2.width / (p2.width + w2.width), 1 / 3, 'the photo takes a third', 0.01)
  await shot('42-stage-drag-desktop.png')
})

await check('comparing the photo with the description puts the image over its text, each half the screen', async () => {
  await ask('Compare the photo with what you wrote', ['compare', photo, words])
  await page.waitForFunction(() => document.querySelector('[data-stage]')?.getAttribute('data-stage') === 'compare')
  const p = await box(photo.id)
  const w = await box(words.id)
  near(p.x, w.x, 'one over the other')
  near(p.width, w.width, 'the same width')
  near(p.height, w.height, 'each half', 3)
  assert(p.y + p.height < w.y, 'the image above its text')
  await shot('43-stage-compare-desktop.png')
})

await check('a new picture and text side by side open at the third the person dragged them to', async () => {
  await page.getByRole('button', { name: 'Put away' }).click()
  await page.locator('[data-stage]').waitFor({ state: 'detached' })
  await ask('Show me the second sketch and its notes', ['show', sketch], ['recall', notes])
  await page.waitForFunction(() => document.querySelector('[role="separator"]')?.getAttribute('aria-valuenow') === '33')
  const s = await box(sketch.id)
  const n = await box(notes.id)
  near(s.width / (s.width + n.width), 1 / 3, 'the learned third', 0.01)
  await shot('44-stage-learned-desktop.png')
})

await check('a tall picture is shown tall, in its own shape', async () => {
  await page.getByRole('button', { name: 'Put away' }).click()
  await page.locator('[data-stage]').waitFor({ state: 'detached' })
  await ask('Show me the lighthouse', ['show', tall])
  // MeTTa draws it at its kind's shape until the picture has loaded, then in the picture's own
  await page.waitForFunction((id) => {
    const r = document.querySelector(`[data-stage-item="${id}"]`)?.getBoundingClientRect()
    return !!r && r.height > r.width * 1.9
  }, tall.id)
  const t = await box(tall.id)
  near(t.height / t.width, 2, 'twice as high as it is wide', 0.02)
  near(t.x + t.width / 2, page.viewportSize().width / 2, 'centred across')
  await shot('46-stage-shape-desktop.png')
})

await check('with the Ask’s thread open, the shown photo is arranged above it, and over the whole screen once it closes', async () => {
  await page.getByRole('button', { name: 'Put away' }).click()
  await page.locator('[data-stage]').waitFor({ state: 'detached' })
  // the person opens the Ask's thread: on an earlier build it covered the lower fifth of a shown picture
  await page.locator('#ask button[aria-label^="Show the thread"]').click()
  const thread = page.locator('#ask .ask-panel')
  await thread.waitFor({ state: 'visible' })
  // its entrance fades and lifts it into place: a shot taken before it ends shows a faint thread lower down
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#ask .ask-panel')).opacity === '1')
  await ask('Show me the harbour photo you made', ['show', photo])
  // once the thread's entrance settles, MeTTa arranges the photo in the window above it
  await page.waitForFunction((id) => {
    const p = document.querySelector(`[data-stage-item="${id}"]`)?.getBoundingClientRect()
    const t = document.querySelector('#ask .ask-panel')?.getBoundingClientRect()
    return !!p && !!t && p.height > 0 && p.bottom <= t.top + 1
  }, photo.id)
  const t = await thread.boundingBox()
  const p = await box(photo.id)
  assert(p.y + p.height <= t.y + 1, `the photo ends above the thread: ${p.y + p.height} is below ${t.y}`)
  near(p.x + p.width / 2, page.viewportSize().width / 2, 'centred across')
  await shot('47-stage-thread-desktop.png')
  await page.locator('#ask button[aria-label="Hide the thread"]').click()
  await thread.waitFor({ state: 'detached' })
  // the thread closed: the stage's window reaches down to the dock again, past where the thread was
  await page.waitForFunction((top) => (document.querySelector('[data-stage-window]')?.getBoundingClientRect().bottom ?? 0) > top + 1, t.y)
})

await check('over the Canvas look, the stage shows the photo the same way', async () => {
  await page.getByRole('button', { name: 'Put away' }).click()
  await page.locator('[data-stage]').waitFor({ state: 'detached' })
  const ui = await api('GET', '/api/me/ui', person)
  await api('PUT', '/api/me/ui', person, { ...(ui?.prefs ?? {}), experience: 'canvas' })
  await hearing(() => page.reload())
  await ask('Show me the photo again', ['show', photo])
  const p = await box(photo.id)
  near(p.x + p.width / 2, page.viewportSize().width / 2, 'centred over the Canvas look')
  await shot('45-stage-canvas-desktop.png')
})

hub.close()
await browser.close()
await writeFile(resolve(out, 'stage-check.json'), JSON.stringify({ hive, results }, null, 2) + '\n')
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length} of ${results.length} checks passed`)
if (failed.length) {
  console.log(`failed: ${failed.map((r) => r.name).join('; ')}`)
  process.exit(1)
}
