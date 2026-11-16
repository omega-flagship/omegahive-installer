import { describe, expect, it } from 'vitest'
import { matchFiles, namedFunctions } from './fileMatch'

const tree = ['calculator.py', 'tests/test_calculator.py', 'README.md', 'utils/strings.py', 'app/main.py']

describe('matchFiles: the file a request names', () => {
  it('a word that is the file’s name', () => {
    expect(matchFiles('Fix add() in the calculator', tree)).toEqual(['calculator.py'])
    expect(matchFiles('tidy up strings', tree)).toEqual(['utils/strings.py'])
  })
  it('a short file name the words lengthen ("calc.py" for "calculator")', () => {
    expect(matchFiles('Fix add() in the calculator', ['calc.py', 'main.py'])).toEqual(['calc.py'])
  })
  it('the test file only when tests are asked about', () => {
    expect(matchFiles('add a test for the calculator', tree)).toEqual(['tests/test_calculator.py'])
    expect(matchFiles('the calculator is wrong', ['calculator.py', 'test_calculator.py'])).toEqual(['calculator.py'])
  })
  it('a function name: a file named for it, or (when loaded) one whose text defines it', () => {
    expect(matchFiles('make add() work', ['add.py', 'sub.py'])).toEqual(['add.py'])
    expect(matchFiles('make add() work', ['ops.py', 'misc.py'], { 'ops.py': 'def add(a, b):\n    return a - b\n', 'misc.py': 'x = add_more()' })).toEqual(['ops.py'])
    expect(matchFiles('fix total()', ['a.js', 'b.js'], { 'b.js': 'export function total(xs) {}' })).toEqual(['b.js'])
  })
  it('the exact file name wins', () => {
    expect(matchFiles('in main.py, rename run', tree)).toEqual(['app/main.py'])
  })
  it('none, or several, when the words don’t settle it', () => {
    expect(matchFiles('make it faster', tree)).toEqual([])
    expect(matchFiles('fix the parser', ['parser/a.py', 'parser_b.py', 'lexer.py'])).toEqual(['parser_b.py'])
    expect(matchFiles('fix helpers', ['a/helpers.py', 'b/helpers.py'])).toEqual(['a/helpers.py', 'b/helpers.py'])
    expect(matchFiles('anything', [])).toEqual([])
  })
  it('namedFunctions', () => {
    expect(namedFunctions('Fix add() and sub(x) in calc')).toEqual(['add', 'sub'])
    expect(namedFunctions('no calls here')).toEqual([])
  })
})
