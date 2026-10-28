import { expect, it } from 'vitest'
import { commandArgs, liveRunStatus } from './commandArgs'
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
