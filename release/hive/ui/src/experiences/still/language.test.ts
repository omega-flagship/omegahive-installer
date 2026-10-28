import { describe, expect, it } from 'vitest'
import { shortId } from './ident'
import { decisionFacts, explainApproval } from './language'

const base = { id: 'ap_000000000001', agent_id: 'ag_7d1c0a11f3', skill: 'shell-confirm', risk: 'high' as const, reason: 'human-only' }

describe('decision detail: the exact request is always beside the prose', () => {
  it('two requests whose prose reads the same still show different exact requests', () => {
    const a = { ...base, command: '(shell-confirm "echo ready" "safe-scope")' }
    const b = { ...base, id: 'ap_000000000002', command: '(shell-confirm "echo ready" "different-scope")' }
    // the prose alone cannot tell them apart (Review's probe 3)
    expect(explainApproval(a)).toEqual(explainApproval(b))
    const fa = decisionFacts(a, { name: 'Mira' }, { id: 'sw_aaaa111111', name: 'Forge' }, shortId)
    const fb = decisionFacts(b, { name: 'Mira' }, { id: 'sw_aaaa111111', name: 'Forge' }, shortId)
    expect(fa.raw).toBe(a.command)
    expect(fb.raw).toBe(b.command)
    expect(fa).not.toEqual(fb)
  })

  it('a long command with a destructive suffix is carried whole, never shortened', () => {
    const long = `(shell-confirm "${'cd /srv/app && '.repeat(60)}rm -rf / --no-preserve-root")`
    const f = decisionFacts({ ...base, command: long }, { name: 'Mira' }, undefined, shortId)
    expect(f.raw).toBe(long)
    expect(f.raw.endsWith('rm -rf / --no-preserve-root")')).toBe(true)
  })

  it('scope names requester with id, swarm with id, skill, risk, rule and request id', () => {
    const f = decisionFacts({ ...base, command: '(x)' }, { name: 'Mira' }, { id: 'sw_aaaa111111', name: 'Forge' }, shortId)
    expect(Object.fromEntries(f.rows)).toEqual({
      'Asked by': 'Mira · #0a11f3',
      Swarm: 'Forge · #111111',
      Skill: 'shell-confirm',
      Risk: 'high',
      Rule: 'human-only',
      Request: '#000001',
    })
    const none = decisionFacts({ ...base, command: '(x)', reason: '' }, undefined, undefined, shortId)
    expect(Object.fromEntries(none.rows)).toMatchObject({ 'Asked by': 'Unknown mind · #0a11f3', Swarm: 'No swarm', Rule: 'none given' })
  })
})
