import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Agent, Wakeup } from '../../api/types'
import { CRON_PRESETS, cronError, describeCron, isValidTz, localTz, nextRun, zonedToUtc } from '../../lib/cron'
import { hsl } from '../../lib/color'
import { cx } from '../../lib/cx'
import { ago, localWhen, until } from '../../lib/format'
import { useNow, useReducedMotion } from '../../lib/hooks'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Button, ErrorState, IconButton, Segmented, Skeleton, Switch } from '../../ui/primitives'
import { shown } from '../../lib/displayName'

const IDLE = [
  { label: 'Never', value: 0 },
  { label: '5m', value: 5 },
  { label: '15m', value: 15 },
  { label: '30m', value: 30 },
  { label: '1h', value: 60 },
  { label: '2h', value: 120 },
]

const ZONES = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  } catch {
    return []
  }
})()

export function Schedule({ agent }: { agent: Agent }) {
  const all = useHive((s) => s.wakeups)
  const loaded = useHive((s) => !!s.wakeupsLoaded[agent.id])
  const load = useHive((s) => s.loadWakeups)
  const [err, setErr] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)

  useEffect(() => {
    load(agent.id).then(() => setErr(null), (e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load wakeups'))
  }, [agent.id, load])

  const list = useMemo(
    () =>
      Object.values(all)
        .filter((w) => w.agent_id === agent.id)
        .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.next_run_at ?? '9').localeCompare(b.next_run_at ?? '9')),
    [all, agent.id],
  )

  return (
    <div className="space-y-6 px-4 pt-2 pb-6">
      <IdleSleep agent={agent} />

      <section aria-labelledby="wake-h" data-tour="schedule-wakeups">
        <div className="mb-2 flex items-center justify-between">
          <h3 id="wake-h" className="eyebrow">
            Wakeups {loaded ? `· ${list.length}` : ''}
          </h3>
          <Button variant={composing ? 'ghost' : 'subtle'} icon={composing ? 'x' : 'plus'} className="min-h-9 px-3 text-[13px]" onClick={() => setComposing(!composing)} aria-expanded={composing}>
            {composing ? 'Close' : 'New wakeup'}
          </Button>
        </div>
        <AnimatePresence initial={false}>
          {composing && (
            <m.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <Composer agent={agent} onDone={() => setComposing(false)} />
            </m.div>
          )}
        </AnimatePresence>
        {err && !loaded ? (
          <ErrorState title="Could not load wakeups" body={err} onRetry={() => load(agent.id).then(() => setErr(null), () => undefined)} />
        ) : !loaded ? (
          <div className="space-y-2">
            <Skeleton className="h-24 rounded-2xl" />
            <Skeleton className="h-24 rounded-2xl" />
          </div>
        ) : list.length === 0 ? (
          !composing && (
            <button onClick={() => setComposing(true)} className="flex w-full flex-col items-center gap-1.5 rounded-2xl border border-dashed border-line px-4 py-7 text-center transition-colors hover:border-line-2">
              <Icon name="calendar" size={22} className="text-ink-3" />
              <span className="text-sm font-medium">No wakeups</span>
              <span className="text-[12px] text-ink-4">Schedule {shown(agent.name)} to wake and act on its own, once or on a cron.</span>
            </button>
          )
        ) : (
          <ul className="space-y-2">
            <AnimatePresence initial={false}>
              {list.map((w) => (
                <WakeupCard key={w.id} w={w} hue={agent.hue} />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </section>
    </div>
  )
}

function IdleSleep({ agent }: { agent: Agent }) {
  const patch = useHive((s) => s.patchAgent)
  const [saving, setSaving] = useState<number | null>(null)
  const supported = agent.idle_sleep_minutes !== undefined
  const cur = saving ?? agent.idle_sleep_minutes ?? 0
  // a value set elsewhere (API, CLI) that is not a preset still gets its own chip
  const options = IDLE.some((o) => o.value === cur) ? IDLE : [...IDLE, { label: cur >= 60 && cur % 60 === 0 ? `${cur / 60}h` : `${cur}m`, value: cur }].sort((a, b) => a.value - b.value)
  const set = async (v: number) => {
    if (v === agent.idle_sleep_minutes) return
    setSaving(v)
    await patch(agent.id, { idle_sleep_minutes: v })
    setSaving(null)
  }
  return (
    <section aria-labelledby="idle-h" className="rounded-2xl border border-line bg-tint/[0.025] p-3.5" data-tour="schedule-idle">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl" style={{ background: hsl(235, 70, 55, 0.16), color: '#a5b4fc' }}>
          <Icon name="moon" size={18} />
        </span>
        <div className="min-w-0">
          <h3 id="idle-h" className="text-sm font-medium">
            Auto-sleep when idle
          </h3>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-3">
            {cur === 0
              ? `${shown(agent.name)} stays awake until you put it to sleep.`
              : `${shown(agent.name)} sleeps after ${cur >= 60 ? `${cur / 60} h` : `${cur} min`} without a message or wakeup. Either one wakes it.`}
          </p>
        </div>
      </div>
      <div role="radiogroup" aria-labelledby="idle-h" className="mt-3 grid gap-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map((o) => {
          const on = o.value === cur
          return (
            <button
              key={o.value}
              role="radio"
              aria-checked={on}
              disabled={!supported || saving !== null}
              onClick={() => set(o.value)}
              className={cx('relative min-h-10 rounded-lg text-[12.5px] font-medium transition-colors disabled:cursor-default', on ? 'text-ink' : 'text-ink-3 hover:bg-tint/[0.04] hover:text-ink-2')}
            >
              {on && <m.span layoutId={`idle-${agent.id}`} className="absolute inset-0 rounded-lg border" style={{ borderColor: '#a5b4fc66', background: 'color-mix(in oklab, var(--color-ink) 12%, transparent)' }} transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
              <span className="relative">{o.label}</span>
            </button>
          )
        })}
      </div>
      {!supported && <p className="mt-2 text-[11px] text-ink-4">This server does not report idle_sleep_minutes yet.</p>}
    </section>
  )
}

function WakeupCard({ w, hue }: { w: Wakeup; hue: number }) {
  const patchW = useHive((s) => s.patchWakeup)
  const del = useHive((s) => s.deleteWakeup)
  const fired = useHive((s) => s.wakeFired[w.id])
  const now = useNow(20_000)
  const reduced = useReducedMotion()
  const [confirm, setConfirm] = useState(false)
  const tz = localTz()
  const words = w.cron ? describeCron(w.cron) : null
  const title = w.cron ? (words ?? 'Custom schedule') : w.at ? `Once · ${localWhen(w.at)}` : 'Wakeup'
  const sun = 42

  useEffect(() => {
    if (!confirm) return
    const t = setTimeout(() => setConfirm(false), 3500)
    return () => clearTimeout(t)
  }, [confirm])

  return (
    <m.li
      layout={!reduced}
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, transition: { duration: 0.2 } }}
      className={cx('relative overflow-hidden rounded-2xl border bg-tint/[0.025] transition-colors', w.enabled ? 'border-line' : 'border-line opacity-70')}
    >
      {fired && !reduced && (
        <m.span
          key={fired}
          className="pointer-events-none absolute inset-0 rounded-2xl"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 2.4, ease: 'easeOut' }}
          style={{ background: `radial-gradient(80% 120% at 0% 0%, ${hsl(sun, 100, 60, 0.35)}, transparent 70%)`, boxShadow: `inset 0 0 0 1px ${hsl(sun, 100, 70, 0.7)}` }}
        />
      )}
      <div className="relative flex items-start gap-3 p-3.5">
        <span
          className="relative mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl"
          style={{ background: w.enabled ? hsl(sun, 90, 55, 0.14) : 'color-mix(in oklab, var(--color-ink) 5%, transparent)', color: w.enabled ? hsl(sun, 100, 72) : 'var(--color-ink-4)' }}
        >
          <Icon name={w.cron ? 'calendar' : 'clock'} size={18} />
          {fired && !reduced && <m.span key={fired} className="absolute inset-0 rounded-xl border-2" style={{ borderColor: hsl(sun, 100, 70) }} initial={{ scale: 1, opacity: 1 }} animate={{ scale: 1.9, opacity: 0 }} transition={{ duration: 1.2 }} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[14px] font-medium">{title}</span>
            {w.cron && <code className="font-mono text-[11px] text-ink-4">{w.cron}</code>}
          </div>
          <p className="mt-0.5 text-[13px] leading-snug text-ink-2">“{w.text}”</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11.5px] text-ink-3">
            {w.enabled && w.next_run_at ? (
              <span className="inline-flex items-center gap-1" title={new Date(w.next_run_at).toString()}>
                <span className="size-1.5 rounded-full" style={{ background: hsl(sun, 100, 65), boxShadow: `0 0 6px ${hsl(sun, 100, 60)}` }} />
                Next {until(w.next_run_at, now)}
                {w.cron && (
                  <>
                    {' '}
                    · <span className="text-ink-2">{localWhen(w.next_run_at)}</span>
                  </>
                )}
              </span>
            ) : (
              <span>{w.enabled ? 'No upcoming run' : w.at && w.last_run_at ? 'Done' : 'Paused'}</span>
            )}
            {w.tz !== tz && <span className="rounded border border-line px-1 font-mono text-[10px] text-ink-4">{w.tz}</span>}
            {w.last_run_at && <span className="text-ink-4">last {ago(w.last_run_at, now)}</span>}
          </div>
        </div>
        <div className="-mt-1.5 -mr-1 flex shrink-0 flex-col items-end">
          <Switch checked={w.enabled} onChange={(v) => patchW(w.id, { enabled: v })} label={`${w.enabled ? 'Pause' : 'Enable'} wakeup`} hue={sun} disabled={!!w.at && !w.enabled && !!w.last_run_at} />
          <AnimatePresence mode="wait" initial={false}>
            {confirm ? (
              <m.button key="c" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} onClick={() => void del(w.id)} className="min-h-9 rounded-lg bg-bad/15 px-2.5 text-[12px] font-semibold text-bad">
                Delete
              </m.button>
            ) : (
              <m.div key="t" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <IconButton icon="trash" label="Delete wakeup" size={16} className="size-9 text-ink-4 hover:text-bad" onClick={() => setConfirm(true)} />
              </m.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      <span className="pointer-events-none absolute -right-8 -bottom-10 size-28 rounded-full opacity-40" style={{ background: `radial-gradient(circle, ${hsl(hue, 90, 55, 0.25)}, transparent 70%)` }} />
    </m.li>
  )
}

