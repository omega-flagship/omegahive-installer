import ts from 'typescript'

/**
 * The shown-strings scanner (moved from wordingGuard.test.ts unchanged, so more than one guard can use it): only strings
 * shown to people are read: JSX text, the people-facing JSX attributes (aria-label, title, placeholder, label and the
 * like), strings inside JSX expressions, the people-facing properties of objects, and prose anywhere. Internal
 * identifiers, routes, keys, comparisons, imports and search keywords are not shown and are not read.
 */
// node's fs, loaded the way the other source-reading tests load it (the app's tsconfig carries no node types)
const fsName = 'node:fs'
const { readdirSync, readFileSync, statSync } = (await import(/* @vite-ignore */ fsName)) as {
  readdirSync: (p: string) => string[]
  readFileSync: (p: string, e: 'utf8') => string
  statSync: (p: string) => { isDirectory: () => boolean }
}
export const ROOT = new URL('.', import.meta.url).pathname.replace(/\/$/, '')
const join = (a: string, b: string) => `${a}/${b}`
const relative = (root: string, f: string) => f.slice(root.length + 1)
/** JSX attributes that never reach a person's eyes or ears. */
const NOT_SHOWN_ATTR = new Set(['info', 'className', 'style', 'id', 'key', 'type', 'role', 'name', 'value', 'href', 'to', 'kind', 'tone', 'icon', 'variant', 'size', 'as', 'src', 'rel', 'target', 'mode', 'route', 'side', 'tab', 'testid', 'autoComplete', 'inputMode', 'lang', 'dir', 'method', 'htmlFor', 'form', 'motif', 'state', 'layoutId', 'initial', 'animate', 'exit', 'transition', 'skin', 'surface', 'scope', 'program', 'path', 'goalId', 'swarm', 'swarmId', 'mind', 'mindId', 'at', 'focus', 'section', 'where'])
/** Object properties whose text people read (toasts, notices, menus, chips, cards). */
const SHOWN_PROP = new Set(['rows', 'facts', 'options', 'chips', 'title', 'body', 'label', 'placeholder', 'eyebrow', 'blurb', 'tagline', 'hint', 'notice', 'message', 'detail', 'description', 'headline', 'summary', 'ariaLabel', 'help', 'caption', 'empty', 'what', 'why', 'say', 'line', 'note', 'sub', 'subtitle', 'heading', 'cta', 'confirm', 'cancel', 'action', 'text', 'answer', 'reply', 'prompt', 'chip', 'desc', 'thing', 'verb', 'lead', 'tip', 'status'])

/** Object properties that hold keys, routes and commands, never words to read. */
const KEY_PROP = new Set(['value', 'page', 'run', 'insert', 'kind', 'id', 'key', 'route', 'tab', 'type', 'icon', 'tone', 'href', 'to', 'view', 'feature', 'deck', 'cmd', 'command', 'scope', 'mode', 'section', 'info'])

/** Allowed hits: `at` is a file, a directory (ending /) or `file:exact text`; `why` says why. */
export type Allowed = (rel: string, text: string) => boolean

function files(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...files(p))
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|testkit)\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) && !name.includes('.fixture')) out.push(p)
  }
  return out
}

const attrName = (a: ts.JsxAttribute) => (ts.isIdentifier(a.name) ? a.name.text : a.name.getText())
const propName = (p: ts.PropertyAssignment) => (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null)

/** Text pieces of a string-ish node (string literal, plain template, template head and spans). */
function texts(n: ts.Node): string[] {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return [n.text]
  if (ts.isTemplateExpression(n)) return [n.head.text, ...n.templateSpans.map((s) => s.literal.text)]
  return []
}

