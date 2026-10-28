/**
 * Guard: the in-browser demo/sim data does not carry the hive owner's identity markers. Demo mode shows invented
 * people only (Ada Brightwater, Rowan Vale, ..., all @example.org).
 *
 * SCOPE: this catches ACCIDENTAL real-person data in demo fixtures; it is not a guarantee against deliberately
 * assembled strings (e.g. an array joined at run time inside a function that takes arguments), which code review
 * owns. No static or runtime scan can see every computed value. It is also a DENYLIST of known markers, not a
 * real-person detector: it cannot tell that an arbitrary name belongs to someone real. A value fails when, as it
 * would be rendered, it contains:
 *   - the owner's sign-in principal, first name or full name;
 *   - a family name together with the owner's first name or surname in the same value (an invented "Cormac" or
 *     "Tessa" alone is fine);
 *   - an email address outside the reserved example domains (example.org/.com/.net), or the organisation's domain;
 *   - a home-directory path (/Users/...).
 *
 * Layers (values only; comments are provenance and never scanned):
 *   1. Source: every string the sim modules, guided-demo scripts, sim fixtures and look seeds produce from constants:
 *      literals, constant `+` chains and templates folded whole, identifiers resolved to the `const` they lexically
 *      bind to (the TypeScript checker, so a shadowing inner binding wins), JSX text and attributes decoded exactly
 *      as the JSX compiler decodes them (TypeScript's own JSX emit; an entity it does not know stays literal), and
 *      constant JSX children joined.
 *   2. Runtime: every string reachable from the sim modules' exports, from the results of their exported
 *      zero-argument functions (fixture factories), from a freshly seeded SimClient, its zero-argument reads, and
 *      its one-argument get/list reads called with every seeded id. A read that cannot be exercised is listed as a
 *      skipped test with its reason, never dropped silently.
 *   3. Rendered: scripts/demo-people-check.mjs opens the main demo pages in a browser on the sim and scans the
 *      page text and every attribute value with these same patterns (asserted identical below).
 * Values are also checked after NFKC normalisation with zero-width characters removed.
 */
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { SimClient } from './SimClient'

// The owner's real names are NOT stored in the repo either. Set OMEGA_PRIVATE_OWNER_NAMES locally (comma list: first name,
// then surnames or other forms) to guard the real ones; the default is invented and keeps the self-test meaningful.
const DEFAULT_OWNER_NAMES = "kip,thorne"
// Names of real family members are NOT stored in the repo. Set OMEGA_PRIVATE_FAMILY_NAMES (comma list) locally to guard
// the real ones; the default list is invented and keeps the guard and its self-test meaningful.
const DEFAULT_FAMILY_NAMES = "odette,wren,cormac,maren,tessa,ines"
const ENV = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const FAMILY_NAMES = (ENV?.OMEGA_PRIVATE_FAMILY_NAMES ?? DEFAULT_FAMILY_NAMES).split(",").map((n: string) => n.trim()).filter(Boolean)
const FAMILY = new RegExp(`\\b(${FAMILY_NAMES.join("|")})\\b`, "i")
const OWNER_NAMES = (ENV?.OMEGA_PRIVATE_OWNER_NAMES ?? DEFAULT_OWNER_NAMES).split(",").map((n: string) => n.trim()).filter(Boolean)
const [OWNER_FIRST, ...OWNER_OTHER] = OWNER_NAMES
const OWNER: RegExp[] = [new RegExp(`user:${OWNER_FIRST}\\b`, "i"), new RegExp(`\\b${OWNER_FIRST} (${OWNER_OTHER.join("|")})\\b`, "i"), new RegExp(`\\b${OWNER_FIRST}\\b`, "i")]
const OWNER_CONTEXT = new RegExp(`\\b(${OWNER_NAMES.join("|")})\\b`, "i")
const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g
const EXAMPLE_DOMAIN = /^example\.(org|com|net)$/i
const ORG_DOMAIN = /singularitynet\.io/i
const HOME_PATH = /\/Users\//
const PATTERNS = [...OWNER, FAMILY, OWNER_CONTEXT, EMAIL, EXAMPLE_DOMAIN, ORG_DOMAIN, HOME_PATH]

const visible = (s: string) => s.normalize('NFKC').replace(/[\u00AD\u200B-\u200F\u2060\uFEFF]/g, '')

