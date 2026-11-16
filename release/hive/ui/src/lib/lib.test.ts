import { describe, expect, it } from 'vitest'
import type { PolicyRule } from '../api/types'
import { cronError, describeCron, nextRun, parseCron, zonedToUtc } from './cron'
import { commandSkill, globMatch, resolvePolicy, skillRisk } from './policy'

describe('cron', () => {
  it('parses lists, ranges, steps and names', () => {
    const s = parseCron('*/15 9-17 * jan,jul mon-fri')
    expect([...s.minute]).toEqual([0, 15, 30, 45])
    expect(s.hour.size).toBe(9)
    expect([...s.month]).toEqual([1, 7])
    expect([...s.dow]).toEqual([1, 2, 3, 4, 5])
    expect([...parseCron('0 0 * * 7').dow]).toEqual([0])
  })

  it('reports readable errors', () => {
    expect(cronError('0 9 * *')).toMatch(/5 fields/)
    expect(cronError('61 9 * * *')).toMatch(/Minute must be 0–59/)
    expect(cronError('0 9 * * funday')).toMatch(/Unknown/)
    expect(cronError('0 9 * * 1-5')).toBeNull()
  })

  it('describes common schedules in plain words', () => {
    expect(describeCron('0 9 * * 1-5')).toBe('Weekdays at 09:00')
    expect(describeCron('30 18 * * *')).toBe('Every day at 18:30')
    expect(describeCron('*/15 * * * *')).toBe('Every 15 minutes')
    expect(describeCron('0 * * * *')).toBe('Every hour')
    expect(describeCron('0 */2 * * 1-5')).toBe('Every 2 hours on weekdays')
    expect(describeCron('0 10 * * 6,0')).toBe('Weekends at 10:00')
    expect(describeCron('0 17 * * 5')).toBe('Fridays at 17:00')
    expect(describeCron('0 8 * * 1,3,5')).toBe('Mon, Wed and Fri at 08:00')
    expect(describeCron('0 8 1 * *')).toBe('On the 1st of every month at 08:00')
    expect(describeCron('0 9,17 * * *')).toBe('Every day at 09:00 and 17:00')
    expect(describeCron('7 3-4/1 2 * 1')).toBeNull()
  })

  it('finds the next run in UTC and in another zone', () => {
    const from = Date.parse('2026-10-02T10:30:00Z') // a Friday
    expect(nextRun('0 9 * * 1-5', 'UTC', from)?.toISOString()).toBe('2026-10-05T09:00:00.000Z')
    expect(nextRun('*/15 * * * *', 'UTC', from)?.toISOString()).toBe('2026-10-02T10:45:00.000Z')
    // 09:00 in New York during EDT is 13:00 UTC
    expect(nextRun('0 9 * * *', 'America/New_York', from)?.toISOString()).toBe('2026-10-02T13:00:00.000Z')
    expect(nextRun('0 0 29 2 *', 'UTC', from)?.toISOString()).toBe('2028-02-29T00:00:00.000Z')
  })

  it('converts a wall-clock time in a zone to UTC', () => {
    expect(zonedToUtc('2026-10-05T09:00', 'Europe/Berlin')).toBe('2026-10-05T07:00:00.000Z')
    expect(zonedToUtc('2026-12-05T09:00', 'Europe/Berlin')).toBe('2026-12-05T08:00:00.000Z')
    expect(zonedToUtc('nope', 'UTC')).toBeNull()
  })
})

const rule = (p: Partial<PolicyRule>): PolicyRule => ({ id: 'r', scope: 'hive', skill: '*', mode: 'allow', note: '', created_at: '2026-01-01T00:00:00Z', ...p })

