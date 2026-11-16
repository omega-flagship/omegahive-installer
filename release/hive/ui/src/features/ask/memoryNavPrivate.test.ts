import { describe, expect, it } from 'vitest'
import { editProblemWords } from './memoryNav'

/**
 * Kimi town-r3 #2: an edit refused for naming a private app says what counted (the words named one) without naming any,
 * so the person knows what to change. Never a private app's name (privateNames.test.ts's rule).
 */
describe('the private-app edit notice', () => {
  it('says the words named a private app, and names none', () => {
    const w = editProblemWords('private')
    expect(w).toMatch(/words name a private app/i)
    expect(w).toMatch(/Cancel/)
    expect(w).not.toMatch(/atlas|omega ?truth|\btruth\b/i)
  })
})