/** Why a value is refused, or null. */
function refusal(raw: string): string | null {
  for (const s of new Set([raw, visible(raw)])) {
    if (OWNER.some((re) => re.test(s))) return 'owner identity'
    if (FAMILY.test(s) && OWNER_CONTEXT.test(s)) return 'family name with owner context'
    if (ORG_DOMAIN.test(s)) return 'organisation domain'
    for (const m of s.matchAll(EMAIL)) if (!EXAMPLE_DOMAIN.test(m[1])) return 'email outside example domains'
    if (HOME_PATH.test(s)) return 'home path'
  }
  return null
}
const hits = (values: Iterable<string>): string[] => [...new Set(values)].filter((s) => refusal(s) !== null)

// ---------------------------------------------------------------- layer 1: constants in source

const jsxCache = new Map<string, string>()
/** What the JSX compiler makes of a JSX text child or attribute initializer (its source text): TypeScript's own emit. */
function jsxDecoded(kind: 'text' | 'attr', raw: string): string {
  const key = `${kind}\u0000${raw}`
  const hit = jsxCache.get(key)
  if (hit !== undefined) return hit
  const src = kind === 'text' ? `x = <>${raw}</>` : `x = <a b=${raw} />`
  const out = ts.transpileModule(src, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 }, fileName: 'x.tsx' }).outputText
  let value = ''
  const find = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const args = n.arguments.slice(2)
      if (kind === 'text') value = args.filter(ts.isStringLiteral).map((a) => a.text).join('')
      else {
        const props = n.arguments[1]
        if (props && ts.isObjectLiteralExpression(props)) for (const p of props.properties) if (ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer)) value = p.initializer.text
      }
      return
    }
    ts.forEachChild(n, find)
  }
  find(ts.createSourceFile('out.js', out, ts.ScriptTarget.ES2022, true))
  jsxCache.set(key, value)
  return value
}

/** One file, type-checked alone, so identifiers resolve to their lexical binding (no lib, no imports). */
function checked(text: string, file: string): { sf: ts.SourceFile; checker: ts.TypeChecker } {
  const name = `/scan/file.${file.endsWith('x') ? 'tsx' : 'ts'}`
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const host: ts.CompilerHost = {
    getSourceFile: (n) => (n === name ? sf : undefined),
    writeFile: () => undefined,
    getDefaultLibFileName: () => '/scan/lib.d.ts',
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => '/scan',
    getNewLine: () => '\n',
    fileExists: (n) => n === name,
    readFile: () => undefined,
  }
  const program = ts.createProgram({ rootNames: [name], options: { noLib: true, noResolve: true, types: [], jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022 }, host })
  return { sf, checker: program.getTypeChecker() }
}

function sourceValues(text: string, file = 'x.ts'): string[] {
  const { sf, checker } = checked(text, file)
  const fold = (n: ts.Expression, seen: ReadonlySet<ts.Node> = new Set()): string | undefined => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return ts.isJsxAttribute(n.parent) ? jsxDecoded('attr', n.getText()) : n.text
    if (ts.isNumericLiteral(n)) return n.text
    if (ts.isIdentifier(n)) {
      const sym = checker.getSymbolAtLocation(n)
      const decl = sym?.valueDeclaration ?? sym?.declarations?.[0]
      if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer || !(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) || seen.has(decl)) return undefined
      return fold(decl.initializer, new Set([...seen, decl]))
    }
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n)) return fold(n.expression, seen)
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = fold(n.left, seen)
      const r = fold(n.right, seen)
      return l !== undefined && r !== undefined ? l + r : undefined
    }
    if (ts.isTemplateExpression(n)) {
      let out = n.head.text
      for (const span of n.templateSpans) {
        const v = fold(span.expression, seen)
        if (v === undefined) return undefined
        out += v + span.literal.text
      }
      return out
    }
    return undefined
  }

  const out: string[] = []
  const jsxRuns = (children: ts.NodeArray<ts.JsxChild>) => {
    let run = ''
    for (const c of children) {
      const v = ts.isJsxText(c) ? jsxDecoded('text', c.text) : ts.isJsxExpression(c) && c.expression ? fold(c.expression) : undefined
      if (v === undefined) { if (run) out.push(run); run = '' } else run += v
    }
    if (run) out.push(run)
  }
  const visit = (n: ts.Node) => {
    if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text)
    else if (ts.isJsxText(n)) out.push(jsxDecoded('text', n.text))
    else if (ts.isJsxElement(n) || ts.isJsxFragment(n)) jsxRuns(n.children)
    if (ts.isExpression(n)) {
      const v = fold(n)
      if (v !== undefined) out.push(v)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** Every string (keys and values) in a JSON document. */
function jsonValues(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach((x) => jsonValues(x, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); jsonValues(x, out) }
  return out
}

// ---------------------------------------------------------------- layer 2: values the running sim holds

/** Every string reachable from a value: objects, arrays, Maps, Sets (functions are code, not data). */
function heldValues(root: unknown): string[] {
  const out: string[] = []
  const seen = new WeakSet<object>()
  const stack: unknown[] = [root]
  while (stack.length) {
    const v = stack.pop()
    if (typeof v === 'string') { out.push(v); continue }
    if (!v || typeof v !== 'object' || seen.has(v)) continue
    seen.add(v)
    if (v instanceof Map) for (const [k, x] of v) stack.push(k, x)
    else if (v instanceof Set || Array.isArray(v)) for (const x of v) stack.push(x)
    else for (const k of Object.keys(v)) { out.push(k); stack.push((v as Record<string, unknown>)[k]) }
  }
  return out
}

interface Read { name: string; ok: boolean; values: string[]; why: string }
const isClass = (f: unknown) => typeof f === 'function' && /^class\b/.test(Function.prototype.toString.call(f))
const settle = async (f: () => unknown): Promise<{ ok: true; value: unknown } | { ok: false; why: string }> => {
  try {
    const value = await Promise.race([Promise.resolve(f()), new Promise((_, no) => setTimeout(() => no(new Error('no answer within 2 s')), 2000))])
    return { ok: true, value }
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) }
  }
}

