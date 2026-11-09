/**
 * professional-release r1.2 (stand-in r1.1 P1, the class): a scanner for multi-write chains. A chain is a function
 * that awaits two or more hive mutations (a loop of one counts as two). Each write after the first must be sent through
 * a bound operation (lib/boundOperation `op.write`), which checks the identity epoch and the caller's lifetime
 * IMMEDIATELY before the write; the client's own response check cannot close the gap between a promise settling and its
 * caller resuming.
 *
 * Syntax-aware (the TypeScript compiler's own parser). Which calls are mutations is derived, not listed by hand:
 * - client mutations: LiveClient members whose request is not a GET. Every member is CLASSIFIED (write, read, no
 *   request, or unknown) through its own requests, its fetch() calls and the members it calls (a private `post()`
 *   wrapper included), so a write routed through a wrapper is a write, and one the classifier cannot read is `unknown`
 *   (the standing test fails on it) instead of silently absent;
 * - store mutations: store actions whose body sends a client mutation or another store mutation (to a fixed point);
 * - helper effects (followups-r8, stand-in r1.2 P2): any named function, method or object member in src whose body
 *   (its callbacks included) sends a mutation is itself one, to a fixed point. A same-file or imported function is
 *   resolved by its declaration; a member call (`x.name()`) by its name. So `await checkOnce(...)` counts as the write
 *   it sends, and First Light's `r.host.setOwnLimit(...)` / `save(...)` are writes too;
 * - aliases: `const send = client.createAgent` (or `.bind(client)`), `const { createAgent: make } = client`.
 *
 * Where a write counts as a step on a path: awaited, returned (a concise arrow body included), or inside a callback an
 * awaited/returned call runs (`for`-like array methods count as a loop, two). A Promise.all/allSettled/race/any group
 * sends its writes in one synchronous run: one step, however many writes. A fire-and-forget write (not awaited, not
 * returned) is not a step, as before.
 * Test-only (node:fs); the standing test is src/mutationChains.test.ts.
 */
import ts from 'typescript'

const fsName = 'node:fs'
const pathName = 'node:path'
interface Dirent { name: string; isDirectory(): boolean }
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync(p: string, e: 'utf8'): string; readdirSync(p: string, o: { withFileTypes: true }): Dirent[]; existsSync(p: string): boolean }
const path = (await import(/* @vite-ignore */ pathName)) as { join(...p: string[]): string; relative(from: string, to: string): string; dirname(p: string): string; resolve(...p: string[]): string }

export const SRC = new URL('..', import.meta.url).pathname

const cache = new Map<string, ts.SourceFile>()
const parse = (file: string): ts.SourceFile => {
  let sf = cache.get(file)
  if (!sf) {
    sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    cache.set(file, sf)
  }
  return sf
}

/** Every non-test .ts/.tsx under src. */
export function sourceFiles(dir = SRC): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...sourceFiles(p)) }
    else if (/\.tsx?$/.test(e.name) && !/\.(test|testkit)\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

const WRITE_VERBS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const strip = (e: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression
  return e
}
const FUNC = (n: ts.Node): n is ts.FunctionLikeDeclaration => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)
const LOOP = (n: ts.Node) => ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)
/** every string literal inside an expression (a `wake ? 'POST' : 'GET'` verb included) */
const literals = (n: ts.Node): string[] => {
  const out: string[] = []
  const walk = (x: ts.Node) => { if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) out.push(x.text); ts.forEachChild(x, walk) }
  walk(n)
  return out
}

export type ClientEffect = 'write' | 'read' | 'none' | 'unknown'
export interface ClientClasses {
  /** public members that send a write (POST, PUT, PATCH, DELETE), directly or through any member they call */
  writes: Set<string>
  /** public members that only read */
  reads: Set<string>
  /** public members that send nothing (sockets, listeners, state) */
  none: Set<string>
  /** public members whose request verb cannot be read (the standing test fails on any) */
  unknown: Set<string>
  /** public members that take the verb from their caller (`method`): counted as writes, since a caller may write */
  transports: Set<string>
}

/**
 * Classify every member of the client class. A transport is a member with a parameter named `method` (request,
 * askRequest, binary, draftCall, raw; the public codeProxy and repoMapRequest): a call to one is read by the string literals of its first argument. A fetch()
 * call is read by its init's `method` (none: a GET). A call to another member takes that member's effect (a wrapper
 * such as `private post(p, b) { return this.request('POST', p, b) }` makes its callers writes).
 */
