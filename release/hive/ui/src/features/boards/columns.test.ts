import { describe, expect, it } from 'vitest'
import { boardColumns, columnForStatus } from './columns'

describe('canonical task state visibility', () => {
  it('keeps submission distinct from completion and waiting', () => {
    expect(columnForStatus('submitted')).toBe('submitted')
    expect(boardColumns.find(c => c.id === 'submitted')?.label).toBe('Awaiting review')
    expect(columnForStatus('done')).toBe('done')
    expect(columnForStatus('waiting')).toBe('waiting')
  })
  it('shows every host state exactly once, including future states', () => {
    for (const status of ['open', 'claimed', 'waiting', 'stalled', 'submitted', 'done', 'failed', 'cancelled', 'future-host-state', '']) {
      expect(boardColumns.filter(c => columnForStatus(status) === c.id)).toHaveLength(1)
    }
    expect(columnForStatus('future-host-state')).toBe('other')
  })
})
