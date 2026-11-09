import { m } from 'framer-motion'
import { designCreation } from '../../lib/designCreation'
import { navigate, openInDesign } from '../../lib/router'
import type { ProgramAction, WorkGraph, WorkItem } from '../../api/types'
import { cx } from '../../lib/cx'
import { localWhen } from '../../lib/format'
import type { ResultDetail, SourceDetail } from '../../store/programSession'
import { Icon } from '../../ui/Icon'
import { Button } from '../../ui/primitives'
import type { GraphIndex } from './layout'
import { FlagChip, RoleMark, SourceFields, StatusChip, UMini, UReading } from './parts'
import { ResultPanel } from './ResultPanel'
import { ACTION_ICON, FLAG_TEXT, POL, ROLE, SPRING, SURFACE } from './style'

const when = (iso?: string) => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? localWhen(iso) : iso
}

/** One item, all of it: text, every source field, uncertainty, revisions, flags, links in and out, its actions. */
export function Detail({
  graph,
  gi,
  id,
  scope,
  actions,
  busy,
  sourceDetail,
  result = null,
  onCloseResult,
  onOpen,
  onAct,
  onInspect,
  inspectable,
  swarmId,
}: {
  graph: WorkGraph
  gi: GraphIndex
  id: string
  scope: string
  actions: ProgramAction[]
  busy: string | null
  sourceDetail: SourceDetail | null
  /** What the last action returned (besides sources), shown here when it is about this item. */
  result?: ResultDetail | null
  onCloseResult?(): void
  onOpen(id: string): void
  onAct(a: ProgramAction, ids: string[]): void
  onInspect(id: string): void
  inspectable: boolean
  swarmId?: string
}) {
  const item = gi.items.get(id)
  if (!item) return null
  const creation = designCreation(item.meta)
  const designRoute = creation && swarmId ? openInDesign(creation, swarmId) : undefined
  const role = gi.role(item.kind)
  const r = ROLE[role]
  const out = graph.links.filter((l) => l.from === id && gi.items.has(l.to))
  const inn = graph.links.filter((l) => l.to === id && gi.items.has(l.from))
  const groups = graph.groups.filter((g) => g.items.includes(id))
  const flags = item.flags ?? []
  const revisions = [...(item.revisions ?? [])].reverse()
  const corrected = (other: WorkItem) => other.status === 'corrected'
  const causes = flags.includes('affected-by-correction') ? [...new Set([...out, ...inn].map((l) => (l.from === id ? l.to : l.from)))].map((o) => gi.items.get(o)!).filter(corrected) : []

  return (
    <div className="thin-scroll absolute inset-0 overflow-y-auto overscroll-contain">
      <div className="mx-auto w-full max-w-[920px] px-3 pt-2 pb-28 md:px-6">
        <m.article
          layoutId={`pn-${scope}-${id}`}
          transition={SPRING}
          className="relative overflow-hidden rounded-[22px] border p-4 md:p-5"
          style={{ background: SURFACE, borderColor: `color-mix(in srgb, ${r.color} 45%, transparent)`, boxShadow: `0 24px 70px -30px rgb(0 0 0 / 0.9), 0 0 60px -24px ${r.color}` }}
          aria-labelledby={`detail-${scope}`}
        >
          <div className="pointer-events-none absolute -top-24 -right-16 size-72 rounded-full opacity-40" style={{ background: `radial-gradient(circle, ${r.color}40, transparent 70%)` }} />
          {item.status === 'corrected' && <span className="absolute inset-y-4 left-0 w-[3px] rounded-r-full bg-warn" aria-hidden="true" />}
          <m.div layout="position" className="relative">
            <div className="flex flex-wrap items-center gap-2">
              <RoleMark role={role} kindLabel={gi.kindLabel(item.kind)} />
              <span className="font-mono text-[10.5px] text-ink-4">{item.id}</span>
              <span className="flex-1" />
              <StatusChip status={item.status} />
              {flags.map((f) => (
                <FlagChip key={f} flag={f} />
              ))}
            </div>
            <h2 id={`detail-${scope}`} className={cx('mt-2 font-display text-[21px] leading-snug font-semibold tracking-tight text-ink md:text-[24px]', item.status === 'retracted' && 'line-through decoration-bad/70')}>
              {item.label}
            </h2>
            {item.text && <p className="mt-2 text-[14px] leading-relaxed whitespace-pre-wrap text-ink-2">{item.text}</p>}
            <div className="mt-3.5 flex flex-wrap items-center gap-x-5 gap-y-2">
              <div data-tour="detail-uncertainty">
                <div className="eyebrow mb-1">Uncertainty</div>
                <UReading u={item.uncertainty} large />
              </div>
              {item.weight != null && (
                <div>
                  <div className="eyebrow mb-1">Weight</div>
                  <span className="font-mono text-[13px] text-ink-2 tabular-nums">{Number(item.weight).toFixed(2)}</span>
                </div>
              )}
              {item.at && (
                <div>
                  <div className="eyebrow mb-1">As of</div>
                  <span className="text-[13px] text-ink-2">{when(item.at)}</span>
                </div>
              )}
            </div>
          </m.div>
        </m.article>

        {flags.length > 0 && (
          <div className="mt-3 space-y-2">
            {flags.map((f) => (
              <div key={f} className={cx('flex items-start gap-2.5 rounded-2xl border px-3.5 py-2.5', f === 'affected-by-correction' ? 'border-warn/30 bg-warn/[0.07]' : 'border-line bg-tint/[0.03]')} role={f === 'affected-by-correction' ? 'alert' : undefined}>
                <Icon name="alert" size={16} className={cx('mt-0.5 shrink-0', f === 'affected-by-correction' ? 'text-warn' : 'text-ink-3')} />
                <div className="min-w-0 text-[12.5px] leading-snug">
                  <div className="font-semibold text-ink">{FLAG_TEXT[f]?.label ?? f}</div>
                  <div className="text-ink-3">{FLAG_TEXT[f]?.why ?? 'A flag set by the program.'}</div>
                  {causes.length > 0 && f === 'affected-by-correction' && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {causes.map((c) => (
                        <button key={c.id} onClick={() => onOpen(c.id)} className="inline-flex items-center gap-1 rounded-lg border border-warn/30 bg-warn/10 px-2 py-0.5 text-[11.5px] text-warn hover:bg-warn/15">
                          <Icon name="edit" size={11} />
                          corrected: {c.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {designRoute && (
          <div className="mt-3">
            <Button variant="subtle" disabled={!!busy} onClick={() => navigate(designRoute)}>Open in Design</Button>
          </div>
        )}

        {actions.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2" role="toolbar" aria-label="Actions for this item">
            {actions.map((a) => (
              <Button key={a.id} variant={a.id === 'correct' ? 'primary' : 'subtle'} hue={a.id === 'correct' ? 38 : undefined} disabled={!!busy} onClick={() => onAct(a, [id])} className="min-h-10 text-[13px]">
                {busy === a.id ? <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" /> : <Icon name={ACTION_ICON[a.id] ?? 'bolt'} size={16} />}
                {a.label ?? a.id}
              </Button>
            ))}
          </div>
        )}

        {result && (!result.items.length || result.items.includes(id)) && (
          <ResultPanel className="mt-3" result={result} currentRevision={graph.revision} itemLabel={(x) => gi.items.get(x)?.label ?? x} onClose={() => onCloseResult?.()} />
        )}

        <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2">
          <LinkList title="Links out" empty="It points at nothing." links={out.map((l) => ({ l, other: l.to, morph: true }))} gi={gi} scope={scope} onOpen={onOpen} dir="out" />
          <LinkList title="Links in" empty="Nothing points at it." links={inn.map((l) => ({ l, other: l.from, morph: !out.some((o) => o.to === l.from) }))} gi={gi} scope={scope} onOpen={onOpen} dir="in" />
        </div>

        <section className="mt-5" aria-label="Sources of this item">
          <div className="mb-2 flex items-baseline gap-2">
            <h3 className="eyebrow">Sources</h3>
            <span className="text-[11.5px] text-ink-4">{item.sources?.length ?? 0}</span>
          </div>
          {(item.sources?.length ?? 0) === 0 ? (
            <p className="rounded-xl border border-dashed border-line-2 px-3 py-2.5 text-[12.5px] text-ink-3">This item cites no source of its own. The sources rail shows what the linked items cite.</p>
          ) : (
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-2.5 md:grid-cols-2">
              {item.sources!.map((s) => {
                const returned = sourceDetail?.items.includes(id) ? sourceDetail.sources.find((x) => x.id === s.id) : undefined
                const shared = s.origin ? graph.items.filter((o) => o.id !== id && o.sources?.some((x) => x.origin === s.origin && x.id !== s.id)) : []
                return (
                  <li key={s.id} className="rounded-2xl border border-line p-3" style={{ background: 'rgb(0 0 0 / 0.22)' }}>
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1 text-[13.5px] leading-snug font-semibold text-ink">{s.label}</div>
                      {inspectable && (
                        <Button variant="subtle" className="min-h-8 shrink-0 rounded-lg px-2.5 text-[12px]" disabled={!!busy} onClick={() => onInspect(id)}>
                          Open
                        </Button>
                      )}
                    </div>
                    <div className="mt-2">
                      <SourceFields s={returned ?? s} />
                    </div>
                    {shared.length > 0 && (
                      <p className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-snug text-warn">
                        <Icon name="link" size={12} className="mt-px shrink-0" />
                        Same origin as the source of {shared.map((o) => o.id).join(', ')}: not independent.
                      </p>
                    )}
                    {returned && sourceDetail?.message && <p className="mt-2 text-[11.5px] text-ink-3">{sourceDetail.message}</p>}
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="mt-5" aria-label="Revisions">
          <div className="mb-2 flex items-baseline gap-2">
            <h3 className="eyebrow">Revisions</h3>
            <span className="text-[11.5px] text-ink-4">{revisions.length ? `${revisions.length} earlier` : 'none'}</span>
          </div>
          <ol className="relative space-y-0 border-l border-line-2 pl-4">
            <li className="relative pb-3">
              <span className="absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-[#0b0b22]" style={{ background: r.color, boxShadow: `0 0 10px ${r.color}` }} aria-hidden="true" />
              <div className="flex items-baseline gap-2 text-[11px] text-ink-4">
                <span className="font-mono">{graph.revision}</span>
                <span>now</span>
              </div>
              <div className="text-[13px] text-ink">{item.label}</div>
            </li>
            {revisions.map((rv, i) => (
              <li key={`${rv.revision}-${i}`} className="relative pb-3">
                <span className="absolute top-1.5 -left-[20px] size-2 rounded-full bg-ink-4" aria-hidden="true" />
                <div className="flex flex-wrap items-baseline gap-2 text-[11px] text-ink-4">
                  <span className="font-mono">{rv.revision}</span>
                  {rv.at && <span>{when(rv.at)}</span>}
                </div>
                {rv.label && <div className="text-[13px] text-ink-3 line-through decoration-ink-4/60">{rv.label}</div>}
                {rv.note && (
                  <div className="mt-0.5 text-[12px] text-ink-2">
                    <span className="text-ink-4">why: </span>
                    {rv.note}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>

        {groups.length > 0 && (
          <section className="mt-4" aria-label="Groups">
            <h3 className="eyebrow mb-2">In groups</h3>
            <div className="flex flex-wrap gap-1.5">
              {groups.map((g) => (
                <span key={g.id} className="rounded-lg border border-line bg-tint/[0.03] px-2 py-1 text-[12px] text-ink-2">
                  {g.label ?? g.id} <span className="text-ink-4">· {g.items.length}</span>
                </span>
              ))}
            </div>
          </section>
        )}

        {item.atom && (
          <section className="mt-4" aria-label="Atom">
            <h3 className="eyebrow mb-2">Atom</h3>
            <pre className="thin-scroll overflow-x-auto rounded-xl border border-line bg-shade/30 px-3 py-2 font-mono text-[12px] text-ink-2">{item.atom}</pre>
          </section>
        )}
      </div>
    </div>
  )
}

function LinkList({ title, empty, links, gi, scope, onOpen, dir }: { title: string; empty: string; links: { l: { id: string; rel: string; weight?: number }; other: string; morph: boolean }[]; gi: GraphIndex; scope: string; onOpen(id: string): void; dir: 'in' | 'out' }) {
  return (
    <section aria-label={title} className="min-w-0">
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="eyebrow">{title}</h3>
        <span className="text-[11.5px] text-ink-4">{links.length}</span>
      </div>
      {!links.length ? (
        <p className="text-[12.5px] text-ink-4">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {links.map(({ l, other, morph }) => {
            const o = gi.items.get(other)!
            const pol = POL[gi.polarity(l.rel)]
            return (
              <li key={l.id}>
                <m.button
                  layoutId={morph ? `pn-${scope}-${other}` : undefined}
                  transition={SPRING}
                  onClick={() => onOpen(other)}
                  className="group flex w-full min-w-0 items-center gap-2.5 rounded-xl border border-line px-3 py-2 text-left hover:border-line-2"
                  style={{ background: SURFACE }}
                  aria-label={`${dir === 'out' ? 'This item' : o.label} ${gi.relLabel(l.rel)} ${dir === 'out' ? o.label : 'this item'}. Open it.`}
                >
                  <m.span layout="position" className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
                    <span className="shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold whitespace-nowrap" style={{ color: pol.color, background: `color-mix(in srgb, ${pol.color} 13%, transparent)` }}>
                      {dir === 'in' ? '← ' : ''}
                      {gi.relLabel(l.rel)}
                      {dir === 'out' ? ' →' : ''}
                    </span>
                    <span className="min-w-0 flex-1 overflow-hidden">
                      <span className="block truncate text-[13px] text-ink">{o.label}</span>
                      <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                        <RoleMark role={gi.role(o.kind)} kindLabel={gi.kindLabel(o.kind)} />
                        <UMini u={o.uncertainty} />
                        <StatusChip status={o.status} compact />
                        {(o.flags ?? []).map((f) => (
                          <FlagChip key={f} flag={f} compact />
                        ))}
                      </span>
                    </span>
                    {l.weight != null && <span className="shrink-0 font-mono text-[10.5px] text-ink-4">w {l.weight.toFixed(2)}</span>}
                    <Icon name="chevron" size={14} className="shrink-0 text-ink-4 group-hover:text-ink-2" />
                  </m.span>
                </m.button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
