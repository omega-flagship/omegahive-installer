/**
 * Purpose: Ask turns end to end on a running local hive, in a real Chromium. From the hive map a person asks for a
 * picture by its title, and the Ask's conductor moves the page to Artifacts and shows it, finding its id only by its
 * name in the move's answer. That answer is the page the move opened, read once it has rendered and its list has
 * landed (features/ask/conductor settledPage), its creations named by the hive (core/conductor _named_refs). Then,
 * on the classic look and on Canvas, the person asks from the home page to build a tip calculator, and the conductor
 * hands it to Create (core/conductor make, kind view: the person's own Create plan, which Create plans, builds and
 * checks), says so, and the answer holds no code. On v0.31 that build was handed to Studio, refused, and answered
 * with the app's HTML; building software goes to Create with no exceptions (Jon on #395).
 * Last, the person asks from the home page for research: the conductor hands it to the
 * Research swarm, and the turn shows the hand-over and the whole answer with no gap (on v0.31 the turn's intent frame
 * was dropped by the page, and the answer showed as incomplete); then the researcher finishes, as its own mind would
 * with its own token, and the report comes back to that turn, where the person opens it.
 *
 * The conductor's model here is this script: a small OpenAI-compatible server the hive calls as its local provider.
 * It plays rules, not a mind. Asked for a picture: first it moves to Artifacts, and moves there again while an answer
 * says the page was still loading, as the conductor's prompt says to; then it looks for the asked title among the
 * names in the last move's answer and shows the one it finds; then it says so. A move answered with the page it left,
 * or with unnamed ids, gives it nothing to show, and the check fails. Asked to build: it makes the view with make, as
 * the conductor's prompt says to, then says so. Asked to research: it hands it over with dispatch, then says so. A
 * call that is not the conductor's (a researcher mind the hive starts) is answered with words only. Run the hive with
 * Create on and
 *   HIVE_CREATE_PLAN_ENGINE=on HIVE_ASK_CONDUCTOR=1 HIVE_ASK_CONDUCTOR_MODEL=local/conductor-script HIVE_LOCAL_LLM_MODELS=conductor-script
 *   HIVE_LOCAL_LLM_URL=http://127.0.0.1:<model port>/v1
 *
 * Usage (a disposable hive with invented content; the operator password in HIVE_CHECK_PASSWORD):
 *   node scripts/ask-conductor-check.mjs --hive http://127.0.0.1:8878 --model-port 8879 --browser <chromium> --out <dir>
 *     --data-dir <the hive's HIVE_DATA_DIR, where the researcher's token is>
 * The hive's owner must be a named admin who existed when the hive started, as on an installed hive (make one with
 * the operator password, then restart the hive): the hive binds its Research swarm to its owner only at start, so a
 * Research swarm still bound to the operator password refuses every hand-over, and the research check says so.
 * Writes 48-ask-move-show-desktop.png, 49-ask-build-classic-desktop.png, 50-ask-build-canvas-desktop.png,
 * 51-ask-research-report-desktop.png and ask-conductor-check.json into --out; exits non-zero, naming every failed check.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] }
const hive = (flag('--hive') ?? '').replace(/\/+$/, '')
const modelPort = Number(flag('--model-port'))
const browserPath = flag('--browser')
const out = resolve(flag('--out') ?? 'ask-conductor-check-out')
const dataDir = flag('--data-dir')
const password = process.env.HIVE_CHECK_PASSWORD
assert(hive && modelPort && browserPath && dataDir && password, 'needs --hive, --model-port, --browser, --data-dir and HIVE_CHECK_PASSWORD')
// waits are generous: the check runs on shared, loaded hosts where the first page also compiles its screens
const WAIT = 90_000
const TITLE = 'Harbour at dusk'
const RESEARCH_ASK = 'I would like to research reputation systems for decentralised AI networks'
const SENT_WORDS = 'I have sent this for research. The sourced report will come back to this conversation when it is ready.'
// a report as a researcher proposes one (research.py REPORT_SCHEMA): its one claim cites no page, so it reads uncited
const REPORT = { summary: 'Reputation in open AI networks rests on staking and peer review.',
  sections: [{ heading: 'What the sources say', claims: [{ text: 'Staked reviews make a bad report cost something.', citations: [] }] }],
  open_questions: ['How is collusion between reviewers found?'] }

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

// ---- the conductor's scripted model -----------------------------------------------------------------------------------
// every request it answered, with the tool results it was given: what the check reads afterwards
const calls = []
const toolCall = (name, args) => ({ id: `call_${name}_${calls.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
function decide(body) {
  const messages = body.messages ?? []
  // only the conductor's calls are played: a researcher mind the hive starts gets words, never the conductor's tools
  if (!(body.tools ?? []).some((t) => t.function?.name === 'dispatch')) return { content: 'This scripted model plays only the Ask conductor.' }
  // this turn only: what follows the person's latest words (a thread's earlier turns come before them)
  const last = messages.map((m) => m.role).lastIndexOf('user')
  const asked = messages[last]?.role === 'user' && typeof messages[last].content === 'string' ? messages[last] : null
  const title = asked?.content.match(/called (.+?)[.?!]*$/i)?.[1]?.trim()
  const results = messages.slice(last).filter((m) => m.role === 'tool').map((m) => { try { return JSON.parse(m.content) } catch { return {} } })
  // asked to build: handed to Create with make, as the conductor's prompt says, never written out; then said
  if (/\bbuild\b/i.test(asked?.content ?? '')) {
    const made = results.find((r) => r.plan_id !== undefined || r.reason)
    if (!made) return { tool_calls: [toolCall('make', { kind: 'view', title: 'a tip calculator' })] }
    return { content: made.ok ? 'Create is building your tip calculator. You can follow it in Create.' : 'I could not start it here.' }
  }
  // asked to research: handed over with dispatch, as the conductor's prompt says; then said
  if (/\bresearch\b/i.test(asked?.content ?? '')) {
    const handed = results.find((r) => typeof r.ok === 'boolean')
    if (!handed) return { tool_calls: [toolCall('dispatch', { kind: 'research.request', request: { title: 'Reputation systems', instruction: 'What are the latest advances in reputation systems for decentralised AI networks, and their biggest unaddressed problems?' }, label: 'Research it' })] }
    return { content: handed.ok ? SENT_WORDS : 'I could not send that for research.' }
  }
  const moves = results.filter((r) => r.view !== undefined || r.loading !== undefined)
  const moved = moves[moves.length - 1]
  const shown = results.find((r) => Array.isArray(r.items))
  if (!moved) return { tool_calls: [toolCall('navigate', { route: '#/artifacts', label: 'Artifacts' })] }
  if (shown) return { content: `It is on your screen: ${title}.` }
  // as the conductor's prompt says: an answer read while the page was still loading is read again, by a move to the
  // same place, rather than acted on (twice at most here)
  if (moved.loading && moves.length < 3) return { tool_calls: [toolCall('navigate', { route: '#/artifacts', label: 'Artifacts' })] }
  // the one rule this model plays: the asked title among the names the move's answer gives, never a guess
  const found = (moved.view?.refs ?? []).find((r) => r.kind === 'artifact' && r.name === title)
  if (!found) return { content: `I could not find ${title} on that page.` }
  return { tool_calls: [toolCall('show', { item: found.id })] }
}
const model = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const reply = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)) }
    if (req.method === 'GET' && req.url.endsWith('/models')) return reply(200, { object: 'list', data: [{ id: 'conductor-script', object: 'model' }] })
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) return reply(404, { error: { message: 'not here' } })
    const body = JSON.parse(raw)
    const message = { role: 'assistant', content: null, ...decide(body) }
    calls.push({ body, message })
    reply(200, { id: `chatcmpl-${calls.length}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
      choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  })
})
await new Promise((ok) => model.listen(modelPort, '127.0.0.1', ok))

// ---- a person, a mind's creations, the page ---------------------------------------------------------------------------
await mkdir(out, { recursive: true })
const operatorToken = (await api('POST', '/api/auth/login', null, { password })).token
const email = `ask-conductor-check-${Date.now()}@example.test`
const member = await api('POST', '/api/people/members', operatorToken, { email, name: 'Sam' })
const person = (await api('POST', '/api/auth/login', null, { email, password: member.password })).token
// the person set First Light aside before (its Not now, which the hive records), so it never opens over the page
await api('PATCH', '/api/me/onboarding', person, { status: 'skipped' })
const swarm = await api('POST', '/api/swarms', person, { name: 'Harbour photos' })
const wren = await api('POST', '/api/agents', person, { name: 'Wren', kind: 'module', swarm_id: swarm.id })
await api('PATCH', `/api/swarms/${swarm.id}`, operatorToken, { coordinator_id: wren.id })
const svg = (sky) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"><rect width="640" height="480" fill="${sky}"/>
<circle cx="420" cy="250" r="46" fill="#ffd9a0"/><rect y="290" width="640" height="190" fill="#24476b"/></svg>`
// the asked one among others, so the model must pick it by its name
await api('POST', '/api/agent/artifacts', wren.token, { kind: 'image', title: 'Lighthouse', body: svg('#101d33') })
const photo = await api('POST', '/api/agent/artifacts', wren.token, { kind: 'image', title: TITLE, body: svg('#e98d58') })
await api('POST', '/api/agent/artifacts', wren.token, { kind: 'note', title: 'Notes on the harbour', body: 'Two boats heading in.' })
const caps = (await api('GET', '/api/me/ask', person))?.capabilities ?? {}
assert(caps.conductor === true, 'the hive does not answer the Ask with its conductor: run it with HIVE_ASK_CONDUCTOR=1')
// the mind the person asks is awake: a module mind runs outside the hive and is awake once it connects to the hub with
// its own token (the person's own mind would be woken before the Ask is sent, which needs a mind runtime this check
// does not start); the conductor answers the turn either way
const hub = new WebSocket(hive.replace(/^http/, 'ws') + '/agent-hub', { headers: { authorization: `Bearer ${wren.token}` } })
await new Promise((ok, no) => { hub.onopen = ok; hub.onerror = () => no(new Error('the mind could not reach the hub')) })
let awake = false
for (let i = 0; i < 60 && !awake; i++) {
  awake = (await api('GET', `/api/agents/${wren.id}`, person)).status === 'awake'
  if (!awake) await new Promise((r) => setTimeout(r, 500))
}
assert(awake, 'the mind did not come awake on the hub')

const browser = await chromium.launch({ executablePath: resolve(browserPath), headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
// reduced motion stills the hive map: drawn by this headless browser's software renderer it takes ~470 ms a frame,
// which would put every wait of the page's behind it; a person's own GPU draws it in a few ms
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
await context.route('**/*', (route) => (route.request().url().startsWith(hive) ? route.continue() : route.fulfill({ status: 204, body: '' })))
page = await context.newPage()
page.setDefaultTimeout(WAIT)
page.on('pageerror', (e) => console.log(`page error: ${e.message}`))
// a page hears the stage once its events socket is open and the stage has read where its hearing starts
const hearing = async (go) => {
  const socket = page.waitForEvent('websocket', (ws) => ws.url().includes('/api/events'))
  const start = page.waitForResponse((r) => r.url().includes('/api/me/stage'))
  await go()
  await Promise.all([socket, start])
}
await page.goto(hive + '/')
// the person signs in and picks Never in the rest setting, so a slow step never leaves a press under the rest screen
await page.evaluate((t) => { localStorage.setItem('omegadots.hive.token', t); localStorage.setItem('omegahive.rest', JSON.stringify({ minutes: 0 })) }, person)
await hearing(() => page.goto(hive + '/#/'))

