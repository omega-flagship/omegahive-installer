import { shown } from '../../lib/displayName'
import { currentEpoch } from '../../lib/identityEpoch'
import { readContext } from '../../lib/readContext'
import { navigate } from '../../lib/router'
import { refusedBack } from './refusedBack'
import { need, UnsupportedError, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { Button, EmptyState } from '../../ui/primitives'

/** An app refused this swarm. Never a dead end: offer the swarms the app actually works in (its declared homes),
 *  so a viewer is never stranded by a stale or wrong default (Atlas lockout, 2026-10-05). Back works with no onExit
 *  too (Kimi town-r3 #4): back through history where this page was reached in the hive, otherwise Home. */
export function RefusedHere({ programId, swarmId, programName, message, onExit }: {
  programId: string; swarmId: string; programName: string; message: string; onExit?: () => void
}) {
  const back = refusedBack(onExit)
  const client = useHive((s) => s.client)
  const session = useHive((s) => s.session)
  const inits = useHive((s) => s.inits)
  const swarms = useHive((s) => s.swarms)
  const ctx = readContext(client, session, inits, currentEpoch(), programId, swarmId)
  const originCurrent = () => {
    const live = useHive.getState()
    return readContext(live.client, live.session, live.inits, currentEpoch(), programId, swarmId) === ctx
  }
  // Native resource binding hides an earlier answer immediately and suppresses late publication on rebind/unmount.
  const { data } = useResource(async () => {
    if (!originCurrent()) throw new UnsupportedError('App homes under this earlier connection')
    const reply = await need(client, 'programHomes', 'App homes')(programId)
    // The server decides the visible IDs. Mapping failures stay inside the native resource's error handling.
    return reply.program === programId ? reply.homes.map((h) => h.swarm_id).filter((id) => id !== swarmId) : []
  }, { context: ctx })
  const elsewhere = data ?? []
  return (
    <EmptyState
      icon="shield"
      title={`${shown(programName)} isn't open in ${shown(swarms[swarmId]?.name ?? 'this swarm')}`}
      body={elsewhere.length
        ? `${message}. It works in ${elsewhere.length === 1 ? 'this swarm' : 'these swarms'}:`
        : `${message}. The app's owner decides which swarms may open it.`}
      action={
        <div className="flex flex-wrap justify-center gap-2" data-program-home-context={ctx}>
          {elsewhere.map((id) => (
            <Button key={id} variant="primary" onClick={(event) => {
              const panel = event.currentTarget.closest('[data-program-home-context]')
              if (!originCurrent() || !panel?.isConnected || panel.getAttribute('data-program-home-context') !== ctx) return
              navigate({ name: 'program', id: programId, swarm: id })
            }}>
              Open in {shown(swarms[id]?.name ?? id)}
            </Button>
          ))}
          <Button onClick={back}>Back</Button>
        </div>
      }
    />
  )
}