export function classifyClient(file = `${SRC}api/live.ts`, className = 'LiveClient'): ClientClasses {
  const sf = parse(file)
  let cls: ts.ClassDeclaration | undefined
  const find = (n: ts.Node) => { if (ts.isClassDeclaration(n) && n.name?.text === className) cls = n; else ts.forEachChild(n, find) }
  find(sf)
  const out: ClientClasses = { writes: new Set(), reads: new Set(), none: new Set(), unknown: new Set(), transports: new Set() }
  if (!cls) return out
  // each member's parameters, and the literal default of its `method` parameter if it has one
  const members = new Map<string, { body: ts.Node; priv: boolean; params: string[]; methodDefault: string[] }>()
  const methodDefault = (ps: ts.NodeArray<ts.ParameterDeclaration>) => {
    const p = ps.find((x) => x.name.getText(sf) === 'method')
    return p?.initializer ? literals(p.initializer).filter((v) => v === 'GET' || WRITE_VERBS.has(v)) : []
  }
  for (const m of cls.members) {
    if (!m.name || !ts.isIdentifier(m.name)) continue
    const priv = !!(ts.getCombinedModifierFlags(m as ts.Declaration) & ts.ModifierFlags.Private)
    if (ts.isMethodDeclaration(m) && m.body) members.set(m.name.text, { body: m.body, priv, params: m.parameters.map((p) => p.name.getText(sf)), methodDefault: methodDefault(m.parameters) })
    else if (ts.isPropertyDeclaration(m) && m.initializer) {
      const init = strip(m.initializer)
      if (FUNC(init)) members.set(m.name.text, { body: init.body!, priv, params: init.parameters.map((p) => p.name.getText(sf)), methodDefault: methodDefault(init.parameters) })
    }
  }
  const transports = new Set([...members].filter(([, m]) => m.params.includes('method')).map(([n]) => n))
  /** each member's own verbs, the members it calls, and whether a verb could not be read */
  const own = new Map<string, { verbs: Set<string>; calls: Set<string>; opaque: boolean }>()
  for (const [name, m] of members) {
    const verbs = new Set<string>(); const calls = new Set<string>(); let opaque = false
    const walk = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const e = strip(n.expression)
        if (ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const callee = e.name.text
          if (transports.has(callee) && !transports.has(name)) {
            // the verb is the argument at the transport's `method` parameter (request(method, …): the first; a helper like
            // appLinkRequest(path, body, method = 'POST'): the third), or that parameter's literal default when omitted
            const t = members.get(callee)!, at = t.params.indexOf('method')
            const arg = n.arguments[at]
            const vs = arg ? literals(arg).filter((v) => v === 'GET' || WRITE_VERBS.has(v)) : t.methodDefault
            if (vs.length) vs.forEach((v) => verbs.add(v)); else opaque = true
          } else if (members.has(callee)) calls.add(callee)
        } else if (ts.isIdentifier(e) && e.text === 'fetch') {
          const init = n.arguments[1] && strip(n.arguments[1])
          if (!init) verbs.add('GET')
          else if (ts.isObjectLiteralExpression(init)) {
            const mp = init.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === 'method')
            if (!mp) verbs.add('GET')
            else {
              const vs = literals(mp).filter((v) => v === 'GET' || WRITE_VERBS.has(v))
              if (vs.length) vs.forEach((v) => verbs.add(v)); else if (!transports.has(name)) opaque = true
            }
          } else if (!transports.has(name)) opaque = true
        }
      }
      ts.forEachChild(n, walk)
    }
    walk(m.body)
    own.set(name, { verbs, calls, opaque })
  }
  const effect = new Map<string, ClientEffect>()
  const of = (name: string, seen = new Set<string>()): ClientEffect => {
    if (effect.has(name)) return effect.get(name)!
    if (seen.has(name)) return 'none'
    seen.add(name)
    if (transports.has(name)) return 'none' // a transport's effect is its caller's verb
    const o = own.get(name)!
    const deps = [...o.calls].map((c) => of(c, seen))
    const e: ClientEffect = [...o.verbs].some((v) => WRITE_VERBS.has(v)) || deps.includes('write') ? 'write'
      : o.opaque || deps.includes('unknown') ? 'unknown'
      : o.verbs.size || deps.includes('read') ? 'read' : 'none'
    effect.set(name, e)
    return e
  }
  for (const [name, m] of members) {
    if (m.priv) continue
    if (transports.has(name)) { out.transports.add(name); out.writes.add(name); continue }
    const e = of(name)
    out[e === 'write' ? 'writes' : e === 'read' ? 'reads' : e === 'none' ? 'none' : 'unknown'].add(name)
  }
  return out
}

/** LiveClient members that write. */
export function clientMutations(file?: string): Set<string> {
  return classifyClient(file).writes
}

/** The store's actions (methods of the object the store is created with), and its module-level helper functions, with
 * their bodies' text (an action may deliver through a helper: sendMessage → deliverMessage → client.sendMessage). */
