// Purpose: validate the host's recipient-scoped spend alerts and control replies.

export interface SpendAlert {
  id: string
  scope: 'hive' | 'mind'
  agent_id: string | null
  name: string | null
  opened_at: string
  closed_at: string | null
  window_seconds: number
  spent_usd: number
  projected_usd: number | null
  limit_usd: number | null
  paused: boolean
  can_control: boolean
}

export type SpendControl = 'pause' | 'resume'

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim()
const timestamp = (v: unknown): v is string => text(v) && Number.isFinite(Date.parse(v))
const amount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

export function readSpendAlert(raw: unknown): SpendAlert {
  if (!record(raw) || !text(raw.id) ||
    !(raw.scope === 'hive' || raw.scope === 'mind') ||
    !(raw.agent_id === null || text(raw.agent_id)) || (raw.scope === 'hive') !== (raw.agent_id === null) ||
    !(raw.name === null || typeof raw.name === 'string') || !timestamp(raw.opened_at) ||
    !(raw.closed_at === null || timestamp(raw.closed_at)) ||
    !amount(raw.window_seconds) || !amount(raw.spent_usd) ||
    !(raw.projected_usd === null || amount(raw.projected_usd)) ||
    !(raw.limit_usd === null || amount(raw.limit_usd)) ||
    typeof raw.paused !== 'boolean' || typeof raw.can_control !== 'boolean') {
    throw new Error('The hive returned an invalid spend alert.')
  }
  return {
    id: raw.id, scope: raw.scope, agent_id: raw.agent_id, name: raw.name, opened_at: raw.opened_at,
    closed_at: raw.closed_at, window_seconds: raw.window_seconds, spent_usd: raw.spent_usd,
    projected_usd: raw.projected_usd, limit_usd: raw.limit_usd, paused: raw.paused, can_control: raw.can_control,
  }
}

export function readSpendAlerts(raw: unknown): SpendAlert[] {
  if (!record(raw) || !Array.isArray(raw.alerts)) throw new Error('The hive returned an invalid list of spend alerts.')
  const alerts = raw.alerts.map(readSpendAlert)
  if (new Set(alerts.map(({ id }) => id)).size !== alerts.length) throw new Error('The hive returned duplicate spend alerts.')
  return alerts
}
