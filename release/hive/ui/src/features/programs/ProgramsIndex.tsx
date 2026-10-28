import { m } from 'framer-motion'
import { useEffect } from 'react'
import type { Program } from '../../api/types'
import { cx } from '../../lib/cx'
import { navigate } from '../../lib/router'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { iconOr } from '../../ui/iconPaths'
import { Page } from '../../ui/Page'
import { has } from '../../lib/useResource'
import { ActivityList, AppAccessButton } from './AppActivity'
import { Button, EmptyState, ErrorState, Skeleton, Switch } from '../../ui/primitives'
import { shown } from '../../lib/displayName'
import { useAppLook } from '../../shell/appLook'

const CAP_TEXT: Record<string, string> = {
  'commons:read': 'reads the swarm commons',
  'goals:read': 'reads tasks',
  'goals:write': 'posts tasks',
}

/** #/programs: every mind program this hive found, with its state and an operator switch. */
export default function ProgramsIndex() {
  const programs = useHive((s) => s.programs)
  const err = useHive((s) => s.programsError)
  const load = useHive((s) => s.loadPrograms)
  const reload = useHive((s) => s.reloadPrograms)
  useEffect(() => {
    void load().catch(() => undefined)
  }, [load])
  return (
    <Page
      label="Programs"
      eyebrow="In this hive"
      title="Apps"
      onClose={() => navigate({ name: 'hive' })}
      info="programs"
      actions={
        <Button variant="subtle" icon="reset" onClick={() => void reload()} className="mr-1" title="Re-read app code from disk">
          <span className="hidden sm:inline">Reload</span>
        </Button>
      }
    >
      <div className="mx-auto w-full max-w-[1100px] px-3 pb-[calc(var(--sab)+24px)] md:px-6 md:pb-10">
        <p className="mb-5 max-w-[680px] px-1 text-[13.5px] leading-relaxed text-ink-3">
          A program supplies the meaning of a piece of work as a graph of items, links and sources. The hive turns it into a space you can unfold, map, compare and inspect, with sources, uncertainty and your trail always in view.
        </p>
        {err && !programs ? (
          <ErrorState title="Apps are not available" body={`${err}. This hive may be older than the programs API.`} onRetry={() => void load().catch(() => undefined)} />
        ) : !programs ? (
          <div className="grid gap-3 md:grid-cols-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-48 rounded-[20px]" />
            ))}
          </div>
        ) : !programs.length ? (
          <EmptyState icon="apps" title="No programs found" body="Built-in programs live in hive/plugins/. Point HIVE_PLUGIN_DIRS at your own program directories, then Reload." />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2" data-tour="programs-list">
            {programs.map((p, i) => (
              <ProgramCard key={p.id} p={p} i={i} />
            ))}
          </ul>
        )}
        <RecentActivity />
      </div>
    </Page>
  )
}

