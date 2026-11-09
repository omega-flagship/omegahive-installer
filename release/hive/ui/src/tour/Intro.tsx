import { m } from 'framer-motion'
import { useEffect, useRef, type ReactNode } from 'react'
import { isDemoClient } from '../features/showreel/hook'
import { useEscape, useIsDesktop, useReducedMotion } from '../lib/hooks'
import { useHive } from '../store/store'
import { Icon, type IconName } from '../ui/Icon'
import { LivingMark } from '../brand/LivingMark'
import { useLook } from '../shell/uiVariant'
import { Kbd } from '../ui/primitives'
import { CHAPTERS } from './chapters'
import { useIntro } from './introStore'
import { useModalContainment } from '../ui/useModalContainment'

const FEATURES: { icon: IconName; label: string }[] = [
  { icon: 'hive', label: 'Minds' },
  { icon: 'swarms', label: 'Swarms' },
  { icon: 'orbit', label: 'Commons' },
  { icon: 'target', label: 'Tasks' },
  { icon: 'inbox', label: 'Inbox' },
  { icon: 'apps', label: 'Apps' },
]

/** The first-run welcome, over the live hive: what this is, then the tour or explore. */
export function Welcome() {
  const answer = useIntro((s) => s.answerWelcome)
  const sim = useHive((s) => s.client?.mode === 'sim')
  // demo mode only (the simulator with invented people): the showreel is a third choice here, so this dialog never
  // stands between a first visit and the demo card's own "Watch it run"
  const demo = useHive((s) => isDemoClient(s.client))
  const desktop = useIsDesktop()
  const reduced = useReducedMotion()
  const primary = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLElement>(null)
  useEscape(() => answer('explore'))
  useModalContainment(box)
  useEffect(() => {
    const t = setTimeout(() => primary.current?.focus({ preventScroll: true }), 350)
    return () => clearTimeout(t)
  }, [])

  return (
    <m.div
      className="fixed inset-0 z-[90] flex items-end justify-center md:items-center md:p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.3 } }}
      transition={{ duration: 0.6 }}
      style={{ background: 'radial-gradient(120% 85% at 50% 38%, color-mix(in oklab, var(--color-void) 5%, transparent), color-mix(in oklab, var(--color-void) 55%, transparent) 55%, color-mix(in oklab, var(--color-void) 86%, transparent))' }}
    >
      <m.section
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        aria-describedby="welcome-body"
        initial={{ opacity: 0, y: reduced ? 0 : desktop ? 18 : 60, scale: reduced || !desktop ? 1 : 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: reduced ? 0 : 12, transition: { duration: 0.22 } }}
        transition={{ type: 'spring', stiffness: 220, damping: 30, delay: 0.25 }}
        className="glass-strong relative w-full overflow-hidden rounded-t-[28px] px-5 pt-6 md:max-w-[540px] md:rounded-[28px] md:px-8 md:pt-8 md:pb-7"
        style={desktop ? undefined : { paddingBottom: 'calc(var(--sab) + 18px)' }}
      >
        <div className="pointer-events-none absolute -top-36 left-1/2 size-[420px] -translate-x-1/2 rounded-full opacity-70" style={{ background: 'radial-gradient(circle, color-mix(in oklab, var(--color-accent) 28%, transparent), transparent 65%)' }} aria-hidden="true" />
        <div className="relative">
          <BrandMark />
          <div className="eyebrow mt-5">Welcome to</div>
          <h1 id="welcome-title" className="mt-1 font-display text-[30px] leading-[1.05] font-semibold tracking-tight md:text-[36px]">
            Omega<span className="text-ink-3">Hive</span>
          </h1>
          <p id="welcome-body" className="mt-3 text-[15px] leading-relaxed text-ink-2 md:text-[15.5px]">
            A hive of always-on AI minds. They live in swarms and share a commons of beliefs, each backed by evidence. They take on tasks, ask you before anything risky, and run programs that turn their work into maps you can explore.
          </p>
          <ul className="mt-4 flex flex-wrap gap-1.5" aria-label="What you will meet">
            {FEATURES.map((f, i) => (
              <m.li
                key={f.label}
                initial={{ opacity: 0, y: reduced ? 0 : 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.45 + i * 0.05 }}
                className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-line bg-tint/[0.04] py-1 pr-3 pl-2 text-[12.5px] text-ink-2"
              >
                <Icon name={f.icon} size={14} className="text-accent" />
                {f.label}
              </m.li>
            ))}
          </ul>
          {sim && (
            <p className="mt-4 flex items-start gap-2 rounded-xl border border-warn/20 bg-warn/[0.05] px-3 py-2 text-[12.5px] leading-snug text-ink-3">
              <Icon name="info" size={14} className="mt-0.5 shrink-0 text-warn" />
              <span>
                <b className="font-semibold text-warn">Simulation.</b> The minds, the evidence they share and their costs are invented, in your browser. The reasoning over it is real: the shared beliefs are revised by the hive’s own MeTTa (lib_nal and lib_hive), running here in the page. No model is called and nothing is charged.
              </span>
            </p>
          )}
          <div className="mt-6 flex flex-col gap-2 md:flex-row-reverse">
            <button
              ref={primary}
              onClick={() => answer('tour')}
              className="relative flex min-h-13 flex-1 items-center justify-center gap-2.5 rounded-2xl px-5 text-[15px] font-semibold text-primary-ink transition-[transform,filter] hover:brightness-110 active:scale-[0.98]"
              style={{ background: 'linear-gradient(180deg, #ece7ff, #b3a3ff)', boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-ink) 30%, transparent) inset, 0 12px 36px -8px color-mix(in oklab, var(--color-accent) 85%, transparent)' }}
            >
              <span className="flex size-7 items-center justify-center rounded-full bg-primary-ink/10">
                <Icon name="play" size={14} strokeWidth={2.6} />
              </span>
              <span className="whitespace-nowrap">Watch the tour <span className="font-medium text-primary-ink/65">(about 2 min)</span></span>
            </button>
            <button onClick={() => answer('explore')} className="flex min-h-13 items-center justify-center gap-2 rounded-2xl border border-line bg-tint/[0.04] px-5 text-[15px] font-medium text-ink-2 transition-colors hover:border-line-2 hover:text-ink md:flex-none">
              Explore on my own
            </button>
          </div>
          {demo && (
            <button
              type="button"
              onClick={() => answer('showreel')}
              className="mt-2 flex min-h-13 w-full items-center justify-center gap-2 rounded-2xl border border-line bg-tint/[0.04] px-5 text-[15px] font-medium text-ink-2 transition-colors hover:border-line-2 hover:text-ink"
              data-welcome-showreel=""
            >
              <Icon name="play" size={14} strokeWidth={2.6} />
              Watch it run
            </button>
          )}
          <p className="mt-3 text-center text-[11.5px] text-ink-4 md:text-left">
            {desktop ? (
              <>
                Voice and captions · <Kbd>Space</Kbd> pauses · <Kbd>Esc</Kbd> leaves · <Kbd>?</Kbd> brings it back
              </>
            ) : (
              'With voice and captions. Replay it any time from the ⋯ menu.'
            )}
          </p>
        </div>
      </m.section>
    </m.div>
  )
}