function storeActions(): Map<string, string> {
  const sf = parse(`${SRC}store/store.ts`)
  const out = new Map<string, string>()
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) out.set(st.name.text, st.body.getText(sf))
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) out.set(d.name.text, d.initializer.getText(sf))
  }
  const visit = (n: ts.Node) => {
    if (ts.isMethodDeclaration(n) && n.body && ts.isIdentifier(n.name) && ts.isObjectLiteralExpression(n.parent)) out.set(n.name.text, n.body.getText(sf))
    else if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && ts.isObjectLiteralExpression(n.parent) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) out.set(n.name.text, n.initializer.getText(sf))
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** Store actions that write: they send a client mutation or call another store mutation (to a fixed point). */
export function storeMutations(client = clientMutations()): Set<string> {
  const actions = storeActions()
  const out = new Set<string>()
  const member = (body: string, names: Iterable<string>) => [...names].some((m) => new RegExp(`\\.${m}!?\\(`).test(body))
  const any = (body: string, names: Iterable<string>) => [...names].some((m) => new RegExp(`(\\.|\\b)${m}!?\\(`).test(body))
  const writing = new Set<string>()
  for (let changed = true; changed;) {
    changed = false
    for (const [name, body] of actions) {
      if (writing.has(name)) continue
      if (member(body, client) || any(body, writing)) { writing.add(name); changed = true }
    }
  }
  // only the store's own actions are exported as store mutations (helpers are reached through them)
  const sf = parse(`${SRC}store/store.ts`)
  const actionNames = new Set<string>()
  const visit = (n: ts.Node) => {
    if ((ts.isMethodDeclaration(n) || ts.isPropertyAssignment(n)) && ts.isIdentifier(n.name) && ts.isObjectLiteralExpression(n.parent)) actionNames.add(n.name.text)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  for (const n of writing) if (actionNames.has(n)) out.add(n)
  return out
}

// ---------------------------------------------------------------- helper effects (followups-r8)

/** A named function-like thing in src: a declaration, a const/let arrow or function, or a method/member. */
interface Named { file: string; name: string; fn: ts.FunctionLikeDeclaration; member: boolean; top: boolean; cls: string | null; key: string }

/** the in-memory stand-ins for a hive: the simulator client and First Light's demo host (no hive is reached) */
export const STAND_IN = /^api\/sim\/|\/demo\.ts$/

/** The file a relative import names (.ts, .tsx, /index.ts, /index.tsx), or null. */
function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(from), spec)
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (/\.tsx?$/.test(c) && fs.existsSync(c)) return c
  return null
}

/** Per file: its named functions, its imports (local name → file and exported name), and its aliases of members. */
interface FileIndex {
  named: Named[]
  locals: Map<string, Named[]>
  imports: Map<string, { file: string; name: string }>
  /** `const send = x.createAgent` / `.bind(x)` / `const { createAgent: make } = x`: local name → member names */
  aliases: Map<string, string[]>
}

function indexFile(file: string): FileIndex {
  const sf = parse(file)
  const named: Named[] = []
  const imports = new Map<string, { file: string; name: string }>()
  const aliases = new Map<string, string[]>()
  // by name for the whole file (not by scope): every member a name stands for anywhere in it is kept, so a reuse of
  // the name never hides a write (it can only add one)
  const alias = (name: string, member: string) => aliases.set(name, [...(aliases.get(name) ?? []), member])
  const rel = path.relative(SRC, file)
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
      const target = resolveImport(file, st.moduleSpecifier.text)
      if (target) for (const el of st.importClause.namedBindings.elements) imports.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text })
    }
  }
  const classOf = (n: ts.Node): string | null => {
    const p = n.parent
    return (ts.isClassDeclaration(p) || ts.isClassExpression(p)) && p.name ? p.name.text : null
  }
  const visit = (n: ts.Node) => {
    if (FUNC(n)) {
      const p = n.parent
      const top = ts.isSourceFile(p) || (ts.isVariableDeclaration(p) && ts.isVariableDeclarationList(p.parent) && ts.isVariableStatement(p.parent.parent) && ts.isSourceFile(p.parent.parent.parent))
      if (n.name && ts.isIdentifier(n.name)) named.push({ file, name: n.name.text, fn: n, member: ts.isMethodDeclaration(n), top, cls: ts.isMethodDeclaration(n) ? classOf(n) : null, key: `${rel}#${n.name.text}` })
      else if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) named.push({ file, name: p.name.text, fn: n, member: false, top, cls: null, key: `${rel}#${p.name.text}` })
      else if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && ts.isIdentifier(p.name)) named.push({ file, name: p.name.text, fn: n, member: true, top: false, cls: classOf(p), key: `${rel}#${p.name.text}` })
    }
    if (ts.isVariableDeclaration(n) && n.initializer) {
      let init = strip(n.initializer)
      if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === 'bind') init = strip(init.expression.expression)
      if (ts.isIdentifier(n.name) && ts.isPropertyAccessExpression(init)) alias(n.name.text, init.name.text)
      if (ts.isObjectBindingPattern(n.name)) for (const el of n.name.elements) if (el.propertyName && ts.isIdentifier(el.propertyName) && ts.isIdentifier(el.name)) alias(el.name.text, el.propertyName.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  const locals = new Map<string, Named[]>()
  for (const d of named) if (!d.member) locals.set(d.name, [...(locals.get(d.name) ?? []), d])
  return { named, locals, imports, aliases }
}

export interface Effects {
  /** every mutation name a member call (`x.name()`) sends: the base set plus every derived member name */
  members: Set<string>
  /** member names some real objects write through and others do not: never counted as writes by name */
  ambiguous: Set<string>
  /** the named functions (not members) that write, as `file#name` (relative to src) */
  functions: Set<string>
  /** of those, the ones that send every write through op.write (or through another such function) */
  bound: Set<string>
  /** does this call send a mutation (directly, through a helper it resolves to, or an alias)? its name, and whether the
   * helper it resolves to binds every write itself; or null */
  callee(call: ts.CallExpression, file: string): { name: string; bound: boolean } | null
}

