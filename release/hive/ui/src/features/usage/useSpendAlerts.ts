// Purpose: keep the current viewer's spend alerts fresh and submit explicit controls.
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { SpendAlert, SpendControl } from '../../api/spendAlerts'
import type { HiveEvent } from '../../api/types'
import { bindEpoch } from '../../lib/identityEpoch'
import { errorMessage, has, need, useResource } from '../../lib/useResource'
import { hiveBus, storeIdentity, useHive } from '../../store/store'

interface ControlState {
  identity: string
  pending: string | null
  error?: string
}

function allows(alert: SpendAlert, action: SpendControl): boolean {
  return alert.can_control && (action === 'resume' ? alert.paused : !alert.paused && alert.closed_at === null)
}

// One resource serves both surfaces. useResource also rereads after LiveClient detects a subscription gap.
export function useSpendAlerts(enabled: boolean) {
  const client = useHive((s) => s.client)
  const identity = useHive(storeIdentity)
  const [invalidation, invalidate] = useState(0)
  const [control, setControl] = useState<ControlState>()
  const running = useRef<ControlState | null>(null)
  const resource = useResource(
    () => enabled ? need(client, 'spendAlerts', 'Spend alerts')() : Promise.resolve([]),
    { context: [identity, enabled], key: invalidation },
  )
  const action = enabled && control?.identity === identity ? control : undefined
  const alerts = enabled && resource.error === undefined ? resource.data ?? [] : []
  const hasControl = enabled && has(client, 'controlSpendAlert')

  // The hint never supplies what we display. A changed or removed mind can also invalidate its current owner view.
  const hear = useEffectEvent((event: HiveEvent) => {
    if (event.type === 'spend.alert' ||
      (event.type === 'agent.updated' && resource.data?.some((alert) => alert.agent_id === event.agent.id)) ||
      (event.type === 'agent.deleted' && resource.data?.some((alert) => alert.agent_id === event.agent_id))) {
      invalidate((n) => n + 1)
    }
  })
  useEffect(() => {
    if (enabled && has(client, 'spendAlerts')) return hiveBus.on((event) => hear(event))
  }, [client, enabled])

  async function change(id: string, choice: SpendControl) {
    const state = useHive.getState()
    if (!hasControl || state.client !== client || state.connection === 'unauthorized' ||
      storeIdentity(state) !== identity || resource.refreshing || running.current?.identity === identity) return
    const alert = alerts.find((item) => item.id === id)
    if (!alert || !allows(alert, choice)) return
    const binding = bindEpoch()
    const write = { identity, pending: id }
    running.current = write
    setControl(write)
    let error: string | undefined
    try {
      await need(client, 'controlSpendAlert', 'Spend control')(id, choice)
    } catch (failure: unknown) {
      error = `Could not confirm the change to paid calls. ${errorMessage(failure)}`
    } finally {
      if (running.current === write) running.current = null
      binding.commit(() => {
        resource.reload()
        setControl({ identity, pending: null, error })
      })
    }
  }

  return {
    status: resource.error !== undefined && resource.status !== 'unsupported' ? 'error' as const : resource.status,
    readError: resource.error,
    refreshing: resource.refreshing,
    reload: resource.reload,
    alerts,
    canControl: hasControl,
    pending: action?.pending ?? null,
    actionError: action?.error,
    change,
  }
}

export type SpendAlertsView = ReturnType<typeof useSpendAlerts>