/** Exported zero-argument functions of the sim modules (fixture factories): called, their results scanned. */
async function exportedReads(mods: Record<string, unknown>): Promise<Read[]> {
  const reads: Read[] = []
  for (const [file, mod] of Object.entries(mods)) {
    for (const [k, f] of Object.entries(mod as object)) {
      if (typeof f !== 'function' || isClass(f) || f.length !== 0) continue
      const r = await settle(() => (f as () => unknown)())
      reads.push({ name: `${file} ${k}()`, ok: r.ok, values: r.ok ? heldValues(r.value) : [], why: r.ok ? '' : r.why })
    }
  }
  return reads
}

/** A seeded SimClient's reads: zero-argument ones, and one-argument get/list reads with every seeded id. */
async function simReads(sim: SimClient): Promise<Read[]> {
  const proto = Object.getPrototypeOf(sim) as Record<string, unknown>
  const methods = Object.getOwnPropertyNames(proto).filter((k) => /^(me|list[A-Z]\w*|get[A-Z]\w*)$/.test(k) && typeof proto[k] === 'function')
  const call = (k: string, ...a: unknown[]) => (sim as unknown as Record<string, (...x: unknown[]) => unknown>)[k](...a)
  const reads: Read[] = []
  const zero = methods.filter((k) => (proto[k] as () => unknown).length === 0)
  for (const k of zero) {
    const r = await settle(() => call(k))
    reads.push({ name: `sim.${k}()`, ok: r.ok, values: r.ok ? heldValues(r.value) : [], why: r.ok ? '' : r.why })
  }
  // fixture ids: every prefixed id the seeded sim holds (swarms, minds, goals, motivations, ...) and the slugs its
  // zero-argument reads name (programs, providers)
  const ids = [...new Set([...heldValues(sim).filter((s) => /^(s|a|g|mo|run|lr|pr)_[\w-]+$/.test(s)), ...reads.flatMap((r) => r.values).filter((s) => /^[a-z][\w-]{2,40}$/.test(s))])]
  for (const k of methods.filter((m) => (proto[m] as () => unknown).length === 1)) {
    const values: string[] = []
    let why = 'no seeded id answered'
    let any = false
    for (const id of ids) {
      const r = await settle(() => call(k, id))
      if (r.ok) { any = true; values.push(...heldValues(r.value)) } else why = r.why
    }
    reads.push({ name: `sim.${k}(id)`, ok: any, values, why: any ? '' : why })
  }
  return reads
}

