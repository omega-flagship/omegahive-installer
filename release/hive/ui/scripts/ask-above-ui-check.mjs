/**
 * Purpose: the Ask keeps working whatever the person does in the page (Jon, 17 Nov: "Ask should exist above UI - stop
 * shouldn't happen"), checked in a real Chromium against a running local hive. One Ask turn per trigger, each made while
 * the turn's model call is held, so the trigger lands mid-turn:
 *   - pointer: the person moves the pointer over the page, scrolls it and clicks on it;
 *   - visibility: the page goes hidden behind another tab (a trusted visibilitychange, its timers throttled as a
 *     background tab's are), then comes back, and the person clicks it, as after switching desktops;
 *   - navigation: the person opens another page of the hive and goes Back.
 * Each turn then answers: its words reach the Ask's thread, nothing in it says the Ask stopped, the turn closes complete,
 * and the move the mind asked for after the person's touch is held (answered stale_origin, the thread saying the person
 * took over), so the page stays where the person left it.
 *
 * Chromium is started here and driven through connectOverCDP with noDefaults: a page Playwright launches or attaches with
 * its defaults has focus emulation on, which keeps it visible behind other tabs, so its visibility never changes.
 *
 * The conductor's model is this script: a small OpenAI-compatible server the hive calls as its local provider. Its first
 * call of a turn waits until the check has done the turn's trigger, then asks to move the page to Artifacts; once that
 * move is answered it says it finished. Run the hive with
 *   HIVE_ASK_CONDUCTOR=1 HIVE_ASK_CONDUCTOR_MODEL=local/conductor-script HIVE_LOCAL_LLM_MODELS=conductor-script
 *   HIVE_LOCAL_LLM_URL=http://127.0.0.1:<model port>/v1
 *
 * Usage (a disposable hive with invented content; the operator password in HIVE_CHECK_PASSWORD):
 *   node scripts/ask-above-ui-check.mjs --hive http://127.0.0.1:8878 --model-port 8879 --browser <chromium> --out <dir>
 * Writes ask-above-ui-check.json and a screenshot per trigger into --out; exits non-zero, naming every failed check.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] }
const hive = (flag('--hive') ?? '').replace(/\/+$/, '')
const modelPort = Number(flag('--model-port'))
const browserPath = flag('--browser')
const out = resolve(flag('--out') ?? 'ask-above-ui-check-out')
const password = process.env.HIVE_CHECK_PASSWORD
assert(hive && modelPort && browserPath && password, 'needs --hive, --model-port, --browser and HIVE_CHECK_PASSWORD')
// waits are generous: the check runs on shared, loaded hosts where the first page also compiles its screens
const WAIT = 90_000
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
// what the Ask says when a turn ended before its answer: none of it may appear for a turn the person only touched
const STOPPED = /the Ask stopped|This request was stopped|Stopped here|Stopped\./

const results = []
let page = null
const stamp = () => new Date().toISOString().slice(11, 23)
const say = (line) => console.log(`${stamp()} ${line}`)
const check = async (name, fn) => {
  try { await fn(); results.push({ name, ok: true }); console.log(`ok    ${name}`) }
  catch (e) {
    results.push({ name, ok: false, error: String(e?.message ?? e) })
    console.log(`FAIL  ${name}: ${e?.message ?? e}`)
    await page?.screenshot({ path: resolve(out, `failed-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 80)}.png`) }).catch(() => undefined)
  }
}
async function api(method, path, token, body) {
  const res = await fetch(hive + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

// ---- the conductor's scripted model -----------------------------------------------------------------------------------
// every request it answered, with the tool results it was given: what the check reads afterwards
const calls = []
// the turn's first call waits here until the check lets it go: `arrived` once it is in, `release` to answer it
let hold = null
const holdNextTurn = () => {
  let arrived, release
  const h = { arrived: new Promise((ok) => (arrived = ok)), go: new Promise((ok) => (release = ok)) }
  h.arrive = arrived
  h.release = release
  hold = h
  return h
}
const toolCall = (name, args) => ({ id: `call_${name}_${calls.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
function decide(body) {
  const messages = body.messages ?? []
  // this turn only: what follows the person's latest words
  const last = messages.map((m) => m.role).lastIndexOf('user')
  const asked = typeof messages[last]?.content === 'string' ? messages[last].content : ''
  const results = messages.slice(last).filter((m) => m.role === 'tool').map((m) => { try { return JSON.parse(m.content) } catch { return {} } })
  if (!results.length) return { tool_calls: [toolCall('navigate', { route: '#/artifacts', label: 'Artifacts' })] }
  return { content: `Finished: ${asked.replace(/[.?!]+$/, '')}.` }
}
const model = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', async () => {
    const reply = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)) }
    if (req.method === 'GET' && req.url.endsWith('/models')) return reply(200, { object: 'list', data: [{ id: 'conductor-script', object: 'model' }] })
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) return reply(404, { error: { message: 'not here' } })
    const body = JSON.parse(raw)
    const message = { role: 'assistant', content: null, ...decide(body) }
    say(`model call ${calls.length + 1}: ${message.tool_calls ? message.tool_calls[0].function.name : 'text'}${message.tool_calls && hold ? ', held' : ''}`)
    // the turn's first call (no tool result yet) is held while the check makes the person's move
    if (message.tool_calls && hold) {
      const h = hold
      hold = null
      h.arrive()
      await h.go
    }
    calls.push({ body, message })
    reply(200, { id: `chatcmpl-${calls.length}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
      choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  })
})
await new Promise((ok) => model.listen(modelPort, '127.0.0.1', ok))

// ---- a person, a swarm whose mind answers, the page -------------------------------------------------------------------
await mkdir(out, { recursive: true })
const operatorToken = (await api('POST', '/api/auth/login', null, { password })).token
const email = `ask-above-ui-check-${Date.now()}@example.test`
const member = await api('POST', '/api/people/members', operatorToken, { email, name: 'Sam' })
const person = (await api('POST', '/api/auth/login', null, { email, password: member.password })).token
// the person set First Light aside before (its Not now, which the hive records), so it never opens over the page
await api('PATCH', '/api/me/onboarding', person, { status: 'skipped' })
const swarm = await api('POST', '/api/swarms', person, { name: 'Harbour photos' })
const wren = await api('POST', '/api/agents', person, { name: 'Wren', kind: 'module', swarm_id: swarm.id })
await api('PATCH', `/api/swarms/${swarm.id}`, operatorToken, { coordinator_id: wren.id })
// the person's Ask goes to that swarm, whose mind is awake, in every thread they start
await api('PUT', '/api/me/ask', person, { swarm_id: swarm.id })
const caps = (await api('GET', '/api/me/ask', person))?.capabilities ?? {}
assert(caps.conductor === true, 'the hive does not answer the Ask with its conductor: run it with HIVE_ASK_CONDUCTOR=1')
// the mind the person asks is awake: a module mind is awake once it connects to the hub with its own token
const hub = new WebSocket(hive.replace(/^http/, 'ws') + '/agent-hub', { headers: { authorization: `Bearer ${wren.token}` } })
await new Promise((ok, no) => { hub.onopen = ok; hub.onerror = () => no(new Error('the mind could not reach the hub')) })
let awake = false
for (let i = 0; i < 60 && !awake; i++) {
  awake = (await api('GET', `/api/agents/${wren.id}`, person)).status === 'awake'
  if (!awake) await sleep(500)
}
assert(awake, 'the mind did not come awake on the hub')

// Chromium as a person runs it: its own tabs in one window, each hidden while another is in front
const profile = resolve(out, 'chromium-profile')
await rm(profile, { recursive: true, force: true })
await mkdir(profile, { recursive: true })
const chrome = spawn(resolve(browserPath), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
  '--no-default-browser-check', '--window-size=1440,900', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' })
// the browser goes with this script however it ends, a failed step included
process.on('exit', () => chrome.kill())
let cdpPort = 0
for (let i = 0; i < 100 && !cdpPort; i++) {
  cdpPort = Number((await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0]) || 0
  if (!cdpPort) await sleep(200)
}
assert(cdpPort, 'Chromium did not open its debugging port')
const cdp = `http://127.0.0.1:${cdpPort}`
const browser = await chromium.connectOverCDP(cdp, { noDefaults: true })
const context = browser.contexts()[0]
page = context.pages()[0]
page.setDefaultTimeout(WAIT)
// reduced motion stills the hive map: drawn by this headless browser's software renderer a frame takes ~470 ms, and
// every pointer event would wait behind one (a person's own GPU draws it in a few ms); emulated media changes no
// visibility or focus
await page.emulateMedia({ reducedMotion: 'reduce' })
page.on('pageerror', (e) => console.log(`page error: ${e.message}`))
await context.route('**/*', (route) => (route.request().url().startsWith(hive) ? route.continue() : route.fulfill({ status: 204, body: '' })))
const pageTarget = (await (await fetch(`${cdp}/json/list`)).json()).find((t) => t.type === 'page')
await page.goto(hive + '/')
// the person signs in and picks Never in the rest setting, so the rest screen never covers a step
await page.evaluate((t) => { localStorage.setItem('omegadots.hive.token', t); localStorage.setItem('omegahive.rest', JSON.stringify({ minutes: 0 })) }, person)
// the page hears the turn's frames once its events socket is open: loaded afresh, signed in
const socket = page.waitForEvent('websocket', (ws) => ws.url().includes('/api/events'))
await page.reload()
await socket
say('page open, hearing the hive')

