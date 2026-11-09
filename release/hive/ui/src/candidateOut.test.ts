/**
 * The production build carries no unreviewed candidate code, checked on the built files (Kimi cosmos-rest r1 and r2):
 * `npm run build` runs scripts/candidate-out.mjs as `postbuild`. Here: every marker is a real string of the candidate
 * sources and of nothing else; every gate site states the one build-mode rule identically; and the checker passes a whole clean build, fails
 * (and removes) a build carrying a marker or a candidate chunk, and refuses a partial build.
 */
import { describe, expect, it } from 'vitest'

const fsName = 'node:fs'
const cpName = 'node:child_process'
const osName = 'node:os'
const fs = (await import(/* @vite-ignore */ fsName)) as {
  readFileSync(p: string, e: 'utf8'): string
  readdirSync(p: string, o: { recursive: true }): string[]
  mkdtempSync(p: string): string
  mkdirSync(p: string, o: { recursive: true }): void
  writeFileSync(p: string, d: string): void
  rmSync(p: string, o: { recursive: true; force: true }): void
  existsSync(p: string): boolean
}
const cp = (await import(/* @vite-ignore */ cpName)) as { spawnSync(cmd: string, args: string[], o: { encoding: 'utf8'; cwd?: string }): { status: number | null; stdout: string; stderr: string } }
const os = (await import(/* @vite-ignore */ osName)) as { tmpdir(): string }
const UI = new URL('..', import.meta.url).pathname
const SCRIPT = `${UI}scripts/candidate-out.mjs`
const { markers, chunks, files: candidateFiles } = JSON.parse(fs.readFileSync(`${UI}scripts/candidate-markers.json`, 'utf8')) as { markers: string[]; chunks: string[]; files: string[] }

/** The candidate's own files (compiled out of production): every marker lives in these and nowhere else. */
// The approved native renderers are released; Classic's renderer and all parts inspection stay candidate.
const CANDIDATE = /^(experiences\/classic\/phases\.(tsx|css)|experiences\/(classic|professional|still|construct|cosmos)\/parts\.metta|experiences\/parts\/|lib\/intent\/uiParts\.ts)/

