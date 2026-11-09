import { m } from 'framer-motion'
import { useEffect, useState } from 'react'
import type { BeliefDetail } from '../../api/types'
import { hsl } from '../../lib/color'
import { ago } from '../../lib/format'
import { copyText, useNow } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import { pulseKey } from '../../store/reducer'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { OUTCOME } from './outcomes'
import { AsWritten, Sureness } from '../../ui/Belief'
import { beliefText, capFirst, truthWords } from '../../lib/beliefSentence'
import { ErrorState, IconButton, Orb, Skeleton, TruthBars } from '../../ui/primitives'
import { Sheet } from '../../ui/Sheet'


function stampAgent(stamp: string): string | null {
  const m = /^ev:([^:]+):/.exec(stamp)
  return m ? m[1] : null
}

export function Provenance({ swarmId, statement, onClose }: { swarmId: string; statement: string; onClose: () => void }) {
  const client = useHive((s) => s.client)
  const agents = useHive((s) => s.agents)
  const pulse = useHive((s) => s.beliefPulse[pulseKey(swarmId, statement)])
  const [detail, setDetail] = useState<BeliefDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const now = useNow(10_000)

  const [nonce, setNonce] = useState(0)
  const load = () => setNonce((n) => n + 1)

  // fetch on open, on retry, and live whenever this belief changes in the commons
  useEffect(() => {
    if (!client) return
    let alive = true
    client.getBeliefDetail(swarmId, statement).then(
      (d) => {
        if (!alive) return
        setDetail(d)
        setErr(null)
      },
      (e: unknown) => alive && setErr(e instanceof Error ? e.message : 'Could not load provenance'),
    )
    return () => {
      alive = false
    }
  }, [client, swarmId, statement, pulse, nonce])

  const name = (id: string) => agents[id]?.name ?? id
  const hue = (id: string) => agents[id]?.hue ?? 240

  const header = (
    <div className="flex items-center gap-2 px-4 pt-1 pb-2 md:pt-4">
      <div className="min-w-0 flex-1">
        <div className="eyebrow">Provenance</div>
      </div>
      <IconButton icon="x" label="Close provenance" onClick={onClose} className="-mr-2" />
    </div>
  )

  return (
    <Sheet label="Belief provenance" onClose={onClose} header={header} width={460} initialSnap="peek" peekHeight="60dvh">
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        <div className="relative rounded-2xl border border-line bg-shade/30 p-4 pr-12 text-[15px]">
          <p className="text-[15px] leading-snug text-ink">{beliefText(statement)}</p>
          <AsWritten text={statement} />
          <IconButton
            icon={copied ? 'check' : 'copy'}
            label="Copy as written"
            size={16}
            className="absolute top-1.5 right-1.5"
            onClick={async () => {
              if (await copyText(statement)) {
                setCopied(true)
                setTimeout(() => setCopied(false), 1400)
              }
            }}
          />
        </div>

        {err ? (
          <ErrorState title="Could not load provenance" body={err} onRetry={load} />
        ) : !detail ? (
          <div className="mt-4 space-y-3">
            <Skeleton className="h-12" />
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        ) : (
          <>
            <section className="mt-4 rounded-2xl border border-line bg-tint/[0.02] p-4" aria-label="Current truth value" data-tour="prov-truth">
              <div className="mb-2.5 flex items-baseline justify-between">
                <span className="eyebrow">Current truth</span>
                <span className="text-[11px] text-ink-4">updated {ago(detail.updated_at, now)}</span>
              </div>
              <p className="mb-2 text-[13px] text-ink-2">{capFirst(truthWords(detail.tv))}</p>
              <TruthBars f={detail.tv.f} c={detail.tv.c} />
            </section>

            <section className="mt-4" aria-labelledby="src-h" data-tour="prov-sources">
              <h3 id="src-h" className="eyebrow mb-2">
                Sources
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {detail.sources.map((id) => (
                  <button key={id} onClick={() => navigate({ name: 'dot', id })} className="flex min-h-10 items-center gap-1.5 rounded-full border border-line bg-tint/[0.04] py-1 pr-3 pl-1.5 text-[13px] hover:border-line-2">
                    <Orb hue={hue(id)} status={agents[id]?.status ?? 'stopped'} size={20} />
                    {name(id)}
                  </button>
                ))}
              </div>
            </section>

            <section className="mt-4" aria-labelledby="stamp-h">
              <h3 id="stamp-h" className="eyebrow mb-2">
                Evidential stamp · {detail.stamp.length}
              </h3>
              <StampChips stamp={detail.stamp} hue={hue} />
            </section>

            <section className="mt-6" aria-labelledby="tl-h" data-tour="prov-assertions">
              <h3 id="tl-h" className="eyebrow mb-3">
                Assertions · {detail.assertions.length} · newest first
              </h3>
              <ol className="relative">
                <div className="absolute top-2 bottom-2 left-[15px] w-px bg-gradient-to-b from-tint/20 via-tint/10 to-transparent" aria-hidden="true" />
                {[...detail.assertions].reverse().map((a, i) => {
                  const o = OUTCOME[a.outcome]
                  return (
                    <m.li
                      key={`${a.created_at}-${i}`}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: Math.min(0.4, i * 0.04), type: 'spring', stiffness: 300, damping: 30 }}
                      className="relative flex gap-3 pb-4"
                    >
                      <div className="relative z-[1] flex size-8 shrink-0 items-center justify-center rounded-full border" style={{ color: o.color, borderColor: `${o.color}55`, background: `${o.color}18`, boxShadow: `0 0 14px ${o.color}33` }} title={o.hint}>
                        <Icon name={o.icon} size={15} />
                      </div>
                      <div className="min-w-0 flex-1 rounded-xl border border-line bg-tint/[0.025] px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-[12px] font-semibold" style={{ color: o.color }}>
                            {o.label}
                          </span>
                          <button onClick={() => navigate({ name: 'dot', id: a.agent_id })} className="flex items-center gap-1 text-[12px] text-ink-2 hover:text-ink">
                            <Orb hue={hue(a.agent_id)} size={14} />
                            {name(a.agent_id)}
                          </button>
                          <span className="ml-auto text-[11px] text-ink-4">{ago(a.created_at, now)}</span>
                        </div>
                        <div className="mt-1.5 text-[11px] text-ink-3">
                          <Sureness tv={a.tv} className="text-ink-2" />
                        </div>
                        <div className="mt-1.5">
                          <StampChips stamp={a.stamp} hue={hue} small />
                        </div>
                      </div>
                    </m.li>
                  )
                })}
              </ol>
            </section>

            {detail.choices.length > 0 && (
              <section className="mt-2" aria-labelledby="ch-h" data-tour="prov-choices">
                <h3 id="ch-h" className="eyebrow mb-2">
                  Choices · {detail.choices.length}
                </h3>
                <p className="mb-2 text-[12px] text-ink-3">Overlapping evidence cannot be revised without double counting, so the commons kept one side.</p>
                <div className="space-y-2">
                  {detail.choices.map((c, i) => (
                    <div key={i} className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1.5 rounded-xl border border-line bg-tint/[0.02] p-3 text-[11px]">
                      <span className="pt-1 font-semibold text-[#f5c06b]">kept</span>
                      <StampChips stamp={c.kept} hue={hue} small />
                      <span className="pt-1 text-ink-4">rejected</span>
                      <div className="opacity-60">
                        <StampChips stamp={c.rejected} hue={hue} small />
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </Sheet>
  )
}

function StampChips({ stamp, hue, small }: { stamp: string[]; hue: (id: string) => number; small?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1">
      {stamp.map((s) => {
        const a = stampAgent(s)
        return (
          <span key={s} className={`inline-flex items-center gap-1 rounded-md border border-line bg-shade/30 font-mono text-ink-2 ${small ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-[11px]'}`}>
            {a && <span className="size-1.5 rounded-full" style={{ background: hsl(hue(a), 95, 68) }} />}
            {s}
          </span>
        )
      })}
    </div>
  )
}