function BrandMark() {
  const experience = useLook().current?.experience ?? 'classic'   // the welcome wears the experience it is shown in
  return <LivingMark look={experience} className="size-12" />
}

// ---------------------------------------------------------------- help sheet

const GROUPS: { title: string; rows: [ReactNode, string][] }[] = [
  {
    title: 'Everywhere',
    rows: [
      [<><Kbd>⌘</Kbd><Kbd>K</Kbd></>, 'Jump to a mind, swarm or command'],
      [<Kbd>/</Kbd>, 'Search'],
      [<Kbd>N</Kbd>, 'New mind'],
      [<Kbd>?</Kbd>, 'This help'],
      [<Kbd>Esc</Kbd>, 'Close the top panel'],
    ],
  },
  {
    title: 'Go to',
    rows: [
      [<><Kbd>G</Kbd><Kbd>H</Kbd></>, 'Hive'],
      [<><Kbd>G</Kbd><Kbd>S</Kbd></>, 'Swarms'],
      [<><Kbd>G</Kbd><Kbd>I</Kbd></>, 'Inbox'],
      [<><Kbd>G</Kbd><Kbd>W</Kbd></>, 'Motivations'],
      [<><Kbd>G</Kbd><Kbd>G</Kbd></>, 'Tasks'],
      [<><Kbd>G</Kbd><Kbd>E</Kbd></>, 'Health'],
      [<><Kbd>G</Kbd><Kbd>U</Kbd></>, 'Usage'],
      [<><Kbd>G</Kbd><Kbd>L</Kbd></>, 'Lab'],
      [<><Kbd>G</Kbd><Kbd>P</Kbd></>, 'Apps'],
      [<><Kbd>G</Kbd><Kbd>A</Kbd></>, 'Add an outside agent'],
      [<><Kbd>G</Kbd><Kbd>K</Kbd></>, 'You & your keys'],
    ],
  },
  {
    title: 'In an app',
    rows: [
      [<><Kbd>1</Kbd>–<Kbd>4</Kbd></>, 'Unfold, Map, Compare, Detail'],
      [<><Kbd>⌫</Kbd> or <Kbd>Alt</Kbd><Kbd>←</Kbd></>, 'Back one step'],
    ],
  },
  {
    title: 'During the tour',
    rows: [
      [<Kbd>Space</Kbd>, 'Pause or play'],
      [<><Kbd>←</Kbd><Kbd>→</Kbd></>, 'Previous or next chapter'],
      [<Kbd>Esc</Kbd>, 'Leave the tour'],
    ],
  },
]

