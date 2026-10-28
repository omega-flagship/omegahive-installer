import { plural } from '../../lib/plural'
import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Agent, Approval, GateDecision, ThinkingPhase, Trace, TraceCommand } from '../../api/types'
import { hsl } from '../../lib/color'
import { cx } from '../../lib/cx'
import { ago, seconds, tokens } from '../../lib/format'
import { useNow, useReducedMotion } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import { useHive } from '../../store/store'
import { Icon, type IconName } from '../../ui/Icon'
import { MODE_STYLE } from '../../ui/modes'
import { MeTTa } from '../../ui/MeTTa'
import { EmptyState, ErrorState, IconButton, Segmented, Skeleton } from '../../ui/primitives'
import { ArchivedHistory } from './ArchivedHistory'
import { shown as shownName } from '../../lib/displayName'

type Filter = 'all' | 'skills' | 'errors'
const EMPTY: Trace[] = []

const isError = (c: TraceCommand) => c.gated === 'deny' || /^(error|denied)\b/i.test(c.result)
const isSkill = (c: TraceCommand) => !/^\(\s*send\b/.test(c.command)

type Trigger = { kind: 'message' | 'autonomous' | 'wakeup' | 'approved'; label: string; icon: IconName; text: string | null }
function trigger(input: string | null): Trigger {
  if (!input) return { kind: 'autonomous', label: 'Autonomous turn', icon: 'sparkles', text: null }
  const w = /^\[wakeup\]\s*(.*)$/s.exec(input)
  if (w) return { kind: 'wakeup', label: 'Scheduled wakeup', icon: 'sun', text: w[1] }
  const a = /^\[APPROVED (\S+)\]\s*(.*)$/s.exec(input)
  if (a) return { kind: 'approved', label: `Approval ${a[1]} granted`, icon: 'shield', text: a[2] }
  return { kind: 'message', label: 'Message', icon: 'chat', text: input }
}

/** "Watch it think": every model iteration as a live vertical timeline with replay. */
export function MindTimeline({ agent }: { agent: Agent }) {
  const traces = useHive((s) => s.traces[agent.id] ?? EMPTY)
  const loaded = useHive((s) => !!s.tracesLoaded[agent.id])
  const load = useHive((s) => s.loadTraces)
  const thinking = useHive((s) => s.thinking[agent.id])
  const reduced = useReducedMotion()
  const [filter, setFilter] = useState<Filter>('all')
  const [err, setErr] = useState<string | null>(null)
  /** Index (oldest → newest in the filtered list) the replay is parked on; null = live. */
  const [cursor, setCursor] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [open, setOpen] = useState<Record<number, boolean>>({})

  useEffect(() => {
    if (!loaded) load(agent.id).then(() => setErr(null), (e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load traces'))
  }, [agent.id, loaded, load])

  const filtered = useMemo(
    () => traces.filter((t) => (filter === 'all' ? true : filter === 'skills' ? t.commands.some(isSkill) : t.commands.some(isError))),
    [traces, filter],
  )
  const last = filtered.length - 1
  const at = cursor === null ? last : Math.min(cursor, last)
  const shown = useMemo(() => filtered.slice(0, at + 1).reverse(), [filtered, at])
  const live = cursor === null

  // autoplay steps forward, then rejoins live
  useEffect(() => {
    if (!playing) return
    const t = setTimeout(() => {
      if (cursor === null || cursor >= last) {
        setPlaying(false)
        setCursor(null)
      } else setCursor(cursor + 1)
    }, reduced ? 900 : 1700)
    return () => clearTimeout(t)
  }, [playing, cursor, last, reduced])

  const step = (d: number) => {
    setPlaying(false)
    const next = Math.max(0, Math.min(last, at + d))
    setCursor(next >= last && d > 0 ? null : next)
  }
  const play = () => {
    if (playing) return setPlaying(false)
    if (cursor === null || cursor >= last) setCursor(Math.max(0, last - Math.min(last, 8)))
    setPlaying(true)
  }

  const totals = useMemo(() => {
    let tok = 0
    let ms = 0
    let n = 0
    for (const t of traces) {
      tok += t.tokens ?? 0
      if (t.llm_ms != null) {
        ms += t.llm_ms
        n++
      }
    }
    return { tok, avg: n ? ms / n : null }
  }, [traces])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 border-b border-line px-4 pt-1 pb-2.5">
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setPlaying(false)
              setCursor(null)
            }}
            className={cx('inline-flex min-h-9 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold transition-colors', live ? 'border-transparent' : 'border-line text-ink-3 hover:text-ink')}
            style={live ? { color: hsl(agent.hue, 100, 82), background: hsl(agent.hue, 90, 55, 0.16) } : undefined}
            aria-pressed={live}
          >
            <span className="relative flex size-2">
              {live && agent.status === 'awake' && <span className="absolute inset-0 animate-ping rounded-full" style={{ background: hsl(agent.hue, 100, 70) }} />}
              <span className="relative size-2 rounded-full" style={{ background: live ? hsl(agent.hue, 100, 70) : 'var(--color-ink-4)' }} />
            </span>
            {live ? 'Live' : `Replay ${at + 1}/${filtered.length}`}
          </button>
          <span className="hidden truncate text-[11px] text-ink-4 sm:inline">
            {plural(traces.length, 'iteration')} · {tokens(totals.tok)} tok · avg {seconds(totals.avg ? Math.round(totals.avg) : null)}
          </span>
          <Segmented<Filter>
            dense
            label="Timeline filter"
            value={filter}
            onChange={(f) => {
              setFilter(f)
              setCursor(null)
              setPlaying(false)
            }}
            className="ml-auto shrink-0"
            options={[
              { value: 'all', label: 'All' },
              { value: 'skills', label: 'Skills' },
              { value: 'errors', label: 'Errors' },
            ]}
          />
        </div>
        <div className="flex items-center gap-0.5" role="group" aria-label="Replay" data-tour="mind-replay">
          <IconButton icon="first" label="First iteration" size={17} onClick={() => (setPlaying(false), setCursor(0))} disabled={!filtered.length} className="size-10" />
          <IconButton icon="stepBack" label="Previous iteration" size={17} onClick={() => step(-1)} disabled={at <= 0} className="size-10" />
          <button
            onClick={play}
            disabled={filtered.length < 2}
            aria-label={playing ? 'Pause replay' : 'Replay recent iterations'}
            className="flex size-10 items-center justify-center rounded-full text-[#0b0820] transition-transform active:scale-95 disabled:opacity-40"
            style={{ background: `linear-gradient(180deg, ${hsl(agent.hue, 100, 84)}, ${hsl(agent.hue, 92, 68)})`, boxShadow: `0 0 18px ${hsl(agent.hue, 100, 65, 0.45)}` }}
          >
            <Icon name={playing ? 'pause' : 'play'} size={16} strokeWidth={2.4} />
          </button>
          <IconButton icon="stepFwd" label="Next iteration" size={17} onClick={() => step(1)} disabled={live} className="size-10" />
          <input
            type="range"
            min={0}
            max={Math.max(0, last)}
            value={Math.max(0, at)}
            onChange={(e) => {
              setPlaying(false)
              const v = Number(e.target.value)
              setCursor(v >= last ? null : v)
            }}
            aria-label="Scrub iterations"
            className="scrub ml-2 min-w-0 flex-1"
            style={{ ['--fill' as string]: `${last > 0 ? (at / last) * 100 : 100}%`, ['--hue' as string]: String(agent.hue) }}
            disabled={filtered.length < 2}
          />
          <span className="w-12 shrink-0 text-right font-mono text-[11px] text-ink-3">#{filtered[at]?.iteration ?? '–'}</span>
        </div>
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-6">
        {err && !traces.length ? <ErrorState title="Could not load the recent timeline" body={err} onRetry={() => load(agent.id).then(() => setErr(null), () => undefined)} /> : !loaded && !traces.length ? (
          <div className="space-y-3 pl-9">
            <Skeleton className="h-24 w-full rounded-2xl" />
            <Skeleton className="h-16 w-full rounded-2xl" />
            <Skeleton className="h-20 w-full rounded-2xl" />
          </div>
        ) : !filtered.length && !thinking ? (
          <EmptyState icon="mind" title={filter === 'all' ? 'No recent iterations' : filter === 'skills' ? 'No recent skills used' : 'No recent errors'} body={filter === 'all' ? `This is the recent window. Browse older history below for archived traces.` : 'Nothing in this recent view. Try All or browse older history.'} />
        ) : (
          <ol className="relative" aria-label={`${shownName(agent.name)} iterations, newest first`}>
            <span className="absolute top-3 bottom-3 left-[15px] w-px" style={{ background: `linear-gradient(${hsl(agent.hue, 100, 75, 0.7)}, ${hsl(agent.hue, 80, 60, 0.12)})` }} aria-hidden="true" />
            <AnimatePresence initial={false}>
              {live && thinking && thinking !== 'idle' && <ThinkingNow key="now" hue={agent.hue} phase={thinking} />}
              {shown.map((t, i) => (
                <TraceItem
                  key={t.id}
                  trace={t}
                  hue={agent.hue}
                  head={i === 0}
                  expanded={open[t.id] ?? (i === 0 || (!live && i === 0))}
                  onToggle={() => setOpen((o) => ({ ...o, [t.id]: !(o[t.id] ?? i === 0) }))}
                  animateIn={!live || i === 0}
                />
              ))}
            </AnimatePresence>
          </ol>
        )}
        <ArchivedHistory agent={agent} renderTrace={t => <TraceItem key={t.id} trace={t} hue={agent.hue} head={false} expanded={open[t.id] ?? false} onToggle={() => setOpen(o => ({ ...o, [t.id]: !o[t.id] }))} animateIn={false} />} />
      </div>
    </div>
  )
}

