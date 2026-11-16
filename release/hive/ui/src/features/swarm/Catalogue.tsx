import { useState } from 'react'
import type { CatalogueOffer } from '../../api/missingUi'
import type { Swarm } from '../../api/types'
import { shown } from '../../lib/displayName'
import { ago } from '../../lib/format'
import { useMe } from '../../lib/useAdmin'
import { has, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { Button } from '../../ui/primitives'
import { ResourceView } from '../../ui/ResourceView'

const SOURCE: Record<string, string> = { service: 'offered service', 'role.media': 'role (media)', 'role.mandate': 'role (mandate)', 'program.action': 'app action' }
const UNKNOWN: Record<string, string> = {
  'skills-not-projected': 'minds’ skills are not listed yet',
  'code-not-projected': 'code abilities are not listed yet',
  'performance-evidence-not-derived': 'nothing here says how well they do it',
  'semantic-witnesses-unavailable': 'no worked examples back these entries',
}

/** Offers grouped by who provides them (swarm, mind or app), providers in name order. Pure. */
export function groupOffers(offers: CatalogueOffer[], name: (p: CatalogueOffer['provider']) => string): { provider: CatalogueOffer['provider']; label: string; offers: CatalogueOffer[] }[] {
  const by = new Map<string, { provider: CatalogueOffer['provider']; label: string; offers: CatalogueOffer[] }>()
  for (const o of offers) {
    const k = `${o.provider.kind}:${o.provider.id}`
    if (!by.has(k)) by.set(k, { provider: o.provider, label: name(o.provider), offers: [] })
    by.get(k)!.offers.push(o)
  }
  return [...by.values()].sort((a, b) => a.label.localeCompare(b.label))
}

/** Plain words for the catalogue's own unknowns. Pure. */
export const unknownWords = (u: string): string => UNKNOWN[u] ?? u.replace(/-/g, ' ')

/**
 * What other swarms (and apps) say they can do for this swarm (GET /api/match/catalogue?scope=; Surface missing-UI
 * batch 1, audit item 11). Every entry is advertised from configuration, not demonstrated; the hive says what it
 * does not know, and so does this list. A person sees it for a swarm they own, or as an admin (the host refuses others).
 */
export function CapabilityCatalogue({ swarm }: { swarm: Swarm }) {
  const client = useHive((s) => s.client)
  const { me, admin, loaded } = useMe()
  const [open, setOpen] = useState(false)
  if (!loaded || !has(client, 'capabilityCatalogue') || !(admin || (me && swarm.owner && swarm.owner === me.principal))) return null
  return (
    <section aria-labelledby={`catalogue-h-${swarm.id}`} className="mx-1 mb-5 rounded-2xl border border-line bg-tint/[0.02] p-4" data-capability-catalogue>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`catalogue-h-${swarm.id}`} className="text-lead font-semibold">What other swarms can do for {shown(swarm.name)}</h2>
        <Button variant="subtle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show the catalogue'}</Button>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-3">Advertised by the hive’s configuration: services swarms offer, roles and app actions. Advertised is not proven.</p>
      {open && <CatalogueBody swarm={swarm} />}
    </section>
  )
}

function CatalogueBody({ swarm }: { swarm: Swarm }) {
  const client = useHive((s) => s.client)
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const programs = useHive((s) => s.programs)
  const res = useResource(() => need(client, 'capabilityCatalogue', 'Capability catalogue')(swarm.id), { context: swarm.id, isEmpty: () => false })
  const name = (p: CatalogueOffer['provider']) =>
    p.kind === 'swarm' ? `Swarm ${shown(swarms[p.id]?.name ?? p.id)}` : p.kind === 'agent' ? `Mind ${shown(agents[p.id]?.name ?? p.id)}` : `App ${shown(programs?.find((x) => x.id === p.id)?.name ?? p.id)}`
  return (
    <ResourceView res={res} errorTitle="Could not read the catalogue">
      {(c) => (
        <div className="mt-3 space-y-3 text-[13px]">
          {c.offers.length === 0 ? (
            <p className="text-ink-3">Nothing is advertised to this swarm yet.</p>
          ) : (
            <ul className="space-y-2">
              {groupOffers(c.offers, name).map((g) => (
                <li key={`${g.provider.kind}:${g.provider.id}`} className="rounded-xl border border-line px-3 py-2">
                  <div className="text-ink">{g.label}</div>
                  <ul className="mt-1 flex flex-wrap gap-1.5">
                    {g.offers.map((o) => (
                      <li key={o.id} className="rounded-full border border-line px-2 py-0.5 text-[12px] text-ink-2" title={o.evidence.map((e) => `${e.kind}: ${e.ref}`).join('\n')}>
                        {o.capability.name} <span className="text-ink-4">· {SOURCE[o.capability.source] ?? o.capability.source}{o.scope.connection_only ? ' · needs a connection' : ''}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          <div className="text-[12px] text-ink-4">
            {c.unknowns.length > 0 && <p>Not known yet: {c.unknowns.map(unknownWords).join('; ')}.</p>}
            {c.truncated && <p>The hive says this list is not complete.</p>}
            <p>Read {ago(c.generated_at)} · <span className="font-mono">{c.catalogue_digest.slice(0, 19)}…</span></p>
          </div>
        </div>
      )}
    </ResourceView>
  )
}
