#!/usr/bin/env node
// Re-derive the line hints of the showreel's Code references (src/features/showreel/scenes.ts) from their excerpts.
// Each reference is anchored by its excerpt; the line shown in the Code layer is a hint. This script moves every hint
// to the excerpt's occurrence nearest the old hint. It never changes an excerpt; a missing excerpt is reported and
// left alone (the test in layers.test.ts fails on it).
//
//   node scripts/showreel-lines.mjs           report drifted hints, exit 1 if any
//   node scripts/showreel-lines.mjs --write   rewrite them in place
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ui = fileURLToPath(new URL('..', import.meta.url))
const repo = fileURLToPath(new URL('../../..', import.meta.url))
const scenesPath = `${ui}src/features/showreel/scenes.ts`
const write = process.argv.includes('--write')
const unquote = (q) => (q[0] === "'" ? q.slice(1, -1).replace(/\\'/g, "'") : JSON.parse(q))
const ref = /\{ file: '([^']+)', line: (\d+), symbol: ('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"), excerpt: ('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*") \}/g

const files = new Map()
const linesOf = (file) => {
  if (!files.has(file)) files.set(file, readFileSync(`${repo}${file}`, 'utf8').split('\n'))
  return files.get(file)
}
let drifted = 0
let missing = 0
const out = readFileSync(scenesPath, 'utf8').replace(ref, (whole, file, line, symbol, excerpt) => {
  const text = unquote(excerpt)
  const at = linesOf(file).flatMap((l, n) => (l.includes(text) ? [n + 1] : []))
  const hint = Number(line)
  if (!at.length) {
    missing++
    console.error(`missing: ${file} (${unquote(symbol)}): excerpt not in the file`)
    return whole
  }
  if (at.includes(hint)) return whole
  const best = at.reduce((a, b) => (Math.abs(b - hint) < Math.abs(a - hint) ? b : a))
  drifted++
  console.log(`${file}:${hint} -> ${best} (${unquote(symbol)})`)
  return whole.replace(`line: ${line},`, `line: ${best},`)
})
if (write && drifted) writeFileSync(scenesPath, out)
console.log(`${drifted} drifted${write && drifted ? ' (rewritten)' : ''}, ${missing} missing`)
process.exit(missing || (drifted && !write) ? 1 : 0)
