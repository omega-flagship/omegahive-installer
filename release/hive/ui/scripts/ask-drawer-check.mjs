// Purpose: verify that a Change conversation leaves Code review decisions visible and clickable.
// Usage: node scripts/ask-drawer-check.mjs http://localhost:5173 ../../ai-tmp/ask-drawer
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'

const base = new URL(process.argv[2] ?? 'http://localhost:5173')
base.searchParams.set('sim', '1')
base.hash = '/code/repo%3Asim-suggestions'
const out = resolve(process.argv[3] ?? '../../ai-tmp/ask-drawer')
await mkdir(out, { recursive: true })
const results = []
const browser = await chromium.launch({ channel: 'chrome', headless: true })

async function reachable(button, page, name) {
  await button.scrollIntoViewIfNeeded()
  const hit = await button.evaluate(element => {
    const r = element.getBoundingClientRect()
    return { rect: r.toJSON(), clear: [[.5, .5], [.1, .5], [.9, .5]].every(([x, y]) => element.contains(document.elementFromPoint(r.left + r.width * x, r.top + r.height * y))) }
  })
  await page.screenshot({ path: resolve(out, `${name}.png`) })
  assert.equal(hit.clear, true, `${name}: another surface covers the decision: ${JSON.stringify(hit.rect)}`)
  return hit.rect
}

try {
  for (const [name, viewport] of Object.entries({ desktop: { width: 1440, height: 900 }, tall: { width: 1440, height: 1800 }, phone: { width: 390, height: 844 }, smallPhone: { width: 360, height: 740 } })) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.addInitScript(() => localStorage.setItem('omegadots.intro.welcome.v1', 'explore'))
      await page.goto(base.href, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => window.__hiveAsk?.state().bound)
      await page.evaluate(async () => {
        const { useHive } = await import('/src/store/store.ts')
        const { saveSession } = await import('/src/features/code/savedSession.ts')
        const client = useHive.getState().client
        const me = await client.me()
        const opened = await client.codeOpen('repo:sim-suggestions')
        saveSession(me.principal, 'repo:sim-suggestions', opened, true)
        window.dispatchEvent(new StorageEvent('storage'))
      })
      await page.getByRole('button', { name: /^Reuse task / }).click()
      await page.locator('.cc').waitFor()
      await page.getByRole('button', { name: 'calculator.py', exact: true }).click()
      await page.locator('.cm-content').waitFor()
      await page.getByRole('button', { name: 'Change…', exact: true }).click()
      await page.getByRole('form', { name: 'Say what should change', exact: true }).locator('textarea').fill('Make add actually add the two numbers.')
      await page.getByRole('button', { name: 'Propose', exact: true }).click()
      await page.getByRole('region', { name: 'Ask thread', exact: true }).waitFor()

      // Native simulator calls return the same envelopes the live Code client parses. No invented API replies.
      await page.evaluate(async () => {
        const { useHive } = await import('/src/store/store.ts')
        const { readSession, readWorkspace } = await import('/src/features/code/savedSession.ts')
        const { useAskStore } = await import('/src/store/ask.ts')
        const client = useHive.getState().client
        const me = await client.me()
        const ctx = readSession(me.principal, 'repo:sim-suggestions')
        if (!ctx) throw new Error('The native edit session was not saved')
        const workspace = readWorkspace(me.principal, 'repo:sim-suggestions')
        const ws = await client.codeProxy('GET', `/v1/workspaces/${workspace}`, ctx)
        const file = await client.codeProxy('GET', `/v1/workspaces/${ws.id}/files`, { ...ctx, path: 'calculator.py' })
        const size = new TextEncoder().encode(file.content).length
        const scope = await client.codeSuggestionScope(ctx, ws.id, { operation_id: crypto.randomUUID(), expected_generation: ws.generation, expected_tree_digest: ws.tree_digest, ranges: { 'calculator.py': [[0, size]] } })
        await client.codeSuggestionCreate(ctx, ws.id, { operation_id: crypto.randomUUID(), scope_id: scope.id, hunks: [{ path: 'calculator.py', start_byte: 0, end_byte: size, before_digest: file.digest, replacement: file.content.replace('a - b', 'a + b') }] })
        const rows = Array.from({ length: 6 }, (_, i) => [
          { id: `question-${i}`, kind: 'you', text: 'Can you explain the proposed change before I decide?' },
          { id: `answer-${i}`, kind: 'answer', who: 'Vega', text: 'The change makes add return the sum of the two numbers. Review the highlighted lines, then accept the change if it is what you wanted.' },
        ]).flat()
        useAskStore.setState({ log: rows.map(row => ({ kind: 'row', row })), turns: {}, open: null, threadOpen: true, pinned: false })
      })
      await page.getByRole('button', { name: 'Open the drawer: files, changes, proposals, tests and tools', exact: true }).click()
      if (name === 'tall') await page.evaluate(async () => {
        const { useAskStore } = await import('/src/store/ask.ts')
        useAskStore.setState({ pinned: true })
      })
      await page.getByRole('tab', { name: 'Proposals', exact: true }).click()
      await page.getByRole('button', { name: /1 hunk.*current source/ }).last().click()
      await page.getByRole('group', { name: 'Decision for hunk 1', exact: true }).waitFor()
      await page.locator('#cc-drawer').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)))
      const geometry = await page.evaluate(() => ({ panel: document.querySelector('.ask-panel').getBoundingClientRect().toJSON(), drawer: document.querySelector('#cc-drawer').getBoundingClientRect().toJSON() }))
      const { panel, drawer } = geometry
      assert.ok(panel.right <= drawer.left || panel.left >= drawer.right || drawer.bottom <= panel.top, `${name}: the conversation overlaps the drawer: ${JSON.stringify(geometry)}`)
      const accept = page.getByRole('group', { name: 'Decision for hunk 1', exact: true }).getByRole('button', { name: 'Accept', exact: true })
      const acceptRect = await reachable(accept, page, `${name}-accept`)
      await accept.click()
      const review = page.getByRole('button', { name: 'Review decision: accept 1, reject 0', exact: true })
      const reviewRect = await reachable(review, page, `${name}-review`)
      await review.click()
      const dialog = page.getByRole('alertdialog', { name: 'Accept 1 hunk', exact: true })
      await dialog.waitFor()
      assert.match(await dialog.innerText(), /Accept 1 hunk/)
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      assert.equal(await page.getByRole('region', { name: 'Ask thread', exact: true }).isVisible(), true)
      await page.getByRole('button', { name: 'Close the drawer', exact: true }).click()
      await page.waitForFunction(() => !document.documentElement.style.getPropertyValue('--ask-companion-room'))
      if (name === 'tall') await page.locator('.ask-pinned').waitFor()
      assert.deepEqual(errors, [])
      results.push({ name, viewport, ...geometry, acceptRect, reviewRect, clicked: true, restored: true })
    } catch (error) {
      await page.screenshot({ path: resolve(out, `${name}-failure.png`) })
      await writeFile(resolve(out, `${name}-failure.txt`), `${error.stack}\n${await page.locator('body').innerText()}`)
      throw error
    } finally { await page.close() }
  }
  await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results.map(({ name, clicked, restored }) => ({ name, clicked, restored }))))
} finally { await browser.close() }
