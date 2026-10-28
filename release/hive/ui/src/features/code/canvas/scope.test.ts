import { describe, expect, it } from 'vitest'
import { scopeWords } from './vibe'

// r2, Kimi FIX-FIRST 3: the confirm prints the scope the person authorised
describe('the authorised scope, in words', () => {
  it('says the whole file, or the lines', () => {
    expect(scopeWords({ path: 'src/greeting.py', lines: null })).toBe('Whole file: src/greeting.py')
    expect(scopeWords({ path: 'src/greeting.py', lines: { first: 28, last: 36 } })).toBe('Lines 28–36 of src/greeting.py')
    expect(scopeWords({ path: 'a.py', lines: { first: 4, last: 4 } })).toBe('Line 4 of a.py')
  })
})