await check('from the hive map, one Ask turn asking for a picture by its title moves to Artifacts and shows that picture', async () => {
  assert(!(await page.evaluate(() => location.hash)).startsWith('#/artifacts'), 'the turn must begin away from Artifacts')
  // the person picks the Harbour photos swarm, whose mind is awake, to answer just this thread, from the Ask's own chip
  await page.locator('#ask button[data-answerer-chip]').first().click()
  await page.locator('[role="listbox"][aria-label="Who answers"] [role="option"]').filter({ hasText: 'Harbour photos' }).first().click()
  const justThis = page.getByRole('button', { name: 'Just for this thread' })
  if (await justThis.isVisible().catch(() => false)) await justThis.click()
  const field = page.locator('#ask input.ask-input').first()
  await field.waitFor({ state: 'visible' })
  await field.fill(`Show me the picture called ${TITLE}.`)
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/ask') && r.method() === 'POST')
  // the row that puts the words to the Ask's answerer, as a person picks it when the words are a question for the mind
  const mindRow = page.locator('#ask [role="option"]').filter({ hasText: /Ask|Answer/ }).first()
  if (await mindRow.isVisible().catch(() => false)) await mindRow.click()
  else await field.press('Enter')
  const request = await sent
  assert.equal(request.postDataJSON().context.route, 'hive', 'the turn is asked from the hive map')
  // the conductor moves the page, reads Artifacts once settled, and shows the picture it found there by name
  await page.waitForFunction(() => location.hash.startsWith('#/artifacts'))
  const shown = page.locator(`[data-stage-item="${photo.id}"]`)
  await shown.waitFor({ state: 'visible' })
  // the answer the model showed it from: the last move's, which named the picture once Artifacts had read its list
  const moves = calls.flatMap((c) => c.body.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content))).filter((r) => r.view !== undefined || r.loading !== undefined)
  const answer = moves[moves.length - 1]
  assert.equal(answer.loading, undefined, `the last move was answered before Artifacts had read its list: ${JSON.stringify(answer)}`)
  assert.ok(answer.view.refs.some((r) => r.kind === 'artifact' && r.id === photo.id && r.name === TITLE), `the move's answer names the picture: ${JSON.stringify(answer.view.refs)}`)
  const said = calls.map((c) => c.message.tool_calls?.[0]?.function.name ?? 'text')
  assert.deepEqual(said.slice(-2), ['show', 'text'], `the conductor moved, then showed the picture: ${said.join(', ')}`)
  assert.ok(said.slice(0, -2).every((x) => x === 'navigate'), `only moves before the show: ${said.join(', ')}`)
  await page.locator(`[data-stage-item="${photo.id}"] img`).waitFor({ state: 'visible' })
  await page.screenshot({ path: resolve(out, '48-ask-move-show-desktop.png'), animations: 'disabled' })
})