describe('candidate markers', () => {
  const files = fs.readdirSync(`${UI}src`, { recursive: true }).filter((f) => /\.(ts|tsx|css|metta)$/.test(f) && !/\.test\.ts$/.test(f))
  it('each is a real string of the candidate sources, and of no released source', () => {
    expect(markers.length).toBeGreaterThanOrEqual(3)
    for (const m of markers) {
      const where = files.filter((f) => fs.readFileSync(`${UI}src/${f}`, 'utf8').includes(m))
      expect(where.length, `${m} is in the candidate sources`).toBeGreaterThan(0)
      expect(where.filter((f) => !CANDIDATE.test(f)), `${m} only in candidate files`).toEqual([])
    }
  })
  it('the chunk names are the candidate modules (each names a real candidate source file)', () => {
    for (const c of chunks.filter((x) => !['space', 'parts', 'answer', 'lib_ui', 'phase'].includes(x))) expect(files.some((f) => f.endsWith(`/${c}.tsx`) || f.endsWith(`/${c}.ts`)), c).toBe(true)
    expect(chunks).toEqual(expect.arrayContaining(['answer', 'space', 'lib_ui']))
    expect(chunks).not.toEqual(expect.arrayContaining(['phases']))   // released (contract R1.1)
  })
  it('the whole-file exclusion names the real candidate Construct parts source', () => {
    expect(candidateFiles).toContain('src/experiences/construct/parts.metta')
    for (const f of candidateFiles) {
      expect(fs.existsSync(UI + f), f).toBe(true)
      expect(CANDIDATE.test(f.replace(/^src\//, '')), f).toBe(true)
    }
  })
})

/**
 * Kimi r2 sharpest asked for ONE exported gate constant. Both single-source forms were tried in r2.1 and failed on
 * evidence: an exported constant (ea220759) is not folded across modules, so the release build carried the candidate
 * chunks (the postbuild check failed it, 16 hits; as reviewGate.test.ts already records for a shared factory); a Vite
 * define (8fa1740a) folds, but is beyond the env the PROD-build tests stub, so reviewGate's release guards (the
 * VITE_UNREVIEWED_EXPERIENCES=1 case among them) could no longer see the rule. So the rule stays a literal at each import
 * site, the form the bundler folds and the tests can drive, and drift, the finding's concern, is what this checks.
 */
describe('the one build-mode rule, stated identically at every gate site (Kimi r2 sharpest)', () => {
  const EXPR = "import.meta.env.PROD ? import.meta.env.MODE === 'surface-preview' : true"
  // Classic retains its registry gate and two host gates; Cosmos's host phase gate is released.
  const SITES: Record<string, number> = { 'experiences/registry.ts': 2, 'experiences/ExperienceHost.tsx': 2, 'features/ask/run.ts': 1, 'lib/intent/index.ts': 1, 'lib/candidates.ts': 1 }
  const read = (p: string) => fs.readFileSync(`${UI}src/${p}`, 'utf8')
  const all = fs.readdirSync(`${UI}src`, { recursive: true }).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f) && !f.endsWith('.d.ts'))
  it('each gate site states the exact rule, and only these sites state it', () => {
    for (const [f, n] of Object.entries(SITES)) expect(read(f).split(EXPR).length - 1, f).toBe(n)
    expect(all.filter((f) => read(f).includes(EXPR)).sort()).toEqual(Object.keys(SITES).sort())
  })
  it('no source states a variant of the rule (another spelling of a production-build test in code)', () => {
    // comments are not code; a dev-only debug hook (import.meta.env.DEV) and the preview marker (MODE alone) are not gates
    const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1').split(EXPR).join('')
    const variants = all.filter((f) => /import\.meta\.env\.PROD\b|import\.meta\.env\.DEV \|\|/.test(code(read(f))))
    expect(variants).toEqual([])
  })
  it('the rule is the registry rule (unreviewedAllowed), for every build this run is not', async () => {
    const { unreviewedAllowed } = await import('./experiences/registry')
    const rule = (PROD: boolean, MODE: string) => (PROD ? MODE === 'surface-preview' : true)
    for (const [PROD, MODE] of [[true, 'production'], [true, 'surface-preview'], [true, 'demo'], [false, 'development'], [false, 'test']] as const) expect(unreviewedAllowed({ PROD, MODE }), `${PROD} ${MODE}`).toBe(rule(PROD, MODE))
  })
})

describe('scripts/candidate-out.mjs', () => {
  const run = (dir: string, cwd?: string) => cp.spawnSync('node', [SCRIPT, dir], { encoding: 'utf8', cwd })
  const WHOLE: Record<string, string> = { 'index.html': '<!doctype html>', 'assets/index-abc12345.css': '.cx{color:red}', ...Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`assets/c${i}-abc12345.js`, `console.log(${i})`])) }
  const build = (files: Record<string, string>, name = 'dist') => {
    const parent = fs.mkdtempSync(`${os.tmpdir()}/candidate-out-`)
    const d = `${parent}/${name}`
    fs.mkdirSync(`${d}/assets`, { recursive: true })
    for (const [n, t] of Object.entries(files)) fs.writeFileSync(`${d}/${n}`, t)
    return { parent, d }
  }
  it('passes a whole clean build', () => {
    const { parent } = build(WHOLE)
    try {
      const r = run('dist', parent)
      expect(r.status, r.stderr).toBe(0)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
  it.each(['parts.metta', 'parts-abc12345.metta'])('rejects the entire candidate file asset %s without relying on its contents', name => {
    const { parent, d } = build({ ...WHOLE, [`assets/${name}`]: 'content without any candidate marker' })
    try {
      const r = run('dist', parent)
      expect(r.status, r.stderr).toBe(1)
      expect(r.stderr).toContain('candidate file asset')
      expect(fs.existsSync(d)).toBe(false)
    } finally { fs.rmSync(parent, { recursive: true, force: true }) }
  })
  it('fails a build carrying any marker, names it, and removes the rejected build', () => {
    for (const m of markers) {
      const { parent, d } = build({ ...WHOLE, [m.startsWith('cxp') || m.startsWith('shell') ? 'assets/x-abc12345.css' : 'assets/x-abc12345.js']: `x="${m}"` })
      try {
        const r = run('dist', parent)
        expect(r.status, m).toBe(1)
        expect(r.stderr, m).toContain(m)
        expect(fs.existsSync(d), `${m}: the rejected build is gone`).toBe(false)
      } finally {
        fs.rmSync(parent, { recursive: true, force: true })
      }
    }
  })
  it('fails a build that carries a candidate chunk even without any marker (Kimi r2 #4)', () => {
    for (const c of chunks) {
      const { parent } = build({ ...WHOLE, [`assets/${c}-Dw5m7RfI.js`]: 'export const a=1' })
      try {
        const r = run('dist', parent)
        expect(r.status, c).toBe(1)
        expect(r.stderr, c).toContain(`a candidate chunk (${c}-Dw5m7RfI.js)`)
      } finally {
        fs.rmSync(parent, { recursive: true, force: true })
      }
    }
  })
  it('leaves a rejected directory that is not a dist* inside the working directory where it is (and says so)', () => {
    const { parent, d } = build({ ...WHOLE, 'assets/x-abc12345.js': `x="${markers[0]}"` }, 'release')
    try {
      const r = run(d, os.tmpdir())
      expect(r.status).toBe(1)
      expect(fs.existsSync(d)).toBe(true)
      expect(r.stderr).toMatch(/left .* in place/)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
  it('refuses a partial build: no index.html, no stylesheet, fewer than 5 scripts, nothing (Kimi r2 #1)', () => {
    const cases: Record<string, string>[] = [
      {},
      Object.fromEntries(Object.entries(WHOLE).filter(([k]) => k !== 'index.html')),
      Object.fromEntries(Object.entries(WHOLE).filter(([k]) => !k.endsWith('.css'))),
      Object.fromEntries(Object.entries(WHOLE).filter(([k]) => !k.startsWith('assets/c5'))),
    ]
    for (const files of cases) {
      const { parent } = build(files)
      try {
        expect(run('dist', parent).status, JSON.stringify(Object.keys(files))).toBe(2)
      } finally {
        fs.rmSync(parent, { recursive: true, force: true })
      }
    }
    expect(run('/nonexistent-candidate-out-dir').status).toBe(2)
  })
})