describe('policy', () => {
  it('matches globs', () => {
    expect(globMatch('shell*', 'shell-confirm')).toBe(true)
    expect(globMatch('*-commit', 'space-commit')).toBe(true)
    expect(globMatch('write-file', 'write-files')).toBe(false)
    expect(globMatch('a.b', 'axb')).toBe(false)
  })

  it('applies defaults, then the most specific scope', () => {
    const who = { agentId: 'a_1', swarmId: 's_1' }
    expect(resolvePolicy([], who, 'query')).toMatchObject({ mode: 'allow', source: 'default' })
    expect(resolvePolicy([], who, 'shell')).toMatchObject({ mode: 'ask', source: 'default' })
    expect(resolvePolicy([], who, 'brand-new-skill')).toMatchObject({ mode: 'ask', source: 'unlisted' })
    const rules = [
      rule({ id: 'h', scope: 'hive', skill: 'shell*', mode: 'deny' }),
      rule({ id: 's', scope: 'swarm:s_1', skill: 'shell*', mode: 'ask' }),
      rule({ id: 'a', scope: 'agent:a_1', skill: 'shell-confirm', mode: 'allow' }),
    ]
    expect(resolvePolicy(rules, who, 'shell-confirm')).toMatchObject({ mode: 'allow', source: 'agent' })
    expect(resolvePolicy(rules, who, 'shell')).toMatchObject({ mode: 'ask', source: 'swarm' })
    expect(resolvePolicy(rules, { agentId: 'a_2', swarmId: null }, 'shell')).toMatchObject({ mode: 'deny', source: 'hive' })
  })

  it('never lets a rule open a human-only skill', () => {
    const rules = [rule({ scope: 'agent:a_1', skill: '*', mode: 'allow' })]
    expect(resolvePolicy(rules, { agentId: 'a_1', swarmId: null }, 'transfer-funds')).toMatchObject({ mode: 'deny', source: 'human-only' })
    expect(resolvePolicy(rules, { agentId: 'a_1', swarmId: null }, 'payroll')).toMatchObject({ mode: 'deny' })
  })

  it('prefers the more literal glob within one scope', () => {
    const rules = [rule({ id: 'x', skill: '*', mode: 'deny' }), rule({ id: 'y', skill: 'metta', mode: 'allow' })]
    expect(resolvePolicy(rules, { agentId: 'a', swarmId: null }, 'metta').rule?.id).toBe('y')
  })

  it('reads the skill and risk from a command', () => {
    expect(commandSkill('(shell-confirm "ls /")')).toBe('shell-confirm')
    expect(skillRisk('shell')).toBe('high')
    expect(skillRisk('write-file')).toBe('medium')
    expect(skillRisk('query')).toBe('low')
  })
})

describe('gateway errors and leases', () => {
  it('maps last_error text to a gateway code', async () => {
    const { describeLlmError } = await import('./llmErrors')
    expect(describeLlmError('llm: 402 hive_budget_exhausted')?.code).toBe('hive_budget_exhausted')
    expect(describeLlmError('402 budget_exhausted: spent')?.code).toBe('budget_exhausted')
    expect(describeLlmError('{"error":{"code":"no_budget"}}')?.status).toBe(402)
    expect(describeLlmError('HTTP 429 Too Many Requests')?.code).toBe('rate_limited')
    expect(describeLlmError('unpriced_model')?.title).toMatch(/price/)
    expect(describeLlmError('upstream 529')).toMatchObject({ code: 'other', hint: 'upstream 529' })
    expect(describeLlmError(null)).toBeNull()
  })

  it('reads a goal lease', async () => {
    const { leaseOf, leaseText } = await import('./goals')
    const base = { status: 'claimed', lease_until: '2026-10-03T12:30:00Z' } as Parameters<typeof leaseOf>[0]
    const now = Date.parse('2026-10-03T12:00:00Z')
    expect(leaseOf(base, now)).toMatchObject({ kind: 'running', ms: 30 * 60_000 })
    expect(leaseOf(base, now + 31 * 60_000)).toEqual({ kind: 'lapsed' })
    expect(leaseOf({ ...base, status: 'waiting' }, now)).toEqual({ kind: 'paused' })
    expect(leaseOf({ ...base, status: 'open' }, now)).toBeNull()
    expect(leaseText(90 * 60_000)).toBe('1h 30m')
  })
})
