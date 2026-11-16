import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { mettaDiagnostics, mettaLanguage } from './metta'

describe('non-evaluating MeTTa authoring', () => {
  it('ignores delimiters in escaped strings and comments, including multiline strings', () => {
    for (const source of ['(= (add $x $y) (+ $x $y))\n!(add 2 3)', '(text "(;) \\"quoted\\"") ; ))\n', '(a symbol"inside #symbol)', '(a "multi\nline")']) expect(mettaDiagnostics(source)).toEqual([])
  })
  it('uses CodeMirror UTF-16 locations after astral characters', () => {
    const issues = mettaDiagnostics('; ignore )\n😀 ) ("unfinished')
    expect(issues.map((d) => d.from)).toEqual([14, 17, 16])
    expect(issues.map((d) => d.message)).toEqual(['Closing parenthesis has no opening parenthesis', 'Quoted string has no closing quote', 'Opening parenthesis has no closing parenthesis'])
  })
  it('bounds malformed nesting, input length and issue counts', () => {
    expect(mettaDiagnostics(')'.repeat(1000))).toHaveLength(100)
    expect(mettaDiagnostics('('.repeat(4097)).at(-1)?.message).toContain('nesting exceeds')
    expect(mettaDiagnostics('a'.repeat(1000001))[0].message).toContain('scan skipped')
  })
  it('provides actual CodeMirror string, variable and comment token nodes', () => {
    const state = EditorState.create({ doc: '(= (hello $name) "Hello") ; comment', extensions: [mettaLanguage] })
    const names: string[] = []
    syntaxTree(state).iterate({ enter: (node) => { names.push(node.name) } })
    expect(names).toEqual(expect.arrayContaining(['string', 'variableName', 'comment']))
  })
})
