import { StreamLanguage, type StringStream } from '@codemirror/language'
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint'

/** Highlighting only: grounded-symbol interpretation belongs to the chosen runtime. */
export const mettaLanguage = StreamLanguage.define<{ string: boolean; escaped: boolean }>({
  name: 'metta', startState: () => ({ string: false, escaped: false }),
  token(stream: StringStream, state) {
    if (state.string) {
      while (!stream.eol()) {
        const c = stream.next()
        if (state.escaped) state.escaped = false
        else if (c === '\\') state.escaped = true
        else if (c === '"') { state.string = false; break }
      }
      return 'string'
    }
    if (stream.eatSpace()) return null
    const c = stream.next()
    if (c === ';') { stream.skipToEnd(); return 'comment' }
    if (c === '"') { state.string = true; state.escaped = false; return 'string' }
    if (c === '(' || c === ')') return 'paren'
    stream.eatWhile(/[^\s();]/)
    return c === '$' ? 'variableName' : /^[-+]?\d+(\.\d+)?$/.test(stream.current()) ? 'number' : c === '!' ? 'operator' : 'atom'
  },
  languageData: { commentTokens: { line: ';' }, closeBrackets: { brackets: ['(', '"'] } },
})

export function mettaDiagnostics(source: string): Diagnostic[] {
  const issues: Diagnostic[] = [], stack: number[] = []
  let mode: 'code' | 'comment' | 'string' = 'code', escaped = false, atom = false, stringStart = 0
  const report = (from: number, message: string) => { if (issues.length < 100) issues.push({ from, to: Math.min(source.length, from + 1), severity: 'warning', source: 'MeTTa delimiters', message }) }
  if (source.length > 1000000) { report(0, 'Delimiter scan skipped: source exceeds 1,000,000 UTF-16 units'); return issues }
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (mode === 'comment') { if (c === '\r' || c === '\n') { mode = 'code'; atom = false } }
    else if (mode === 'string') {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') { mode = 'code'; atom = false }
    } else if (c === ';') { mode = 'comment'; atom = false }
    else if (/\s/.test(c)) atom = false
    else if (c === '"' && !atom) { mode = 'string'; stringStart = i }
    else if (c === '(') {
      if (stack.length >= 4096) { report(i, 'Delimiter scan stopped: nesting exceeds 4,096'); return issues }
      stack.push(i); atom = false
    } else if (c === ')') { if (stack.length) stack.pop(); else report(i, 'Closing parenthesis has no opening parenthesis'); atom = false }
    else atom = true
  }
  if (mode === 'string') report(stringStart, 'Quoted string has no closing quote')
  for (const start of stack) report(start, 'Opening parenthesis has no closing parenthesis')
  return issues
}

export const mettaSupport = () => [mettaLanguage, lintGutter(), linter((view) => mettaDiagnostics(view.state.doc.toString()), { delay: 200 })]