function ThinkingNow({ hue, phase }: { hue: number; phase: ThinkingPhase }) {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const t0 = performance.now()
    const id = setInterval(() => setSecs((performance.now() - t0) / 1000), 100)
    return () => clearInterval(id)
  }, [])
  const skills = phase === 'skills'
  const h = skills ? hue + 55 : hue
  return (
    <m.li layout initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0, transition: { duration: 0.2 } }} className="relative mb-3 pl-10" aria-live="polite">
      <span className="absolute top-1 left-0 flex size-[31px] items-center justify-center rounded-full border" style={{ borderColor: hsl(h, 100, 75, 0.5), background: hsl(h, 80, 30, 0.5) }}>
        <span className="absolute inset-[-4px] animate-spin rounded-full border-2 border-transparent [animation-duration:1.2s]" style={{ borderTopColor: hsl(h, 100, 78) }} />
        <Icon name={skills ? 'bolt' : 'mind'} size={15} style={{ color: hsl(h, 100, 85) }} />
      </span>
      <div className="relative overflow-hidden rounded-2xl border px-3.5 py-2.5" style={{ borderColor: hsl(h, 100, 75, 0.3), background: hsl(h, 70, 20, 0.25) }}>
        <div className="flex items-center gap-2 text-[13px]">
          <span className="font-medium" style={{ color: hsl(h, 100, 86) }}>
            {skills ? 'Running skills' : 'Thinking'}
          </span>
          <span className="flex gap-0.5" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <m.span key={i} className="size-1 rounded-full" style={{ background: hsl(h, 100, 80) }} animate={{ opacity: [0.2, 1, 0.2] }} transition={{ duration: 1, repeat: Infinity, delay: i * 0.18 }} />
            ))}
          </span>
          <span className="ml-auto font-mono text-[11px] text-ink-3 tabular-nums">{secs.toFixed(1)} s</span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <m.div className="h-full w-1/3 rounded-full" style={{ background: `linear-gradient(90deg, transparent, ${hsl(h, 100, 75)}, transparent)` }} animate={{ x: ['-100%', '300%'] }} transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut' }} />
        </div>
      </div>
    </m.li>
  )
}

