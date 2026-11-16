export const boardColumns = [
  { id: 'open', label: 'Open' },
  { id: 'claimed', label: 'In progress' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'submitted', label: 'Awaiting review' },
  { id: 'done', label: 'Done' },
  { id: 'failed', label: 'Failed or cancelled' },
  { id: 'other', label: 'Other' },
] as const

type Column = typeof boardColumns[number]['id']
export function columnForStatus(status: string): Column {
  if (status === 'stalled') return 'waiting'
  if (status === 'cancelled') return 'failed'
  if (['open', 'claimed', 'waiting', 'submitted', 'done', 'failed'].includes(status)) return status as Column
  return 'other'
}