/** The called name: `a.b(...)`, `a.b!(...)`, `a?.b(...)`, `b(...)`. */
function calleeName(call: ts.CallExpression): string | null {
  const e = strip(call.expression)
  return ts.isPropertyAccessExpression(e) ? e.name.text : ts.isIdentifier(e) ? e.text : null
}
const isWriteOp = (n: ts.CallExpression) => calleeName(n) === 'write' && n.arguments.length === 1 && FUNC(n.arguments[0])

export interface EffectOptions {
  /** client members that take their verb from the caller: a call whose verb is only 'GET' is a read */
  transports?: Set<string>
  /** the client class (its members are classified by classifyClient, not derived here) */
  clientClass?: string
}

/**
 * Propagate writes through helpers to a fixed point. `base` is the client and store mutations.
 * - A function (a declaration or a const arrow/function) is resolved by its declaration (same file, or the module it is
 *   imported from), so a call to it is exact: it writes when its body (callbacks included) sends any write.
 * - A member call (`x.name()`) can only be matched by its NAME, so a member is a mutation only when it sends a base
 *   mutation itself, and only when every real member of that name does (another object's `run`, `get` or `send` that
 *   does not write makes the name ambiguous, and it stays out; the in-memory stand-ins do not count). Without that,
 *   names colliding across src would make most method names "writes".
 */
export function deriveEffects(base: Set<string>, files = sourceFiles(), opts: EffectOptions = {}): Effects {
  const clientClass = opts.clientClass ?? 'LiveClient'
  const transports = opts.transports ?? new Set<string>()
  const index = new Map(files.map((f) => [f, indexFile(f)]))
  const members = new Set(base)
  const functions = new Set<string>()
  const key = (d: Named) => d.key
  const standIn = (file: string) => STAND_IN.test(path.relative(SRC, file))
  /** the declarations an identifier call resolves to: same-file functions, else the imported module's top-level ones */
  const resolveId = (file: string, name: string): Named[] => {
    const ix = index.get(file)
    if (!ix) return []
    const local = ix.locals.get(name)
    if (local?.length) return local
    const imp = ix.imports.get(name)
    if (!imp) return []
    return index.get(imp.file)?.locals.get(imp.name)?.filter((d) => d.top) ?? []
  }
  /** a transport called with only 'GET' is a read */
  const readOnly = (call: ts.CallExpression, name: string) => {
    if (!transports.has(name) || !call.arguments[0]) return false
    const vs = literals(call.arguments[0]).filter((v) => v === 'GET' || WRITE_VERBS.has(v))
    return vs.length > 0 && vs.every((v) => v === 'GET')
  }
  /**
   * What a call can reach, worked out once: the function declarations an identifier resolves to (null: it resolves to
   * none), or the member name it is matched by (`x.name()`, an alias, a destructured name; null when it is a read).
   */
  interface Ref { decls: string[] | null; member: string[] }
  const refs = new WeakMap<ts.CallExpression, Ref>()
  const refOf = (call: ts.CallExpression, file: string): Ref => {
    let r = refs.get(call)
    if (r) return r
    const e = strip(call.expression)
    let names: string[] = []
    let decls: string[] | null = null
    if (ts.isPropertyAccessExpression(e)) names = [e.name.text]
    else if (ts.isIdentifier(e)) {
      const ds = resolveId(file, e.text)
      if (ds.length) decls = ds.map(key)
      else names = [e.text, ...(index.get(file)?.aliases.get(e.text) ?? [])]
    }
    r = { decls, member: names.filter((n) => !readOnly(call, n)) }
    refs.set(call, r)
    return r
  }
  const bound = new Set<string>()
  const callee = (call: ts.CallExpression, file: string): { name: string; bound: boolean } | null => {
    const r = refOf(call, file)
    if (r.decls) {
      const w = r.decls.filter((k) => functions.has(k))
      return w.length ? { name: calleeName(call)!, bound: w.every((k) => bound.has(k)) } : null
    }
    const m = r.member.find((n) => members.has(n))
    return m === undefined ? null : { name: m, bound: false }
  }
  // each named thing's calls, found once
  const calls = new Map<Named, ts.CallExpression[]>()
  for (const ix of index.values()) for (const d of ix.named) {
    if (standIn(d.file) || d.cls === clientClass) continue
    const out: ts.CallExpression[] = []
    const walk = (n: ts.Node) => { if (ts.isCallExpression(n)) out.push(n); ts.forEachChild(n, walk) }
    if (d.fn.body) walk(d.fn.body)
    calls.set(d, out)
  }
  const direct = (d: Named) => calls.get(d)!.some((c) => { const r = refOf(c, d.file); return !r.decls && r.member.some((n) => base.has(n)) })
  const ambiguous = new Set<string>()
  {
    const writing = new Set<string>()
    for (const d of calls.keys()) if (d.member && direct(d)) writing.add(d.name)
    for (const d of calls.keys()) if (d.member && writing.has(d.name) && !direct(d)) ambiguous.add(d.name)
  }
  for (let changed = true; changed;) {
    changed = false
    for (const [d, cs] of calls) {
      if (d.member ? members.has(d.name) || ambiguous.has(d.name) : functions.has(key(d))) continue
      if (d.member ? !direct(d) : !cs.some((c) => callee(c, d.file) !== null)) continue
      if (d.member) members.add(d.name); else functions.add(key(d))
      changed = true
    }
  }
  // bound helpers: the greatest set of writing functions whose every write is inside an op.write callback, or a call
  // to another bound helper (a helper that checks the binding right before each write, as op.write does)
  const insideWriteOp = (n: ts.Node, fn: ts.FunctionLikeDeclaration): boolean => {
    for (let x: ts.Node = n; x && x !== fn; x = x.parent) if (FUNC(x) && ts.isCallExpression(x.parent) && isWriteOp(x.parent) && x.parent.arguments[0] === x) return true
    return false
  }
  for (const d of calls.keys()) if (!d.member && functions.has(key(d))) bound.add(key(d))
  for (let changed = true; changed;) {
    changed = false
    for (const [d, cs] of calls) {
      if (d.member || !bound.has(key(d))) continue
      const ok = cs.every((c) => { const w = callee(c, d.file); return w === null || isWriteOp(c) || w.bound || insideWriteOp(c, d.fn) })
      if (!ok) { bound.delete(key(d)); changed = true }
    }
  }
  return { members, ambiguous, functions, bound, callee }
}

