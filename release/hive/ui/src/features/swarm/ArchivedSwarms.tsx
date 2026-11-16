import { AnimatePresence } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'
import type { Swarm } from '../../api/types'
import { bindTo, decisionFailure } from '../../lib/decisionGate'
import { shown } from '../../lib/displayName'
import { hsl } from '../../lib/color'
import { ago } from '../../lib/format'
import { readContext, taggedFor, type Tagged } from '../../lib/readContext'
import { useMe } from '../../lib/useAdmin'
import { errorMessage, has, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { Button } from '../../ui/primitives'
import { archivedList } from './swarmEdit'
import { learnArchived, openSwarmDelete } from './deleteRequest'

/**
 * Swarms index: archived swarms, so Restore is reachable after a reload (the hive leaves them out of the normal list).
 * Admins only: the hive refuses everyone else, and archive and restore are admin decisions.
 */
export function ArchivedSwarms() {
  const client = useHive((s) => s.client)
  const swarms = useHive((s) => s.swarms)
  const { me, admin } = useMe()
  // Surface K1: the list belongs to this client, this principal and their admin standing; another one never sees it
  const res = useResource(() => (admin ? need(client, 'listSwarms', 'Archived swarms')({ archived: true }) : Promise.resolve([] as Swarm[])), { context: [me?.principal, admin], isEmpty: () => false })
  const list = useMemo(() => archivedList(res.data, swarms), [res.data, swarms])
  // the Ask can name these too ("delete the Forge swarm": finishing a delete that left cleanup pending)
  useEffect(() => {
    if (res.data && admin) learnArchived(res.data)
  }, [res.data, admin])
  const canDelete = has(client, 'deleteSwarmWithMinds') && has(client, 'deleteSwarmPreview')
  const ctx = readContext(client, me?.principal, admin)
  // a Restore opened under one identity is not carried over to another
  const [opened, setRestoring] = useState<Tagged<Swarm> | null>(null)
  const restoring = taggedFor(opened, ctx)
  const toast = useHive((s) => s.toast)
  if (!admin || !has(client, 'restoreSwarm')) return null
  if (res.status === 'loading' || (res.status !== 'error' && list.length === 0)) return null
  return (
    <section className="mt-8" aria-labelledby="archived-h" data-tour="archived-swarms">
      <h2 id="archived-h" className="eyebrow mb-1 px-1">
        Archived · {list.length}
      </h2>
      <p className="mb-3 px-1 text-[12.5px] text-ink-3">Put away with their history. Nothing starts, joins or is asked of them until they are restored.</p>
      {res.status === 'error' && (
        <p className="px-1 text-[13px] text-bad">
          Could not list archived swarms: {errorMessage(res.error)}{' '}
          <button className="underline" onClick={res.reload}>
            Try again
          </button>
        </p>
      )}
      <ul className="overflow-hidden rounded-2xl border border-line bg-tint/[0.02]">
        {list.map((s, i) => (
          <li key={s.id} className={i ? 'flex flex-wrap items-center gap-3 border-t border-line px-3 py-2.5' : 'flex flex-wrap items-center gap-3 px-3 py-2.5'}>
            <span className="size-3 shrink-0 rounded-full opacity-60" style={{ background: hsl(s.hue, 70, 60) }} aria-hidden="true" />
            <div className="min-w-0 flex-1 text-[13px]">
              <div className="text-ink-2">{shown(s.name)}</div>
              <div className="truncate text-meta text-ink-4">
                archived {s.archived_at ? ago(s.archived_at) : ''}
                {s.archived_by ? ` by ${s.archived_by}` : ''} · {s.member_ids.length} mind{s.member_ids.length === 1 ? '' : 's'}
              </div>
            </div>
            <Button variant="subtle" className="min-h-9 px-3 text-[12.5px]" onClick={() => setRestoring({ ctx, value: { ...s } })}>
              Restore…
            </Button>
            {canDelete && (
              <Button variant="danger" className="min-h-9 px-3 text-[12.5px]" onClick={() => openSwarmDelete(s.id, { name: s.name })} aria-label={`Delete ${shown(s.name)}…`}>
                Delete…
              </Button>
            )}
          </li>
        ))}
      </ul>
      <AnimatePresence>
        {restoring && (
          <DecisionDialog
            icon="replay"
            eyebrow="Restore a swarm"
            title={`Bring ${shown(restoring.name)} back?`}
            facts={[
              ['Swarm', `${shown(restoring.name)} (${restoring.id})`],
              ['Purpose', restoring.description || 'none given'],
              ['Archived', restoring.archived_at ? `${new Date(restoring.archived_at).toLocaleString()} (${ago(restoring.archived_at)})${restoring.archived_by ? ` by ${restoring.archived_by}` : ''}` : 'unknown'],
              ['Minds', String(restoring.member_ids.length)],
            ]}
            bound={bindTo(restoring, list.find((x) => x.id === restoring.id), ['id', 'archived_at', 'member_ids'])}
            thing="This swarm"
            onClose={() => setRestoring(null)}
            actions={[
              {
                label: 'Restore swarm',
                busyLabel: 'Restoring',
                tone: 'primary',
                run: async () => {
                  try {
                    const back = await need(client, 'restoreSwarm', 'Restoring')(restoring.id)
                    // the hive also announces it (swarm.updated); put it in the store now so it leaves this list at once,
                    // unless the store has moved to another client meanwhile (that client's swarms are not this one's)
                    if (useHive.getState().client === client) useHive.setState((st) => ({ swarms: { ...st.swarms, [back.id]: back } }))
                    toast({ tone: 'success', title: `${shown(restoring.name)} is back` })
                    return true
                  } catch (e) {
                    return decisionFailure(e)
                  }
                },
              },
            ]}
          >
            <p className="text-[13px] leading-relaxed text-ink-2">It returns to the swarm list with everything it had: minds, tasks, beliefs and history. Its minds stay asleep until someone wakes them.</p>
          </DecisionDialog>
        )}
      </AnimatePresence>
    </section>
  )
}
