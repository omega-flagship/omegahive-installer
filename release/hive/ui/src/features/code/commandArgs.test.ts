import { expect, it } from 'vitest'
import { commandArgs, commandText, liveRunStatus } from './commandArgs'
import fixture from './commandArgs.fixture.json'
it('matches native Python shlex argument grouping and errors on 116 reference cases', () => {
  for (const sample of fixture.cases) {
    if (sample.error) expect(() => commandArgs(sample.input), sample.input).toThrow()
    else expect(commandArgs(sample.input), sample.input).toEqual(sample.args)
  }
})
it('refuses empty executables, null bytes, overlong input and too many arguments', () => {
  for (const input of ['', '   ', '"" argument', 'p nul\0byte', 'p '+ 'x'.repeat(16384), 'p '+Array(100).fill('x').join(' ')]) expect(() => commandArgs(input)).toThrow()
  expect(commandArgs('p '+Array(99).fill('x').join(' '))).toHaveLength(100)
})
it('keeps all active lifecycle states active, including prepared and cancellation requested', () => {
  for (const status of ['prepared', 'starting', 'running', 'cancel_requested']) expect(liveRunStatus(status)).toBe(true)
  for (const status of ['cancelled', 'completed', 'failed', 'timed_out', 'lost']) expect(liveRunStatus(status)).toBe(false)
})

it('writes a command as Python shlex.join does, so it parses back to exactly that argv', () => {
  expect(commandText(['/venv/bin/python', 'check_app.py'])).toBe('/venv/bin/python check_app.py')
  expect(commandText(['a b', "it's", '', '$HOME', 'x*'])).toBe(`'a b' 'it'"'"'s' '' '$HOME' 'x*'`)
  for (const sample of fixture.cases) if (!sample.error && sample.args) expect(commandArgs(commandText(sample.args)), sample.input).toEqual(sample.args)
  // seeded random argv over the characters quoting has to handle: space, quotes, backslash, $, tab, newline, non-ASCII
  let seed = 20261111
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const alphabet = ['a', 'Z', '0', '_', '-', '.', '/', '=', ' ', "'", '"', '\\', '$', '*', '\t', '\n', 'é', '你', '#', ';', '|', '&', '(', '`']
  for (let n = 0; n < 500; n++) {
    const argv = Array.from({ length: 1 + Math.floor(next() * 5) }, (_, i) =>
      Array.from({ length: (i === 0 ? 1 : 0) + Math.floor(next() * 8) }, () => alphabet[Math.floor(next() * alphabet.length)]).join(''))
    if (!argv[0]) continue
    expect(commandArgs(commandText(argv)), JSON.stringify(argv)).toEqual(argv)
  }
})
