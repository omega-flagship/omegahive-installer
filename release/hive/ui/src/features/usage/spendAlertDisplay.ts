// Purpose: provide numeric values and current alert facts to the MeTTa screen plans.
import type { SpendAlert } from '../../api/spendAlerts'
import { errorMessage } from '../../lib/useResource'
import type { Compose, ScreenFacts } from '../../screens/screenSpace'
import { exactUsd } from './settle'
import type { SpendAlertsView } from './useSpendAlerts'

const durationUnits = [[86_400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']] as const
const at = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function duration(seconds: number): string {
  const [scale, unit] = durationUnits.find(([size]) => seconds >= size) ?? durationUnits[3]
  return new Intl.NumberFormat(undefined, { style: 'unit', unit, unitDisplay: 'long', maximumFractionDigits: 1 }).format(seconds / scale)
}

export function noticeFacts(alerts: readonly SpendAlert[], onUsage: boolean): ScreenFacts {
  return {
    counts: { 'alerts.open': alerts.filter((alert) => alert.closed_at === null).length },
    flags: { 'alerts.on-usage': onUsage },
  }
}

// Time: one composition per alert and one linear pass over the alerts. Space: one plan and data record per alert.
export function usageAlertFacts(view: SpendAlertsView, compose: Compose) {
  const rows = view.alerts.map((alert) => {
    const control = view.canControl && alert.can_control
    const open = alert.closed_at === null
    const pending = view.pending === alert.id
    return {
      id: alert.id,
      control: control && (open || alert.paused),
      busy: view.pending !== null,
      plan: compose('spend-alert-detail', { flags: {
        'alert.open': open,
        'alert.projection': open && alert.projected_usd !== null && alert.limit_usd !== null,
        'alert.paused': alert.paused,
        'alert.hive': alert.scope === 'hive',
        'alert.control': control,
        'alert.writing': pending,
      } }),
      data: {
        'alert.name': alert.name?.trim() || alert.agent_id || 'Hive',
        'alert.spend': exactUsd(alert.spent_usd),
        'alert.window': duration(alert.window_seconds),
        'alert.opened': at.format(new Date(alert.opened_at)),
        'alert.closed': alert.closed_at === null ? '' : at.format(new Date(alert.closed_at)),
        'alert.projected': alert.projected_usd === null ? '' : exactUsd(alert.projected_usd),
        'alert.limit': alert.limit_usd === null ? '' : exactUsd(alert.limit_usd),
      },
    }
  })
  return {
    facts: {
      counts: { 'alerts.controls': rows.filter((row) => row.control).length },
      values: { 'alerts.read': view.status },
      flags: { 'alerts.available': view.status !== 'unsupported', 'alerts.action-failed': Boolean(view.actionError) },
    },
    data: {
      'alerts.rows': rows,
      'alerts.error': view.readError === undefined ? '' : errorMessage(view.readError),
      'alerts.action-error': view.actionError ?? '',
    },
  }
}