// ---------------------------------------------------------------- chains

export interface Chain {
  /** `file:function` (file relative to src; the function's own name, or `<anonymous@line>`) */
  at: string
  /** every awaited mutation, in source order: name, line, sent through op.write or direct, inside a loop */
  writes: { name: string; line: number; bound: boolean; loop: boolean }[]
  /** the most writes on any one path through the function (exclusive branches count once; a loop of one counts two) */
  path: number
  /** `.then`/`.catch`/`.finally` chains: a mutation whose settled promise's callback sends another mutation */
  thens: number[]
}

function nameOf(fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile): string {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text
  const p = fn.parent
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && ts.isIdentifier(p.name)) return p.name.text
  return `<anonymous@${sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1}>`
}

const COMBINATOR = (n: ts.CallExpression) => {
  const e = strip(n.expression)
  return ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'Promise' && ['all', 'allSettled', 'race', 'any'].includes(e.name.text)
}
const ITERATES = new Set(['forEach', 'map', 'flatMap', 'reduce', 'reduceRight', 'filter', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex'])
type Flow = { cont: number; done: number }
const NONE = -Infinity
const add = (a: number, b: number) => (a === NONE || b === NONE ? NONE : a + b)
const STATEMENT = (n: ts.Node) => ts.isBlock(n) || ts.isIfStatement(n) || ts.isSwitchStatement(n) || LOOP(n) || ts.isReturnStatement(n) || ts.isThrowStatement(n) || ts.isTryStatement(n) || ts.isLabeledStatement(n)
const isThen = (n: ts.CallExpression) => { const e = strip(n.expression); return ts.isPropertyAccessExpression(e) && ['then', 'catch', 'finally'].includes(e.name.text) }

/** Is this call's promise awaited or returned (through parentheses, `!`, `as`, a ternary's branch or `??`/`||`/`&&`)? */
function consumed(n: ts.Expression): boolean {
  let x: ts.Node = n
  for (;;) {
    const p: ts.Node = x.parent
    if (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p)) { x = p; continue }
    if (ts.isConditionalExpression(p) && p.condition !== x) { x = p; continue }
    if (ts.isBinaryExpression(p) && p.right === x && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(p.operatorToken.kind)) { x = p; continue }
    return ts.isAwaitExpression(p) || ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === x)
  }
}