/** The person asks in a new thread; the turn's first model call is held until `trigger` has run, then the turn goes on. */
async function turnThrough(words, trigger) {
  // each trigger's turn in a thread of its own, so its thread holds only what that turn said
  const fresh = page.getByRole('button', { name: 'New thread' }).first()
  if (await fresh.isVisible().catch(() => false)) {
    await fresh.click()
    await page.locator('#ask').getByText(/Ask for anything/).first().waitFor({ state: 'visible' })
  }
  const held = holdNextTurn()
  const since = calls.length
  const field = page.locator('#ask [data-ask-input]').first()
  await field.waitFor({ state: 'visible' })
  // a new thread remounts the field: words typed into the old one are lost, so they are typed until the field holds them
  for (let i = 0; i < 20; i++) {
    await field.fill(words)
    if ((await field.inputValue().catch(() => '')) === words) break
    await sleep(250)
  }
  assert.equal(await field.inputValue(), words, 'the Ask field never held the words')
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/ask') && r.method() === 'POST')
  sent.catch(() => undefined)   // awaited below; a press that fails first must not leave it unhandled
  // the row that puts the words to the Ask's answerer: Enter sends it when it is already the selected row, as a person
  // does; otherwise the person picks it
  const mindRow = page.locator('#ask [role="option"]').filter({ hasText: /Ask|Answer/ }).first()
  await mindRow.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined)
  if (await mindRow.isVisible().catch(() => false) && (await mindRow.getAttribute('aria-selected').catch(() => null)) !== 'true') await mindRow.click()
  else await field.press('Enter')
  const op = (await sent).postDataJSON().operation_id
  say(`asked ${op}: ${words}`)
  await Promise.race([held.arrived, sleep(WAIT).then(() => { throw new Error('the turn never reached its model') })])
  say('the turn is at its model; the person acts')
  const where = await trigger()
  say(`the person is done; the model answers (page at ${where})`)
  held.release()
  // the turn closes on the hive, as the person's own recovery read gives it
  let view = null
  for (let i = 0; i < WAIT / 500; i++) {
    view = await api('GET', `/api/ask/${encodeURIComponent(op)}`, person)
    if (view.state === 'done' || view.state === 'refused') break
    await sleep(500)
  }
  say(`the turn ended ${view.state}${view.reason ? ` (${view.reason})` : ''}`)
  return { op, view, where, given: calls.slice(since) }
}