const pad = (n: number) => String(n).padStart(2, '0')
function defaultOnce(): string {
  const d = new Date(Date.now() + 3_600_000)
  d.setMinutes(0, 0, 0)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function Composer({ agent, onDone }: { agent: Agent; onDone: () => void }) {
  const create = useHive((s) => s.createWakeup)
  const [kind, setKind] = useState<'cron' | 'once'>('cron')
  const [cron, setCron] = useState('0 9 * * 1-5')
  const [once, setOnce] = useState(defaultOnce)
  const [tz, setTz] = useState(localTz)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const now = useNow(30_000)

  const tzOk = isValidTz(tz)
  const cErr = kind === 'cron' ? cronError(cron) : null
  const onceIso = kind === 'once' && tzOk ? zonedToUtc(once, tz) : null
  const preview = useMemo(() => {
    if (!tzOk) return { ok: false, text: 'Unknown time zone' }
    if (kind === 'cron') {
      if (cErr) return { ok: false, text: cErr }
      const nx = nextRun(cron, tz, now)
      return { ok: true, text: `${describeCron(cron) ?? 'Custom schedule'}${nx ? ` · next ${localWhen(nx.toISOString())} your time` : ''}` }
    }
    if (!onceIso) return { ok: false, text: 'Pick a date and time' }
    if (Date.parse(onceIso) <= now) return { ok: false, text: 'That time has passed' }
    return { ok: true, text: `Once, ${until(onceIso, now)} · ${localWhen(onceIso)} your time` }
  }, [kind, cron, cErr, onceIso, tz, tzOk, now])

  const valid = preview.ok && text.trim().length > 0
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    const w = await create(agent.id, kind === 'cron' ? { cron: cron.trim(), tz, text: text.trim() } : { at: onceIso!, tz, text: text.trim() })
    setBusy(false)
    if (w) {
      setText('')
      onDone()
    }
  }

  return (
    <form onSubmit={submit} className="mb-3 space-y-3 rounded-2xl border border-line-2 bg-shade/25 p-3.5">
      <Segmented
        label="Wakeup kind"
        value={kind}
        onChange={setKind}
        className="w-full"
        options={[
          { value: 'cron', label: 'Repeat (cron)' },
          { value: 'once', label: 'Once' },
        ]}
      />
      {kind === 'cron' ? (
        <div className="space-y-2">
          <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1">
            {CRON_PRESETS.map((p) => (
              <button
                key={p.cron}
                type="button"
                onClick={() => setCron(p.cron)}
                className={cx('min-h-9 shrink-0 rounded-lg border px-2.5 text-[12px] font-medium whitespace-nowrap transition-colors', cron === p.cron ? 'border-line-2 bg-tint/[0.09] text-ink' : 'border-line text-ink-3 hover:text-ink-2')}
              >
                {p.label}
              </button>
            ))}
          </div>
          <label className="block">
            <span className="sr-only">Cron expression</span>
            <input
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              className="min-h-11 w-full rounded-xl border bg-shade/30 px-3 font-mono text-[14px] text-ink outline-none"
              style={{ borderColor: cErr ? 'color-mix(in oklab, var(--color-bad) 50%, transparent)' : 'var(--color-line)' }}
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={!!cErr}
              aria-describedby="cron-preview"
            />
          </label>
          <div className="grid grid-cols-5 gap-1 px-0.5 font-mono text-[9.5px] tracking-wide text-ink-4 uppercase" aria-hidden="true">
            {['min', 'hour', 'day', 'month', 'weekday'].map((x) => (
              <span key={x}>{x}</span>
            ))}
          </div>
        </div>
      ) : (
        <label className="block">
          <span className="mb-1 block text-[12px] text-ink-3">When (wall clock in the zone below)</span>
          <input type="datetime-local" value={once} onChange={(e) => setOnce(e.target.value)} className="min-h-11 w-full rounded-xl border border-line bg-shade/30 px-3 font-mono text-[14px] text-ink outline-none [color-scheme:dark] focus:border-line-2" />
        </label>
      )}
      <label className="block">
        <span className="mb-1 block text-[12px] text-ink-3">Time zone</span>
        <input
          value={tz}
          onChange={(e) => setTz(e.target.value.trim())}
          list="tz-list"
          autoCapitalize="off"
          spellCheck={false}
          className="min-h-11 w-full rounded-xl border bg-shade/30 px-3 font-mono text-[14px] text-ink outline-none"
          style={{ borderColor: tzOk ? 'var(--color-line)' : 'color-mix(in oklab, var(--color-bad) 50%, transparent)' }}
        />
        <datalist id="tz-list">
          {['UTC', localTz(), ...ZONES].filter((z, i, a) => a.indexOf(z) === i).map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
      </label>
      <p id="cron-preview" className={cx('flex items-start gap-1.5 text-[12px]', preview.ok ? 'text-ink-2' : 'text-bad')} aria-live="polite">
        <Icon name={preview.ok ? 'calendar' : 'alert'} size={13} className="mt-px shrink-0" />
        {preview.text}
      </p>
      <label className="block">
        <span className="mb-1 block text-[12px] text-ink-3">What should {shown(agent.name)} do when it wakes?</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="Pull fresh photometry and revise variable stars."
          className="w-full resize-none rounded-xl border border-line bg-shade/30 p-3 text-[14px] leading-snug text-ink outline-none placeholder:text-ink-4 focus:border-line-2"
        />
      </label>
      <Button type="submit" variant="primary" hue={42} icon="calendar" disabled={!valid || busy} className="w-full">
        {busy ? 'Scheduling…' : 'Schedule wakeup'}
      </Button>
    </form>
  )
}
