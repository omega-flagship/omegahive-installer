// Purpose: draw the MeTTa-composed spend alert in the shared notice lane.
import type { SpendAlert } from '../../api/spendAlerts'
import { navigate } from '../../lib/router'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { noticeFacts } from './spendAlertDisplay'

export function SpendAlertNotice({ alerts, onUsage, look }: { alerts: readonly SpendAlert[]; onUsage: boolean; look: string }) {
  const compose = useCompose(look)
  const plan = compose('spend-alert-notice', noticeFacts(alerts, onUsage))
  return plan.parts.length > 0 && (
    <Screen plan={plan} className="xc-frame glass-strong pointer-events-auto shrink-0 rounded-xl border border-warn/40 px-2 pt-1"
      host={{
        data: {},
        onAction: (action) => { if (action === 'view-spend-alerts') navigate({ name: 'usage' }) },
      }} />
  )
}
