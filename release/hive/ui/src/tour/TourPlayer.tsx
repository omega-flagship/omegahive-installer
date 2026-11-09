import { AnimatePresence, m } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cx } from '../lib/cx'
import { useIsDesktop, useReducedMotion } from '../lib/hooks'
import { navigate, type Route } from '../lib/router'
import { useScene } from '../scene/sceneStore'
import { newSession, sessionKey, type ProgramSession } from '../store/programSession'
import { useHive } from '../store/store'
import { Icon, type IconName } from '../ui/Icon'
import { useIntro, type TourRequest } from './introStore'
import { chapterMs, estimateMs, initialState, RATES, TourRunner, type TourState } from './machine'
import { browserRestoreEnv, restoreSnapshot, takeSnapshot, type Snapshot } from './restore'
import { buildChapters, type Chapter, type Rect, type Target, type TourCtx } from './script'
import { beatPreparer, type ReportRow } from './prepare'
import { browserSpeech, englishVoices, loadVoices, pickVoice, speechSupported } from './speech'
import { KEYS, readKey, writeKey } from './storage'
import { shown } from '../lib/displayName'
import { timeJump } from '../brand/timeJump'

// ---------------------------------------------------------------- geometry

type Box = { x: number; y: number; w: number; h: number; round: boolean }

function rectOf(t: Element | Rect | null): Box | null {
  if (!t) return null
  if (t instanceof Element) {
    const r = t.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return null
    return { x: r.left, y: r.top, w: r.width, h: r.height, round: false }
  }
  return { x: t.x, y: t.y, w: t.w, h: t.h, round: !!t.round }
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return false
  return !el.closest('[aria-hidden="true"]')
}

function findTour(name: string): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(`[data-tour="${CSS.escape(name)}"]`)
  for (const el of all) if (visible(el)) return el
  return null
}

/** Where the pointer rests: small things at their centre, big panels near their top-left so it never hides the content. */
function aim(b: Box) {
  if (b.round || (b.w < 260 && b.h < 150)) return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  return { x: b.x + Math.min(b.w / 2, 120), y: b.y + Math.min(b.h / 2, 46) }
}

/** The app's real route, store and storage, for the snapshot taken before the tour and restored after. */
const restoreEnv = () => browserRestoreEnv({ getState: () => useHive.getState(), setState: (p) => useHive.setState(p) })

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

declare global {
  interface Window {
    /** Tour state for automated checks (the end-to-end script reads `report`). */
    __hiveTour?: { state: () => TourState | null; report: ReportRow[]; setRate(r: number): void; close(): void; done: boolean }
  }
}

// ---------------------------------------------------------------- the player