function TraceItem({ trace: t, hue, head, expanded, onToggle, animateIn }: { trace: Trace; hue: number; head: boolean; expanded: boolean; onToggle: () => void; animateIn: boolean }) {
  const now = useNow(15_000)
  const reduced = useReducedMotion()
  const trg = trigger(t.input)
  const errors = t.commands.filter(isError).length
  const gates = t.commands.reduce<Record<GateDecision, number>>((acc, c) => (c.gated ? { ...acc, [c.gated]: acc[c.gated] + 1 } : acc), { allow: 0, ask: 0, deny: 0 })
  const lat = t.llm_ms ?? 0
  const latColor = lat < 1500 ? '#4ade80' : lat < 3000 ? '#fbbf24' : '#fb7185'
  const [thought, ...rest] = t.response.split('\n')
  const isCmdLine = (l: string) => l.trim().startsWith('(')
  const textLines = isCmdLine(thought) ? [] : [thought]
  const cmdLines = (isCmdLine(thought) ? [thought, ...rest] : rest).filter((l) => l.trim())

  return (
    <m.li
      layout={!reduced}
      initial={animateIn ? { opacity: 0, y: -14, scale: 0.98 } : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, height: 0, marginBottom: 0, transition: { duration: 0.18 } }}
      transition={{ type: 'spring', stiffness: 360, damping: 32 }}
      className="relative mb-3 pl-10"
    >
      <span
        className="absolute top-1 left-0 flex size-[31px] items-center justify-center rounded-full border"
        style={{
          borderColor: errors ? 'rgb(251 113 133 / 0.5)' : hsl(hue, 100, 75, head ? 0.6 : 0.25),
          background: errors ? 'rgb(60 10 24 / 0.9)' : hsl(hue, 60, head ? 26 : 16, 0.95),
          boxShadow: head ? `0 0 16px ${hsl(hue, 100, 60, 0.5)}` : undefined,
        }}
      >
        {head && animateIn && !reduced && <m.span className="absolute inset-0 rounded-full border" style={{ borderColor: hsl(hue, 100, 75) }} initial={{ scale: 1, opacity: 0.9 }} animate={{ scale: 2, opacity: 0 }} transition={{ duration: 1.1 }} />}
        <Icon name={trg.icon} size={14} style={{ color: errors ? '#fb7185' : hsl(hue, 100, head ? 86 : 74) }} />
      </span>

      <article className={cx('overflow-hidden rounded-2xl border bg-white/[0.025] transition-colors', head ? 'border-line-2' : 'border-line')}>
        <button onClick={onToggle} aria-expanded={expanded} className="block w-full px-3.5 pt-2.5 pb-2 text-left">
          <div className="flex items-center gap-2 text-[12px]">
            <span className="font-mono text-ink-3" title={`Trace ${t.id} · ${t.agent_id}`}>#{t.iteration}</span>
            <span className="font-medium text-ink">{trg.label}</span>
            <span className="ml-auto shrink-0 text-ink-4">{ago(t.created_at, now)}</span>
          </div>
          {trg.text && (
            <p className={cx('mt-1.5 rounded-xl px-2.5 py-1.5 text-[13px] leading-snug', trg.kind === 'message' ? 'bg-white/[0.06] text-ink-2' : 'border border-line bg-black/20 text-ink-3')}>
              {trg.kind === 'approved' ? <MeTTa src={trg.text} /> : <span className={cx(!expanded && 'line-clamp-2')}>{trg.text}</span>}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="inline-flex items-center gap-1 rounded-md border border-line bg-black/20 px-1.5 py-0.5 font-mono text-ink-2" title="Gateway latency of the model call">
              <Icon name="clock" size={11} />
              {seconds(t.llm_ms)}
              <span className="ml-0.5 h-1 w-8 overflow-hidden rounded-full bg-white/10">
                <span className="block h-full rounded-full" style={{ width: `${Math.min(100, (lat / 4000) * 100)}%`, background: latColor }} />
              </span>
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-line bg-black/20 px-1.5 py-0.5 font-mono text-ink-2" title="Tokens">
              <Icon name="token" size={11} />
              {tokens(t.tokens)}
            </span>
            {(['allow', 'ask', 'deny'] as const).map((g) =>
              gates[g] ? (
                <span key={g} className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-semibold" style={{ color: MODE_STYLE[g].color, background: MODE_STYLE[g].bg }}>
                  <Icon name={MODE_STYLE[g].icon} size={10} strokeWidth={2.6} />
                  {gates[g]}
                </span>
              ) : null,
            )}
            {errors > 0 && <span className="font-medium text-bad">{errors} error{errors > 1 ? 's' : ''}</span>}
            <Icon name="chevronDown" size={14} className={cx('ml-auto text-ink-4 transition-transform', expanded && 'rotate-180')} />
          </div>
        </button>

        <AnimatePresence initial={false}>
          {expanded && (
            <m.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 40 }} className="overflow-hidden">
              <div className="space-y-2.5 px-3.5 pb-3.5">
                <p className="break-all font-mono text-meta text-ink-4">Trace {t.id} · {t.created_at}</p>
                <div>
                  <div className="eyebrow mb-1 !text-[10px]">Model response</div>
                  <div className="rounded-xl border border-line bg-black/35 px-3 py-2 text-[12.5px] leading-relaxed">
                    {textLines.map((l, i) => (
                      <TypeOn key={`t${i}`} text={l} run={animateIn && head} className="text-ink-2" />
                    ))}
                    {cmdLines.length > 0 && (
                      <div className={cx('space-y-0.5 font-mono text-[11.5px] opacity-70', textLines.length > 0 && 'mt-1.5 border-t border-line pt-1.5')}>
                        {cmdLines.map((l, i) => (
                          <div key={`c${i}`} className="truncate">
                            <MeTTa src={l} wrap={false} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                {t.commands.length > 0 && (
                  <div>
                    <div className="eyebrow mb-1 !text-[10px]">Commands</div>
                    <ul className="space-y-1.5">
                      {t.commands.map((c, i) => (
                        <CommandRow key={i} c={c} agentId={t.agent_id} delay={animateIn && head && !reduced ? 0.25 + i * 0.18 : 0} />
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </m.div>
          )}
        </AnimatePresence>
      </article>
    </m.li>
  )
}

/** Reveals the thought like it is being written, once. */
function TypeOn({ text, run, className }: { text: string; run: boolean; className?: string }) {
  const reduced = useReducedMotion()
  const [n, setN] = useState(run && !reduced ? 0 : text.length)
  const raf = useRef(0)
  useEffect(() => {
    if (!run || reduced) return
    const t0 = performance.now()
    const tick = () => {
      const k = Math.min(text.length, Math.round(((performance.now() - t0) / 700) * text.length))
      setN(k)
      if (k < text.length) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [run, reduced, text])
  return (
    <p className={className} aria-label={text}>
      <span aria-hidden="true">{text.slice(0, n)}</span>
      {n < text.length && <span className="ml-px inline-block h-[1em] w-[2px] translate-y-[2px] animate-pulse bg-current" aria-hidden="true" />}
    </p>
  )
}

function CommandRow({ c, agentId, delay }: { c: TraceCommand; agentId: string; delay: number }) {
  const gate = c.gated ?? 'allow'
  const st = MODE_STYLE[gate]
  const approvalId = /\bp_[a-z0-9]+/i.exec(c.result)?.[0]
  const approval = useHive((s) =>
    gate === 'ask' ? (approvalId ? s.approvals[approvalId] : Object.values(s.approvals).find((a) => a.agent_id === agentId && a.command === c.command)) : undefined,
  )
  const err = isError(c)
  return (
    <m.li
      initial={delay ? { opacity: 0, x: -8 } : false}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, type: 'spring', stiffness: 400, damping: 30 }}
      className="relative overflow-hidden rounded-xl border bg-black/20"
      style={{ borderColor: gate === 'allow' && !err ? 'var(--color-line)' : `color-mix(in srgb, ${err && gate === 'allow' ? '#fb7185' : st.color} 35%, transparent)` }}
    >
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: err && gate === 'allow' ? '#fb7185' : st.color, opacity: gate === 'allow' && !err ? 0.45 : 0.9 }} />
      <div className="flex items-start gap-2 py-2 pr-2.5 pl-3">
        <span className="mt-0.5 inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-[10px] font-bold tracking-wide uppercase" style={{ color: st.color, background: st.bg }} title={`Gate: ${gate}`}>
          <Icon name={st.icon} size={10} strokeWidth={2.8} />
          {gate}
        </span>
        <div className="min-w-0 flex-1 text-[12.5px]">
          <MeTTa src={c.command} />
          <div className={cx('mt-1 font-mono text-[11.5px] leading-snug break-words', err ? 'text-bad/90' : 'text-ink-3')}>
            <span className="text-ink-4">→ </span>
            {gate === 'ask' ? <AskResult approval={approval} raw={c.result} /> : c.result}
          </div>
        </div>
      </div>
    </m.li>
  )
}

function AskResult({ approval, raw }: { approval: Approval | undefined; raw: string }) {
  if (!approval) return <>{raw}</>
  const label =
    approval.status === 'pending' ? 'awaiting approval' : approval.status === 'used' ? 'approved and ran' : approval.status === 'approved' ? 'approved' : approval.status === 'denied' ? 'denied by operator' : 'expired'
  const color = approval.status === 'pending' ? '#fbbf24' : approval.status === 'denied' ? '#fb7185' : approval.status === 'expired' ? '#8a89b3' : '#4ade80'
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      <span style={{ color }}>{label}</span>
      <button
        onClick={() => navigate({ name: 'approvals', tab: approval.status === 'pending' ? undefined : 'history', focus: approval.id })}
        className="inline-flex min-h-6 items-center gap-0.5 font-sans font-semibold text-warn underline-offset-2 hover:underline"
      >
        {approval.id}
        {approval.status === 'pending' && <span> · Review</span>}
        <Icon name="chevron" size={11} strokeWidth={2.4} />
      </button>
    </span>
  )
}
