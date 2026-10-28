import { plural } from '../../lib/plural'
import { useEffect, useMemo, useState } from 'react'
import type { AgentOptions } from '../../api/types'
import { hsl } from '../../lib/color'
import { cx } from '../../lib/cx'
import { ago } from '../../lib/format'
import { navigate, useRoute } from '../../lib/router'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Page } from '../../ui/Page'
import { Button, Orb, Skeleton } from '../../ui/primitives'
import { ModelPicker } from './ModelPicker'
import { ProviderConnect } from './ProviderConnect'
import { buildRows, readDefaultModel, routeSummary, writeDefaultModel } from './modelUtil'
import { shown } from '../../lib/displayName'

/** Providers, keys and the catalogue, and which model new minds get by default. */
export default function ModelsPage() {
  const route = useRoute()
  const providers = useHive((s) => s.providers)
  const loadProviders = useHive((s) => s.loadProviders)
  const models = useHive((s) => s.models)
  const catalog = useHive((s) => s.catalog)
  const agents = useHive((s) => s.agents)
  const toast = useHive((s) => s.toast)
  const [def, setDef] = useState<{ model: string; options?: AgentOptions } | null>(() => readDefaultModel())
  const focus = route.name === 'models' ? route.provider : undefined

  useEffect(() => {
    void loadProviders()
  }, [loadProviders])

  const rows = useMemo(() => buildRows(models, catalog?.models), [models, catalog])
  const defaultRow = def ? rows.find((r) => r.id === def.model) : undefined
  const byModel = useMemo(() => {
    const m = new Map<string, typeof agents[string][]>()
    for (const a of Object.values(agents)) m.set(a.model, [...(m.get(a.model) ?? []), a])
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [agents])

  const connected = providers?.filter((p) => p.connected).length ?? 0

  return (
    <Page title="Models" eyebrow="Providers and catalogue" label="Models" onClose={() => navigate({ name: 'hive' })}>
      <div className="mx-auto max-w-3xl space-y-8 px-4 pt-2 pb-12 md:px-6">
        <section aria-labelledby="providers-h">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 id="providers-h" className="eyebrow">
              Providers
            </h2>
            {providers && (
              <span className="text-[12px] text-ink-3">
                {connected} of {providers.length} ready
              </span>
            )}
          </div>
          {!providers ? (
            <div className="grid gap-3 md:grid-cols-2" aria-busy="true">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2">
              {providers.map((p) => (
                <div key={p.name} className={cx(focus === p.name && 'rounded-2xl ring-2 ring-accent-2/60')}>
                  <ProviderConnect provider={p} hue={p.name === 'openrouter' ? 262 : p.name === 'anthropic' ? 24 : p.name === 'openai' ? 160 : 252} autoFocus={focus === p.name} />
                  {p.name === 'openrouter' && p.connected && p.catalog && (
                    <p className="mt-1.5 px-1 text-[11px] text-ink-4">
                      {p.catalog.count ? `${plural(p.catalog.count, 'model')} in the catalogue` : 'Catalogue not fetched yet'}
                      {p.catalog.fetched_at ? ` · ${ago(new Date(p.catalog.fetched_at * 1000).toISOString())}` : ''}
                      {p.catalog.error ? ` · ${p.catalog.error}` : ''}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-[12px] leading-relaxed text-ink-4">
            Keys live in the hive's data directory, readable only by the hive process. Minds call models through the gateway, which injects the key, meters tokens and enforces each mind's budget. Nothing a mind says can reveal a key.
          </p>
        </section>

        <section aria-labelledby="default-h">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 id="default-h" className="eyebrow">
              Default for new minds
            </h2>
            {def && (
              <button onClick={() => (writeDefaultModel(null), setDef(null))} className="text-[12px] text-ink-3 hover:text-ink">
                Clear
              </button>
            )}
          </div>
          <p className="mb-3 text-[12px] leading-relaxed text-ink-3">
            {defaultRow ? (
              <>
                New minds start on <span className="text-ink">{shown(defaultRow.name)}</span>
                {defaultRow.provider === 'openrouter' ? <> · {routeSummary(def?.options)}</> : null}. You can still change it for each mind.
              </>
            ) : (
              <>Pick what the create flow should suggest first. Saved in this browser.</>
            )}
          </p>
          <ModelPicker
            value={def?.model ?? ''}
            options={def?.options}
            hue={252}
            onChange={(model, options) => {
              const next = { model, options }
              writeDefaultModel(next)
              setDef(next)
              toast({ tone: 'success', icon: 'check', title: 'Default model saved', body: rows.find((r) => r.id === model)?.name ?? model })
            }}
          />
        </section>

        {byModel.length > 0 && (
          <section aria-labelledby="inuse-h">
            <h2 id="inuse-h" className="eyebrow mb-3">
              In use
            </h2>
            <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">
              {byModel.map(([model, list]) => {
                const row = rows.find((r) => r.id === model)
                return (
                  <div key={model} className="flex items-center gap-3 px-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] text-ink">{row?.name ?? model}</span>
                      <span className="block truncate font-mono text-[11px] text-ink-4">{model}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {list.slice(0, 6).map((a) => (
                        <button key={a.id} onClick={() => navigate({ name: 'dot', id: a.id, tab: 'model' })} title={shown(a.name)} aria-label={`${shown(a.name)}, open model settings`} className="rounded-full p-0.5 hover:bg-white/[0.06]">
                          <Orb hue={a.hue} status={a.status} size={18} />
                        </button>
                      ))}
                      {list.length > 6 && <span className="text-[11px] text-ink-4">+{list.length - 6}</span>}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        <div className="flex justify-center">
          <Button variant="primary" hue={252} icon="plus" onClick={() => navigate({ name: 'new' })} style={{ ['--btn-glow' as string]: hsl(252, 100, 65, 0.5) }}>
            Create a mind
          </Button>
        </div>
        <p className="flex items-center justify-center gap-1.5 text-[11px] text-ink-4">
          <Icon name="info" size={12} /> Costs show on the Usage view as minds talk.
        </p>
      </div>
    </Page>
  )
}
