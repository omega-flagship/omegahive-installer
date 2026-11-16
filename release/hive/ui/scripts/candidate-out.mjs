#!/usr/bin/env node
// Fails when unreviewed candidate code reaches a built bundle (runs after `npm run build` as `postbuild`).
// Usage: node scripts/candidate-out.mjs <build dir>   (scans JS/CSS/HTML contents and all candidate file-asset names)
// Exit 0: a whole build, clean. Exit 1: a candidate marker in a file, or a file named after a candidate module (each
// printed); the rejected build directory is then removed, so nothing rejected is left on disk to be deployed.
// Exit 2: not a whole build (needs index.html, at least one stylesheet and at least 5 scripts); nothing was passed.
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

const dir = process.argv[2]
const { markers, chunks = [], files: candidateFiles = [] } = JSON.parse(readFileSync(new URL('./candidate-markers.json', import.meta.url), 'utf8'))
const files = []
const assets = []
const walk = (d) => {
  let names = []
  try {
    names = readdirSync(d)
  } catch {
    return
  }
  for (const n of names) {
    const p = join(d, n)
    if (statSync(p).isDirectory()) walk(p)
    else {
      assets.push(p)
      if (/\.(js|mjs|css|html)$/.test(n)) files.push(p)
    }
  }
}
if (dir) walk(dir)
const js = files.filter((f) => /\.m?js$/.test(f)).length
const css = files.filter((f) => f.endsWith('.css')).length
const html = files.some((f) => basename(f) === 'index.html')
if (!html || css < 1 || js < 5) {
  console.error(`candidate-out: not a whole build under ${dir ?? '(no dir given)'} (index.html ${html ? 'yes' : 'no'}, ${css} stylesheets, ${js} scripts; needs index.html, 1+ stylesheet, 5+ scripts); nothing was passed`)
  process.exit(2)
}
const hits = []
// Raw source assets must also be absent, even if all their content markers were removed or renamed.
for (const source of candidateFiles) {
  const name = basename(source), dot = name.lastIndexOf('.')
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${escape(name.slice(0, dot))}(?:-[A-Za-z0-9_-]{6,})?${escape(name.slice(dot))}$`)
  for (const f of assets) if (re.test(basename(f))) hits.push(`${f}: a candidate file asset (${source})`)
}
const chunkRe = new RegExp(`^(${chunks.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})-[A-Za-z0-9_-]{6,}\\.(m?js|css)$`)
for (const f of files) {
  if (chunks.length && chunkRe.test(basename(f))) hits.push(`${f}: a candidate chunk (${basename(f)})`)
  const text = readFileSync(f, 'utf8')
  for (const m of markers) if (text.includes(m)) hits.push(`${f}: ${m}`)
}
if (hits.length) {
  console.error(`candidate-out: unreviewed candidate code is in this build (${hits.length}):\n  ${hits.join('\n  ')}`)
  // nothing rejected is left behind: the build directory goes (only one named dist*, inside the working directory)
  const abs = resolve(dir)
  if (/^dist/.test(basename(abs)) && abs.startsWith(process.cwd() + sep)) {
    rmSync(abs, { recursive: true, force: true })
    console.error(`candidate-out: removed the rejected build ${abs}`)
  } else console.error(`candidate-out: left ${abs} in place (not a dist* directory inside ${process.cwd()}); do not deploy it`)
  process.exit(1)
}
console.log(`candidate-out: ${files.length} built files (${js} scripts, ${css} stylesheets, index.html), none carries a candidate marker (${markers.length} markers) or is a candidate chunk (${chunks.length} names); no candidate file assets (${candidateFiles.length} source paths)`)
