import { describe, expect, it } from 'vitest'
import { LEASE_HINT, leaseStep, missingSkills } from './steps'

const base = { coordinator: 'a_purple', delegated: ['a_red'], member: 'a_red', openTasks: 1, task: 'g_1' }

describe('lifecycle setup steps', () => {
  it('walks the person through the steps in order and never skips one', () => {
    expect(leaseStep({ ...base, coordinator: '' })).toBe('needs-coordinator')
    expect(leaseStep({ ...base, delegated: [] })).toBe('needs-delegation')
    expect(leaseStep({ ...base, member: '' })).toBe('needs-member')
    expect(leaseStep({ ...base, openTasks: 0, task: '' })).toBe('needs-task')
    expect(leaseStep({ ...base, task: '' })).toBe('needs-task')
    expect(leaseStep(base)).toBe('ready')
  })

  it('says what each blocked step needs', () => {
    expect(LEASE_HINT['needs-delegation']).toContain('apply the delegation')
    expect(LEASE_HINT['needs-task']).toContain('create one')
  })

  it('shows no skills as missing before a coordinator is chosen (nothing looks pending)', () => {
    expect(missingSkills('', ['hive-goals'], () => false)).toEqual([])
    expect(missingSkills('a_purple', ['hive-goals', 'hive-goal-get'], (s) => s === 'hive-goals')).toEqual(['hive-goal-get'])
  })
})
