import { describe, expect, it } from 'vitest'
import { HARNESS_TITLE, joinSteps, TOKEN_PLACEHOLDER } from './joinSteps'

// An outside member connects with its token the way an invited agent joins with its code (the code becomes its token):
// a tester's member offered Start instead, which the hive refuses. INVENTED URL.
describe("an outside member's connect steps", () => {
  const url = 'http://127.0.0.1:8700/mcp'

  it('put its token where the join code goes, and call it a token', () => {
    for (const kind of Object.keys(HARNESS_TITLE) as (keyof typeof HARNESS_TITLE)[]) {
      const steps = joinSteps(kind, url, TOKEN_PLACEHOLDER, 'token')
      expect(steps.map((s) => s.text).join('\n')).toContain(`Bearer ${TOKEN_PLACEHOLDER}`)
      expect(steps.map((s) => s.label).join(' ')).not.toMatch(/\bcode\b/)
    }
    expect(joinSteps('codex', url, TOKEN_PLACEHOLDER, 'token')[0].label).toContain('The token sits in that file in plain text')
  })

  it("keep an invitation's steps about its join code", () => {
    expect(joinSteps('codex', url, 'ohv1_invented')[0].label).toContain('The code sits in that file in plain text')
  })

  it('offer every kind of outside agent the Connect page offers', () => {
    expect(Object.keys(HARNESS_TITLE).sort()).toEqual(['claude-code', 'codex', 'hermes', 'mcp'])
  })
})