export function HelpSheet() {
  const setHelp = useIntro((s) => s.setHelp)
  const startTour = useIntro((s) => s.startTour)
  const desktop = useIsDesktop()
  const close = () => setHelp(false)
  useEscape(close)
  const first = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLElement>(null)
  useModalContainment(box)
  useEffect(() => {
    const t = setTimeout(() => first.current?.focus({ preventScroll: true }), 60)
    return () => clearTimeout(t)
  }, [])
  return (
    <m.div className="xc-dress xc-backdrop fixed inset-0 z-[60] flex items-end justify-center bg-[#03030c]/65 backdrop-blur-[3px] md:items-center md:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={close}>
      <m.section
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label="Help and shortcuts"
        initial={{ opacity: 0, y: desktop ? 12 : 50 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: desktop ? 8 : 40, transition: { duration: 0.16 } }}
        transition={{ type: 'spring', stiffness: 420, damping: 38 }}
        onClick={(e) => e.stopPropagation()}
        className="xc-frame xc-flush-b glass-strong flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-[26px] md:max-w-[640px] md:rounded-[24px]"
        style={desktop ? undefined : { paddingBottom: 'var(--sab)' }}
      >
        <header className="flex items-center gap-2 px-5 pt-5 pb-3">
          <div className="min-w-0 flex-1">
            <div className="eyebrow">Help</div>
            <h2 className="font-display text-[22px] font-semibold tracking-tight">Find your way around</h2>
          </div>
          <button onClick={close} className="-mr-2 flex size-11 items-center justify-center rounded-xl text-ink-2 hover:bg-tint/[0.07] hover:text-ink" aria-label="Close help">
            <Icon name="x" size={20} />
          </button>
        </header>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-6">
          <section className="relative overflow-hidden rounded-[20px] border border-line bg-tint/[0.03] p-4" aria-label="Guided tour">
            <div className="pointer-events-none absolute -top-20 -right-10 size-56 rounded-full" style={{ background: 'radial-gradient(circle, color-mix(in oklab, var(--color-accent) 22%, transparent), transparent 70%)' }} aria-hidden="true" />
            <div className="relative flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1 basis-56">
                <div className="font-display text-[16px] font-semibold">The guided tour</div>
                <p className="mt-0.5 text-[13px] leading-snug text-ink-3">About two minutes, narrated and captioned. It drives the real app, then puts everything back.</p>
              </div>
              <button
                ref={first}
                onClick={() => startTour({})}
                className="flex min-h-11 items-center gap-2 rounded-xl px-4 text-[14px] font-semibold text-primary-ink hover:brightness-110"
                style={{ background: 'linear-gradient(180deg, #ece7ff, #b3a3ff)', boxShadow: '0 8px 26px -8px color-mix(in oklab, var(--color-accent) 85%, transparent)' }}
              >
                <Icon name="play" size={15} strokeWidth={2.6} />
                Replay the tour
              </button>
            </div>
            <div className="relative mt-3 flex flex-wrap gap-1.5" aria-label="Start at a chapter">
              {CHAPTERS.map((c, i) => (
                <button key={c.id} onClick={() => startTour({ chapter: c.id })} className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-line bg-shade/20 py-0.5 pr-2.5 pl-1 text-[12px] text-ink-2 transition-colors hover:border-line-2 hover:text-ink" title={c.blurb}>
                  <span className="flex size-5 items-center justify-center rounded-full bg-tint/[0.07] font-mono text-[10px] text-ink-3">{i + 1}</span>
                  {c.title}
                </button>
              ))}
            </div>
          </section>
          <div className="mt-5 grid gap-x-8 gap-y-5 md:grid-cols-2">
            {GROUPS.map((g) => (
              <section key={g.title} aria-label={g.title}>
                <h3 className="eyebrow mb-2">{g.title}</h3>
                <dl className="space-y-1">
                  {g.rows.map(([keys, what], i) => (
                    <div key={i} className="flex min-h-8 items-center justify-between gap-3 text-[13px]">
                      <dt className="text-ink-2">{what}</dt>
                      <dd className="flex shrink-0 items-center gap-1 text-[11px] text-ink-4">{keys}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
          <p className="mt-5 text-[12px] leading-relaxed text-ink-4">
            Every view has a <Icon name="question" size={13} className="inline -translate-y-px" /> button that says what it is for, with a “Show me” that plays just that part of the tour.
          </p>
        </div>
      </m.section>
    </m.div>
  )
}