// the made thing's result, from what the model was given after its make: polled, since the hive answers the turn
// while the page draws
const madeSince = async (since) => {
  for (let i = 0; i < WAIT / 500; i++) {
    const given = calls.slice(since).flatMap((c) => c.body.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content)))
    const made = given.find((r) => r.plan_id !== undefined || (r.reason && !r.view))
    if (made) return made
    await new Promise((ok) => setTimeout(ok, 500))
  }
  throw new Error('the conductor never made it')
}
for (const [look, shot] of [['classic', '49'], ['canvas', '50']]) {
  await check(`on the ${look} look, from the home page, one Ask turn asking to build a tip calculator hands it to Create and says so, with no code in the answer`, async () => {
    // the person's look, as their own look setting saves it (PUT /api/me/ui; null is the classic hive)
    await api('PUT', '/api/me/ui', person, { variant: null, layout: null, experience: look === 'classic' ? null : look })
    // the home page, opened afresh so the look applies and the page hears the stage on a new socket
    await page.evaluate(() => { location.hash = '#/' })
    await hearing(() => page.reload())
    await page.waitForFunction((l) => (document.querySelector('#ask')?.getAttribute('data-skin') ?? '') !== '' && (l === 'classic' || document.querySelector('#ask')?.getAttribute('data-skin') === 'note'), look)
    await page.locator('#ask button[data-answerer-chip]').first().click()
    await page.locator('[role="listbox"][aria-label="Who answers"] [role="option"]').filter({ hasText: 'Harbour photos' }).first().click()
    const justThis = page.getByRole('button', { name: 'Just for this thread' })
    if (await justThis.isVisible().catch(() => false)) await justThis.click()
    const field = page.locator('#ask [data-ask-input]').first()
    await field.waitFor({ state: 'visible' })
    await field.fill('Please build a tip calculator app')
    const since = calls.length
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/ask') && r.method() === 'POST')
    const mindRow = page.locator('#ask [role="option"]').filter({ hasText: /Ask|Answer/ }).first()
    if (await mindRow.isVisible().catch(() => false)) await mindRow.click()
    else await field.press('Enter')
    assert.equal((await sent).postDataJSON().context.route, 'hive', 'the turn is asked from the home page')
    const made = await madeSince(since)
    assert.ok(made.ok && /^plan_/.test(made.plan_id ?? ''), `the conductor started her Create plan: ${JSON.stringify(made)}`)
    await page.waitForFunction(() => /Create is building/.test(document.querySelector('#ask')?.textContent ?? ''))
    const thread = await page.locator('#ask').innerText()
    assert.ok(!/```|<!doctype|<html|<\/?script/i.test(thread), `no code in the answer: ${thread.slice(0, 400)}`)
    const said = calls.slice(since).map((c) => c.message.tool_calls?.[0]?.function.name ?? 'text')
    assert.deepEqual(said, ['make', 'text'], `made, then said: ${said.join(', ')}`)
    await page.screenshot({ path: resolve(out, `${shot}-ask-build-${look}-desktop.png`), animations: 'disabled' })
  })
}

await check('from the home page, a research hand-over in the Ask shows whole, with no gap, and its report comes back to that turn', async () => {
  await api('PUT', '/api/me/ui', person, { variant: null, layout: null, experience: null })
  await page.evaluate(() => { location.hash = '#/' })
  await hearing(() => page.reload())
  await page.locator('#ask button[data-answerer-chip]').first().click()
  await page.locator('[role="listbox"][aria-label="Who answers"] [role="option"]').filter({ hasText: 'Harbour photos' }).first().click()
  const justThis = page.getByRole('button', { name: 'Just for this thread' })
  if (await justThis.isVisible().catch(() => false)) await justThis.click()
  const field = page.locator('#ask [data-ask-input]').first()
  await field.waitFor({ state: 'visible' })
  await field.fill(RESEARCH_ASK)
  const since = calls.length
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/ask') && r.method() === 'POST')
  const mindRow = page.locator('#ask [role="option"]').filter({ hasText: /Ask|Answer/ }).first()
  if (await mindRow.isVisible().catch(() => false)) await mindRow.click()
  else await field.press('Enter')
  const op = (await sent).postDataJSON().operation_id
  // the hand-over's result, as the model was given it (polled: the hive answers the turn while the page draws). A
  // Research swarm bound to the operator password refuses it: the hive must start after its owner admin exists.
  let handed = null
  for (let i = 0; i < WAIT / 500 && !handed; i++) {
    handed = calls.slice(since).flatMap((c) => c.body.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content))).find((r) => typeof r.ok === 'boolean') ?? null
    if (!handed) await new Promise((ok) => setTimeout(ok, 500))
  }
  assert.ok(handed?.ok, `the hive admitted the hand-over: ${JSON.stringify(handed)}`)
  // the turn, whole: the hand-over and the answer, with no gap and nothing marked incomplete (the v0.31 report)
  await page.waitForFunction((w) => (document.querySelector('#ask')?.textContent ?? '').includes(w), SENT_WORDS)
  await page.locator('#ask [data-kind="change"]').filter({ hasText: 'Handed to Research' }).first().waitFor({ state: 'visible' })
  const turn = await page.locator('#ask').innerText()
  assert.equal(await page.locator('#ask [data-kind="gap"]').count(), 0, `no gap: ${turn.slice(0, 400)}`)
  assert.ok(!/could not be loaded|Incomplete/.test(turn), `nothing marked incomplete: ${turn.slice(0, 400)}`)
  const said = calls.slice(since).filter((c) => (c.body.tools ?? []).some((t) => t.function?.name === 'dispatch')).map((c) => c.message.tool_calls?.[0]?.function.name ?? 'text')
  assert.deepEqual(said, ['dispatch', 'text'], `handed over, then said: ${said.join(', ')}`)
  // the frames the hive stored for the turn, intent frames included, every one placed by the page
  const stored = (await api('GET', `/api/ask/${encodeURIComponent(op)}`, person)).events.map((e) => e.phase)
  assert.ok(stored.includes('intent') && stored.includes('dispatched'), `the hive stored the hand-over's frames: ${stored.join(', ')}`)
  // the researcher finishes as its own mind would, with its own token (in its workspace in the hive's data directory)
  const researcher = (await api('GET', '/api/agents', operatorToken)).filter((a) => String(a.name).startsWith('foundation.researcher.v1')).at(-1)
  assert.ok(researcher, 'the hive started a researcher for the request')
  const token = (await readFile(resolve(dataDir, 'agents', researcher.id, 'token'), 'utf8')).trim()
  const [task] = await api('GET', '/api/agent/goals', token)
  assert.ok(task, 'the researcher sees its task')
  await api('POST', `/api/agent/goals/${task.id}/claim`, token).catch(() => undefined)   // its own runtime may have claimed it first
  const full = await api('GET', `/api/agent/goals/${task.id}`, token)
  await api('POST', `/api/agent/goals/${task.id}/result`, token, { status: 'done', result: 'Report ready', data: { proposal: REPORT, binding_digest: full.binding_digest } })
  // the report back at its turn, as the conductor said it would come, and opened
  const report = page.locator('#ask [data-kind="research"]')
  await report.waitFor({ state: 'visible' })
  assert.ok((await report.innerText()).includes(REPORT.summary), `the report's summary shows: ${await report.innerText()}`)
  await report.getByRole('button', { name: 'Show the report' }).click()
  await report.getByText(REPORT.sections[0].claims[0].text).waitFor({ state: 'visible' })
  assert.equal(await page.locator('#ask [data-kind="gap"]').count(), 0, 'still no gap after the report')
  await page.screenshot({ path: resolve(out, '51-ask-research-report-desktop.png'), animations: 'disabled' })
})

await browser.close()
hub.close()
model.close()
// what the model was told and answered, call by call: the move's answer and the make's result are the evidence
await writeFile(resolve(out, 'ask-conductor-check.json'), JSON.stringify({ hive, results, calls: calls.map((c) => ({ given: c.body.messages.filter((m) => m.role === 'tool').map((m) => m.content), answered: c.message })) }, null, 2) + '\n')
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length} of ${results.length} checks passed`)
if (failed.length) {
  console.log(`failed: ${failed.map((r) => r.name).join('; ')}`)
  process.exit(1)
}