/** Every function in src that awaits at least one mutation (or chains one with .then), with its writes. */
export function scan(mutations: Set<string>, files = sourceFiles().filter((f) => !STAND_IN.test(path.relative(SRC, f))), effects = deriveEffects(mutations, files)): Chain[] {
  const out: Chain[] = []
  for (const file of files) {
    const sf = parse(file)
    const rel = path.relative(SRC, file)
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
    const writeName = (n: ts.CallExpression) => effects.callee(n, file)?.name ?? null
    /** does this subtree (within the function) send a mutation: directly, or (with `bound`) through op.write too? */
    const sends = (n: ts.Node, bound: boolean): boolean => {
      if (ts.isCallExpression(n)) {
        if (writeName(n) !== null && !isWriteOp(n)) return true
        if (bound && isWriteOp(n) && (n.arguments[0] as ts.FunctionLikeDeclaration).body && sends((n.arguments[0] as ts.FunctionLikeDeclaration).body!, false)) return true
      }
      let found = false
      ts.forEachChild(n, (c) => { if (!found && !(FUNC(c) && c !== n)) found = sends(c, bound) })
      return found
    }
    const visitFn = (fn: ts.FunctionLikeDeclaration) => {
      const writes: Chain['writes'] = []
      const thens: number[] = []
      /**
       * Paths through statements: `cont`, the most writes on a path that goes on past `n`; `done`, the most on a path
       * that a return or throw ends inside it (NONE: no such path). So `if (x) return a(); b()` is one write a path, not two.
       */
      const flow = (n: ts.Node, loop: boolean): Flow => {
        if (ts.isBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) return seq(n.statements, loop)
        if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) return { cont: NONE, done: n.expression ? count(n.expression, loop, ts.isReturnStatement(n)) : 0 }
        if (ts.isIfStatement(n)) {
          const c = count(n.expression, loop)
          const t = flow(n.thenStatement, loop)
          const e = n.elseStatement ? flow(n.elseStatement, loop) : { cont: 0, done: NONE }
          return { cont: add(c, Math.max(t.cont, e.cont)), done: add(c, Math.max(t.done, e.done)) }
        }
        if (ts.isSwitchStatement(n)) {
          const c = count(n.expression, loop)
          const fs = n.caseBlock.clauses.map((cl) => flow(cl, loop))
          const fallsOut = !n.caseBlock.clauses.some(ts.isDefaultClause)
          return { cont: add(c, Math.max(fallsOut ? 0 : NONE, ...fs.map((f) => f.cont))), done: add(c, Math.max(NONE, ...fs.map((f) => f.done))) }
        }
        if (LOOP(n)) {
          let inner = 0
          ts.forEachChild(n, (c) => { inner += count(c, true) })
          return { cont: inner * 2, done: inner * 2 }
        }
        if (ts.isTryStatement(n)) {
          // the catch may follow any part of the try; the finally follows everything
          const t = flow(n.tryBlock, loop)
          const before = Math.max(t.cont, t.done, 0)
          const c = n.catchClause ? flow(n.catchClause.block, loop) : { cont: NONE, done: NONE }
          const f = n.finallyBlock ? flow(n.finallyBlock, loop) : { cont: 0, done: NONE }
          const cont = Math.max(t.cont, add(before, c.cont))
          const done = Math.max(t.done, add(before, c.done))
          const fin = Math.max(f.cont, 0)
          return { cont: add(cont, f.cont), done: Math.max(add(done, fin), add(Math.max(cont, done, 0), f.done)) }
        }
        if (ts.isLabeledStatement(n)) return flow(n.statement, loop)
        return { cont: count(n, loop), done: NONE }
      }
      const seq = (sts: ts.NodeArray<ts.Statement>, loop: boolean): Flow => {
        let acc: Flow = { cont: 0, done: NONE }
        for (const st of sts) {
          if (acc.cont === NONE) break
          const r = flow(st, loop)
          acc = { cont: add(acc.cont, r.cont), done: Math.max(acc.done, add(acc.cont, r.done)) }
        }
        return acc
      }
      /** the most writes on one path through `n` (records each write once); `site`: a call here is awaited/returned */
      const count = (n: ts.Node, loop: boolean, site = false): number => {
        if (n !== fn && FUNC(n)) return 0 // its own function
        if (STATEMENT(n)) { const f = flow(n, loop); return Math.max(f.cont, f.done, 0) }
        if (ts.isConditionalExpression(n)) return count(n.condition, loop) + Math.max(count(n.whenTrue, loop, site), count(n.whenFalse, loop, site))
        if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken || n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) return count(n.left, loop) + count(n.right, loop, site)
        if (ts.isCallExpression(n)) {
          // a .then chain: a write (bound or not) whose callback sends a write DIRECTLY (a bound callback is fine)
          // (either callback of .then, or a .catch/.finally one: a write after a failed write is a chain too)
          if (isThen(n) && sends((strip(n.expression) as ts.PropertyAccessExpression).expression, true) && n.arguments.some((a) => FUNC(a) && !!a.body && sends(a.body, false))) thens.push(lineOf(n))
          const here = site || consumed(n)
          // a Promise.all/allSettled/race/any group: its writes are sent in one synchronous run, one step
          if (COMBINATOR(n) && here) {
            let t = 0
            ts.forEachChild(n, (c) => { t += count(c, loop, true) })
            return Math.min(1, t)
          }
          let own = 0
          if (here && isWriteOp(n)) {
            const cb = n.arguments[0] as ts.FunctionLikeDeclaration
            let sent = 'write'
            const find = (x: ts.Node) => { if (sent !== 'write') return; if (ts.isCallExpression(x)) { const m = writeName(x); if (m) { sent = m; return } } ts.forEachChild(x, find) }
            if (cb.body) find(cb.body)
            writes.push({ name: sent, line: lineOf(n), bound: true, loop }); own = 1
          } else if (here && writeName(n) !== null) {
            // a helper that binds every write itself (op.write inside) is a bound write here
            const w = effects.callee(n, file)!
            writes.push({ name: w.name, line: lineOf(n), bound: w.bound, loop }); own = 1
          }
          // callbacks an awaited/returned call runs are part of this path (array iteration: a loop, two)
          if (here && !isWriteOp(n) && !isThen(n)) {
            const iterates = ITERATES.has(calleeName(n) ?? '')
            for (const a of n.arguments) if (FUNC(a) && a.body) { const c = count(a.body, loop || iterates, true); own += iterates ? c * 2 : c }
          }
          let t = own
          ts.forEachChild(n, (c) => { t += count(c, loop) })
          return t
        }
        let t = 0
        // an awaited/returned value's own calls are sites; parentheses and a combinator's array pass `site` through
        const childSite = ts.isAwaitExpression(n) || ts.isReturnStatement(n) || ((ts.isParenthesizedExpression(n) || ts.isArrayLiteralExpression(n)) && site)
        ts.forEachChild(n, (c) => { t += count(c, loop, childSite && ts.isExpression(c)) })
        return t
      }
      const path = fn.body ? count(fn.body, false, ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) : 0
      if (writes.length || thens.length) out.push({ at: `${rel}:${nameOf(fn, sf)}`, writes, path, thens })
    }
    const visit = (n: ts.Node) => { if (FUNC(n)) visitFn(n); ts.forEachChild(n, visit) }
    visit(sf)
  }
  return out
}

