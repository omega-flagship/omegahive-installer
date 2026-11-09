import { AnimatePresence } from 'framer-motion'
import { useState } from 'react'
import type { RegisteredService } from '../../api/moneyWork'
import { bindTo, decisionFailure } from '../../lib/decisionGate'
import { ago } from '../../lib/format'
import { useMe } from '../../lib/useAdmin'
import { has, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { Button } from '../../ui/primitives'
import { ResourceView } from '../../ui/ResourceView'
import { boundRun, type ToastFn } from '../../lib/epochBound'
import type { Stale } from '../../lib/identityEpoch'
import type { HiveClient } from '../../api/client'
import type { DecisionResult } from '../../lib/decisionGate'

type Asking = { seen: RegisteredService; what: 'on' | 'off' | 'remove' }

/** One plain line for a service's last heartbeat. Pure. */
/** Removing a service or turning it on or off, bound to the identity it was pressed under (r5). */
export function serviceRun(d: { client: HiveClient | null; asking: { seen: Pick<RegisteredService, 'id' | 'name'>; what: 'on' | 'off' | 'remove' }; mutate: (fn: (l: RegisteredService[] | undefined) => RegisteredService[]) => void; toast: ToastFn }): () => Promise<DecisionResult | Stale> {
  const { asking } = d
  return boundRun(async (binding) => {
    const s = asking.seen
    try {
      if (asking.what === 'remove') {
        await need(d.client, 'removeService', 'Removing a service')(s.id)
        binding.commit(() => {
          d.mutate((l) => (l ?? []).filter((x) => x.id !== s.id))
          d.toast({ tone: 'success', title: `${s.name} removed`, body: 'Its access is revoked.' })
        })
      } else {
        const out = await need(d.client, 'setServiceEnabled', 'Turning a service on or off')(s.id, asking.what === 'on')
        binding.commit(() => {
          d.mutate((l) => (l ?? []).map((x) => (x.id === out.id ? out : x)))
          d.toast({ tone: 'success', title: `${s.name} is ${out.enabled ? 'on' : 'off'}` })
        })
      }
      return true
    } catch (e) {
      return decisionFailure(e)
    }
  })
}

export function seenWords(s: Pick<RegisteredService, 'last_seen_at'>, now = Date.now()): string {
  return s.last_seen_at ? `last heard from ${ago(s.last_seen_at, now)}` : 'never heard from'
}

/**
 * The hive's registered services (GET /api/services, enable, disable, DELETE; admins; Surface missing-UI batch 1,
 * audit item 8), such as the Code service. Turning one off refuses new capabilities for it; removing it deletes its
 * registration and revokes every capability it holds (services.py remove), so both are decided in full view.
 */
export function RegisteredServices() {
  const client = useHive((s) => s.client)
  const { admin, loaded } = useMe()
  // members never ask: the hive refuses them (admin()), and the section is not theirs to see
  if (!loaded || !admin || !has(client, 'registeredServices')) return null
  return <ServicesList />
}

function ServicesList() {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const res = useResource(() => need(client, 'registeredServices', 'Registered services')(), { poll: 30_000 })
  const [asking, setAsking] = useState<Asking | null>(null)
  if (res.status === 'unsupported') return null
  const live = (id: string) => res.data?.find((x) => x.id === id)
  return (
    <section className="rounded-2xl border border-line bg-tint/[0.02] p-4" aria-labelledby="services-h" data-registered-services>
      <h2 id="services-h" className="eyebrow pb-1">Registered services</h2>
      <p className="pb-3 text-[12.5px] text-ink-3">Separate programs the hive works with, such as the Code service. Off: the hive issues them no new access. Removed: their registration and every access they hold end.</p>
      <ResourceView res={res} errorTitle="Could not list services" empty={{ title: 'No services registered', body: 'A service appears here when it enrols with this hive.' }}>
        {(list) => (
          <ul className="divide-y divide-line">
            {list.map((s) => (
              <li key={s.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
                <div className="min-w-0 flex-1 text-[13px]">
                  <div className="text-ink">
                    {s.name} <span className="text-ink-4">· {s.version}</span>{' '}
                    <span className={s.enabled ? 'text-good' : 'text-warn'}>{s.enabled ? 'on' : 'off'}</span>
                  </div>
                  <div className="text-[12px] text-ink-3 [overflow-wrap:anywhere]">
                    {s.contract} · {s.address} · {seenWords(s)}
                  </div>
                  {s.surfaces.length > 0 && <div className="text-[12px] text-ink-4">Offers: {s.surfaces.join(', ')}</div>}
                </div>
                <div className="flex shrink-0 gap-2">
                  {has(client, 'setServiceEnabled') && (
                    <Button variant="subtle" onClick={() => setAsking({ seen: { ...s }, what: s.enabled ? 'off' : 'on' })}>
                      {s.enabled ? 'Turn off…' : 'Turn on…'}
                    </Button>
                  )}
                  {has(client, 'removeService') && (
                    <Button variant="ghost" className="text-bad" onClick={() => setAsking({ seen: { ...s }, what: 'remove' })}>
                      Remove…
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </ResourceView>
      <AnimatePresence>
        {asking && (
          <DecisionDialog
            icon={asking.what === 'remove' ? 'trash' : 'power'}
            eyebrow="Registered service"
            title={asking.what === 'remove' ? `Remove ${asking.seen.name}?` : `Turn ${asking.seen.name} ${asking.what}?`}
            facts={[
              ['Service', `${asking.seen.name} ${asking.seen.version} (${asking.seen.id})`],
              ['Address', asking.seen.address],
              ['Now', `${asking.seen.enabled ? 'on' : 'off'}, ${seenWords(asking.seen)}`],
              ['Effect', asking.what === 'remove' ? 'Its registration is deleted and every access it holds is revoked. It can enrol again later.' : asking.what === 'off' ? 'The hive issues it no new access until it is turned on again.' : 'The hive issues it access again.'],
            ]}
            bound={bindTo(asking.seen, live(asking.seen.id), ['id', 'enabled', 'version', 'address'])}
            thing="This service"
            onClose={() => setAsking(null)}
            actions={[
              {
                label: asking.what === 'remove' ? 'Remove it' : asking.what === 'off' ? 'Turn it off' : 'Turn it on',
                busyLabel: asking.what === 'remove' ? 'Removing' : 'Changing',
                tone: asking.what === 'on' ? 'primary' : 'danger',
                run: serviceRun({ client, asking, mutate: res.mutate, toast }),
              },
            ]}
          />
        )}
      </AnimatePresence>
    </section>
  )
}