function ProgramCard({ p, i }: { p: Program; i: number }) {
  const setEnabled = useHive((s) => s.setProgramEnabled)
  const look = useAppLook(p)
  const state = p.error ? 'error' : p.enabled ? 'enabled' : 'disabled'
  const color = state === 'error' ? '#fb7185' : state === 'enabled' ? '#4ade80' : '#8a89b3'
  return (
    <m.li
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: i * 0.04, type: 'spring', stiffness: 300, damping: 30 }}
      data-tour={`program-card-${p.id}`}
      className="relative flex flex-col overflow-hidden rounded-[20px] border p-4 md:p-5"
      data-app-type={look?.type}
      style={{ ...look?.style, background: 'linear-gradient(180deg, rgb(255 255 255 / 0.035), rgb(255 255 255 / 0.012)), var(--look-page-a, rgb(13 13 38 / 0.72))', borderColor: state === 'error' ? 'rgb(251 113 133 / 0.3)' : 'var(--color-line)' }}
    >
      {look && look.motif !== 'none' && <div className="app-motif" data-motif={look.motif} aria-hidden="true" />}
      <div className="pointer-events-none absolute -top-20 -right-14 size-56 rounded-full opacity-40" style={{ background: state === 'enabled' ? 'radial-gradient(circle, color-mix(in srgb, var(--color-accent) 20%, transparent), transparent 70%)' : `radial-gradient(circle, ${color}33, transparent 70%)` }} />
      <div className="relative flex items-start gap-3">
        <span className={cx('flex size-11 shrink-0 items-center justify-center rounded-2xl border border-line bg-white/[0.04]', state === 'enabled' ? 'text-accent' : 'text-ink-3')} style={state === 'enabled' ? { boxShadow: '0 0 30px -8px color-mix(in srgb, var(--color-accent) 60%, transparent)' } : undefined}>
          <Icon name={iconOr(p.icon, 'spark')} size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h2 className="font-display text-[17px] font-semibold tracking-tight text-ink">{shown(p.name)}</h2>
            <span className="font-mono text-[11px] text-ink-4">v{p.version}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] font-semibold" style={{ color }}>
            <span className="size-1.5 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} aria-hidden="true" />
            {state === 'error' ? 'Failed to load' : state === 'enabled' ? 'Enabled' : 'Disabled by an operator'}
          </div>
        </div>
        {!p.error && <Switch checked={p.enabled} onChange={(v) => void setEnabled(p.id, v)} label={`${p.enabled ? 'Disable' : 'Enable'} ${shown(p.name)}`} hue={252} />}
      </div>
      {look?.identity && <p className="relative mt-2 font-display text-[13px] text-accent">{look.identity.title}</p>}
      <p className="relative mt-3 text-[13px] leading-relaxed text-ink-2">{shown(p.description) || 'No description.'}</p>
      {p.error && (
        <pre className="thin-scroll relative mt-3 overflow-x-auto rounded-xl border border-bad/25 bg-bad/[0.06] px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-bad">{p.error}</pre>
      )}
      <dl className="relative mt-3 flex flex-wrap items-center gap-1.5 text-[11.5px]">
        <dt className="sr-only">Source</dt>
        <dd className="inline-flex items-center gap-1 rounded-md border border-line bg-white/[0.03] px-1.5 py-0.5 text-ink-2" title={p.source === 'built-in' ? 'Ships with the hive (hive/plugins/)' : 'Loaded from HIVE_PLUGIN_DIRS on this machine'}>
          <Icon name={p.source === 'built-in' ? 'hive' : 'database'} size={11} />
          {p.source === 'built-in' ? 'Built-in' : p.source === 'plugin-dir' ? 'Plugin dir' : p.source}
        </dd>
        <dt className="sr-only">Capabilities</dt>
        {p.capabilities.length ? (
          p.capabilities.map((c) => (
            <dd key={c} className="inline-flex items-center gap-1 rounded-md border border-accent/25 bg-accent/[0.07] px-1.5 py-0.5 font-mono text-[10.5px] text-[#cfc7ff]" title={CAP_TEXT[c] ?? c}>
              {c}
            </dd>
          ))
        ) : (
          <dd className="text-ink-4">no capabilities</dd>
        )}
      </dl>
      <div className="relative mt-4 flex items-center gap-2 pt-1">
        <span className="font-mono text-[10.5px] text-ink-4">{p.id}</span>
        <span className="flex-1" />
        <AppAccessButton programId={p.id} name={shown(p.name)} className="min-h-10 text-[13px]" iconOnly />
        <Button variant={p.enabled ? 'primary' : 'subtle'} icon="unfold" disabled={!p.enabled} onClick={() => navigate({ name: 'program', id: p.id })} className="min-h-10 text-[13px]" aria-label={`Open ${shown(p.name)}`}>
          Open
        </Button>
      </div>
    </m.li>
  )
}

function RecentActivity() {
  const client = useHive((s) => s.client)
  if (!has(client, 'programActivity')) return null
  return (
    <section aria-labelledby="app-activity-h" className="mt-8">
      <h2 id="app-activity-h" className="eyebrow mb-2 px-1">
        What apps did lately
      </h2>
      <ActivityList limit={20} compact />
    </section>
  )
}
