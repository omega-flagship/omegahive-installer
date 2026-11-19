// Purpose: describe the person's durable stopped-task receipts.
export interface TaskStop {
  id: string
  goal_id: string
  mind_id: string | null
  title: string
  status: 'failed' | 'stalled'
  reason: string
  stopped_at: string
}
