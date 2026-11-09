// Demo people check (demo D1, layer 3 of src/api/sim/noRealPeople.test.ts): open the main demo pages on the
// SIMULATOR (?sim=1, invented data, no live hive, no provider call) and scan what is RENDERED (the page text and every
// attribute value, incl. title/aria-label/alt/href) for the owner's identity markers. Same patterns as the unit guard
// (the guard asserts they are identical). Catches accidental real-person data; not a guarantee against deliberately
// assembled strings, which code review owns. Serve the UI (`npx vite --host 127.0.0.1 --port <port>` or a preview of a
// build), then:
//   node scripts/demo-people-check.mjs <port> <outDir> [browserPath]
// Exit 0 when every page showed its landmark, raised no page error and nothing matched; the receipt is <outDir>/demo-people-check.json.
// Reusable: import { scanPage, PAGES } from this file in another smoke.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const OWNER = [/user:jon\b/i, /\bjon(athan)? grove\b/i, /\bjon\b/i]
// Real family names never sit in this tree, not even as digests (unsalted digests of first names are dictionary-
// recoverable; privacy review 2026-11-09). They come only from the local OMEGA_PRIVATE_FAMILY_NAMES setting.
const FAMILY_NAMES_LOCAL = (process.env.OMEGA_PRIVATE_FAMILY_NAMES ?? '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean)
const WORD = /[A-Za-z0-9_]+/g
const OWNER_CONTEXT = /\b(jon|jonathan|grove)\b/i
const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g
const EXAMPLE_DOMAIN = /^example\.(org|com|net)$/i
const ORG_DOMAIN = /singularitynet\.io/i
const HOME_PATH = /\/Users\//

const digests = new Map()
const sha256hex = (s) => {
  let d = digests.get(s)
  if (d === undefined) digests.set(s, (d = createHash('sha256').update(s, 'utf8').digest('hex')))
  return d
}
const FAMILY_SHA256 = new Set(FAMILY_NAMES_LOCAL.map((n) => sha256hex(n)))
const hasFamilyName = (s) => (s.match(WORD) ?? []).some((w) => FAMILY_SHA256.has(sha256hex(w.toLowerCase())))

const visible = (s) => s.normalize('NFKC').replace(/[\u00AD\u200B-\u200F\u2060\uFEFF]/g, '')
export function refusal(raw) {
  for (const s of new Set([raw, visible(raw)])) {
    if (OWNER.some((re) => re.test(s))) return 'owner identity'
    if (hasFamilyName(s) && OWNER_CONTEXT.test(s)) return 'family name with owner context'
    if (ORG_DOMAIN.test(s)) return 'organisation domain'
    for (const m of s.matchAll(EMAIL)) if (!EXAMPLE_DOMAIN.test(m[1])) return 'email outside example domains'
    if (HOME_PATH.test(s)) return 'home path'
  }
  return null
}

/** The main demo pages (hash routes of src/lib/router.ts). */
export const PAGES = ['', 'swarms', 'swarms/s_lyra', 'swarms/s_forge', 'dot/a_vega01', 'tasks', 'motivations', 'messages', 'approvals', 'programs', 'assets', 'artifacts', 'people', 'roles', 'models', 'usage', 'health', 'updates', 'explore', 'lab', 'code', 'me', 'settings',
  // demo D3: Studio (the canvas in Lyra and in held Forge), Tools, a stalled Lab run, two versions compared, a capped mind
  'program/omegadesign/s_lyra', 'program/omegadesign/s_forge', 'program/omega-tools/s_lyra', 'lab/bench-ops', 'lab/bench-core/compare', 'dot/a_qnch11']

/**
 * What each page must show before it is scanned (demo D2, closing D1's P3: an error shell or an empty frame must never
 * pass as a scanned page). Routed pages open as a Page (a dialog with its h1); the hive itself shows the HUD's
 * Simulation line; a mind opens its panel with the mind's name.
 */
export const LANDMARKS = {
  '': 'text=Simulation',
  'dot/a_vega01': 'text=Vega',
  // demo D3: an app opens as its own full page (its section names the app), a mind's panel shows its name
  'program/omegadesign/s_lyra': 'section[aria-label="Design app"]',
  'program/omegadesign/s_forge': 'section[aria-label="Design app"]',
  'program/omega-tools/s_lyra': 'section[aria-label="Omega Tools catalogue (sim) app"]',
  'lab/bench-ops': '[data-lab-stalled]',
  'lab/bench-core/compare': '[data-compare-summary]',
  'dot/a_qnch11': 'text=Quench',
}
export const landmarkFor = (route) => LANDMARKS[route] ?? 'section[role="dialog"] h1'
/** The page's landmark is on screen (waits up to `ms`). */
export async function hasLandmark(page, route, ms = 6000) {
  try {
    await page.locator(landmarkFor(route)).first().waitFor({ state: 'visible', timeout: ms })
    return true
  } catch {
    return false
  }
}

/** Every rendered string on the page: body text, the title, and every attribute value of every element. */
export async function scanPage(page) {
  const values = await page.evaluate(() => {
    const out = [document.title, document.body.innerText]
    // data-vite-dev-id is the dev server's own module path on <style> tags (absent from a build): tooling, not demo data
    for (const el of document.querySelectorAll('*')) for (const a of el.attributes) if (a.name !== 'data-vite-dev-id') out.push(a.value)
    return out
  })
  return { count: values.length, hits: [...new Set(values)].flatMap((v) => (refusal(v) ? [{ why: refusal(v), at: v.slice(0, 160) }] : [])) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const require = createRequire(fileURLToPath(new URL('../package.json', import.meta.url)))
  const { chromium } = require('playwright-core')
  const PORT = process.argv[2] ?? '5291'
  const OUT = process.argv[3] ?? '/tmp/demo-people-check'
  const EXE = process.argv[4] ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch({ executablePath: EXE, headless: true })
  const results = []
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
    for (const route of PAGES) {
      const before = errors.length
      await page.goto(`http://127.0.0.1:${PORT}/?sim=1#/${route}`)
      const landmark = await hasLandmark(page, route)
      await page.waitForTimeout(800)
      const scanned = await scanPage(page)
      results.push({ route: `#/${route}`, landmark, pageErrors: errors.slice(before), ...scanned, url: page.url() })
    }
  } finally {
    await browser.close()
  }
  const bad = results.filter((r) => r.hits?.length)
  const pages = results.filter((r) => r.route)
  const receipt = { pages: pages.length, scannedValues: pages.reduce((n, r) => n + r.count, 0), pass: bad.length === 0 && pages.every((r) => r.landmark && r.pageErrors.length === 0), results }
  await writeFile(`${OUT}/demo-people-check.json`, JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ pages: receipt.pages, scannedValues: receipt.scannedValues, pass: receipt.pass, bad: bad.map((r) => r.route), noLandmark: pages.filter((r) => !r.landmark).map((r) => r.route), pageErrors: pages.flatMap((r) => r.pageErrors) }))
  process.exit(receipt.pass ? 0 : 1)
}
