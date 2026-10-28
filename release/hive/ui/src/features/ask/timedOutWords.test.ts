import { describe, expect, it } from 'vitest'
import thread from './Thread.tsx?raw'
import words from './words.ts?raw'
import earlier from './Earlier.tsx?raw'

/**
 * ask-send-r1 (live walk, Platform-confirmed as host owner): the host's timed_out only means the turn's deadline passed
 * (hive/core/ask.py expire()); the mind may still spend or act. The page's words claim only what the host knows.
 */
describe('ask-send-r1: refusal words claim only what the host contract guarantees', () => {
  it('the thread draws a refusal through refusedSay, with the turn spend the host reported', () => {
    expect(thread).toMatch(/<span className="ask-row-text">\{refusedSay\(r\.reason, r\.spentUsd\)\}<\/span>/)
  })
  it('every "Nothing was done" kept in the refusal words cites the host code that guarantees it', () => {
    const lines = words.split('\n').filter((l) => /Nothing was done/.test(l) && /say:/.test(l))
    expect(lines.map((l) => l.trim().split(':')[0]).sort()).toEqual(['invalid', 'operation_conflict'])
    expect(words).toMatch(/operation_conflict and invalid are only ever HTTP refusals raised before anything is admitted \(hive\/core\/ask\.py/)
    expect(words).toMatch(/timed_out says only that the turn's deadline passed \(hive\/core\/ask\.py expire\(\)/)
  })
  it('Earlier reads the same words (no copy of its own that could still overclaim)', () => {
    expect(earlier).not.toMatch(/Nothing was done; you can ask again/)
  })
})
