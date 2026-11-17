/**
 * Purpose: a request that ends before its answer can be continued (Haley, testers' group, 17 Nov: "At the very least, if
 * it's going to stop, please have a 'continue task' button... Ask currently doesn't remember what it was working on"),
 * checked in a real Chromium against a running local hive:
 *   - the person asks for something, the mind starts on it (it says so and hands part of it on), and the person stops it;
 *   - the thread says it stopped and offers Continue, as features/ask/thread.metta composes it;
 *   - Continue asks again in the person's words from MeTTa, and the mind is handed the stopped request with what it said
 *     and did and why it stopped (the conversation the Ask carries), so it carries on from there;
 *   - after a second stop the person types their own words instead, and the mind carries on the same way.
 *
 * The conductor's model is this script: a small OpenAI-compatible server the hive calls as its local provider. Asked for
 * something, it says it is starting and then asks to move the page, a call it holds until the person stops the turn.
 * Asked to carry on, it reads the conversation it was handed and names the stopped request it carries on with. Run the
 * hive with
 *   HIVE_ASK_CONDUCTOR=1 HIVE_ASK_CONDUCTOR_MODEL=local/conductor-script HIVE_LOCAL_LLM_MODELS=conductor-script
 *   HIVE_LOCAL_LLM_URL=http://127.0.0.1:<model port>/v1
 *
 * Usage (a disposable hive with invented content; the operator password in HIVE_CHECK_PASSWORD):
 *   node scripts/ask-continue-check.mjs --hive http://127.0.0.1:8878 --model-port 8879 --browser <chromium> --out <dir>
 * Writes ask-continue-check.json and its screenshots into --out; exits non-zero, naming every failed check.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] }
const hive = (flag('--hive') ?? '').replace(/\/+$/, '')
const modelPort = Number(flag('--model-port'))
const browserPath = flag('--browser')
const out = resolve(flag('--out') ?? 'ask-continue-check-out')
const password = process.env.HIVE_CHECK_PASSWORD
assert(hive && modelPort && browserPath && password, 'needs --hive, --model-port, --browser and HIVE_CHECK_PASSWORD')
const WAIT = 90_000
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const stamp = () => new Date().toISOString().slice(11, 23)
const say = (line) => console.log(`${stamp()} ${line}`)

const results = []
let page = null
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
const calls = []
// the call that asks to move the page waits here until the person has stopped the turn
let held = null
const CARRY_ON = /^(continue|please carry on)\b/i
const toolCall = (name, args) => ({ id: `call_${name}_${calls.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
function decide(body) {
  const messages = body.messages ?? []
  const last = messages.map((m) => m.role).lastIndexOf('user')
  const asked = typeof messages[last]?.content === 'string' ? messages[last].content.trim() : ''
  const results = messages.slice(last).filter((m) => m.role === 'tool')
  if (CARRY_ON.test(asked)) {
    // what it carries on with: the stopped request in the conversation it was handed, never a guess
    const handed = messages.slice(0, last).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))).join('\n')
    const stopped = [...handed.matchAll(/they said: “([^”]+)”\n\s+.+ answered: “([^”]*)”/g)].filter((m) => /was stopped/.test(m[2])).pop()
    return { content: stopped ? `Carrying on with “${stopped[1]}” from where it stopped.` : 'I do not know what to carry on with.' }
  }
  if (!results.length) return { tool_calls: [toolCall('say', { text: 'Starting on the board.' })] }
  return { tool_calls: [toolCall('navigate', { route: '#/artifacts', label: 'Artifacts' })], hold: true }
}
const model = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', async () => {
    const reply = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)) }
    if (req.method === 'GET' && req.url.endsWith('/models')) return reply(200, { object: 'list', data: [{ id: 'conductor-script', object: 'model' }] })
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) return reply(404, { error: { message: 'not here' } })
    const body = JSON.parse(raw)
    const { hold, ...decided } = decide(body)
    const message = { role: 'assistant', content: null, ...decided }
    calls.push({ body, message })
    say(`model call ${calls.length}: ${message.tool_calls ? message.tool_calls[0].function.name : 'text'}${hold ? ', held' : ''}`)
    if (hold) {
      let release
      held = { arrived: true, go: new Promise((ok) => (release = ok)), release }
      await held.go
    }
    reply(200, { id: `chatcmpl-${calls.length}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
      choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  })
})
await new Promise((ok) => model.listen(modelPort, '127.0.0.1', ok))

// ---- a person, a swarm whose mind answers, the page -------------------------------------------------------------------
await mkdir(out, { recursive: true })
const operatorToken = (await api('POST', '/api/auth/login', null, { password })).token
const email = `ask-continue-check-${Date.now()}@example.test`
const member = await api('POST', '/api/people/members', operatorToken, { email, name: 'Sam' })
const person = (await api('POST', '/api/auth/login', null, { email, password: member.password })).token
await api('PATCH', '/api/me/onboarding', person, { status: 'skipped' })
const swarm = await api('POST', '/api/swarms', person, { name: 'Game makers' })
const wren = await api('POST', '/api/agents', person, { name: 'Wren', kind: 'module', swarm_id: swarm.id })
await api('PATCH', `/api/swarms/${swarm.id}`, operatorToken, { coordinator_id: wren.id })
await api('PUT', '/api/me/ask', person, { swarm_id: swarm.id })
const caps = (await api('GET', '/api/me/ask', person))?.capabilities ?? {}
assert(caps.conductor === true, 'the hive does not answer the Ask with its conductor: run it with HIVE_ASK_CONDUCTOR=1')
const hub = new WebSocket(hive.replace(/^http/, 'ws') + '/agent-hub', { headers: { authorization: `Bearer ${wren.token}` } })
await new Promise((ok, no) => { hub.onopen = ok; hub.onerror = () => no(new Error('the mind could not reach the hub')) })
let awake = false
for (let i = 0; i < 60 && !awake; i++) {
  awake = (await api('GET', `/api/agents/${wren.id}`, person)).status === 'awake'
  if (!awake) await sleep(500)
}
assert(awake, 'the mind did not come awake on the hub')

const browser = await chromium.launch({ executablePath: resolve(browserPath), headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
// reduced motion stills the hive map, which a headless software renderer draws at ~470 ms a frame
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
await context.route('**/*', (route) => (route.request().url().startsWith(hive) ? route.continue() : route.fulfill({ status: 204, body: '' })))
page = await context.newPage()
page.setDefaultTimeout(WAIT)
page.on('pageerror', (e) => console.log(`page error: ${e.message}`))
await page.goto(hive + '/')
await page.evaluate((t) => { localStorage.setItem('omegadots.hive.token', t); localStorage.setItem('omegahive.rest', JSON.stringify({ minutes: 0 })) }, person)
const socket = page.waitForEvent('websocket', (ws) => ws.url().includes('/api/events'))
await page.reload()
await socket
say('page open, hearing the hive')

