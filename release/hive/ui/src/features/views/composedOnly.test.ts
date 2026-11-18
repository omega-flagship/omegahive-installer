// Purpose: nothing around a view writes what a person sees or hears itself. Every word, accessible name and label in
// the views feature's components, and in the Artifacts reader that opens views, is MeTTa's (views.metta, words.metta,
// artifacts.metta); the components state facts and draw. This reads each file's syntax and fails on JSX text, a literal
// or templated name or title, a literal word inside JSX, and a word handed to a composed screen as data: the checks a
// translation lint makes (react/jsx-no-literals, i18next/no-literal-string), held as a test as this UI's guards are.
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string; readdirSync: (p: string) => string[] }
const here = new URL('./', import.meta.url).pathname
/** Every component the views feature draws with, and the Artifacts reader, which opens a view or its text in place. */
const FILES = [
  ...fs.readdirSync(here).filter((f) => f.endsWith('.tsx') && !/\.(test|testkit)\./.test(f)).map((f) => `features/views/${f}`),
  'features/artifacts/CreationReader.tsx',
].sort()

/** Attributes and primitive props whose value a person reads or hears. */
const WORDS_IN = new Set(['aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'title', 'alt', 'placeholder', 'label', 'body', 'text', 'eyebrow', 'hint', 'note'])
/** A key of the data a page hands its composed screen: view.maker, reader.title, words.named. */
const DATA_KEY = /^['"]?[a-z]+\.[a-z.-]+['"]?$/
const hasWords = (s: string) => /[A-Za-z]{2,}/.test(s)

/** Each place in one file's source where it writes words itself, as `line: what`. */
function wordsWritten(name: string, source: string): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const at = (node: ts.Node, what: string) => found.push(`${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${what}`)
  // the literal words of an expression in the positions that reach the screen: itself, either branch, either side of
  // ?? or ||, and a template's own text; never a comparison's operand ('link' in asking, place === 'chat')
  const literals = (e: ts.Expression): ts.Node[] => {
    if (ts.isParenthesizedExpression(e)) return literals(e.expression)
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return hasWords(e.text) ? [e] : []
    if (ts.isTemplateExpression(e)) return [e.head, ...e.templateSpans.map((s) => s.literal)].some((l) => hasWords(l.text)) ? [e] : []
    if (ts.isConditionalExpression(e)) return [...literals(e.whenTrue), ...literals(e.whenFalse)]
    if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind)) return [...literals(e.left), ...literals(e.right)]
    return []
  }
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && hasWords(node.text)) at(node, `text ${node.text.trim()}`)
    else if (ts.isJsxAttribute(node) && WORDS_IN.has(node.name.getText(file)) && node.initializer) {
      const init = node.initializer
      const value = ts.isStringLiteral(init) ? [init].filter((l) => hasWords(l.text)) : ts.isJsxExpression(init) && init.expression ? literals(init.expression) : []
      for (const l of value) at(l, `${node.name.getText(file)} ${l.getText(file)}`)
    } else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      for (const l of literals(node.expression)) at(l, `words ${l.getText(file)}`)
    } else if (ts.isPropertyAssignment(node) && DATA_KEY.test(node.name.getText(file))) {
      for (const l of literals(node.initializer)) at(l, `data ${node.name.getText(file)} ${l.getText(file)}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

describe('nothing around a view writes what a person sees or hears itself', () => {
  it('catches each way a component could write words: text, a name or title, a word in JSX, a word as data', () => {
    const source = `
      export const A = ({ full, maker }: { full: boolean; maker: string | null }) => (
        <dialog aria-label={\`\${'Tip'}, a view\`} data-view="v1" className="m-0">
          <p>Hello there</p>
          <iframe title="The view" sandbox="allow-scripts allow-forms" />
          {full ? 'Close' : 'Full screen'}
          <Screen host={{ data: { 'view.maker': maker ?? 'a mind', 'view.full': full, 'view.link': '' } }} />
        </dialog>
      )`
    expect(wordsWritten('a.tsx', source).map((f) => f.replace(/^\d+: /, ''))).toEqual([
      "aria-label `${'Tip'}, a view`", 'text Hello there', 'title "The view"', "words 'Close'", "words 'Full screen'", "data 'view.maker' 'a mind'",
    ])
  })

  it.each(FILES)('%s', (file) => {
    expect(wordsWritten(file, fs.readFileSync(new URL(`../../${file}`, import.meta.url).pathname, 'utf8'))).toEqual([])
  })

  it('reads every component the views feature has', () => {
    expect(FILES).toContain('features/views/ViewFrame.tsx')
    expect(FILES).toContain('features/views/MettaFrame.tsx')
    expect(FILES.length).toBeGreaterThan(6)
  })
})