/** What a turn the person touched must show: its answer, no stop, the mind's move held (stale_origin), the page left be. */
async function answered(t, words) {
  const done = t.view.events.find((e) => e.phase === 'done')
  assert.equal(t.view.state, 'done', `the turn ended as ${t.view.state} (${t.view.reason ?? ''}), not with its answer`)
  assert.equal(done?.outcome, 'complete', `the turn's done frame: ${JSON.stringify(done)}`)
  const finished = `Finished: ${words.replace(/[.?!]+$/, '')}.`
  await page.locator('#ask').getByText(finished).first().waitFor({ state: 'visible' })
  const thread = await page.locator('#ask').innerText()
  assert.ok(!STOPPED.test(thread), `the thread says the Ask stopped: ${thread.slice(0, 400)}`)
  // the mind's move after the person's touch was held, not made: answered stale_origin, a Go card, the page left be
  const moveResult = t.given.flatMap((c) => c.body.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content)))[0]
  assert.equal(moveResult?.reason, 'stale_origin', `the move was answered ${JSON.stringify(moveResult)}`)
  assert.equal(await page.evaluate(() => location.hash), t.where, 'the page moved away from where the person left it')
  // the thread says the page is the person's now, and the answer came all the same
  await page.locator('#ask').getByText(/You took over/).first().waitFor({ state: 'visible' })
}

