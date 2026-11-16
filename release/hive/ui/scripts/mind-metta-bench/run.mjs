// Build the bench page with vite, serve it at a fake https origin (so IndexedDB is real), run it in a headless
// Chromium (PW_CHROMIUM, e.g. Brave) and print the report plus the worker bundle's size.
//   PW_CHROMIUM="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" node scripts/mind-metta-bench/run.mjs <outDir> <report.json>
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from 'playwright-core'

const here = path.dirname(fileURLToPath(import.meta.url))
const [outDir, reportPath] = process.argv.slice(2)
await build({ configFile: false, root: here, logLevel: 'warn', base: './', build: { outDir, emptyOutDir: true, target: 'es2022' }, worker: { format: 'es' } })

const files = []
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else files.push(p) } }
walk(outDir)
const sizes = files.map((p) => { const b = fs.readFileSync(p); return { file: path.relative(outDir, p), bytes: b.length, gzip: zlib.gzipSync(b).length } })

const ORIGIN = 'https://mind.bench.test'
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM, headless: true })
const ctx = await browser.newContext()
const leaked = []
await ctx.route('**/*', (route) => {
  const u = new URL(route.request().url())
  if (u.origin !== ORIGIN) { leaked.push(u.href); return route.fulfill({ status: 204, body: '' }) }
  const p = path.join(outDir, u.pathname === '/' ? 'index.html' : u.pathname)
  if (!fs.existsSync(p)) return route.fulfill({ status: 404, body: '' })
  const type = p.endsWith('.js') ? 'text/javascript' : p.endsWith('.html') ? 'text/html' : 'application/octet-stream'
  return route.fulfill({ contentType: type, body: fs.readFileSync(p) })
})
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
await page.goto(`${ORIGIN}/`)
await page.waitForFunction(() => window.__bench, null, { timeout: 600_000, polling: 500 })
const report = await page.evaluate(() => window.__bench)
await browser.close()
const out = { browser: report, bundle: sizes, leaked, errors }
fs.writeFileSync(reportPath, JSON.stringify(out, null, 1))
console.log(JSON.stringify({ sizes, leaked, errors, cold: report.cold, error: report.error }, null, 1))
