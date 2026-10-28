import { useMemo } from 'react'
import { useHive } from '../../store/store'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { Orb } from '../../ui/primitives'
import { shown } from '../../lib/displayName'

/** The global kill switch: POST /api/hive/stop-all behind a typed confirmation. */
export default function StopAll() {
  const agents = useHive((s) => s.agents)
  const setOpen = useHive((s) => s.setStopAll)
  const stopAll = useHive((s) => s.stopAll)
  const toast = useHive((s) => s.toast)
  const running = useMemo(() => Object.values(agents).filter((a) => a.status !== 'stopped'), [agents])
  return (
    <ConfirmDialog
      title="Stop every mind?"
      icon="power"
      phrase="stop all"
      tour="stop-all-dialog"
      confirmLabel={running.length ? `Stop ${running.length} mind${running.length === 1 ? '' : 's'}` : 'Stop all'}
      onClose={() => setOpen(false)}
      onConfirm={async () => {
        const n = await stopAll()
        if (n === null) return false
        toast({ tone: 'success', title: n ? `Stopped ${n} mind${n === 1 ? '' : 's'}` : 'Nothing was running', body: n ? 'Each one is set to stay stopped. Start them again from their panels.' : undefined, ttl: 6000 })
      }}
      body={
        <>
          <p>The kill switch stops every agent in the hive and sets its desired state to stopped. Nothing restarts on its own, not even wakeups.</p>
          {running.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1" aria-label={`${running.length} running`}>
              {running.slice(0, 18).map((a) => (
                <span key={a.id} title={shown(a.name)}>
                  <Orb hue={a.hue} status={a.status} size={18} />
                </span>
              ))}
              {running.length > 18 && <span className="ml-1 text-[11px] text-ink-4">+{running.length - 18}</span>}
            </div>
          )}
        </>
      }
    />
  )
}
