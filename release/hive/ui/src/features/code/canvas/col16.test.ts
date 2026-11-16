import { describe, expect, it } from 'vitest'
import { validate, type DocShape } from './codePresence'

// r2, Kimi FIX-FIRST 4: columns are UTF-16 code units, named so, checked against UTF-16 line lengths
const WAVE = '    return "Goodbye, " + name + " 👋"'
const docText = (text: string): DocShape => {
  const rows = text.split('\n')
  return { lines: rows.length, lineText: (n) => rows[n - 1] ?? '' }
}
const G = docText(`def farewell(name):\n${WAVE}\n`)

describe('code presence columns are UTF-16 code units (col16)', () => {
  it('takes col16, never a bare col, and no unknown fields', () => {
    expect(validate(G, { op: 'caret', line: 2, col16: 4 })).toEqual({ op: 'caret', line: 2, col16: 4 })
    expect(validate(G, { op: 'caret', line: 2, col: 4 })).toBeNull()
    expect(validate(G, { op: 'select', from: { line: 1, col: 0 }, to: { line: 2, col: 3 } })).toBeNull()
    expect(validate(G, { op: 'caret', line: 2, col16: 4, extra: 1 })).toBeNull()
  })
  it('measures the emoji line in UTF-16: the end is accepted, the middle of the pair is refused, past the end clamps', () => {
    const end = WAVE.length // 👋 counts 2 here; it is 4 bytes in UTF-8
    const wave = WAVE.indexOf('👋')
    expect(new TextEncoder().encode(WAVE).length).toBe(end + 2)
    expect(validate(G, { op: 'caret', line: 2, col16: end })).toEqual({ op: 'caret', line: 2, col16: end })
    expect(validate(G, { op: 'caret', line: 2, col16: wave + 1 })).toBeNull() // between the two halves of 👋
    expect(validate(G, { op: 'caret', line: 2, col16: end + 2 })).toEqual({ op: 'caret', line: 2, col16: end }) // a byte column past the end
    expect(validate(G, { op: 'caret', line: 2, col16: wave })).toEqual({ op: 'caret', line: 2, col16: wave })
    expect(validate(G, { op: 'caret', line: 2, col16: wave + 2 })).toEqual({ op: 'caret', line: 2, col16: wave + 2 })
    expect(validate(G, { op: 'select', from: { line: 2, col16: wave + 1 }, to: { line: 2, col16: end } })).toBeNull()
  })
})