/** A chain: two or more awaited mutations on one path (a looped one counts as two), or a mutation .then another. */
export const isChain = (c: Chain): boolean => c.path >= 2 || c.thens.length > 0
/** An unbound chain: a chain with any write sent directly (not through op.write). */
export const unbound = (c: Chain): boolean => isChain(c) && (c.thens.length > 0 || c.writes.some((w) => !w.bound))

// ---------------------------------------------------------------- allowance guards (followups-r8, stand-in r1.2 P3)

/** A function in a source text by its scan name (`name`, or `<anonymous@line>`). */
function findFn(sf: ts.SourceFile, name: string): ts.FunctionLikeDeclaration | null {
  let found: ts.FunctionLikeDeclaration | null = null
  const visit = (n: ts.Node) => { if (found) return; if (FUNC(n) && nameOf(n, sf) === name) { found = n; return } ts.forEachChild(n, visit) }
  visit(sf)
  return found
}

export interface GuardCheck { name: string; line: number; guarded: boolean }

/**
 * The `continue` statements that go back to this loop's head (scanner r1): an unlabelled one not inside an inner loop,
 * or one labelled with this loop's label at any depth; never one inside a nested function (its own control flow).
 */
function loopContinues(loop: ts.Node): ts.ContinueStatement[] {
  // every label attached to the loop (scanner r1.1, stand-in P2: `outer: inner: for …` answers to both)
  const labels = new Set<string>()
  for (let p = loop.parent; p && ts.isLabeledStatement(p); p = p.parent) labels.add(p.label.text)
  const out: ts.ContinueStatement[] = []
  const walk = (n: ts.Node, inner: boolean) => {
    if (FUNC(n)) return
    if (ts.isContinueStatement(n)) {
      if (n.label ? labels.has(n.label.text) : !inner) out.push(n)
      return
    }
    ts.forEachChild(n, (c) => walk(c, inner || LOOP(n)))
  }
  walk((loop as ts.IterationStatement).statement, false)
  return out
}

/**
 * Is each call to one of `writes` in `fn` (file:function, a source text given or read from src) preceded by the guard,
 * with no await in between? The guard must lie between the last await before the write and the write; inside a loop
 * with no await before the write in its body, on every way back to the loop's head (the previous turn): between the
 * body's last await and its end, and, for each `continue` of this loop (scanner r1, stand-in/Kimi live-pins r1), between
 * the last await before that `continue` and the `continue` itself. A `continue` is an edge back to the loop head, so a
 * write reached again through one is guarded only if the guard stands on that path: after the turn's last await
 * before the `continue`, or between the loop head and the write. The first send of a loop's first write, with nothing
 * awaited before it, needs none (it is the operation's first write).
 * This pins an allowance's safety argument: remove the guard, or put an await between it and the write, and it fails.
 */
