/** Owned headless browser control. Requires an admitted, explicitly pinned browser and built fixture URL. */
import { chromium } from 'playwright-core'
import { mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'

const flags = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1]
  if (!['--base-url', '--browser-executable', '--owned-root', '--output'].includes(key) || !value || flags.has(key)) throw new Error('Invalid browser control arguments')
  flags.set(key, value)
}
if (flags.size !== 4) throw new Error('Explicit fixture/browser/owned output arguments required')
const url = new URL(flags.get('--base-url'))
if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('Owned loopback fixture only')
const owned = path.resolve(flags.get('--owned-root')), output = path.resolve(flags.get('--output'))
if (!path.isAbsolute(flags.get('--browser-executable')) || output === owned || !output.startsWith(owned + path.sep)) throw new Error('Owned output and absolute browser path required')
await mkdir(path.join(owned, 'browser-tmp'), { recursive: true })
const need = (ok, message) => { if (!ok) throw new Error(message) }
const results = []
const evidence = []
let browserProcess, browser
let browserPid = null
let observedPgid = null
let browserExit = null
let browserExited
let protocolCloseSent = false, termSent = false, killSent = false
const execFileAsync = promisify(execFile)
const started = Date.now()
async function fixture(run) {
  const context = await browser.newContext({ viewport: { width: 1120, height: 850 }, acceptDownloads: true })
  const network = { external: 0, duringMemory: 0, measure: false }
  const errors = []
  await context.route('**/*', (route) => {
    const requested = new URL(route.request().url())
    if (requested.origin !== url.origin) { network.external++; return route.abort('blockedbyclient') }
    if (network.measure) network.duringMemory++
    return route.continue()
  })
  const page = await context.newPage()
  page.on('pageerror', () => errors.push('pageerror'))
  try {
    await page.goto(url.href)
    await page.waitForFunction(() => !!window.p8Host && !!document.querySelector('iframe'))
    const frame = page.frames().find((f) => f !== page.mainFrame())
    need(frame, 'Opaque app frame missing')
    await frame.waitForFunction(() => !!globalThis.p8Frame && globalThis.p8Frame.received.some((r) => r.type === 'context'))
    await page.evaluate(async () => { await document.fonts.ready })
    await page.waitForLoadState('networkidle', { timeout: 10_000 })
    network.measure = true
    await run({ page, frame, network, errors })
    need(network.external === 0, 'Unexpected external browser request')
    need(network.duringMemory === 0, 'Memory control made an HTTP request')
    need(await page.evaluate(() => window.p8Host.wireSafe()), 'Unexpected lifecycle/secret/binary payload reached onward recorder')
    need(errors.length === 0, 'Host browser page error')
  } finally { await context.close() }
}
const openMemory = async (frame, page, id = 'review', theme) => {
  await frame.evaluate(([id, theme]) => globalThis.p8Frame.open(id, 'this topic', theme), [id, theme])
  await page.locator('[data-app-memory-host]').waitFor({ state: 'visible' })
  await frame.waitForFunction((id) => globalThis.p8Frame.received.some((r) => r.type === 'memory-opened' && r.id === id), id)
}
const noFrameContent = async (page, frame) => {
  const received = await frame.evaluate(() => globalThis.p8Frame.received)
  const sentinel = await page.evaluate(() => window.p8Host.sentinel)
  need(!JSON.stringify(received).includes(sentinel), 'Host sentinel reached a frame-visible message')
  need(await frame.evaluate(() => globalThis.p8Frame.safePayloads()), 'Binary/image/pixel-bearing frame payload')
  await page.waitForFunction((count) => window.p8Host.onward.length >= count, received.length)
  need(await page.evaluate(() => !JSON.stringify(window.p8Host.onward).includes(window.p8Host.sentinel)), 'Host sentinel reached an onward channel')
  const onward = await page.evaluate(() => window.p8Host.onward)
  need(JSON.stringify(onward).startsWith(JSON.stringify(received).slice(0, -1)), 'Frame message was not forwarded to the independent recorder')
}
const check = async (name, run) => {
  const at = Date.now()
  try { await fixture(run); results.push({ name, outcome: 'passed', seconds: (Date.now() - at) / 1000 }) }
  catch (error) { results.push({ name, outcome: 'failed', error: error instanceof Error ? error.message : 'browser control error', seconds: (Date.now() - at) / 1000 }); throw error }
}
try {
  const profile = path.join(owned, 'browser-profile')
  await mkdir(profile) // exclusive: never attach the person's or an earlier attempt's browser profile
  browserProcess = spawn(flags.get('--browser-executable'), ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--disable-background-networking', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-breakpad', '--disable-crash-reporter', '--password-store=basic', '--use-mock-keychain', 'about:blank'],
    { detached: false, stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin', TMPDIR: path.join(owned, 'browser-tmp') } })
  browserPid = browserProcess.pid
  browserExited = new Promise((resolve) => browserProcess.once('exit', (code, signal) => { browserExit = { code, signal }; resolve() }))
  const endpoint = await new Promise((resolve, reject) => {
    let bytes = 0, text = '', complete = false
    const timer = setTimeout(() => finish(new Error('Browser protocol startup deadline')), 20_000)
    const finish = (error, value) => { if (complete) return; complete = true; clearTimeout(timer); error ? reject(error) : resolve(value) }
    browserProcess.once('error', () => finish(new Error('Owned browser spawn failed')))
    browserProcess.once('exit', () => finish(new Error('Owned browser exited before protocol ready')))
    browserProcess.stderr.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 65_536) { termSent = true; browserProcess.kill('SIGTERM'); return finish(new Error('Browser startup diagnostic bound exceeded')) }
      text += chunk.toString('utf8')
      const found = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text)
      if (found) {
        const address = new URL(found[1])
        if (address.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(address.hostname) || !address.port || address.username || address.password) return finish(new Error('Nonlocal browser protocol endpoint'))
        finish(null, address.href)
      }
    })
  })
  // Playwright's launcher detaches on Darwin. Spawn above deliberately inherits the registered worker PGID;
  // verify two numeric owned rows before any page/control work. The normal worker pins /bin/ps and samples this group.
  const processRows = await execFileAsync('/bin/ps', ['-p', `${process.pid},${browserPid}`, '-o', 'pid=,ppid=,pgid='], { timeout: 2000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin' } })
  const rows = processRows.stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number))
  const own = rows.find((r) => r[0] === process.pid), child = rows.find((r) => r[0] === browserPid)
  need(rows.length === 2 && rows.every((r) => r.length === 3 && r.every((n) => Number.isSafeInteger(n) && n > 0)) && !!own && !!child && child[1] === process.pid && child[2] === own[2], 'Owned browser did not inherit sampled process group')
  observedPgid = own[2]
  browser = await chromium.connectOverCDP(endpoint, { timeout: 20_000 })
  await check('Actual opaque frame receives lifecycle only; host DOM/pixels remain inaccessible; local memory produces no requests', async ({ page, frame, network }) => {
    network.measure = true
    const calls = await page.evaluate(() => window.p8Host.calls.length)
    await openMemory(frame, page)
    const identity = await page.locator('[data-memory-host-identity]').textContent()
    need(identity.includes('Your memory · kept safe in your hive') && identity.includes('OmegaHive') && identity.includes('Close'), 'Host identity line missing')
    const secretVisible = await page.evaluate(() => document.querySelector('[data-memory-themed]').textContent.includes(window.p8Host.sentinel))
    need(secretVisible, 'Host did not draw actual stored memory')
    need(await frame.evaluate(() => globalThis.p8Frame.parentRead()) === 'SecurityError', 'Frame could read parent DOM')
    need(await frame.evaluate(() => globalThis.p8Frame.parentPixels()) === 'SecurityError', 'Frame could access host overlay geometry/pixel source')
    need(await page.evaluate(() => !document.querySelector('[data-memory-themed]').contains(document.querySelector('[data-memory-host-identity]'))), 'Identity is inside themed body')
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await frame.waitForFunction(() => globalThis.p8Frame.received.filter((r) => r.type.startsWith('memory-')).map((r) => r.type + ':' + r.id).join(',') === 'memory-opened:review,memory-closed:review')
    const onlyLifecycle = await frame.evaluate(() => globalThis.p8Frame.received.filter((r) => r.type.startsWith('memory-')).every((r) => Object.keys(r).sort().join(',') === 'channel,id,type'))
    need(onlyLifecycle, 'Memory lifecycle reply carried an extra field')
    need(await frame.evaluate(() => document.body.innerText.trim() === 'Invented app'), 'Frame DOM unexpectedly contained host content')
    await noFrameContent(page, frame)
    need(await page.evaluate(() => window.p8Host.calls.length) === calls && network.duringMemory === 0, 'Memory operation made a network/client call')
  })
  await check('Unknown raw/export operations are refused without content', async ({ page, frame }) => {
    for (const type of ['memory-read', 'memory-export', 'memory-snapshot']) await frame.evaluate((type) => globalThis.p8Frame.send({ type, id: type }), type)
    await frame.waitForFunction(() => globalThis.p8Frame.received.filter((r) => r.type === 'memory-refused').length === 3)
    need(await page.locator('[data-app-memory-host]').count() === 0, 'Raw operation opened a view')
    need(await frame.evaluate(() => globalThis.p8Frame.received.filter((r) => r.type === 'memory-refused').every((r) => Object.keys(r).sort().join(',') === 'channel,id,reason,type' && r.reason === 'unsupported')), 'Raw refusal contained data')
  })
  await check('Dark named mode and unknown variant fallback remain host-owned', async ({ page, frame }) => {
    await frame.evaluate(() => globalThis.p8Frame.send({ type: 'layout', mode: 'dark' }))
    await openMemory(frame, page, 'calm', 'calm')
    need(await page.locator('[data-memory-themed]').evaluate((e) => getComputedStyle(e).backgroundColor) === 'rgb(17, 17, 17)', 'Named dark theme not selected')
    // Start capture before the real frame mode signal. Both surfaces must retain AA during the entire swap,
    // including inherited memory text on an article whose panel updates immediately. No colour tween is safe.
    for (const reducedMotion of ['no-preference', 'reduce']) {
      await page.emulateMedia({ reducedMotion }) // universal host CSS must not re-enable colour transitions
      for (const [mode, expected] of [['light', 'rgb(255, 255, 255)'], ['dark', 'rgb(17, 17, 17)']]) {
        await page.evaluate(() => {
          const capture = { samples: [], done: false, started: performance.now() }
          window.__p8ThemeContrast = capture
          const luminance = (value) => {
            const rgb = value.match(/^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/)
            if (!rgb) throw new Error('Expected opaque computed theme colour')
            const channel = (n) => { const v = Number(n) / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 }
            return .2126 * channel(rgb[1]) + .7152 * channel(rgb[2]) + .0722 * channel(rgb[3])
          }
          const contrast = (ink, surface) => { const a = luminance(ink), b = luminance(surface); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }
          const sample = () => {
            const body = document.querySelector('[data-memory-themed]'), panel = body?.querySelector('article'), words = panel?.querySelector('p:nth-of-type(2)')
            if (!body || !panel || !words) throw new Error('Actual host theme and memory text required')
            const bs = getComputedStyle(body), ps = getComputedStyle(panel), ws = getComputedStyle(words)
            const elements = [body, ...body.querySelectorAll('*')]
            const background = (element) => {
              for (let at = element; at; at = at.parentElement) {
                const color = getComputedStyle(at).backgroundColor
                if (/^rgb\(/.test(color)) return color
                if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') throw new Error('Unexpected translucent theme background')
              }
              throw new Error('Opaque host theme background required')
            }
            const texts = elements.filter((e) => e.matches('input,textarea') || [...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && !!n.textContent?.trim()))
            const pairs = texts.map((e) => contrast(getComputedStyle(e).color, background(e)))
            const atomic = elements.every((e) => [null, '::before', '::after'].every((pseudo) => getComputedStyle(e, pseudo).transitionProperty === 'none'))
            capture.samples.push({ body: contrast(bs.color, bs.backgroundColor), panel: contrast(ws.color, ps.backgroundColor),
              minimum_text: Math.min(...pairs), checked_texts: pairs.length, atomic })
            if (performance.now() - capture.started >= 500) capture.done = true
            else requestAnimationFrame(sample)
          }
          sample()
        })
        await frame.evaluate((mode) => globalThis.p8Frame.send({ type: 'layout', mode }), mode)
        await page.waitForFunction((expected) => getComputedStyle(document.querySelector('[data-memory-themed]')).backgroundColor === expected, expected)
        await page.waitForFunction(() => window.__p8ThemeContrast.done, undefined, { timeout: 2000 })
        const samples = await page.evaluate(() => window.__p8ThemeContrast.samples)
        need(samples.length >= 2 && samples.every((s) => s.body >= 4.5 && s.panel >= 4.5 && s.checked_texts > 0 && s.minimum_text >= 4.5 && s.atomic), 'Theme mode swap reduced actual displayed memory contrast below AA')
      }
    }
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await openMemory(frame, page, 'unknown', 'undeclared')
    need(await page.locator('[data-memory-themed]').evaluate((e) => getComputedStyle(e).backgroundColor) === 'rgb(2, 2, 2)', 'Unknown variant did not use default dark theme')
  })
  await check('Fix uses host card, shows same-timestamp stale text, and awaits CAS', async ({ page, frame }) => {
    await openMemory(frame, page)
    await page.getByRole('button', { name: 'Fix', exact: true }).click()
    await page.getByLabel('Corrected words').fill('Invented corrected note')
    await page.evaluate(() => window.p8Host.concurrent('Invented concurrent note', true))
    await page.getByRole('button', { name: 'Review fix' }).click()
    await page.getByRole('alert').waitFor()
    need((await page.locator('[data-memory-host-confirm]').textContent()).includes('Invented concurrent note'), 'Current stale text was not shown')
    need(await page.evaluate(() => !document.querySelector('[data-memory-themed]').contains(document.querySelector('[data-memory-host-confirm]'))), 'Confirm was themed')
    await page.getByRole('button', { name: 'Save fix' }).click()
    await page.waitForFunction(async () => (await window.p8Host.current())[0]?.statement === 'Invented corrected note')
  })
  await check('Forget arms for two seconds and removes the stored belief', async ({ page, frame }) => {
    await openMemory(frame, page)
    await page.getByRole('button', { name: 'Forget', exact: true }).click()
    const confirm = page.locator('[data-memory-host-confirm] button').last()
    need(await confirm.isDisabled(), 'Forget armed immediately')
    await page.waitForTimeout(1000)
    need(await confirm.isDisabled(), 'Forget armed before two seconds')
    await confirm.waitFor({ state: 'visible' })
    await page.waitForFunction(() => !document.querySelector('[data-memory-host-confirm] button:last-child').disabled)
    await confirm.click()
    await page.waitForFunction(async () => (await window.p8Host.current()).length === 0)
  })
  await check('Export is an explicit host download with no frame data or network', async ({ page, frame, network }) => {
    await openMemory(frame, page)
    network.measure = true
    await page.getByRole('button', { name: 'Export your memory', exact: true }).click()
    const download = page.waitForEvent('download')
    await page.locator('[data-memory-host-confirm]').getByRole('button', { name: 'Export', exact: true }).click()
    const saved = await download
    need(saved.suggestedFilename() === 'Your-memory.json', 'Host download filename differed')
    const stream = await saved.createReadStream()
    need(stream, 'Host download bytes unavailable')
    const chunks = []; let size = 0
    for await (const chunk of stream) { size += chunk.length; need(size <= 1024 * 1024, 'Host export exceeded fixture bound'); chunks.push(chunk) }
    const raw = Buffer.concat(chunks), file = JSON.parse(raw.toString('utf8'))
    need(file.format === 'omegahive-mind-memory' && file.version === 1, 'Host download format differed')
    need(await page.evaluate((file) => window.p8Host.exportOwnerMatches(file), file), 'Host download owner metadata differed')
    const sentinel = await page.evaluate(() => window.p8Host.sentinel)
    need(raw.toString('utf8').includes(sentinel), 'Host export omitted actual own memory')
    evidence.push({ kind: 'host-export', bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex'), owner_and_actual_sentinel_verified: true })
    need(network.duringMemory === 0, 'Export made a browser request')
    need(await frame.evaluate(() => globalThis.p8Frame.received.filter((r) => r.type.startsWith('memory-')).every((r) => Object.keys(r).sort().join(',') === 'channel,id,type')), 'Export result reached frame')
    await noFrameContent(page, frame)
  })
  for (const kind of ['identity', 'owner', 'missing-program', 'missing-digest', 'disabled', 'release', 'pagehide', 'unmount']) {
    await check(`Current ${kind} boundary closes an open review`, async ({ page, frame }) => {
      await openMemory(frame, page)
      await page.evaluate((kind) => window.p8Host.invalidate(kind), kind)
      await page.locator('[data-app-memory-host]').waitFor({ state: 'hidden' })
    })
  }
  await check('A new iframe document closes the previous review', async ({ page, frame }) => {
    await openMemory(frame, page)
    await frame.evaluate(() => globalThis.p8Frame.navigate())
    await page.locator('[data-app-memory-host]').waitFor({ state: 'hidden' })
  })
  await check('Known session expiry survives backward wall-clock change and closes without another client call', async ({ page, frame: previousFrame }) => {
    // Arm both lifecycle barriers before the keyed remount can replace the document.
    const detached = page.waitForEvent('framedetached', (candidate) => candidate === previousFrame)
    const attached = page.waitForEvent('frameattached', (candidate) => candidate !== previousFrame && candidate.parentFrame() === page.mainFrame())
    const [, , frame] = await Promise.all([page.evaluate(() => window.p8Host.expireNextDocument()), detached, attached])
    await frame.waitForFunction(() => !!globalThis.p8Frame && globalThis.p8Frame.received.some((r) => r.type === 'context'))
    await openMemory(frame, page)
    const calls = await page.evaluate(() => window.p8Host.calls.length)
    await page.evaluate(() => { const read = Date.now; Date.now = () => read() - 1_000_000 })
    await page.locator('[data-app-memory-host]').waitFor({ state: 'hidden' })
    need(await page.evaluate(() => window.p8Host.calls.length) === calls, 'Expiry fetched authority through memory op')
  })
  for (const kind of ['commit', 'export']) await check(`Identity fence drops delayed ${kind} completion`, async ({ page, frame }) => {
    await openMemory(frame, page)
    await page.evaluate((kind) => window.p8Host.holdNext(kind), kind)
    let downloads = 0
    page.on('download', () => downloads++)
    if (kind === 'commit') {
      await page.getByRole('button', { name: 'Fix', exact: true }).click()
      await page.getByLabel('Corrected words').fill('Invented blocked late write')
      await page.getByRole('button', { name: 'Review fix' }).click()
      await page.getByRole('button', { name: 'Save fix' }).click()
    } else {
      await page.getByRole('button', { name: 'Export your memory' }).click()
      await page.locator('[data-memory-host-confirm]').getByRole('button', { name: 'Export', exact: true }).click()
    }
    await page.waitForFunction(() => window.p8Host.held())
    await page.evaluate(() => { window.p8Host.invalidate('identity'); window.p8Host.releaseHeld() })
    await page.waitForFunction(() => window.p8Host.settled() === 1)
    await page.locator('[data-app-memory-host]').waitFor({ state: 'hidden' })
    need(await page.evaluate(async () => (await window.p8Host.current())[0]?.statement === window.p8Host.sentinel), 'Delayed stale operation changed storage')
    need(downloads === 0, 'Delayed stale export downloaded')
  })

  // Actual production AppMemoryHost + AppMemory, fixed invented records. This is a
  // component-lifecycle control, not a claim that the original privacy hypothesis was reproduced.
  await check('Host opening key resets state across batched same-caller-id replacement', async ({ page }) => {
    await page.waitForFunction(() => window.p8Host.onward.length > 0)
    await page.evaluate(() => window.p8Host.lifecycleBegin())
    await page.locator('[data-app-memory-host]').waitFor({ state: 'visible' })
    need(await page.evaluate(() => document.querySelector('[data-memory-themed]').textContent.includes(window.p8Host.sentinel)), 'Initial lifecycle snapshot missing')
    await page.getByLabel('Search your memory').fill('Invented')
    await page.getByRole('button', { name: 'Fix', exact: true }).click()
    await page.getByLabel('Corrected words').fill('Invented old unsaved lifecycle fix')
    await page.getByRole('button', { name: 'Review fix', exact: true }).click()
    const fresh = await page.evaluate(() => window.p8Host.lifecyclePrepareNext())
    await page.evaluate(() => window.p8Host.holdNext('commit'))
    await page.getByRole('button', { name: 'Save fix', exact: true }).click()
    await page.waitForFunction(() => window.p8Host.held())
    need(await page.locator('[data-memory-host-confirm]').count() === 1, 'Old confirmation was not present')
    need(await page.getByRole('button', { name: 'Saving…', exact: true }).isDisabled(), 'Old busy confirmation was not held')
    const swapped = await page.evaluate(() => window.p8Host.lifecycleReplaceBatched())
    need(swapped.sameCallerId && swapped.changedHostKey, 'Fixture did not replace the same caller id with a fresh host opening')
    await page.locator('[data-app-memory-host]').waitFor({ state: 'visible' })
    need(await page.getByLabel('Search your memory').inputValue() === '', 'Previous search survived the opening')
    need(await page.getByLabel('Corrected words').count() === 0, 'Previous edit survived the opening')
    need(await page.locator('[data-memory-host-confirm]').count() === 0, 'Previous confirmation survived the opening')
    need(await page.getByRole('button', { name: 'Fix', exact: true }).isEnabled(), 'Previous busy state survived the opening')
    need(await page.evaluate((words) => {
      const body = document.querySelector('[data-memory-themed]').textContent
      return body.includes(words) && !body.includes(window.p8Host.sentinel) && !body.includes('Invented old unsaved lifecycle fix')
    }, fresh.words), 'Fresh opening retained the previous snapshot or unsaved words')
    await page.evaluate(() => window.p8Host.releaseHeld())
    await page.waitForFunction(() => window.p8Host.settled() === 1)
    need(await page.evaluate(async (words) => (await window.p8Host.current())[0]?.statement === words, fresh.words), 'Closed confirmation changed the replacement snapshot')
    await page.getByRole('button', { name: 'Forget', exact: true }).click()
    const arm = page.locator('[data-memory-host-confirm] button').last()
    need(await arm.isDisabled(), 'Replacement forget was already armed')
    need((await page.locator('[data-memory-host-confirm]').textContent()).includes('replacement lifecycle topic'), 'Replacement reason was not current')
    await page.waitForTimeout(1000)
    need(await arm.isDisabled(), 'Replacement forget armed before two seconds')
    await page.waitForFunction(() => !document.querySelector('[data-memory-host-confirm] button:last-child').disabled)
  })
  await check('Second memory-open is busy without replacing the first panel or spending another opening', async ({ page, frame, network }) => {
    const before = await page.evaluate(() => ({ client: window.p8Host.calls.length, review: window.p8Host.memoryReviewCalls() }))
    await openMemory(frame, page, 'first')
    await page.getByRole('textbox', { name: 'Search your memory', exact: true }).fill('Invented')
    await page.evaluate(() => { window.__p8FirstPanel = document.querySelector('[data-app-memory-host]') })
    await frame.evaluate(() => { for (const id of ['busy-1', 'busy-2', 'busy-3']) globalThis.p8Frame.open(id) })
    await frame.waitForFunction(() => globalThis.p8Frame.received.filter((r) => r.type === 'memory-refused' && r.reason === 'busy').length === 3)
    need(await page.locator('[data-app-memory-host]').count() === 1, 'Second opening replaced or duplicated the first panel')
    need(await page.evaluate(() => document.querySelector('[data-app-memory-host]') === window.__p8FirstPanel), 'First panel host identity changed on busy')
    need(await page.getByRole('textbox', { name: 'Search your memory', exact: true }).inputValue() === 'Invented', 'Busy request discarded first-panel state')
    need(await page.evaluate((before) => window.p8Host.calls.length === before.client && window.p8Host.memoryReviewCalls() === before.review + 1, before), 'Busy opening made a client call or spent another memory review')
    need(await frame.evaluate(() => {
      const rows = globalThis.p8Frame.received.filter((r) => r.type.startsWith('memory-'))
      return rows.filter((r) => r.type === 'memory-opened' && r.id === 'first').length === 1
        && !rows.some((r) => r.type === 'memory-closed')
        && rows.filter((r) => r.type === 'memory-refused').every((r) => r.reason === 'busy' && Object.keys(r).sort().join(',') === 'channel,id,reason,type')
    }), 'Busy request changed the first lifecycle or carried content')
    for (const [current, next] of [['first', 'second'], ['second', 'third']]) {
      await page.getByRole('button', { name: 'Close', exact: true }).click()
      await frame.waitForFunction((id) => globalThis.p8Frame.received.some((r) => r.type === 'memory-closed' && r.id === id), current)
      await openMemory(frame, page, next)
    }
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await frame.waitForFunction(() => globalThis.p8Frame.received.some((r) => r.type === 'memory-closed' && r.id === 'third'))
    await page.evaluate(() => document.activeElement?.blur())
    need(await page.evaluate(() => document.activeElement !== document.querySelector('iframe')), 'Fourth opening unexpectedly had an active frame')
    await frame.evaluate(() => globalThis.p8Frame.open('fourth'))
    await frame.waitForFunction(() => globalThis.p8Frame.received.some((r) => r.type === 'memory-refused' && r.id === 'fourth' && r.reason === 'rate-limited'))
    need(await page.locator('[data-app-memory-host]').count() === 0, 'Fourth unactivated opening exceeded the budget')
    need(await page.evaluate((before) => window.p8Host.calls.length === before.client && window.p8Host.memoryReviewCalls() === before.review + 3, before), 'Busy or rate-limited request consumed memory work')
    need(network.duringMemory === 0, 'Busy control made a browser request')
    await noFrameContent(page, frame)
  })
} catch { process.exitCode = 1 }
finally {
  if (browser && !browserExit) {
    await Promise.race([(async () => {
      try {
        const session = await browser.newBrowserCDPSession()
        protocolCloseSent = true
        await session.send('Browser.close')
      } catch { /* an orderly Browser.close can close the protocol before its reply; numeric exit below decides */ }
    })(), new Promise((resolve) => setTimeout(resolve, 3000))])
    await Promise.race([browserExited, new Promise((resolve) => setTimeout(resolve, 2000))])
  }
  if (browserProcess && !browserExit) {
    termSent = true
    browserProcess.kill('SIGTERM')
    await Promise.race([browserExited, new Promise((resolve) => setTimeout(resolve, 2000))])
    if (!browserExit) { killSent = true; browserProcess.kill('SIGKILL'); await Promise.race([browserExited, new Promise((resolve) => setTimeout(resolve, 2000))]) }
  }
  await Promise.race([browser?.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 1000))])
  const expectedExit = protocolCloseSent && browserExit?.code === 0 && browserExit?.signal === null && !termSent && !killSent
  if (!expectedExit) process.exitCode = 1
  const receipt = { schema: 'studio-p8-browser-controls/1', outcome: process.exitCode ? 'failed' : 'passed', browser_pid: browserPid,
    observed_browser_and_driver_pgid: observedPgid, browser_exit: browserExit, direct_browser_child_reaped: !!browserExit,
    protocol_close_sent: protocolCloseSent, term_sent: termSent, kill_sent: killSent, expected_orderly_exit: expectedExit,
    controls: results, evidence, expected_controls: 20, collected_controls: results.length, seconds: (Date.now() - started) / 1000,
    scope: 'Nineteen actual AppFrame/AppMemory/IndexedDB opaque-srcdoc controls plus one forced-batched component lifecycle control through the production AppMemoryHost renderer in an owned headless browser. No native user session, P1 broad controls, display-capture permission or OS/escaped-network qualification.' }
  if (results.length !== receipt.expected_controls || results.some((r) => r.outcome !== 'passed')) { receipt.outcome = 'failed'; process.exitCode = 1 }
  const fd = await open(output, 'wx'); try { await fd.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await fd.sync() } finally { await fd.close() }
}