const codeFiles: Record<string, string> = {
  ...import.meta.glob<string>(['./**/*.{ts,tsx}', '!./**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob<string>(['../../features/guided/**/*.{ts,tsx}', '!../../features/guided/**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }),
}
const jsonFiles: Record<string, string> = {
  ...import.meta.glob<string>(['./**/*.json', '../../features/guided/**/*.json', '../../shell/uiVariants.seed.json'], { query: '?raw', import: 'default', eager: true }),
}
const simModules: Record<string, unknown> = {
  ...import.meta.glob(['./**/*.ts', '!./**/*.test.ts'], { eager: true }),
  ...import.meta.glob(['../../features/guided/scripts/*.ts'], { eager: true }),
}
const renderedCheck = import.meta.glob<string>('../../../scripts/demo-people-check.mjs', { query: '?raw', import: 'default', eager: true })

const seeded = new SimClient({ seed: 7, latency: false, autoStart: false })
const runtimeReads = [...(await exportedReads(simModules)), ...(await simReads(seeded))]

describe('demo/sim data carries none of the owner\u2019s identity markers', () => {
  it('scans a real set of files and modules', () => {
    expect(Object.keys(codeFiles).length).toBeGreaterThan(10)
    expect(Object.keys(codeFiles)).toEqual(expect.arrayContaining(['./data.ts', './moneyWork.ts', '../../features/guided/types.ts']))
    expect(Object.keys(jsonFiles)).toEqual(expect.arrayContaining(['./fixtures/lab-record.json', '../../shell/uiVariants.seed.json']))
    expect(Object.keys(simModules)).toEqual(expect.arrayContaining(['./data.ts', './moneyWork.ts', '../../features/guided/scripts/index.ts']))
  })

  it('the scanner sees values and skips comments', () => {
    expect(hits(sourceValues("// the owner's ruling, provenance only\nconst a = { by: 'user:kip' }"))).toEqual(['user:kip'])
    expect(hits(sourceValues('/* user:kip */ const b = `x ${1} at /Users/someone`'))).toEqual(['x 1 at /Users/someone', ' at /Users/someone'])
    expect(hits(jsonValues({ a: ['someone@gmail.com', 'Ada Brightwater'] }))).toEqual(['someone@gmail.com'])
  })

  it('refuses values assembled from constant pieces (stand-in r1 P2)', () => {
    const lower = (v: string[]) => hits(v).map((s) => s.toLowerCase())
    expect(hits(sourceValues("const a = 'user:' + 'ki' + 'p'"))).toContain('user:kip')
    expect(hits(sourceValues("const a = `user:${'ki'}p`"))).toContain('user:kip')
    expect(lower(sourceValues('const A = () => <span>K&#105;p</span>', 'x.tsx'))).toContain('kip')
    expect(hits(sourceValues("const ki = 'ki'\nconst who = 'user:' + ki + 'p'"))).toContain('user:kip')
    expect(lower(sourceValues("const A = () => <span>K{'i'}p</span>", 'x.tsx'))).toContain('kip')
    expect(lower(sourceValues('const A = () => <i title="K&#x69;p" />', 'x.tsx'))).toContain('kip')
    expect(hits(['K\u200Bip', '\uFF2Bip'])).toHaveLength(2) // zero-width / full-width forms
    expect(hits(heldValues(new Map([['k', new Set([{ by: ['user:', 'kip'].join('') }])]])))).toEqual(['user:kip'])
  })

  it('resolves names by lexical scope: the nearest binding wins (stand-in r2 P2)', () => {
    const shadowedHit = "const part = 'x'\nexport function demo() {\n  const part = 'ki'\n  return 'user:' + part + 'p'\n}"
    expect(hits(sourceValues(shadowedHit))).toContain('user:kip')
    const shadowedClean = "const part = 'ki'\nexport function demo() {\n  const part = 'ro'\n  return 'user:' + part + 'p'\n}"
    expect(hits(sourceValues(shadowedClean))).toEqual([])
    expect(sourceValues(shadowedClean)).toContain('user:rop')
    // block scope and a parameter that shadows a module const
    expect(hits(sourceValues("const p = 'ki'\nif (Math.random()) { const p = 'ro'; void ('user:' + p + 'p') }"))).toEqual([])
    expect(hits(sourceValues("const p = 'ki'\nexport const f = (p: string) => 'user:' + p + 'p'"))).toEqual([])
    expect(hits(sourceValues("const p = 'ki'\nexport const f = () => 'user:' + p + 'p'"))).toContain('user:kip')
  })

  it('decodes JSX entities as the JSX compiler does; ordinary and unknown entities pass (stand-in r2 P3)', () => {
    expect(hits(sourceValues('const A = () => <span>&copy; 2026 Ada Brightwater</span>', 'x.tsx'))).toEqual([])
    expect(sourceValues('const A = () => <span>&copy; 2026 Ada&nbsp;Brightwater &mdash; &hellip; &eacute;&amp;&lt;&gt;&hearts;&trade;</span>', 'x.tsx')).toContain('\u00A9 2026 Ada\u00A0Brightwater \u2014 \u2026 \u00E9&<>\u2665\u2122')
    expect(sourceValues('const A = () => <i title="Rowan &mdash; &quot;Vale&quot;" />', 'x.tsx')).toContain('Rowan \u2014 "Vale"')
    expect(hits(sourceValues('const A = () => <b>&notarealentity; Ada</b>', 'x.tsx'))).toEqual([]) // stays literal, as React renders it
    expect(sourceValues('const A = () => <b>&notarealentity; Ada</b>', 'x.tsx')).toContain('&notarealentity; Ada')
  })

  it('allows invented people and example addresses (stand-in r1 P3)', () => {
    expect(hits(sourceValues("const c = ['Cormac Ortega', 'Tessa Kowal', 'Maren', 'Ines', 'Cormacology', 'ada@example.org', 'k@example.com', 'n@example.net', 'user:p_ada', 'kipper', 'Thorne Street']"))).toEqual([])
    expect(hits(['Cormac Thorne', 'Odette and kip', 'x@other.org', 'https://singularitynet.io/x'])).toHaveLength(4)
  })

  it('calls exported zero-argument fixture factories and records a read that throws (stand-in r2 P2)', async () => {
    const reads = await exportedReads({ './x.ts': { made: () => ['user:', 'ki', 'p'].join(''), broken: () => { throw new Error('needs a hive') }, withArg: (n: string) => n, Klass: class {} } })
    expect(reads.map((r) => r.name)).toEqual(['./x.ts made()', './x.ts broken()'])
    expect(hits(reads[0].values)).toEqual(['user:kip'])
    expect(reads[1]).toMatchObject({ ok: false, why: 'needs a hive' })
  })

  it('the rendered-page check uses these same patterns', () => {
    const script = Object.values(renderedCheck)[0]
    expect(script).toBeTruthy()
    for (const re of PATTERNS.filter((r) => r !== FAMILY && r !== OWNER_CONTEXT && !OWNER.includes(r))) expect(script).toContain(re.toString())
    // the owner patterns are built from the same env variable and default list in both places
    expect(script).toContain('OMEGA_PRIVATE_OWNER_NAMES')
    expect(script).toContain(DEFAULT_OWNER_NAMES)
    // the family pattern is built from the same env variable and default list in both places
    expect(script).toContain('OMEGA_PRIVATE_FAMILY_NAMES')
    expect(script).toContain(DEFAULT_FAMILY_NAMES)
  })

  it.each(Object.entries(codeFiles))('source %s', (f, text) => {
    expect(hits(sourceValues(text, f))).toEqual([])
  })

  it.each(Object.entries(jsonFiles))('json %s', (_f, text) => {
    expect(hits(jsonValues(JSON.parse(text)))).toEqual([])
  })

  it.each(Object.entries(simModules))('exports of %s', (_f, mod) => {
    expect(hits(heldValues(mod))).toEqual([])
  })

  it('a freshly seeded sim (default persona) holds none', () => {
    const held = heldValues(seeded)
    expect(held.length).toBeGreaterThan(1000)
    expect(held).toEqual(expect.arrayContaining(['user:p_ada', 'a_vega01']))
    expect(hits(held)).toEqual([])
  })

  it('the reads the demo depends on are exercised', () => {
    const ok = new Set(runtimeReads.filter((r) => r.ok).map((r) => r.name))
    for (const name of ['sim.me()', 'sim.listPeople()', 'sim.listAgents()', 'sim.getSwarm(id)', 'sim.getAgent(id)', 'sim.listGoals(id)', 'sim.getGoal(id)', 'sim.listBeliefs(id)', './programs.ts commonsExplorer()', './programs.ts contractFixture()'])
      expect(ok, name).toContain(name)
    expect(runtimeReads.flatMap((r) => r.values)).toEqual(expect.arrayContaining(['Ada Brightwater', 'ada@example.org']))
  })

  for (const r of runtimeReads) {
    if (r.ok) it(`read ${r.name}`, () => expect(hits(r.values)).toEqual([]))
    // listed, never dropped: a read the guard could not exercise shows up as a skipped test with its reason
    else it.skip(`read ${r.name} NOT EXERCISED: ${r.why.slice(0, 120)}`, () => undefined)
  }
})