export default function TourPlayer({ request }: { request: TourRequest }) {
  const desktop = useIsDesktop()
  const reduced = useReducedMotion()
  const sim = useHive((s) => s.client?.mode === 'sim')
  const endTour = useIntro((s) => s.endTour)
  const mobile = !desktop

  // settings, remembered when storage allows
  const [rate, setRateState] = useState(() => {
    const r = Number(readKey(KEYS.rate))
    return (RATES as readonly number[]).includes(r) ? r : 1
  })
  const [captions, setCaptions] = useState(() => readKey(KEYS.captions) !== 'off')
  const [voiceUri, setVoiceUri] = useState<string | null>(() => readKey(KEYS.voice))
  const [voices, setVoices] = useState<SpeechSynthesisVoice[] | null>(null)
  const [state, setState] = useState<TourState | null>(null)
  const [narrating, setNarrating] = useState<{ chapter: number; beat: number } | null>(null)
  /** A beat skipped because its subject is not on screen: its note shows instead of the caption (followups-r6). */
  const [skipped, setSkipped] = useState<{ chapter: number; beat: number; note: string } | null>(null)
  const [spokenTo, setSpokenTo] = useState(-1)
  const [panel, setPanel] = useState<'chapters' | 'settings' | null>(null)
  const [dockTop, setDockTop] = useState(false)
  const dockTopRef = useRef(false)
  const [clicks, setClicks] = useState(0)

  const runner = useRef<TourRunner<Chapter> | null>(null)
  const snap = useRef<Snapshot<ProgramSession> | null>(null)
  const finished = useRef(false)
  const report = useRef<ReportRow[]>([])
  const rateRef = useRef(rate)
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null)
  const playBtn = useRef<HTMLButtonElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const spotRef = useRef<HTMLDivElement>(null)
  const dimRef = useRef<HTMLDivElement>(null)
  const pointerRef = useRef<HTMLDivElement>(null)
  const target = useRef<{ t: Target; el: Element | null; seq: number } | null>(null)
  const targetSeq = useRef(0)
  const glide = useRef<{ from: { x: number; y: number }; t0: number; dur: number } | null>(null)
  const pointerPos = useRef<{ x: number; y: number } | null>(null)
  const pointerShown = useRef(false)

  // ---- the context the script runs against
  const ctx = useMemo<TourCtx>(() => {
    const scaled = (ms: number) => ms / Math.max(1, rateRef.current)
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, scaled(ms)))
    return {
      mobile,
      sim,
      store: () => useHive.getState(),
      go: (route: Route) => navigate(route, { replace: true }),
      sleep,
      find: findTour,
      async waitFor(name, ms = 3000) {
        const until = performance.now() + ms
        for (;;) {
          const el = findTour(name)
          if (el || performance.now() > until) return el
          await new Promise((r) => setTimeout(r, 80))
        }
      },
      freshProgram(programId, swarmId) {
        const key = sessionKey(programId, swarmId)
        const old = useHive.getState().programSessions[key]
        const fresh = newSession(programId, swarmId)
        if (old?.graph) {
          fresh.graph = old.graph
          fresh.trail = [{ stage: 'unfold', focus: old.graph.focus ?? null }]
        }
        useHive.setState((s) => ({ programSessions: { ...s.programSessions, [key]: fresh } }))
      },
      scene: {
        overview: () => useScene.getState().engine?.overview(),
        dot: (id) => useScene.getState().engine?.screenPos(id) ?? null,
        core: (id) => useScene.getState().engine?.corePos(id) ?? null,
      },
    }
    // the tour is built once per run; device changes mid-tour keep the original script
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const chapters = useMemo(() => buildChapters(ctx), [ctx])
  const totals = useMemo(() => chapters.map((c) => chapterMs(c, rate)), [chapters, rate])

  // ---- spotlight + pointer targets
  const resolve = useCallback(
    async (t: Target, ms = 2600): Promise<Element | Rect | null> => {
      const until = performance.now() + ms
      for (;;) {
        const got = typeof t === 'string' ? findTour(t) : t(ctx)
        if (got && rectOf(got)) return got
        if (performance.now() > until) return null
        await new Promise((r) => setTimeout(r, 80))
      }
    },
    [ctx],
  )

  const setTarget = useCallback(
    (t: Target | null, el: Element | null) => {
      if (!t) {
        target.current = null
        pointerShown.current = false
        return
      }
      const seq = ++targetSeq.current
      target.current = { t, el, seq }
      const now = performance.now()
      const from = pointerPos.current
      glide.current = from && !reduced ? { from, t0: now, dur: 720 / Math.sqrt(Math.max(1, rateRef.current)) } : null
      pointerShown.current = true
    },
    [reduced],
  )

  const reveal = useCallback(
    async (got: Element | Rect) => {
      if (!(got instanceof Element)) return
      const r = got.getBoundingClientRect()
      const vh = window.innerHeight
      const vw = window.innerWidth
      if (r.top < 56 || r.bottom > vh - 56 || r.left < 0 || r.right > vw) {
        got.scrollIntoView({ block: r.height > vh * 0.6 ? 'start' : 'center', inline: 'center', behavior: reduced ? 'auto' : 'smooth' })
        await ctx.sleep(reduced ? 120 : 480)
      }
    },
    [ctx, reduced],
  )

  const prepare = useMemo(
    () =>
      beatPreparer({
        chapters,
        ctx,
        reduced,
        resolve,
        reveal,
        setTarget,
        hasTarget: () => !!target.current,
        click: () => setClicks((n) => n + 1),
        begin: (row) => {
          report.current.push(row)
          setNarrating(null)
          setSkipped(null)
        },
      }),
    [chapters, ctx, resolve, reveal, setTarget, reduced],
  )

  // ---- finish: put the app back, remove tour-only state
  const finish = useCallback(
    (how: 'ended' | 'closed') => {
      if (finished.current) return
      finished.current = true
      runner.current?.destroy()
      if (snap.current) restoreSnapshot(restoreEnv(), snap.current)
      if (window.__hiveTour) window.__hiveTour.done = true
      endTour()
      const toast = useHive.getState().toast
      if (how === 'ended' && !request.only)
        toast({ tone: 'success', icon: 'compass', title: 'That’s the tour', body: desktop ? 'Press ? any time for shortcuts, or to watch it again.' : 'Watch it again any time from the ⋯ menu.', ttl: 6000 })
    },
    [endTour, request.only, desktop],
  )

  // ---- start: snapshot, voices, runner
  useEffect(() => {
    snap.current = takeSnapshot(restoreEnv(), request.returnTo)
    report.current = []
    let alive = true
    window.__hiveTour = {
      state: () => runner.current?.state ?? null,
      report: report.current,
      setRate: (r) => {
        rateRef.current = r
        runner.current?.dispatch({ type: 'rate', rate: r })
      },
      close: () => finish('closed'),
      done: false,
    }
    void loadVoices(speechSupported() ? 1200 : 0).then((list) => {
      if (!alive) return
      const english = englishVoices(list)
      setVoices(english)
      voiceRef.current = pickVoice(english, readKey(KEYS.voice))
      // no voices at all (headless browsers, some frames): captions only, on timings
      const speech = english.length ? browserSpeech(() => voiceRef.current) : null
      const muted = readKey(KEYS.muted) === '1'
      const r = new TourRunner<Chapter>(
        {
          chapters,
          speech,
          prepare,
          onState: (s) => setState(s),
          onSkip: (c, b, note) => setSkipped({ chapter: c, beat: b, note }),
          onNarrate: (c, b) => {
            setSkipped(null)
            setNarrating({ chapter: c, beat: b })
            setSpokenTo(-1)
          },
          onBoundary: (i) => setSpokenTo(i),
          onEnded: () => finish('ended'),
        },
        initialState(chapters, { chapter: request.chapter, only: request.only, voice: muted ? 'off' : 'on', rate: rateRef.current }),
      )
      runner.current = r
      r.start()
    })
    return () => {
      alive = false
      // unmounted without finishing (e.g. a replay): still put the app back
      if (!finished.current) {
        finished.current = true
        runner.current?.destroy()
        if (snap.current) restoreSnapshot(restoreEnv(), snap.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const t = setTimeout(() => playBtn.current?.focus({ preventScroll: true }), 400)
    return () => clearTimeout(t)
  }, [])

  const dispatch = useCallback((e: Parameters<TourRunner<Chapter>['dispatch']>[0]) => runner.current?.dispatch(e), [])
  const setRate = (r: number) => {
    setRateState(r)
    rateRef.current = r
    writeKey(KEYS.rate, String(r))
    dispatch({ type: 'rate', rate: r })
  }
  const setMuted = (muted: boolean) => {
    writeKey(KEYS.muted, muted ? '1' : null)
    dispatch({ type: 'mute', muted })
  }
  const chooseVoice = (uri: string) => {
    setVoiceUri(uri)
    writeKey(KEYS.voice, uri)
    voiceRef.current = voices?.find((v) => v.voiceURI === uri) ?? voiceRef.current
    dispatch({ type: 'mute', muted: false })
  }

  // ---- keyboard: Space, ←/→, Esc. Captured first, so the app's own shortcuts stay quiet during the tour.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inPlayer = dockRef.current?.contains(e.target as Node)
      const typing = e.target instanceof HTMLSelectElement
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (panel) setPanel(null)
        else finish('closed')
      } else if ((e.key === ' ' || e.code === 'Space') && !typing) {
        e.preventDefault()
        e.stopImmediatePropagation()
        dispatch({ type: 'toggle' })
      } else if (e.key === 'ArrowRight' && !typing) {
        e.preventDefault()
        e.stopImmediatePropagation()
        dispatch({ type: 'next' })
      } else if (e.key === 'ArrowLeft' && !typing) {
        e.preventDefault()
        e.stopImmediatePropagation()
        timeJump('back')
        dispatch({ type: 'prev' })
      } else if (!inPlayer) {
        // no app shortcuts while the tour drives the app; keys inside the player work as usual
        e.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dispatch, finish, panel])

  // ---- the frame loop: spotlight, pointer and dock placement follow live targets (minds orbit, panels slide)
  useEffect(() => {
    let raf = 0
    let cur: Box | null = null
    let curSeq = -1
    let fadeUntil = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const tg = target.current
      let box: Box | null = null
      if (tg) {
        let src: Element | Rect | null
        if (typeof tg.t === 'string') {
          if (!tg.el || !tg.el.isConnected || !visible(tg.el)) tg.el = findTour(tg.t)
          src = tg.el
        } else src = tg.t(ctx)
        box = rectOf(src)
      }
      const spot = spotRef.current
      const dim = dimRef.current
      const vw = window.innerWidth
      const vh = window.innerHeight
      if (spot && dim) {
        if (box) {
          const pad = box.round ? 4 : desktop ? 8 : 6
          const want: Box = {
            x: Math.max(3, box.x - pad),
            y: Math.max(3, box.y - pad),
            w: Math.min(vw - 6, box.w + pad * 2),
            h: Math.min(vh - 6, box.h + pad * 2),
            round: box.round,
          }
          want.w = Math.min(want.w, vw - 3 - want.x)
          want.h = Math.min(want.h, vh - 3 - want.y)
          if (reduced) {
            if (tg && tg.seq !== curSeq) {
              curSeq = tg.seq
              fadeUntil = now + 170
            }
            if (now >= fadeUntil || !cur) cur = want
          } else if (!cur) cur = want
          else {
            const k = 1 - Math.exp(-dt * 13)
            cur = { x: cur.x + (want.x - cur.x) * k, y: cur.y + (want.y - cur.y) * k, w: cur.w + (want.w - cur.w) * k, h: cur.h + (want.h - cur.h) * k, round: want.round }
          }
          spot.style.transform = `translate3d(${cur.x}px, ${cur.y}px, 0)`
          spot.style.width = `${cur.w}px`
          spot.style.height = `${cur.h}px`
          spot.style.borderRadius = cur.round ? '999px' : desktop ? '18px' : '16px'
          spot.style.opacity = reduced && now < fadeUntil ? '0' : '1'
          dim.style.opacity = '0'
        } else {
          spot.style.opacity = '0'
          dim.style.opacity = '1'
          cur = null
        }
      }
      // pointer: glide in an arc to the target's aim point, then stay with it
      const ptr = pointerRef.current
      if (ptr) {
        if (box && pointerShown.current) {
          const dest = aim(box)
          let pos = dest
          const g = glide.current
          if (g) {
            const t = Math.min(1, (now - g.t0) / g.dur)
            const e = ease(t)
            const dx = dest.x - g.from.x
            const dy = dest.y - g.from.y
            const dist = Math.hypot(dx, dy)
            const arc = Math.sin(Math.PI * e) * Math.min(70, dist * 0.18)
            pos = { x: g.from.x + dx * e + (-dy / (dist || 1)) * arc, y: g.from.y + dy * e + (dx / (dist || 1)) * arc }
            if (t >= 1) glide.current = null
          }
          if (!pointerPos.current) pointerPos.current = { x: vw / 2, y: vh * 0.6 }
          pointerPos.current = pos
          ptr.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`
          ptr.style.opacity = '1'
        } else ptr.style.opacity = '0'
      }
      // dock: bottom, unless the highlighted thing sits under it
      const dock = dockRef.current
      if (dock && cur && !glide.current) {
        const dh = dock.getBoundingClientRect().height + 16
        const overBottom = Math.max(0, cur.y + cur.h - (vh - dh)) * cur.w
        const overTop = Math.max(0, dh + 40 - cur.y) * cur.w
        const wantTop = overBottom > 0 && overTop < overBottom
        if (wantTop !== dockTopRef.current) setDockTop((dockTopRef.current = wantTop))
      } else if (!cur && dockTopRef.current) setDockTop((dockTopRef.current = false))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [ctx, desktop, reduced])

  // ---- render
  const s = state
  const ch = s ? chapters[s.chapter] : null
  const total = totals.reduce((a, b) => a + b, 0)
  const progressBefore = s ? totals.slice(0, s.chapter).reduce((a, b) => a + b, 0) : 0
  const inChapter = s && ch ? ch.beats.slice(0, s.beat).reduce((n, b) => n + estimateMs(b.text, rate) + 700 / rate, 0) : 0
  const frac = s ? (s.status === 'ended' ? 1 : (progressBefore + inChapter) / total) : 0
  const caption = narrating ? chapters[narrating.chapter]?.beats[narrating.beat]?.text : null
  const voiceOn = s?.voice === 'on'
  const unavailable = s?.voice === 'unavailable'
  const loading = !s

  const bar = (
      <div className="pointer-events-auto relative w-full max-w-[720px]">
        <AnimatePresence>
          {panel && (
            <m.div
              key={panel}
              initial={{ opacity: 0, y: dockTop ? -6 : 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={{ type: 'spring', stiffness: 560, damping: 40 }}
              className={cx('glass-strong absolute right-0 left-0 z-10 overflow-hidden rounded-[20px]', dockTop ? 'top-full mt-2' : 'bottom-full mb-2')}
            >
              {panel === 'chapters' ? (
                <ChapterList chapters={chapters} totals={totals} current={s?.chapter ?? 0} only={s?.only ?? null} onPick={(i) => (setPanel(null), dispatch({ type: 'goto', chapter: i }))} />
              ) : (
                <Settings
                  rate={rate}
                  setRate={setRate}
                  voices={voices}
                  voiceUri={voiceRef.current?.voiceURI ?? voiceUri}
                  setVoice={chooseVoice}
                  unavailable={unavailable}
                  captions={captions}
                  setCaptions={(v) => (setCaptions(v), writeKey(KEYS.captions, v ? null : 'off'))}
                  onRestart={() => (setPanel(null), timeJump('start'), dispatch({ type: 'restart' }))}
                  mobile={mobile}
                />
              )}
            </m.div>
          )}
        </AnimatePresence>
        <div className="glass-strong rounded-[20px] px-2 pt-2 pb-1.5 md:px-2.5" data-tour-player="">
          <Progress chapters={chapters} totals={totals} frac={frac} current={s?.chapter ?? 0} onPick={(i) => dispatch({ type: 'goto', chapter: i })} />
          <div className="mt-1.5 flex items-center gap-0.5 md:gap-1">
            <Ctl icon="stepBack" label="Previous chapter (←)" onClick={() => (timeJump('back'), dispatch({ type: 'prev' }))} disabled={loading} />
            <button
              ref={playBtn}
              onClick={() => dispatch({ type: 'toggle' })}
              disabled={loading}
              aria-label={s?.status === 'playing' ? 'Pause (Space)' : 'Play (Space)'}
              title={s?.status === 'playing' ? 'Pause (Space)' : 'Play (Space)'}
              className="flex size-11 shrink-0 items-center justify-center rounded-full text-primary-ink transition-transform active:scale-95 disabled:opacity-50"
              style={{ background: 'linear-gradient(180deg, #e9e4ff, #b7a8ff)', boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-ink) 30%, transparent) inset, 0 6px 22px -6px color-mix(in oklab, var(--color-accent) 90%, transparent)' }}
            >
              <Icon name={s?.status === 'playing' ? 'pause' : 'play'} size={18} strokeWidth={2.6} />
            </button>
            <Ctl icon="stepFwd" label="Next chapter (→)" onClick={() => dispatch({ type: 'next' })} disabled={loading} />
            <button
              onClick={() => setPanel(panel === 'chapters' ? null : 'chapters')}
              aria-expanded={panel === 'chapters'}
              aria-haspopup="dialog"
              className="ml-1 flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-2 text-left transition-colors hover:bg-tint/[0.06]"
              title="Chapters"
            >
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-[10.5px] text-ink-4 tabular-nums">
                  {loading ? 'Starting…' : `${(s?.chapter ?? 0) + 1} of ${chapters.length}`}
                  {unavailable && <span className="ml-1.5 font-sans text-ink-4" title="Voice isn't available in this browser, so the tour runs on timings with captions.">· captions only</span>}
                </span>
                <span className="block truncate text-[13px] font-medium text-ink">{ch?.title ?? chapters[0]?.title}</span>
              </span>
              <Icon name="list" size={16} className="shrink-0 text-ink-3" />
            </button>
            <Ctl icon="captions" label={captions ? 'Hide captions' : 'Show captions'} active={captions} onClick={() => (setCaptions(!captions), writeKey(KEYS.captions, captions ? 'off' : null))} />
            <Ctl
              icon={voiceOn ? 'volume' : 'volumeOff'}
              label={unavailable ? 'Voice unavailable here: captions only' : voiceOn ? 'Mute (captions only)' : 'Unmute'}
              onClick={() => !unavailable && setMuted(voiceOn)}
              disabled={loading || unavailable}
            />
            <button
              onClick={() => setPanel(panel === 'settings' ? null : 'settings')}
              aria-expanded={panel === 'settings'}
              aria-haspopup="dialog"
              aria-label={`Speed ${rate}× and voice`}
              title="Speed and voice"
              className={cx('flex h-11 min-w-11 shrink-0 items-center justify-center rounded-xl px-1.5 font-mono text-[12px] font-semibold text-ink-2 transition-colors hover:bg-tint/[0.07] hover:text-ink', panel === 'settings' && 'bg-tint/[0.08] text-ink')}
            >
              {rate}×
            </button>
            {!mobile && <Ctl icon="replay" label="Restart the tour" onClick={() => (timeJump('start'), dispatch({ type: 'restart' }))} disabled={loading} />}
            <Ctl icon="x" label="Close the tour (Esc)" onClick={() => finish('closed')} />
          </div>
        </div>
      </div>
  )

  return (
    // data-modal-keep: a dialog the tour opens (Stop all) does not make the player inert (ui/useModalContainment)
    <div className="tour-root" data-tour-active="" data-modal-keep="">
      {/* blocks the app while the tour drives it; the player stays usable */}
      <div className="fixed inset-0 z-[80]" aria-hidden="true" onPointerDown={() => setPanel(null)} />
      <div ref={dimRef} className="pointer-events-none fixed inset-0 z-[81] bg-[#03030e]/25 transition-opacity duration-500" aria-hidden="true" />
      <div
        ref={spotRef}
        className="pointer-events-none fixed top-0 left-0 z-[81] transition-[opacity] duration-200"
        style={{
          opacity: 0,
          boxShadow: '0 0 0 1.5px color-mix(in oklab, var(--color-accent-2) 90%, transparent), 0 0 0 5px color-mix(in oklab, var(--color-accent-2) 12%, transparent), 0 0 36px 4px color-mix(in oklab, var(--color-accent-2) 32%, transparent), 0 0 0 200vmax color-mix(in oklab, var(--color-void) 60%, transparent)',
        }}
        aria-hidden="true"
      />
      <Pointer refEl={pointerRef} clicks={clicks} reduced={reduced} />

      <div
        ref={dockRef}
        role="region"
        aria-label="Guided tour"
        className={cx('pointer-events-none fixed inset-x-0 z-[85] flex flex-col items-center gap-2 px-3', dockTop ? 'top-0' : 'bottom-0')}
        style={dockTop ? { paddingTop: 'calc(var(--sat) + 10px)' } : { paddingBottom: desktop ? 20 : 'calc(var(--sab) + 10px)' }}
      >
        {dockTop && bar}
        <AnimatePresence mode="wait">
          {/* a skipped beat says so, captions on or off (it is not narration, it is what the tour did) */}
          {skipped ? (
            <m.div
              key={`skip-${skipped.chapter}-${skipped.beat}`}
              data-tour-skipped={`${chapters[skipped.chapter]?.id ?? ''}-${skipped.beat}`}
              initial={{ opacity: 0, y: reduced ? 0 : 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.14 } }}
              transition={{ duration: 0.22 }}
              className="pointer-events-auto max-w-[640px] rounded-2xl bg-[#05050f]/88 px-4 py-2.5 text-center shadow-[0_10px_40px_-10px_rgb(0_0_0/0.9)] ring-1 ring-tint/[0.08] backdrop-blur-md md:px-5 md:py-3"
              role="status"
            >
              <p className="text-[14px] leading-snug text-ink-3 md:text-[15px]">{skipped.note}</p>
            </m.div>
          ) : captions && caption && (
            <m.div
              key={`${narrating?.chapter}-${narrating?.beat}`}
              initial={{ opacity: 0, y: reduced ? 0 : 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.14 } }}
              transition={{ duration: 0.22 }}
              className="pointer-events-auto max-w-[640px] rounded-2xl bg-[#05050f]/88 px-4 py-2.5 text-center shadow-[0_10px_40px_-10px_rgb(0_0_0/0.9)] ring-1 ring-tint/[0.08] backdrop-blur-md md:px-5 md:py-3"
              aria-live="polite"
            >
              <Caption text={caption} spokenTo={voiceOn ? spokenTo : -1} />
            </m.div>
          )}
        </AnimatePresence>
        {!dockTop && bar}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- parts

function Ctl({ icon, label, onClick, disabled, active }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cx(
        'flex size-11 shrink-0 items-center justify-center rounded-xl transition-colors hover:bg-tint/[0.07] hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent',
        active === false ? 'text-ink-4' : 'text-ink-2',
      )}
    >
      <Icon name={icon} size={18} />
    </button>
  )
}

/** The caption, phrase-synced: with speech, words already spoken are brighter. */
function Caption({ text, spokenTo }: { text: string; spokenTo: number }) {
  if (spokenTo < 0) return <p className="font-display text-[15.5px] leading-snug font-medium tracking-[-0.005em] text-balance text-ink md:text-[18px]">{text}</p>
  return (
    <p className="font-display text-[15.5px] leading-snug font-medium tracking-[-0.005em] text-balance md:text-[18px]">
      <span className="text-ink">{text.slice(0, spokenTo)}</span>
      <span className="text-ink-2">{text.slice(spokenTo)}</span>
    </p>
  )
}

function Progress({ chapters, totals, frac, current, onPick }: { chapters: Chapter[]; totals: number[]; frac: number; current: number; onPick: (i: number) => void }) {
  const total = totals.reduce((a, b) => a + b, 0) || 1
  const lefts = totals.map((_, i) => totals.slice(0, i).reduce((a, b) => a + b, 0) / total)
  return (
    <div className="relative mx-1 flex h-4 items-center" role="group" aria-label="Tour progress">
      <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 overflow-hidden rounded-full bg-tint/[0.09]">
        <div className="h-full rounded-full transition-[width] duration-700 ease-out" style={{ width: `${Math.max(0, Math.min(1, frac)) * 100}%`, background: 'linear-gradient(90deg, #a493ff, #6ee7ff)', boxShadow: '0 0 10px color-mix(in oklab, var(--color-accent-2) 60%, transparent)' }} />
      </div>
      {chapters.map((c, i) => {
        const left = lefts[i]
        return (
          <button
            key={c.id}
            onClick={() => onPick(i)}
            className="group absolute top-0 h-4"
            style={{ left: `${left * 100}%`, width: `${(totals[i] / total) * 100}%` }}
            aria-label={`Chapter ${i + 1}: ${c.title}`}
            aria-current={i === current ? 'step' : undefined}
            title={c.title}
          >
            {i > 0 && <span className="absolute top-1/2 left-0 h-2 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#08081c]" aria-hidden="true" />}
            <span className="absolute inset-x-0 top-1/2 h-[7px] -translate-y-1/2 rounded-full opacity-0 transition-opacity group-hover:bg-tint/[0.08] group-hover:opacity-100" aria-hidden="true" />
          </button>
        )
      })}
    </div>
  )
}

const fmt = (ms: number) => {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function ChapterList({ chapters, totals, current, only, onPick }: { chapters: Chapter[]; totals: number[]; current: number; only: number | null; onPick: (i: number) => void }) {
  return (
    <div className="p-1.5" role="dialog" aria-label="Chapters">
      <div className="flex items-baseline justify-between px-3 pt-2 pb-1.5">
        <span className="eyebrow">Chapters</span>
        <span className="font-mono text-[11px] text-ink-4">{fmt(totals.reduce((a, b) => a + b, 0))} in all</span>
      </div>
      <ol className="thin-scroll max-h-[min(52dvh,440px)] overflow-y-auto">
        {chapters.map((c, i) => {
          const on = i === current
          return (
            <li key={c.id}>
              <button onClick={() => onPick(i)} aria-current={on ? 'step' : undefined} className={cx('flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-1.5 text-left transition-colors', on ? 'bg-tint/[0.08]' : 'hover:bg-tint/[0.05]')}>
                <span className={cx('flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-[11px] tabular-nums', on ? 'bg-accent text-primary-ink' : 'border border-line-2 text-ink-3')}>{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className={cx('block truncate text-[13.5px] font-medium', on ? 'text-ink' : 'text-ink-2')}>{c.title}</span>
                  <span className="block truncate text-[11.5px] text-ink-4">{c.blurb}</span>
                </span>
                <span className="font-mono text-[11px] text-ink-4 tabular-nums">{fmt(totals[i])}</span>
              </button>
            </li>
          )
        })}
      </ol>
      {only !== null && <p className="px-3 pt-1 pb-2 text-[11.5px] text-ink-4">Playing one chapter. Pick any other to keep going.</p>}
    </div>
  )
}

function Settings({
  rate,
  setRate,
  voices,
  voiceUri,
  setVoice,
  unavailable,
  captions,
  setCaptions,
  onRestart,
  mobile,
}: {
  rate: number
  setRate: (r: number) => void
  voices: SpeechSynthesisVoice[] | null
  voiceUri: string | null
  setVoice: (uri: string) => void
  unavailable: boolean
  captions: boolean
  setCaptions: (v: boolean) => void
  onRestart: () => void
  mobile: boolean
}) {
  return (
    <div className="space-y-3.5 p-3.5" role="dialog" aria-label="Speed and voice">
      <div>
        <div className="eyebrow mb-2">Speed</div>
        <div role="radiogroup" aria-label="Speed" data-unsaved-ignore="" className="flex gap-1 rounded-xl border border-line bg-tint/[0.03] p-1">
          {RATES.map((r) => (
            <button key={r} role="radio" aria-checked={r === rate} onClick={() => setRate(r)} className={cx('min-h-9 flex-1 rounded-lg font-mono text-[12.5px] transition-colors', r === rate ? 'bg-tint/[0.1] text-ink ring-1 ring-line-2' : 'text-ink-3 hover:text-ink')}>
              {r}×
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="eyebrow mb-2">Voice</div>
        {unavailable || !voices?.length ? (
          <p className="flex items-start gap-2 text-[12.5px] leading-snug text-ink-3">
            <Icon name="info" size={14} className="mt-0.5 shrink-0 text-ink-4" />
            Voice isn’t available in this browser, so the tour runs on timings with captions.
          </p>
        ) : (
          <select
            value={voiceUri ?? ''}
            onChange={(e) => setVoice(e.target.value)}
            aria-label="Voice"
            className="min-h-11 w-full appearance-none rounded-xl border border-line bg-shade/30 px-3 text-[14px] text-ink outline-none focus:border-line-2"
          >
            {voices.slice(0, 24).map((v) => (
              <option key={v.voiceURI} value={v.voiceURI} className="bg-[#0b0b22]">
                {shown(v.name)} · {v.lang}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => setCaptions(!captions)} aria-pressed={captions} className="flex min-h-10 flex-1 items-center gap-2 rounded-xl border border-line px-3 text-[13px] text-ink-2 hover:border-line-2">
          <Icon name="captions" size={16} />
          Captions {captions ? 'on' : 'off'}
        </button>
        {mobile && (
          <button onClick={onRestart} className="flex min-h-10 flex-1 items-center justify-center gap-2 rounded-xl border border-line px-3 text-[13px] text-ink-2 hover:border-line-2">
            <Icon name="replay" size={16} />
            Restart
          </button>
        )}
      </div>
    </div>
  )
}

/** The guide's pointer: a soft white arrow with a glow; clicks press it and ripple. */
function Pointer({ refEl, clicks, reduced }: { refEl: React.RefObject<HTMLDivElement | null>; clicks: number; reduced: boolean }) {
  return (
    <div ref={refEl} className="pointer-events-none fixed top-0 left-0 z-[83] transition-opacity duration-300" style={{ opacity: 0 }} aria-hidden="true">
      {clicks > 0 && <span key={clicks} className="tour-ripple absolute top-0 left-0 size-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent-2" />}
      <span key={`p${clicks}`} className={cx('block origin-top-left', clicks > 0 && !reduced && 'tour-press')}>
        <svg width="30" height="34" viewBox="0 0 30 34" className="-translate-x-[3px] -translate-y-[2px] drop-shadow-[0_4px_14px_rgb(110_231_255/0.45)]">
          <path d="M4 3 L4 26 L10.2 20.4 L14.4 30 L18.6 28.2 L14.5 18.8 L23 18.4 Z" fill="#fff" stroke="#0b0b22" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
      </span>
    </div>
  )
}