const pointer = 'Gather the harbour photos for the pointer check.'
await check('a turn runs on to its answer while the person moves the pointer over the page, scrolls it and clicks it', async () => {
  const t = await turnThrough(pointer, async () => {
    const box = page.viewportSize() ?? { width: 1440, height: 900 }
    for (let i = 0; i < 8; i++) await page.mouse.move(80 + i * 90, 120 + (i % 3) * 90, { steps: 2 })
    await page.mouse.wheel(0, 360)
    await page.mouse.wheel(0, -360)
    // a press on the page itself, away from the Ask
    await page.mouse.click(Math.round(box.width * 0.5), 24)
    await sleep(1500)
    return page.evaluate(() => location.hash)
  })
  await answered(t, pointer)
  await page.screenshot({ path: resolve(out, 'ask-above-ui-pointer.png') })
})

// words the Ask hands to the mind: none of them reads as one of its own commands (a look or a page to open)
const hidden = 'Gather the harbour photos for the hidden page check.'
await check('a turn runs on to its answer while its page is hidden behind another tab and shown again, and the person clicks back in', async () => {
  const t = await turnThrough(hidden, async () => {
    await page.evaluate(() => { window.__askAboveSeen = []; document.addEventListener('visibilitychange', (e) => window.__askAboveSeen.push(`${document.visibilityState}:${e.isTrusted}`)) })
    const other = await (await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })).json()
    await page.waitForFunction(() => document.visibilityState === 'hidden')
    // a few seconds away, long enough for the background tab's timers to be throttled
    await sleep(4000)
    await fetch(`${cdp}/json/activate/${pageTarget.id}`)
    await page.waitForFunction(() => document.visibilityState === 'visible')
    await fetch(`${cdp}/json/close/${other.id}`)
    const seen = await page.evaluate(() => window.__askAboveSeen)
    assert.deepEqual(seen, ['hidden:true', 'visible:true'], `the page was not hidden and shown by the browser itself: ${seen}`)
    await page.mouse.click(720, 24)
    await sleep(1500)
    return page.evaluate(() => location.hash)
  })
  await answered(t, hidden)
  await page.screenshot({ path: resolve(out, 'ask-above-ui-hidden.png') })
})

const navigation = 'Gather the harbour photos for the navigation check.'
await check('a turn runs on to its answer while the person opens another page of the hive and goes Back', async () => {
  const t = await turnThrough(navigation, async () => {
    const from = await page.evaluate(() => location.hash)
    // the person opens another page from the hive's own Main navigation
    const item = page.locator('nav[aria-label="Main"] button').filter({ hasText: /^(Settings|Usage|Swarms|Artifacts|Goals|Tasks)\b/ }).first()
    await item.click()
    await page.waitForFunction((h) => location.hash !== h, from)
    await sleep(1500)
    await page.goBack()
    await page.waitForFunction((h) => location.hash === h, from)
    await sleep(1500)
    return page.evaluate(() => location.hash)
  })
  await answered(t, navigation)
  await page.screenshot({ path: resolve(out, 'ask-above-ui-navigation.png') })
})

await writeFile(resolve(out, 'ask-above-ui-check.json'), JSON.stringify({ hive, results }, null, 2))
await browser.close().catch(() => undefined)
chrome.kill()
hub.close()
model.close()
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length} of ${results.length} passed`)
process.exit(failed.length ? 1 : 0)
