import { m } from 'framer-motion'
import { useEffect, useState } from 'react'
import type { HealthIssue, MindHealth } from '../../api/types'
import { cx } from '../../lib/cx'
import { need, useResource } from '../../lib/useResource'
import { ago } from '../../lib/format'
import { navigate, useRoute } from '../../lib/router'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Page } from '../../ui/Page'
import { Button, EmptyState, Segmented } from '../../ui/primitives'
import { ResourceView } from '../../ui/ResourceView'
import { shown } from '../../lib/displayName'
import { HealthMind } from '../minds/HealthMind'
import { SleepAndSpend } from './SleepAndSpend'
import { IDLE_SECTION_ID, IdleMinds } from './IdleMinds'

const TONE: Record<string, string> = {
  high: 'border-bad/40 bg-bad/[0.10] text-bad',
  medium: 'border-warn/40 bg-warn/[0.08] text-warn',
  low: 'border-line-2 bg-white/[0.04] text-ink-2',
  info: 'border-line bg-white/[0.02] text-ink-3',
  ok: 'border-good/30 bg-good/[0.06] text-good',
}
const LABEL: Record<string, string> = { high: 'Needs attention', medium: 'Errors', low: 'Minor', ok: 'Healthy' }

/** #/health: what is going wrong across minds, worst first, with what to do about it. */
export default function HealthPage() {
  const client = useHive((s) => s.client)
  const [show, setShow] = useState<'problems' | 'all'>('problems')
  const route = useRoute()
  const toIdle = route.name === 'health' && route.section === 'idle'
  // #/health/idle ("which minds are idle"): bring the Idle minds section into view
  useEffect(() => {
    if (toIdle) document.getElementById(IDLE_SECTION_ID)?.scrollIntoView({ block: 'start' })
  }, [toIdle])
  // polls while the tab is visible; checks again as soon as it is shown
  const res = useResource(() => need(client, 'health', 'Health checks')(), { poll: 15000, isEmpty: () => false })
  return (
    <Page title="Health" eyebrow="Errors across minds" label="Health" onClose={() => navigate({ name: 'hive' })}>
      <div className="mx-auto max-w-3xl space-y-6 px-4 pt-2 pb-12 md:px-6">
        <HealthMind />
        <IdleMinds />
        <SleepAndSpend />
        <ResourceView res={res} errorTitle="Could not check health" unsupported={{ body: 'This hive or the demo does not report mind health yet.' }}>
          {(data) => {
            const minds = data.minds.filter((x) => show === 'all' || x.health !== 'ok' || x.issues.some((i) => i.recent))
            return (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {(['high', 'medium', 'low', 'ok'] as const).map((s) => (
                    <span key={s} className={cx('rounded-full border px-3 py-1 text-[12px]', TONE[s])}>
                      {data.totals[s]} {LABEL[s].toLowerCase()}
                    </span>
                  ))}
                  <div className="ml-auto flex items-center gap-2">
                    <Segmented
                      label="Which minds to show"
                      value={show}
                      onChange={(v) => setShow(v as 'problems' | 'all')}
                      options={[
                        { value: 'problems', label: 'Problems' },
                        { value: 'all', label: 'All minds' },
                      ]}
                    />
                    <Button variant="ghost" icon="replay" onClick={res.reload} disabled={res.refreshing} aria-label="Check again" />
                  </div>
                </div>
                {minds.length === 0 ? (
                  <EmptyState icon="check" title="Nothing is failing" body="Every mind's recent commands came back fine." />
                ) : (
                  <ul className="space-y-4">
                    {minds.map((mind) => (
                      <MindCard key={mind.id} mind={mind} />
                    ))}
                  </ul>
                )}
              </>
            )
          }}
        </ResourceView>
      </div>
    </Page>
  )
}

function MindCard({ mind }: { mind: MindHealth }) {
  return (
    <m.li layout className="rounded-2xl border border-line bg-white/[0.03] p-4">
      <div className="flex items-center gap-3">
        <button className="text-left text-[14px] font-medium text-ink hover:underline" onClick={() => navigate({ name: 'dot', id: mind.id, tab: 'mind' })}>
          {shown(mind.name)}
        </button>
        <span className="text-[11.5px] text-ink-4">{mind.status}</span>
        <span className={cx('ml-auto rounded-full border px-2.5 py-0.5 text-[11px]', TONE[mind.health])}>{LABEL[mind.health]}</span>
      </div>
      {mind.issues.length > 0 && (
        <ul className="mt-3 space-y-2">
          {mind.issues.map((issue, i) => (
            <IssueRow key={`${issue.kind}-${issue.skill}-${i}`} issue={issue} mindId={mind.id} />
          ))}
        </ul>
      )}
    </m.li>
  )
}

function IssueRow({ issue, mindId }: { issue: HealthIssue; mindId: string }) {
  const [open, setOpen] = useState(false)
  return (
    <li className={cx('rounded-xl border border-line bg-black/20 p-3', !issue.recent && 'opacity-55')}>
      <button className="flex w-full items-start gap-3 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={cx('mt-0.5 shrink-0 rounded-md border px-2 py-0.5 text-[11px]', TONE[issue.severity])}>{issue.kind}</span>
        <span className="min-w-0 flex-1 text-[13px]">
          <span className="text-ink">{issue.meaning}</span>
          <span className="text-ink-4">
            {' '}
            · {issue.skill} · {issue.count}×{issue.last_at ? ` · ${ago(issue.last_at)}` : ''}
            {!issue.recent && ' · earlier, not counted'}
          </span>
        </span>
        <Icon name="chevron" className={cx('shrink-0 text-ink-4 transition-transform', open ? '-rotate-90' : 'rotate-90')} />
      </button>
      {open && (
        <div className="mt-3 space-y-2 text-[13px]">
          <p className="text-ink-2">
            <span className="text-ink-4">What to do: </span>
            {issue.hint}
          </p>
          <pre className="max-h-48 overflow-auto rounded-lg border border-line bg-black/30 p-3 font-mono text-[12px] whitespace-pre-wrap break-words text-ink-2">
            {issue.example.command}
            {'\n→ '}
            {issue.example.result}
          </pre>
          <div className="flex gap-2">
            {issue.kind === 'waiting' ? (
              <Button variant="ghost" onClick={() => navigate({ name: 'approvals' })}>
                Open approvals
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => navigate({ name: 'dot', id: mindId, tab: 'mind' })}>
                Open the mind's trace
              </Button>
            )}
          </div>
        </div>
      )}
    </li>
  )
}
