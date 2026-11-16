/** Explicit browser, isolated Vite harness, synthetic callbacks; never attaches to live Hive. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile, writeFile, statfs, mkdtemp, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] }
const receiptPath = flag('--receipt')
const browserPath = flag('--browser')
const servingOnly = args.includes('--serve-check')
const receipt = { kind: 'omegacode-isolated-browser-check', created_at: new Date().toISOString(),
  scope: 'synthetic component callbacks, no live Hive/service/native/model interaction',
  status: 'unexecuted', browser_interactions: 'unexecuted', checks: [], source_sha256: {} }
let server, browser, scratch
try {
  for (const path of ['scripts/omegacode-browser-check.mjs', 'scripts/fixtures/omegacode.html', 'scripts/fixtures/omegacode.tsx',
    'src/features/code/GitExportPanel.tsx', 'src/features/code/gitHistory.ts', 'src/features/code/SymbolicPanel.tsx', 'src/ui/confirm.tsx', 'src/features/code/DebuggerPanel.tsx', 'src/features/code/debuggerSession.ts']) {
    receipt.source_sha256[path] = createHash('sha256').update(await readFile(resolve(root, path))).digest('hex')
  }
  const disk = await statfs(root)
  assert(disk.bavail * disk.bsize >= 10 * 1024 ** 3 + 2 * 1024 ** 2, '10 GiB disk guard plus 2 MiB QA headroom required')
  if (!servingOnly) {
    assert(browserPath, 'Pass --browser with an existing compatible Chromium executable; no automatic installation')
    await access(resolve(browserPath), constants.X_OK)
  }
  scratch = await mkdtemp(resolve(tmpdir(), 'omegacode-browser-'))
  server = await createServer({ root, cacheDir: resolve(scratch, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false } })
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  const url = `${origin}/scripts/fixtures/omegacode.html`
  for (const path of ['/scripts/fixtures/omegacode.html', '/scripts/fixtures/omegacode.tsx', '/src/features/code/GitExportPanel.tsx', '/src/features/code/SymbolicPanel.tsx']) {
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(10_000) })
    assert.equal(response.status, 200, path)
    assert((await response.text()).length > 100, path)
  }
  receipt.checks.push('loopback fixture and component transforms served')
  if (servingOnly) { receipt.status = 'harness-serving-only'; process.exitCode = 0 }
  else {
    browser = await chromium.launch({ executablePath: resolve(browserPath), headless: true, timeout: 15_000 })
    receipt.browser_version = browser.version()
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
    const failures = []
    await context.route('**/*', route => {
      const target = new URL(route.request().url())
      if (target.origin === origin) return route.continue()
      failures.push(`external request blocked: ${target.origin}`); return route.abort()
    })
    const page = await context.newPage()
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => failures.push(error.message))
    const requests = () => page.evaluate(() => structuredClone(window.omegaCodeQA.requests))
    const dialog = () => page.getByRole('alertdialog')
    const create = () => page.getByRole('button', { name: 'Create review export', exact: true })
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15_000 })
    await page.getByLabel('History mode').selectOption('original')
    await page.getByLabel('Commit message').fill('Unicode review Ω → 🐝')
    await create().click()
    await dialog().waitFor({ state: 'visible' })
    assert.match(await dialog().innerText(), /"history_mode":"original"/)
    assert.equal((await requests()).length, 0)
    await dialog().getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal((await requests()).length, 0)
    receipt.checks.push('hidden Symbolic pane does not steal visible exact-body approval; cancel sends nothing')
    await create().click()
    await dialog().getByRole('button', { name: 'Create review export', exact: true }).click()
    await page.getByText('Synthetic lost response', { exact: true }).waitFor()
    assert(await page.getByLabel('History mode').isDisabled())
    await page.getByRole('button', { name: 'Advance source', exact: true }).click()
    await page.getByRole('button', { name: 'Retry exact export', exact: true }).click()
    await dialog().getByRole('button', { name: 'Retry exact export', exact: true }).click()
    await page.getByText(/gx_synthetic · generation 1 · historical source/).waitFor()
    const sent = await requests()
    assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1])
    assert.equal(sent[0].body.message, 'Unicode review Ω → 🐝')
    receipt.checks.push('lost-response retry freezes operation, original mode, Unicode message and prior source generation')
    await page.getByRole('button', { name: 'Toggle dirty draft', exact: true }).click()
    assert(await create().isDisabled())
    await page.getByRole('button', { name: 'Toggle dirty draft', exact: true }).click()
    await create().click()
    // A programmatic click simulates another editor/source publisher while the modal is open.
    await page.getByRole('button', { name: 'Advance source', exact: true }).evaluate(button => button.click())
    await page.getByLabel('Source generation').filter({ hasText: '3' }).waitFor()
    await dialog().getByRole('button', { name: 'Create review export', exact: true }).click()
    await page.getByText('Source changed during confirmation; review it again', { exact: true }).waitFor()
    assert.equal((await requests()).length, 2)
    receipt.checks.push('dirty draft blocks create; source changed during confirmation refuses without sending')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByLabel('Review branch').fill('review/mobile')
    await page.getByRole('button', { name: 'Switch pane', exact: true }).click()
    await page.getByRole('button', { name: 'Switch pane', exact: true }).click()
    assert.equal(await page.getByLabel('Review branch').inputValue(), 'review/mobile')
    await create().click(); await dialog().waitFor({ state: 'visible' })
    await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' })
    assert.equal((await requests()).length, 2)
    receipt.checks.push('narrow viewport keeps Git draft across panes and keyboard Escape cancels approval')
    await page.getByRole('button', {name:'Open debugger pane',exact:true}).click()
    await page.getByRole('button', {name:'Discover debugger runtimes',exact:true}).click()
    await page.getByLabel('Debugger runtime', {exact:true}).selectOption('debug')
    await page.getByRole('button', {name:'Start debugger',exact:true}).click()
    await dialog().getByRole('button', {name:'Start debugger',exact:true}).click()
    await page.getByRole('button', {name:'Read debugger output / status',exact:true}).click()
    await page.getByText('Matching debugger ready receipt observed.', {exact:true}).waitFor()
    await page.getByLabel('Saved debugger target', {exact:true}).fill('src/Ω.py')
    await page.getByLabel('Breakpoint lines', {exact:true}).fill('1, 4')
    await page.getByRole('button', {name:'Review and send debugger input',exact:true}).click()
    assert.match(await dialog().innerText(), /src\/Ω.py/)
    await dialog().getByRole('button', {name:'Send debugger input',exact:true}).click()
    await page.getByText('Synthetic lost debugger response', {exact:true}).waitFor()
    assert(await page.getByLabel('Saved debugger target', {exact:true}).isDisabled())
    await page.getByRole('button', {name:'Advance source',exact:true}).click()
    await page.getByRole('button', {name:'Retry exact debugger request',exact:true}).click()
    await dialog().getByRole('button', {name:'Retry exact debugger request',exact:true}).click()
    await page.getByText(/Input ctl_synthetic: queued/).waitFor()
    const debuggerInputs=(await requests()).filter(r=>r.path==='/v1/runs/run_debug/terminal')
    assert.equal(debuggerInputs.length,2);assert.deepEqual(debuggerInputs[0],debuggerInputs[1])
    const frame=JSON.parse(Buffer.from(debuggerInputs[0].body.data_base64,'base64').toString('utf8'))
    assert.equal(frame.path,'src/Ω.py');assert.deepEqual(frame.breakpoints,[1,4])
    receipt.checks.push('debugger ready/source/runtime custody, Unicode breakpoint launch and exact uncertain retry across source change')
    assert.deepEqual(failures, [])
    receipt.browser_interactions = 'passed'; receipt.status = 'passed-synthetic-browser-interactions'
  }
} catch (error) {
  receipt.error = String(error.message ?? error)
  receipt.status = server || browser ? 'failed' : 'preflight-refused'
  process.exitCode = 3
} finally {
  try {
    try { if (browser) await browser.close() } finally { if (server) await server.close() }
  } finally { if (scratch) await rm(scratch, { recursive: true, force: true }) }
  if (receiptPath) await writeFile(resolve(receiptPath), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt))
}