/** Every string-ish node under `n`, not crossing into nested functions' non-shown code (calls stay: t('…')). */
function stringsUnder(n: ts.Node, out: ts.Node[] = []): ts.Node[] {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
    // skip comparisons and keys: x === 'goal', obj['goals'], import paths
    const p = n.parent
    if (p && ts.isBinaryExpression(p) && /^(===|!==|==|!=)$/.test(p.operatorToken.getText())) return out
    if (p && ts.isElementAccessExpression(p)) return out
    out.push(n)
    if (ts.isTemplateExpression(n)) n.templateSpans.forEach((s) => stringsUnder(s.expression, out))
    return out
  }
  if (ts.isJsxAttribute(n) && NOT_SHOWN_ATTR.has(attrName(n))) return out
  if (ts.isJsxAttribute(n) && attrName(n).startsWith('data-')) return out
  // event handlers and actions run code; their strings are view keys and commands (run={() => changeView('goals')})
  if (ts.isJsxAttribute(n) && /^(on[A-Z]|run$)/.test(attrName(n))) return out
  if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^(navigate|href|cx|go|open|route|routeFor)$/.test(n.expression.text)) return out
  // a method's lookup key or state value: x.startsWith('goal state'), setDeck('goals'), setInboxTab('goals')
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
    const keep = n.arguments.filter((a) => !(ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)))
    stringsUnder(n.expression, out)
    keep.forEach((a) => stringsUnder(a, out))
    return out
  }
  if (ts.isPropertyAssignment(n) && (KEY_PROP.has(propName(n) ?? '') || /^(keywords|words|synonyms|aliases|match)$/.test(propName(n) ?? ''))) return out
  // a [value, label] option pair: the value is a key ('goal', 'Tasks')
  if (ts.isArrayLiteralExpression(n) && n.elements.length === 2 && ts.isStringLiteral(n.elements[0]) && /^[a-z][\w:.-]*$/.test(n.elements[0].text)) {
    stringsUnder(n.elements[1], out)
    return out
  }
  ts.forEachChild(n, (c) => void stringsUnder(c, out))
  return out
}

/** An import path, a comparison, an element key: never prose. */
function isKeyOrImport(n: ts.Node): boolean {
  const p = n.parent
  if (!p) return false
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p) || ts.isLiteralTypeNode(p)) return true
  if (ts.isBinaryExpression(p) && /^(===|!==|==|!=)$/.test(p.operatorToken.getText())) return true
  if (ts.isElementAccessExpression(p) || ts.isCaseClause(p)) return true
  // a method's lookup key: series.startsWith('goal state'), setDeck('goals')
  if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && p.arguments.includes(n as ts.Expression)) return true
  return false
}

/** Every shown string in the tree under `src` that matches `banned` and is not `allowed`, as `file:line: text`. */
export function scanShownTree(banned: RegExp, allowed: Allowed): string[] {
  const hits: string[] = []
  for (const f of files(ROOT)) scanShown(relative(ROOT, f), readFileSync(f, 'utf8'), banned, allowed, hits)
  return hits
}

/** A display label: one capitalised word or more, never a lowercase key or identifier ('goals', 'work.goals'). */
const LABEL = /^\s*[A-Z][A-Za-z’']*(\s|:|$)/
/** Prose: two or more words. A template counts with its `${…}` parts in place, so "${n} goal${s} is open" is prose. */
const PROSE = /[A-Za-z]\s+[A-Za-z]/

/** One file's hits (`rel`: its path under src, used for the allowance list and the report). */
export function scanShown(rel: string, src: string, BANNED: RegExp, allowed: Allowed, hits: string[] = []): string[] {
  {
    if (!BANNED.test(src)) return hits
    const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const report = (node: ts.Node, text: string) => {
      if (!BANNED.test(text)) return
      if (allowed(rel, text.trim())) return
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      hits.push(`${rel}:${line + 1}: ${text.trim().slice(0, 100)}`)
    }
    const seen = new Set<ts.Node>()
    const take = (n: ts.Node) => {
      for (const s of stringsUnder(n)) {
        if (seen.has(s)) continue
        seen.add(s)
        for (const t of texts(s)) report(s, t)
      }
    }
    const visit = (n: ts.Node) => {
      if (ts.isJsxText(n)) report(n, n.text)
      // prose anywhere (two or more words): messages, notes and answers built away from the JSX that shows them
      else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) && !seen.has(n) && !isKeyOrImport(n)) {
        const pieces = texts(n)
        const whole = pieces.join(' x ') // a template read as one sentence, its `${…}` parts as words
        // prose (two or more words, the template whole), or a display label (Title case: 'Goals' in a tuple or table)
        if (PROSE.test(whole) || pieces.some((t) => LABEL.test(t))) for (const t of pieces) report(n, t)
      }
      else if (ts.isJsxExpression(n) && n.parent && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) take(n)
      else if (ts.isJsxAttribute(n) && !NOT_SHOWN_ATTR.has(attrName(n)) && !attrName(n).startsWith('data-') && !/^(on[A-Z]|run$)/.test(attrName(n)) && n.initializer) take(n.initializer)
      else if (ts.isPropertyAssignment(n) && SHOWN_PROP.has(propName(n) ?? '')) take(n.initializer)
      else if (ts.isPropertyAssignment(n) && /^(keywords|words|synonyms|aliases|match)$/.test(propName(n) ?? '')) stringsUnder(n.initializer).forEach((x) => seen.add(x))
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return hits
}

