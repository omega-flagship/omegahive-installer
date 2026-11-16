/**
 * Purpose: the Ask's three sizes end to end on a running local hive, in a real Chromium, in every look on a desktop
 * (1440x900) and a phone (390x844). In each look the person collapses the Ask to its mark with the look's own control,
 * the hive keeps it and a reload shows it collapsed, Professional's home keeping its own width beside the mark; the
 * mark, and Ctrl+K, open it again with the cursor in its field; the half size, set with the look's control, puts the
 * field and the thread in the left half on a desktop, with a page's window and Professional's home right of it, and
 * opens the thread full height on a phone, and a reload keeps it; with the Ask at half on a desktop, a picture a mind
 * shows fills the right half the Ask leaves; and back at the bubble the half's column is gone. Screenshots and
 * ask-sizes-check.json go to --out.
 *
 * Still's paper and Construct's prompt are those looks' own Ask on their home, drawn by the experience at every size,
 * so there the check opens a page over them, where the host's floating Ask takes over. The mind is a module mind that
 * runs outside the hive and answers the Ask itself, as in stage-check.mjs: run the hive with HIVE_ASK_CONDUCTOR=0.
 *
 * Usage (a disposable hive with invented content; the operator password in HIVE_CHECK_PASSWORD):
 *   node scripts/ask-sizes-check.mjs --hive http://127.0.0.1:8890 --browser <chromium> --out <dir> [--looks classic,still]
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
const out = resolve(flag('--out') ?? 'ask-sizes-check-out')
const password = process.env.HIVE_CHECK_PASSWORD
assert(hive && browserPath && password, 'needs --hive, --browser and HIVE_CHECK_PASSWORD')
const LOOKS = (flag('--looks') ?? 'classic,professional,still,canvas,cosmos,construct,flux').split(',')
// each look's Ask skin (features/ask/AskHost.tsx ASK_SKINS), which #ask names once the look is drawn
const SKIN = { classic: 'capsule', professional: 'professional', still: 'still-line', canvas: 'note', cosmos: 'transmission', construct: 'command-line', flux: 'liquid' }
const SCREENS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } }
// where the host draws the Ask in each look: Still's paper and Construct's prompt are their own Ask on the home
const ROUTE = { still: '#/artifacts', construct: '#/artifacts' }
// looks whose home rests with the Ask hidden until something wakes it (shell/phase.css); a page over a look has no phase
const PHASED_HOME = new Set(['professional', 'cosmos'])
// waits are generous: the check runs on shared, loaded hosts where the first page also compiles its screens, and a
// software-rendered page compiling the live Omega's shaders after a reload held its main thread 43 s in one task
const WAIT = 180_000

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
/** Polls `fn` until it answers true, up to 20 s, then fails naming `what`. */
async function until(fn, what) {
  for (let i = 0; i < 80; i++) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out: ${what}`)
}

// a photo the mind made, as an image saved as SVG text: low sun over a harbour, two boats
const photoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"><defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#1b2a4a"/><stop offset="0.55" stop-color="#e98d58"/><stop offset="1" stop-color="#f6c98a"/></linearGradient></defs>
<rect width="640" height="480" fill="url(#sky)"/><circle cx="420" cy="250" r="46" fill="#ffd9a0"/>
<rect y="290" width="640" height="190" fill="#24476b"/><path d="M0 300 Q160 285 320 300 T640 300 V310 H0Z" fill="#ffd9a0" opacity="0.35"/>
<path d="M150 330 h90 l-14 22 h-62z" fill="#13253a"/><path d="M190 330 v-52 l32 52z" fill="#f2efe6"/>
<path d="M380 360 h70 l-11 18 h-48z" fill="#13253a"/><path d="M410 360 v-40 l24 40z" fill="#f2efe6"/></svg>`

await mkdir(out, { recursive: true })
// a named person, as a tester signs in, and the mind of their swarm that answers their Ask
const operatorToken = (await api('POST', '/api/auth/login', null, { password })).token
const email = `ask-sizes-${Date.now()}@example.test`
const member = await api('POST', '/api/people/members', operatorToken, { email, name: 'Sam' })
const person = (await api('POST', '/api/auth/login', null, { email, password: member.password })).token
// the person set First Light aside before (its Not now, which the hive records), so it never opens over the Ask
await api('PATCH', '/api/me/onboarding', person, { status: 'skipped' })
const swarm = await api('POST', '/api/swarms', person, { name: 'Harbour photos' })
const wren = await api('POST', '/api/agents', person, { name: 'Wren', kind: 'module', swarm_id: swarm.id })
await api('PATCH', `/api/swarms/${swarm.id}`, operatorToken, { coordinator_id: wren.id })
const photo = await api('POST', '/api/agent/artifacts', wren.token, { kind: 'image', title: 'Harbour at dusk', body: photoSvg })
const caps = (await api('GET', '/api/me/ask', person))?.capabilities ?? {}
assert(caps.conductor === false, 'the hive answers the Ask with its conductor: run it with HIVE_ASK_CONDUCTOR=0')
const hub = new WebSocket(hive.replace(/^http/, 'ws') + '/agent-hub', { headers: { authorization: `Bearer ${wren.token}` } })
await new Promise((ok, no) => { hub.onopen = ok; hub.onerror = () => no(new Error('the mind could not reach the hub')) })
await until(async () => (await api('GET', `/api/agents/${wren.id}`, person)).status === 'awake', 'the mind comes awake on the hub')
let op = 0
// the person asks; the mind says what it shows, then answers in words, which closes the turn
const ask = async (text, ...statements) => {
  const turn = await api('POST', '/api/ask', person, { operation_id: `op-sizes-${Date.now()}-${++op}`, text, context: { swarm_id: swarm.id } })
  for (const [s, ...items] of statements) await api('POST', '/api/agent/stage', wren.token, { say: s, items: items.map((x) => x.id) })
  await api('POST', '/api/agent/messages', wren.token, { text: 'Here it is.', conversation_id: `ask:${turn.turn_id}` })
}

// the person's look settings as their hive keeps them; an absent size is the bubble
const prefs = async () => (await api('GET', '/api/me/ui', person))?.prefs ?? {}
const kept = (size) => until(async () => ((await prefs()).ask_size ?? 'bubble') === size, `the hive keeps the Ask's size ${size}`)

const browser = await chromium.launch({ executablePath: resolve(browserPath), headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const FIELD = '#ask [data-ask-input]:visible'
const MARK = '#ask [data-ask-mark-open]'
const COLLAPSE = 'button[aria-label="Collapse the Ask to its mark"]'
const HALF = { desktop: 'Widen the Ask to the left half of the screen', phone: 'Open the thread full height' }
const BUBBLE = { desktop: 'Make the Ask a bubble again', phone: 'Open the thread at its usual height' }
// the half size's column in each look: the floating looks' thread, Still's letter, Professional's whole card
const COLUMN = '#ask .ask-half, #ask .ask-still-line[data-region="half-left"] .ask-letter, #ask .pr-ask-layer[data-region="half-left"]'
// a phone's full-height thread: the floating looks' sheet, Still's letter (Professional's shows once it has a conversation)
const TALL = '#ask .ask-sheet[data-height="full"], #ask .ask-still-line[data-region="sheet"] .ask-letter'
const near = (a, b, what, tol = 2) => assert(Math.abs(a - b) <= tol, `${what}: ${a} is not ${b}`)

for (const [screen, viewport] of Object.entries(SCREENS)) {
  const context = await browser.newContext({ viewport, ...(screen === 'phone' ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) })
  await context.route('**/*', (route) => (route.request().url().startsWith(hive) ? route.continue() : route.fulfill({ status: 204, body: '' })))
  page = await context.newPage()
  page.setDefaultTimeout(WAIT)
  page.on('pageerror', (e) => console.log(`page error (${screen}): ${e.message}`))
  await page.goto(hive + '/')
  // the person signs in and picks Never in the rest setting, so a slow step never leaves a press under the rest screen
  await page.evaluate((t) => { localStorage.setItem('omegadots.hive.token', t); localStorage.setItem('omegahive.rest', JSON.stringify({ minutes: 0 })) }, person)
  // a page hears the stage once its events socket is open and the stage has read where its hearing starts
  const hearing = async (go) => {
    const socket = page.waitForEvent('websocket', (ws) => ws.url().includes('/api/events'))
    const start = page.waitForResponse((r) => r.url().includes('/api/me/stage'))
    // awaited together, so a load that fails its own step never leaves a wait to fail later outside every check
    await Promise.all([socket, start, go()])
  }
  const shot = (name) => page.screenshot({ path: resolve(out, name), animations: 'disabled' })
  // a person's press: the control is shown and is what a press at its centre lands on, then a real pointer press goes
  // there. Playwright's own click also waits for two still animation frames, which on a loaded host with a WebGL look
  // starve for minutes (Canvas on a phone drew 3 frames in 5 s at a load of 173, while the dock never moved)
  const tap = async (loc) => {
    const el = loc.first()
    await el.waitFor({ state: 'visible' })
    const box = await el.boundingBox()
    const at = [box.x + box.width / 2, box.y + box.height / 2]
    const hit = await el.evaluate((node, [x, y]) => { const top = document.elementFromPoint(x, y); return !!top && (node === top || node.contains(top)) }, at)
    assert(hit, `something covers the control where a press lands: ${await el.evaluate((n) => n.outerHTML.slice(0, 120))}`)
    await page.mouse.click(at[0], at[1])
  }
  // polled on a timer, never on animation frames, for the same reason
  const until2 = (fn, arg) => page.waitForFunction(fn, arg, { polling: 150 })
  // a phased look's home rests with the Ask hidden: its apps control wakes it without touching the Ask, as a person
  // opening their apps does (every phased look has one: data-intent="shell.apps")
  const wake = async (look) => {
    if (!PHASED_HOME.has(look)) return
    await until2(() => !!document.documentElement.dataset.shellPhase)
    if (await page.evaluate(() => document.documentElement.dataset.shellPhase === 'rest')) {
      await tap(page.locator('[data-intent="shell.apps"]:visible'))
      await until2(() => document.documentElement.dataset.shellPhase !== 'rest')
    }
  }
  // the page loaded again as a person reloads it, woken where its look rests
  const reload = async (look) => {
    await hearing(() => page.reload())
    await until2((skin) => document.querySelector('#ask')?.getAttribute('data-skin') === skin, SKIN[look])
    await wake(look)
  }
  // a fresh page in this look at this size, as the person's hive keeps them, where the host draws the Ask
  const fresh = async (look, size) => {
    const cur = await prefs()
    await api('PUT', '/api/me/ui', person, { variant: cur.variant ?? null, layout: cur.layout ?? null, apps: cur.apps ?? null, experience: look === 'classic' ? null : look, ask_size: size })
    await page.goto(`${hive}/${ROUTE[look] ?? '#/'}`)
    await reload(look)
  }
  // the thread (Still's letter) opened with the look's own control, where a size control lives in its head
  const openThread = async (look) => {
    if (look === 'still') await tap(page.locator('#ask .ask-still-btn', { hasText: 'Today’s page' }))
    else if (look !== 'professional') await tap(page.locator('#ask button[aria-label^="Show the thread"]'))
  }
  // a control of the look's, pressed where the look keeps it: in its field or card head, else in its thread's head
  const press = async (look, selector) => {
    if (!(await page.locator(`#ask ${selector}:visible`).count())) await openThread(look)
    await tap(page.locator(`#ask ${selector}:visible`))
  }
  const focused = () => until2(() => !!document.activeElement?.closest?.('#ask') && document.activeElement.matches('[data-ask-input]'))

  for (const look of LOOKS) {
    const name = `${look} on a ${screen}`
    await check(`${name}: the look's own control collapses the Ask to its mark at the start of its row, and the hive keeps it`, async () => {
      await fresh(look, 'bubble')
      await page.locator(FIELD).first().waitFor({ state: 'visible' })
      await press(look, COLLAPSE)
      const mark = page.locator(MARK)
      await mark.waitFor({ state: 'visible' })
      const m = await mark.boundingBox()
      assert(m.x < 300 && m.y + m.height > viewport.height - 170, `the mark sits at the start of the Ask's row, bottom left: ${JSON.stringify(m)}`)
      assert.equal(await page.locator(FIELD).count(), 0, 'no field shows while the Ask is collapsed')
      // a look that aligns with the Ask's row keeps its column while the Ask is the mark (Professional's home)
      if (look === 'professional') {
        const home = await page.locator('.prh-column').boundingBox()
        assert(home && home.width >= 300, `Professional's home keeps its column beside the mark: ${JSON.stringify(home)}`)
      }
      await kept('collapsed')
      await shot(`60-ask-${look}-${screen}-collapsed.png`)
    })
    await check(`${name}: collapsed stays collapsed across a reload; the mark and Ctrl+K open it with the cursor in its field`, async () => {
      await reload(look)
      await page.locator(MARK).waitFor({ state: 'visible' })
      assert.equal(await page.locator(FIELD).count(), 0, 'still collapsed after a reload')
      await tap(page.locator(MARK))
      await page.locator(FIELD).first().waitFor({ state: 'visible' })
      await focused()
      await kept('bubble')
      await press(look, COLLAPSE)
      await page.locator(MARK).waitFor({ state: 'visible' })
      await kept('collapsed')
      await page.keyboard.press('Control+k')
      await page.locator(FIELD).first().waitFor({ state: 'visible' })
      await focused()
      await kept('bubble')
    })
    await check(`${name}: the look's own control sets the half size, which ${screen === 'desktop' ? 'puts the field and the thread in the left half' : 'opens the thread full height'} and is kept across a reload`, async () => {
      await press(look, `button[aria-label="${HALF[screen]}"]`)
      await kept('half')
      const measure = async () => {
        if (screen === 'desktop') {
          const col = page.locator(COLUMN).first()
          await col.waitFor({ state: 'visible' })
          // its entrance slides it in: measured once it has settled
          await until2((sel) => {
            const el = document.querySelector(sel)
            const t = el ? getComputedStyle(el).transform : ''
            return !!el && getComputedStyle(el).opacity === '1' && (t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)')
          }, COLUMN)
          const c = await col.boundingBox()
          // the left half of what lies right of where the Ask's row starts (past Ω or the rail): the rest is the stage's
          const middle = (c.x + viewport.width) / 2
          assert(c.x < 320 && c.x + c.width <= middle + 2 && c.x + c.width >= middle - 40 && c.height >= viewport.height * 0.6, `the Ask's column is the left half, top to foot: ${JSON.stringify(c)}`)
          const f = await page.locator(FIELD).first().boundingBox()
          assert(f.x >= c.x - 2 && f.x + f.width <= middle + 2, `the field is in the left half, under the column: ${JSON.stringify(f)}`)
          // what the look draws starts right of the column: a page's window (Still and Construct open one here) and
          // Professional's awake home, which would otherwise lie half under it
          const beside = ROUTE[look] ? '.xc-page' : look === 'professional' ? '.prh-column' : null
          if (beside) {
            const b = await page.locator(beside).first().boundingBox()
            assert(b && b.x >= c.x + c.width - 1, `${beside} starts right of the Ask's column: ${JSON.stringify(b)} beside ${JSON.stringify(c)}`)
          }
        } else if (look !== 'professional') {
          if (!(await page.locator(TALL).count())) await openThread(look)
          const t = page.locator(TALL).first()
          await t.waitFor({ state: 'visible' })
          await until2((sel) => (document.querySelector(sel)?.getBoundingClientRect().height ?? 0) >= window.innerHeight * 0.6, TALL)
        } else {
          await page.locator('#ask .pr-ask-layer[data-region="sheet"]').waitFor({ state: 'attached' })
        }
      }
      await measure()
      await shot(`61-ask-${look}-${screen}-half.png`)
      await reload(look)
      await page.locator(FIELD).first().waitFor({ state: 'visible' })
      await measure()
    })
    if (screen === 'desktop') {
      await check(`${name}: with the Ask at half, a picture a mind shows fills the right half the Ask leaves`, async () => {
        await ask('Show me the harbour photo you made', ['show', photo])
        const item = page.locator(`[data-stage-item="${photo.id}"]`)
        await item.waitFor({ state: 'visible' })
        await page.locator(`[data-stage-item="${photo.id}"] img`).waitFor({ state: 'visible' })
        const c = await page.locator(COLUMN).first().boundingBox()
        const w = await page.locator('[data-stage-window]').boundingBox()
        const p = await item.boundingBox()
        near(w.x, c.x + c.width, 'the stage arranges from where the Ask’s column ends', 2)
        near(w.x + w.width, viewport.width, 'to the screen’s right edge', 2)
        assert(p.x >= c.x + c.width - 1 && p.x + p.width <= viewport.width + 1, `the picture is in the right half: ${JSON.stringify(p)}`)
        near(p.x + p.width / 2, w.x + w.width / 2, 'centred across the right half', 2)
        assert(p.width / p.height > 1.3 && p.width / p.height < 1.37, `the picture keeps its shape: ${p.width}x${p.height}`)
        await shot(`62-ask-${look}-desktop-half-stage.png`)
        await tap(page.getByRole('button', { name: 'Put away' }))
        await page.locator('[data-stage]').waitFor({ state: 'detached' })
      })
    }
    await check(`${name}: the same control takes it back to the bubble, and the half's ${screen === 'desktop' ? 'column' : 'full height'} goes`, async () => {
      await press(look, `button[aria-label="${BUBBLE[screen]}"]`)
      await kept('bubble')
      await page.locator(FIELD).first().waitFor({ state: 'visible' })
      if (screen === 'desktop') await page.locator(COLUMN).first().waitFor({ state: 'detached' })
      else await page.locator('#ask [data-region="sheet"]').first().waitFor({ state: 'detached' })
      await shot(`63-ask-${look}-${screen}-bubble.png`)
    })
  }
  await context.close()
}

hub.close()
await browser.close()
await writeFile(resolve(out, 'ask-sizes-check.json'), JSON.stringify({ hive, results }, null, 2) + '\n')
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length} of ${results.length} checks passed`)
if (failed.length) {
  console.log(`failed: ${failed.map((r) => r.name).join('; ')}`)
  process.exit(1)
}