export function guardedWrites(at: string, guard: RegExp, writes: string[], source?: string): GuardCheck[] {
  const [rel, name] = [at.slice(0, at.lastIndexOf(':')), at.slice(at.lastIndexOf(':') + 1)]
  const file = `${SRC}${rel}`
  const text = source ?? fs.readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const fn = findFn(sf, name)
  if (!fn?.body) return []
  const awaits: ts.AwaitExpression[] = []
  const sites: ts.CallExpression[] = []
  const walk = (n: ts.Node) => {
    if (ts.isAwaitExpression(n)) awaits.push(n)
    if (ts.isCallExpression(n) && writes.includes(calleeName(n) ?? '')) sites.push(n)
    ts.forEachChild(n, walk)
  }
  walk(fn.body)
  const has = (from: number, to: number) => guard.test(text.slice(from, to))
  /**
   * An await that can't run before this call on any path: it sits in the other branch of an `if/else` or a `?:` that also
   * holds the call (release baseline r1: `if (view) await view() else if (act) await act()`: the act follows no await)
   */
  const within = (n: ts.Node, outer: ts.Node | undefined) => !!outer && n.getStart(sf) >= outer.getStart(sf) && n.end <= outer.end
  const exclusive = (a: ts.Node, call: ts.Node) => {
    for (let x: ts.Node = a.parent; x && x !== fn; x = x.parent) {
      if (ts.isIfStatement(x) && x.elseStatement) {
        if ((within(a, x.thenStatement) && within(call, x.elseStatement)) || (within(a, x.elseStatement) && within(call, x.thenStatement))) return true
      } else if (ts.isConditionalExpression(x)) {
        if ((within(a, x.whenTrue) && within(call, x.whenFalse)) || (within(a, x.whenFalse) && within(call, x.whenTrue))) return true
      }
    }
    return false
  }
  /**
   * KNOWN LIMITS (Dot's ruling on the stand-in's R2, 4 Nov: this is a test lint, already stricter than the live code
   * needs; no full control-flow analysis now). The dominance check below is structural, not a CFG, and still reports a
   * write guarded in these shapes (each an it.todo in mutationChains.test.ts):
   *  - an escape from the guard's own branch: `break` out of a loop or a switch case before the guard
   *    (`do { await c.r(); if (b) break; if (!ok()) return } while (false); await c.w()`);
   *  - a guard in a nested function that shares an enclosing node with the await (`const f = async () => { await c.r();
   *    if (!ok()) return }; await c.w()`);
   *  - loop-back paths: the loop fallback still reads the guard's text, so a guard inside a branch of the loop body counts
   *    for the next iteration's write;
   *  - a guard inside a try whose check can throw, with an empty catch that falls through to the write.
   * A new allowance in one of these shapes must be read by hand.
   */
  /**
   * A guard between `from` and the call that is on every path to it (stand-in on 4733c4aa: an opposite-branch guard must
   * not count). From the guard up to the lowest node that also holds the call, every enclosing node must be a plain
   * block: a guard inside a branch (an if's then/else, a ?: arm, a switch case, a loop body, a catch or a nested function)
   * that doesn't hold the call protects only that branch.
   */
  // a catch whose try block always leaves (ends in return or throw) is the only way on past the try: not a branch
  const exits = (b: ts.Block) => { const last = b.statements[b.statements.length - 1]; return !!last && (ts.isReturnStatement(last) || ts.isThrowStatement(last)) }
  const onlyWayOn = (n: ts.Node) => ts.isCatchClause(n) && ts.isTryStatement(n.parent) && exits(n.parent.tryBlock)
  const BRANCHY = (n: ts.Node) => ts.isIfStatement(n) || ts.isConditionalExpression(n) || ts.isCaseClause(n) || ts.isDefaultClause(n) || LOOP(n) || (ts.isCatchClause(n) && !onlyWayOn(n)) || FUNC(n)
  const dominated = (call: ts.Node, from: number, to: number, after?: ts.Node) => {
    const re = new RegExp(guard.source, guard.flags.replace('g', '') + 'g')
    const slice = text.slice(from, to)
    for (const m of slice.matchAll(re)) {
      const at = from + m.index!
      // the statement the guard begins
      let g: ts.Node | undefined
      const find = (n: ts.Node) => { if (n.getStart(sf) <= at && at < n.end) { if (ts.isStatement(n) && n.getStart(sf) === at) g = n; ts.forEachChild(n, find) } }
      find(fn.body!)
      if (!g) continue
      // not in the other branch of an if/else or ?: that holds the call (or the await it follows)
      let ok = !exclusive(g, call) && !(after && exclusive(g, after))
      // a branch around the guard that doesn't hold the call is fine only if it holds the await the write follows: the
      // path from that await to the write then passes the guard
      for (let x: ts.Node = g.parent; ok && x && !within(call, x); x = x.parent) if (BRANCHY(x) && !(after && within(after, x))) ok = false
      if (ok) return true
    }
    return false
  }
  return sites.map((call) => {
    const start = call.getStart(sf)
    let loop: ts.Node | null = null
    for (let x: ts.Node = call.parent; x && x !== fn; x = x.parent) if (LOOP(x)) { loop = x; break }
    const body = loop ? (loop as ts.IterationStatement).statement : fn.body!
    const inBody = (a: ts.Node) => a.getStart(sf) >= body.getStart(sf) && a.end <= body.end
    const before = awaits.filter((a) => a.end <= start && inBody(a) && !exclusive(a, call))
    const from = before.length ? Math.max(...before.map((a) => a.end)) : body.getStart(sf)
    const last = before.length ? before.reduce((a, b) => (b.end > a.end ? b : a)) : undefined
    let guarded = dominated(call, from, start, last)
    if (!guarded && loop && !before.length) {
      // the previous turn's last await, then the loop's end; and before the loop, the last await (if any) to it
      const after = awaits.filter((a) => a.end > start && inBody(a))
      const lastBefore = (at: number, list: ts.AwaitExpression[]) => { const l = list.filter((a) => a.end <= at); return l.length ? Math.max(...l.map((a) => a.end)) : null }
      const fallsThrough = lastBefore(body.end, after)
      // each `continue` of this loop goes back to its head: the guard must follow that turn's last await before it
      // (a `continue` with no await before it in the body brings nothing new: its turn's awaits are another edge's)
      const continues = loopContinues(loop)
      const back = (fallsThrough === null || has(fallsThrough, body.end)) &&
        continues.every((c) => { const at = c.getStart(sf); const a = lastBefore(at, awaits.filter(inBody)); return a === null || has(a, at) })
      const outer = awaits.filter((a) => a.end <= loop!.getStart(sf))
      const first = !outer.length || has(Math.max(...outer.map((a) => a.end)), start)
      guarded = back && first
    }
    return { name: calleeName(call)!, line: sf.getLineAndCharacterOfPosition(start).line + 1, guarded }
  })
}
