import { describe, expect, it } from 'vitest'
import type { LabCase, LabMetric } from '../../api/types'
import { findMetric } from './labUtil'

/**
 * host-wording r1: the host renamed "subgoals accepted" to "subtasks accepted" and serves old and new runs under the new
 * name, with the old one in `legacy_names` (and `renamed_from` on an old record). The Drift view still asks for the old
 * name, so a lookup by a former name must find the one measure. INVENTED data.
 */
const m = (name: string, extra: Partial<LabMetric> = {}): LabMetric => ({ name, value: 12, unit: '', better: 'equal', target: 12, ok: true, ...extra })
const kase = (metrics: LabMetric[]): LabCase => ({ run_id: 'r', id: 'bench-drift::subgoal_explosion', name: 'Subtask explosion', group: 'tasks', dimension: 'drift', status: 'passed', duration_ms: 1, message: null, notes: null, metrics, series: [] })

describe('findMetric by a former name', () => {
  it('finds a new-run measure through legacy_names, and an old record served renamed through renamed_from', () => {
    expect(findMetric(kase([m('subtasks accepted', { legacy_names: ['subgoals accepted'] })]), 'subgoals accepted')?.name).toBe('subtasks accepted')
    expect(findMetric(kase([m('subtasks accepted', { renamed_from: 'subgoals accepted' })]), 'subgoals accepted')?.name).toBe('subtasks accepted')
  })
  it('an exact name always wins, and an unknown name finds nothing', () => {
    const c = kase([m('subtasks accepted', { legacy_names: ['depth reached'] }), m('depth reached', { value: 3 })])
    expect(findMetric(c, 'depth reached')?.value).toBe(3)
    expect(findMetric(c, 'nothing like it')).toBeUndefined()
  })
})