/** The person asks in the Ask; the operation id the page sent it under. */
async function ask(words) {
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
  sent.catch(() => undefined)
  // the row that puts the words to the Ask's answerer: Enter sends it when it is already the selected row, as a person
  // does; otherwise the person picks it
  const mindRow = page.locator('#ask [role="option"]').filter({ hasText: /Ask|Answer/ }).first()
  await mindRow.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined)
  if (await mindRow.isVisible().catch(() => false) && (await mindRow.getAttribute('aria-selected').catch(() => null)) !== 'true') await mindRow.click()
  else await field.press('Enter')
  const op = (await sent).postDataJSON().operation_id
  say(`asked ${op}: ${words}`)
  return op
}
/** The person stops the request once the mind has started on it and is waiting on its next step. */
async function startedThenStopped(words) {
  held = null
  const op = await ask(words)
  for (let i = 0; i < WAIT / 250 && !held; i++) await sleep(250)
  assert.ok(held, 'the mind never reached its second step')
  await page.locator('#ask button[data-stop]').first().click()
  for (let i = 0; i < WAIT / 500; i++) {
    const view = await api('GET', `/api/ask/${encodeURIComponent(op)}`, person)
    if (view.state === 'done' || view.state === 'refused') break
    await sleep(500)
  }
  held.release()
  say('stopped')
  return op
}
const carriedOn = (request) => `Carrying on with “${request}” from where it stopped.`

const first = 'Build me a tic-tac-toe game'
await check('a request the person stopped says so and offers Continue, and Continue carries on from what it did', async () => {
  await page.getByRole('button', { name: 'New thread' }).first().click().catch(() => undefined)
  await startedThenStopped(first)
  const thread = page.locator('#ask')
  await thread.getByText('This request was stopped.').first().waitFor({ state: 'visible' })
  const go = thread.locator('[data-ask-ending]').getByRole('button', { name: 'Continue' })
  await go.waitFor({ state: 'visible' })
  await page.screenshot({ path: resolve(out, 'ask-continue-offered.png') })
  const since = calls.length
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/ask') && r.method() === 'POST')
  await go.click()
  const body = (await sent).postDataJSON()
  assert.equal(body.text, 'Continue', 'Continue asks in its own words')
  const stopped = (body.conversation ?? []).at(-1)
  assert.ok(stopped && stopped.said === first && /Starting on the board/.test(stopped.answer) && /was stopped/.test(stopped.answer), `the stopped request goes with it: ${JSON.stringify(body.conversation)}`)
  await thread.getByText(carriedOn(first)).first().waitFor({ state: 'visible' })
  assert.ok(calls.slice(since).some((c) => c.message.content === carriedOn(first)), 'the mind was handed the stopped request')
  // Continue was the way on from that stop; it is not offered again once a later request is in the thread
  assert.equal(await thread.locator('[data-ask-ending]').getByRole('button', { name: 'Continue' }).count(), 0, 'Continue is still offered under an older request')
  await page.screenshot({ path: resolve(out, 'ask-continue-carried-on.png') })
})

const second = 'Build me a chess board'
await check('after a stop, the person\'s own words carry on the same way', async () => {
  await startedThenStopped(second)
  await page.locator('#ask').locator('[data-ask-ending]').getByRole('button', { name: 'Continue' }).waitFor({ state: 'visible' })
  await ask('please carry on')
  await page.locator('#ask').getByText(carriedOn(second)).first().waitFor({ state: 'visible' })
})

await writeFile(resolve(out, 'ask-continue-check.json'), JSON.stringify({ hive, results }, null, 2))
await browser.close()
hub.close()
model.close()
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length} of ${results.length} passed`)
process.exit(failed.length ? 1 : 0)
