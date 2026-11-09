// Intent-aware extraction for the UI inventory (Surface R3.1, for Codex's Town/intent round). Reads the TypeScript AST,
// so a label that becomes a say() call, or a computed one, is still counted; only how it binds changes.
//   node entries.mjs <hive/ui/src> <entry file>...   ->  JSON on stdout: { experiences: [...], controls: [...] }
// experiences: every object literal in experiences/registry.ts with an `id` and a `name` (whatever the name's value),
//   bound to its explicit `intent: '…'` field, else experience.<id>.
// controls: every interactive element in each entry file: a button / Button / a / input / select / textarea, anything with
//   onClick or role button|menuitem|menuitemradio|menuitemcheckbox|tab|option|link|switch|checkbox, and menu rows (object
//   literals with a `label` and one of onSelect / run / action / onClick / to / href). Each carries its intent from
//   data-intent="…" (or an `intent: '…'` field on a menu row), else from a say('…') label, else none; and its label as
//   literal text, say, or dynamic. A dynamic label with no intent stays in the inventory, unbound, so unbound-entry sees it.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [src, ...files] = process.argv.slice(2)
const ts = createRequire(import.meta.url)('typescript')

const ROLES = new Set(['button', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'tab', 'option', 'link', 'switch', 'checkbox'])
const TAGS = new Set(['button', 'Button', 'a', 'input', 'select', 'textarea'])
const ROW_ACTS = new Set(['onSelect', 'run', 'action', 'onClick', 'to', 'href'])

const parse = (file) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
const lit = (n) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null)
/** say('intent') (or t.say / words.say): the intent id */
const sayOf = (n) => {
  if (!n || !ts.isCallExpression(n)) return null
  const callee = n.expression
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null
  return name === 'say' ? lit(n.arguments[0]) : null
}
/** a label expression as { kind: 'literal'|'say'|'dynamic', text?, intent? } */
const labelOf = (n) => {
  if (!n) return null
  if (ts.isJsxExpression(n)) return labelOf(n.expression)
  if (ts.isParenthesizedExpression(n)) return labelOf(n.expression)
  const l = lit(n)
  if (l !== null) return l.trim() ? { kind: 'literal', text: l.trim() } : null
  const s = sayOf(n)
  if (s) return { kind: 'say', intent: s }
  return { kind: 'dynamic' }
}
const prop = (obj, name) => obj.properties.find((p) => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name)
const propValue = (obj, name) => { const p = prop(obj, name); return p && ts.isPropertyAssignment(p) ? p.initializer : p && ts.isShorthandPropertyAssignment(p) ? p.name : null }
const line = (sf, n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1

const out = { experiences: [], controls: [] }

// the experiences the registry offers
{
  const file = join(src, 'experiences/registry.ts'), sf = parse(file)
  const visit = (n) => {
    if (ts.isObjectLiteralExpression(n)) {
      const id = lit(propValue(n, 'id')), name = propValue(n, 'name')
      if (id && name) {
        const explicit = lit(propValue(n, 'intent'))
        const label = labelOf(name)
        out.experiences.push({ id, intent: explicit ?? (label?.kind === 'say' ? label.intent : `experience.${id}`), label, line: line(sf, n) })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

// the interactive elements of each entry component
for (const file of files) {
  const sf = parse(join(src, file))
  const attrs = (el) => Object.fromEntries(el.attributes.properties.filter(ts.isJsxAttribute).map((a) => [a.name.getText(sf), a.initializer ?? true]))
  const textOf = (node) => {
    // the visible text of a JSX element: its literal children, else a single say()/expression child
    const kids = node.children ?? []
    const words = kids.filter(ts.isJsxText).map((k) => k.text.trim()).filter(Boolean).join(' ')
    if (words) return { kind: 'literal', text: words }
    for (const k of kids) if (ts.isJsxExpression(k) && k.expression) return labelOf(k)
    return kids.some((k) => ts.isJsxElement(k) || ts.isJsxSelfClosingElement(k)) ? { kind: 'dynamic' } : null
  }
  const visit = (n) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const open = ts.isJsxElement(n) ? n.openingElement : n
      const tag = open.tagName.getText(sf)
      const a = attrs(open)
      const role = lit(a.role?.expression ?? a.role)
      if (TAGS.has(tag) || 'onClick' in a || (role && ROLES.has(role))) {
        const intent = lit(a['data-intent']?.expression ?? a['data-intent'])
        const label = labelOf(a['aria-label']) ?? labelOf(a.label) ?? (ts.isJsxElement(n) ? textOf(n) : null) ?? labelOf(a.placeholder) ?? labelOf(a.title) ?? { kind: 'dynamic' }
        out.controls.push({ file, line: line(sf, n), kind: role ?? tag, intent: intent ?? (label.kind === 'say' ? label.intent : null), label })
      }
    } else if (ts.isObjectLiteralExpression(n) && prop(n, 'label') && n.properties.some((p) => p.name && ROW_ACTS.has(p.name.getText(sf)))) {
      const label = labelOf(propValue(n, 'label'))
      const intent = lit(propValue(n, 'intent'))
      out.controls.push({ file, line: line(sf, n), kind: 'menuitem', intent: intent ?? (label?.kind === 'say' ? label.intent : null), label: label ?? { kind: 'dynamic' } })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}
process.stdout.write(JSON.stringify(out))
