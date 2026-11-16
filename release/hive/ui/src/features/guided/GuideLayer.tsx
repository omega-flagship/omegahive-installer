/**
 * The guided demo on screen (mounted ONCE in App.tsx beside the Ask, so it plays in every experience, page and app):
 *  - drives the steps (driver.playStep through the live environment), only while the run's Ask origin holds;
 *  - draws the mind's presence on the target in the experience's own style (Classic's soft light and glow, Still's
 *    highlighter, Cosmos's beacon, Construct's block cursor, Flux's ripple, Canvas's pencil ring), and a caption
 *    beside it with Back / Pause / Next / Stop, placed clear of the chrome the experience keeps clear;
 *  - announces each step to screen readers (a banked step with its "banked / synthetic, not run now" qualification;
 *    nothing while a modal holds the screen); respects reduced motion (no glide, instant highlight);
 *  - pauses when the person takes over (a click, scroll or key on the page, or a page change they made), except on a
 *    step that waits for them; ends when the signed-in person or session changes (nothing more is shown; the store
 *    clears it inside the identity change itself, finished or not);
 *  - every control the person uses (button, key, words) takes the demo from the conductor first (personAct).
 * Presentation only: it never takes focus, and it is inert and hidden under a modal (askUnderModal).
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useReducedMotion } from '../../lib/hooks'
import { selfMoveAt as askMoveAt, useAskStore } from '../../store/ask'
import { useHive } from '../../store/store'
import { placeHint, type Box as HintBox } from '../../tour/place'
import { ReadingRoom, sameMeasure, type TargetMeasure, endReflow, holdAsks, markDemo, overlaps, placeReading, readingNow, visibleBand } from './reading'
import { guideUnderModal } from './underModal'
import { currentEpoch } from '../../lib/identityEpoch'
import { askReservePx } from '../../ui/overlays'
import { liveEnv, readingStepLayout, personAct, playPrepared, selfMoveAt, setGuideEnv, threadFold, useGuide, type GuideRun } from './store'
import { announcement, guideButtons, guideKeys, yourTurn } from './controls'
import { fill } from './driver'
import { BANKED_LABEL, BANKED_QUALIFICATION, shortValue } from './banked'
import type { BankedStep } from './types'
import { dwellMs } from './machine'
import { GUIDE_SCRIPTS } from './scripts'
import { inputVerdict, playInk, type PlayScreen } from './play'
import { reducedMotion } from '../ask/conductor'
import { clearInk, drawMarks, glideTo } from '../ink/ink'
import { InkLayer } from '../ink/InkLayer'
import './guided.css'

type DemoRun = Extract<GuideRun, { kind: 'demo' }>

/** The steps play on this screen: the store drives each running step (and the conductor's tour.step) through it. */
function useDriver() {
  useEffect(() => {
    setGuideEnv(liveEnv)
    return () => setGuideEnv(null)
  }, [])
}

/** Auto-advance: a shown step stays long enough to read, then the next one plays. */
function useAuto(run: GuideRun | null) {
  const demo = run?.kind === 'demo' ? run : null
  const ready = demo?.m.status === 'ready' && demo.m.auto
  const token = demo?.m.token
  const text = demo ? demo.said[demo.m.step] ?? '' : ''
  useEffect(() => {
    if (!ready || token === undefined) return
    const t = window.setTimeout(() => useGuide.getState().send({ type: 'tick', token }), dwellMs(text))
    return () => window.clearTimeout(t)
  }, [ready, token, text])
}

/** Fenced like the Ask: a change of client, session, sign-in or Ask thread ends the demo at once. */
function useFence(run: GuideRun | null) {
  const id = run?.id
  useEffect(() => {
    if (id === undefined) return
    const check = () => {
      const r = useGuide.getState().run
      if (!r || r.id !== id || (r.origin.ok() && r.bind.current())) return
      if (r.kind === 'demo') useGuide.getState().send({ type: 'fenced' })
      else useGuide.getState().close()
    }
    const a = useAskStore.subscribe(check)
    const b = useHive.subscribe(check)
    const t = window.setInterval(check, 1000)
    check()
    return () => {
      a()
      b()
      window.clearInterval(t)
    }
  }, [id])
}

/**
 * The person always wins: their own input on the page (a click, scroll, tap or key) pauses the demo, "you took over"
 * (not on a step that waits for them); typing in the Ask pauses a demo that plays itself (guided-play: play.ts).
 */
function useTakeover(run: GuideRun | null) {
  const demo = run?.kind === 'demo' ? run : null
  const watching = !!demo && (demo.m.status === 'running' || demo.m.status === 'ready') && demo.script.steps[demo.m.step]?.wait?.for !== 'you'
  const playing = !!demo?.play
  useEffect(() => {
    if (!watching) return
    const on = (e: Event) => {
      const v = inputVerdict({ type: e.type, isTrusted: e.isTrusted, key: (e as globalThis.KeyboardEvent).key, target: e.target }, playing)
      if (v === 'takeover') useGuide.getState().send({ type: 'takeover' })
      else if (v === 'pause') useGuide.getState().send({ type: 'pause', why: 'ask' })
    }
    const onHash = () => {
      // the demo's moves and the orchestrator's are not the person's
      if (Date.now() - Math.max(selfMoveAt, askMoveAt) > 900) useGuide.getState().send({ type: 'takeover' })
    }
    const opts = { capture: true, passive: true }
    const kinds = ['pointerdown', 'wheel', 'touchstart', 'touchmove', 'keydown'] as const
    kinds.forEach((k) => window.addEventListener(k, on, opts))
    window.addEventListener('hashchange', onHash)
    return () => {
      kinds.forEach((k) => window.removeEventListener(k, on, opts))
      window.removeEventListener('hashchange', onHash)
    }
  }, [watching, playing])
}

/**
 * Guided-play on screen: each shown step of a demo that plays itself gets the demo cursor and a mark (play.ts, drawn
 * by the shared ink layer); a step starting afresh clears the last mark; the end (or another kind of run) clears it
 * all. Paused, the marks stay so the person can see what it was showing. It draws only: nothing is ever pressed.
 */
function usePlay(run: GuideRun | null) {
  const demo = run?.kind === 'demo' && run.play ? run : null
  const playing = !!demo
  const status = demo?.m.status
  const id = demo?.id
  const token = demo?.m.token
  useEffect(() => {
    // the Ask's thread is folded while a step plays, and put back when it pauses, ends or is closed (r1.1)
    if (status === 'running' || status === 'ready') threadFold.step(id)
    else threadFold.restore({ ended: !demo || status === 'ended' })
    if (!demo || status === 'ended') return clearInk('guided', { cursor: true })
    if (status === 'running') return clearInk('guided')
    if (status !== 'ready') return
    const step = demo.script.steps[demo.m.step]
    if (!step) return
    let live = true
    const alive = () => {
      const r = useGuide.getState().run
      return live && r?.kind === 'demo' && r.id === id && r.m.token === token && r.m.status === 'ready'
    }
    const screen: PlayScreen = {
      find: (targets) => liveEnv.find(targets, demo.picks),
      glide: (el, click) => glideTo('guided', el, click, reducedMotion()),
      draw: (marks) => drawMarks('guided', marks),
      clear: () => clearInk('guided'),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      reveal: (el) => el.scrollIntoView({ block: el.getBoundingClientRect().height > window.innerHeight * 0.6 ? 'start' : 'center', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }),
    }
    void playInk(step, demo.picks, screen, alive, { width: window.innerWidth, height: window.innerHeight })
    return () => {
      live = false
    }
    // the step (id, token) and where it stands are what it plays on; the rest of the run is read when it does
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, status, id, token])
  // gone with the layer
  useEffect(
    () => () => {
      clearInk('guided', { cursor: true })
      threadFold.restore({ ended: true })
    },
    [],
  )
}


function useUnderModal(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mo = new MutationObserver(cb)
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-modal', 'inert'] })
      return () => mo.disconnect()
    },
    // probed on the demo's always-mounted live region, never on the caption (underModal.ts says why)
    () => guideUnderModal(document),
    () => false,
  )
}

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** The target's box while shown, measured each frame it may move (scroll, resize) and every half second. */
function useTargetBox(run: GuideRun | null): TargetMeasure {
  const demo = run?.kind === 'demo' ? run : null
  const shown = !!demo && (demo.m.status === 'ready' || demo.m.status === 'paused') && demo.found
  const step = demo?.m.step
  const token = demo?.m.token
  const [out, setOut] = useState<TargetMeasure>({ box: null, el: null, full: null, band: null })
  useEffect(() => {
    if (!shown || step === undefined) return
    const r = useGuide.getState().run as DemoRun
    const targets = r.script.steps[step]?.target
    const reading = !!r.script.steps[step]?.read
    let raf = 0
    const measure = () => {
      raf = 0
      const el = liveEnv.find(Array.isArray(targets) ? targets : targets ? [targets] : [], r.picks)
      const b = el?.getBoundingClientRect()
      // the part that can actually be seen: a reading step clips to the boxes that clip the target (its scrollport,
      // never under a panel's fixed header or log band) and the Ask's band; others to the window, as before
      const band = el && reading ? visibleBand(el) : { top: 0, bottom: window.innerHeight }
      const box = b && b.bottom > band.top && b.top < band.bottom ? { left: Math.max(0, b.left), top: Math.max(band.top, b.top), right: Math.min(window.innerWidth, b.right), bottom: Math.min(band.bottom, b.bottom) } : null
      // the clipped box draws the highlight; the whole box and the band are kept too, so a target that grows inside an
      // unchanged band (its clipped box the same) still lays the reading step out again (Root 191824Z)
      const next: TargetMeasure = { box, el: el ?? null, full: b ? { left: b.left, top: b.top, right: b.right, bottom: b.bottom } : null, band }
      setOut((o) => (sameMeasure(o, next) ? o : next))
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    schedule()
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    const t = window.setInterval(schedule, 500)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.clearInterval(t)
    }
  }, [shown, step, token])
  return shown ? out : NONE
}
const NONE: TargetMeasure = { box: null, el: null, full: null, band: null }

/** Everything the experience keeps clear (its bars, docks, Ω, the clock, the Ask): the caption avoids them. */
function keepClear(): HintBox[] {
  const out: HintBox[] = []
  for (const el of document.querySelectorAll('[data-xc-keep-clear], [data-omega-button], .os-clock, #ask .ask-dock, #ask .ask-panel, #ask .ask-still-line, .toast-stack > *')) {
    const r = el.getBoundingClientRect()
    if (r.width >= 1 && r.height >= 1) out.push({ left: r.left, top: r.top, width: r.width, height: r.height })
  }
  return out
}

export function GuideControls({ run, compact }: { run: DemoRun; compact?: boolean }) {
  const { m } = run
  const ended = m.status === 'ended'
  return (
    <span className="guide-controls" role="group" aria-label={ended ? 'Demo finished' : 'Demo controls'}>
      {guideButtons(run).map((b) => (
        <button
          key={b.label}
          type="button"
          className="guide-btn"
          data-tone={b.tone}
          onClick={() => personAct(b.act)}
          disabled={b.disabled}
          aria-pressed={b.pressed}
          aria-keyshortcuts={b.keys}
        >
          {b.label}
        </button>
      ))}
      {!compact && !ended && (
        <label className="guide-auto">
          <input type="checkbox" checked={m.auto} onChange={(e) => personAct({ auto: e.target.checked })} /> Auto
        </label>
      )}
    </span>
  )
}

/**
 * The qualification of a banked step, in the card's own words (BANKED_LABEL; executed now: false), for every place
 * its explanation appears outside the card: each entry of the thread's transcript, while the demo plays and after it
 * stopped or finished (stand-in r2).
 */
export function BankedTag() {
  return <span className="guide-banked-tag">{BANKED_QUALIFICATION}</span>
}

/**
 * A banked step as recorded (Root's contract): its tool and skill, its arguments, and its recorded output, ALWAYS
 * labelled "banked / synthetic, not run now" and never as an actual result (executed_now: false).
 */
export function BankedCard({ step }: { step: BankedStep }) {
  const out = step.expected_native ?? step.contains_native
  return (
    <div className="guide-banked" role="group" aria-label={`${BANKED_LABEL}: ${step.tool}`}>
      <p className="guide-banked-badge">
        <span>{BANKED_LABEL}</span>
        <span>executed now: false</span>
      </p>
      <dl>
        <dt>Tool</dt>
        <dd>
          <code>{step.tool}</code> · {step.skill}
        </dd>
        <dt>Arguments</dt>
        <dd>
          <code>{shortValue(step.arguments)}</code>
        </dd>
        {out && (
          <>
            <dt>{step.expected_native ? 'Recorded output (expected, not actual)' : 'Recorded output contains (expected, not actual)'}</dt>
            <dd>
              <code>{shortValue(out)}</code>
            </dd>
          </>
        )}
        <dt>State</dt>
        <dd>{step.state_origin}</dd>
      </dl>
    </div>
  )
}

const statusWord = (run: DemoRun) =>
  run.m.status === 'paused' ? (run.m.paused === 'took-over' ? 'Paused: you took over' : run.m.paused === 'ask' ? 'Paused while you type' : 'Paused') : yourTurn(run) ? 'Your turn: I’ll carry on when it opens' : run.m.status === 'running' ? 'Moving there…' : run.m.status === 'ended' ? (run.m.ended === 'done' ? 'Finished' : 'Stopped') : null

/**
 * What a `read` step keeps readable: the region holding its target (the reasoning viewers' section, say), as a box.
 * The caption is placed outside it where there is room and never counts it as free space.
 */
function readRegion(el: Element | null): HintBox | null {
  const r = el?.parentElement?.closest('[data-presence-region]')?.getBoundingClientRect()
  if (!r || r.width < 1 || r.height < 1) return null
  const top = Math.max(0, r.top)
  const bottom = Math.min(window.innerHeight, r.bottom)
  return bottom > top ? { left: r.left, top, width: r.width, height: bottom - top } : null
}

/** The caption beside the target (or at the top when there is none). */
function Caption({ run, box, el, measured }: { run: DemoRun; box: Box | null; el: Element | null; measured?: TargetMeasure }) {
  const ref = useRef<HTMLDivElement>(null)
  /** the reading step's room (made once per step, when a later measurement no longer fits: guided/reading) */
  const room = useRef(new ReadingRoom())
  /** the step (run id and token) whose target was scrolled clear of the caption, and how many times (a few per step) */
  const shifted = useRef('')
  const step = run.script.steps[run.m.step]
  // a step that waits for the person is said at once: they need the words to know what to do
  const text = run.said[run.m.step] ?? (step && yourTurn(run) ? fill(step.say, run.picks) : '')
  const caption = step?.caption ?? text
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const width = Math.min(380, window.innerWidth - 24)
    const height = node.offsetHeight || 120
    // the caption keeps clear of the Ask's band (ui/overlays ASK_RESERVE: the safe area and the Ask's own room)
    const vp = { width: window.innerWidth, height: window.innerHeight - askReservePx() }
    // placed by writing its style (the caption is measured, then moved, before paint)
    const put = (left: number, top: number, w: number) => {
      node.style.left = `${Math.round(left)}px`
      node.style.top = `${Math.round(top)}px`
      node.style.width = `${Math.round(w)}px`
      node.style.visibility = 'visible'
    }
    node.removeAttribute('data-reading')
    node.removeAttribute('data-clear')
    if (!box) return put(Math.max(12, (vp.width - width) / 2), 72, width)
    const anchor = { left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top }
    if (step?.read) {
      // a reading step: the caption and its target are both readable and never overlap (guided/reading). No early
      // return for a big target and no fallback taken as clearance: docked, with the target scrolled clear of it.
      // the target's whole box, not only its part on screen: a docked caption measures the scroll from its real top
      // (store readingStepLayout/layoutReading: the placement from the target as measured now, and the room made once per step when a
      // later settled measurement no longer fits: a viewer resolving from "loading", a panel settling)
      // (paused, by the person's own input or by Pause: measured and drawn, never moving the page: readingStepLayout)
      const lay = el ? readingStepLayout(el, { width, height }, vp, keepClear(), readRegion(el), room.current, run, currentEpoch(), shifted) : null
      const target = lay?.target ?? anchor
      const r = lay?.placement ?? placeReading(target, { width, height }, vp, keepClear(), null)
      put(r.left, r.top, r.width)
      if (lay?.roomMade) return
      node.dataset.reading = r.mode + (r.scrolls ? ' scrolls' : '')
      // honest, from the target as it is NOW: clear only once it needs no more scroll and the caption is off it (the
      // layout runs again on the scroll, from the re-measured target)
      node.dataset.clear = !r.shift && !overlaps({ left: r.left, top: r.top, width: r.width, height }, target) ? 'yes' : 'no'
      return
    }
    // a target bigger than most of the screen (a whole page): the caption sits inside its top edge, clear of chrome
    if (anchor.height > vp.height * 0.6) return put(Math.max(12, Math.min(vp.width - width - 12, anchor.left + anchor.width / 2 - width / 2)), Math.max(72, anchor.top + 16), width)
    const p = placeHint(anchor, { width, height }, vp, keepClear())
    put(p.left, p.top, p.width)
  }, [box, el, measured, step, caption, run])
  const word = statusWord(run)
  return (
    <div
      ref={ref}
      className="guide-ui guide-caption"
      role="group"
      aria-label={`Guided demo: ${run.script.title}`}
      onKeyDown={guideKeys}
      style={{ visibility: 'hidden', left: 0, top: 0 }}
    >
      <p className="guide-eyebrow">
        <span>Demo · {run.script.title}</span>
        <span>
          {Math.min(run.m.step + 1, run.m.total)} / {run.m.total}
        </span>
      </p>
      {run.m.status === 'ended' ? (
        <p className="guide-text">{run.m.ended === 'done' ? `That’s ${run.script.title.toLowerCase()}. Ask “show me how … works” for another.` : 'Demo stopped. Nothing it showed was changed.'}</p>
      ) : (
        <p className="guide-text">{run.m.status === 'running' && !text ? '…' : caption}</p>
      )}
      {step?.banked && run.m.status !== 'ended' && <BankedCard step={step.banked} />}
      {run.note && run.m.status !== 'ended' && <p className="guide-note">{run.note}</p>}
      {run.found === false && run.m.status === 'ready' && step?.target && <p className="guide-note">What I wanted to point at is not on this screen right now.</p>}
      {word && run.m.status !== 'ended' && <p className="guide-status">{word}</p>}
      {/* the demo's only controls (the thread card has none); Auto here too, except for a demo that plays itself */}
      <GuideControls run={run} compact={!!run.play} />
    </div>
  )
}

/** A stub's honest answer, an unknown topic, or the list of demos: a panel with the nearest real demos. */
export function GuideAnswer({ run, inThread }: { run: Extract<GuideRun, { kind: 'answer' }>; inThread?: boolean }) {
  const g = useGuide.getState()
  const s = run.script
  return (
    <div className={inThread ? 'guide-ui guide-answer guide-in-thread' : 'guide-ui guide-answer guide-caption guide-answer-float'} role="group" aria-label={s ? `${s.title}: not built yet` : 'Guided demos'} onKeyDown={guideKeys}>
      <p className="guide-eyebrow">
        <span>{s ? `Demo · ${s.title}` : 'Guided demos'}</span>
        {s && <span className="guide-badge">needs {s.needs ?? 'building'}</span>}
      </p>
      <p className="guide-text">{run.text}</p>
      {s?.hooks && s.hooks.length > 0 && <p className="guide-note">Its demo will use {s.hooks.join(', ')} when those land.</p>}
      <span className="guide-controls" role="group" aria-label="Demos you can see now">
        {s && s.steps.length > 0 && (
          <button type="button" className="guide-btn" data-tone="primary" onClick={() => g.play({ ...s, status: 'ready', banked: undefined, title: `${s.title}: what exists today` }, { origin: run.origin, bind: run.bind })}>
            Show what exists today
          </button>
        )}
        {run.near.map((n) => (
          <button key={n.id} type="button" className="guide-btn" onClick={() => void playPrepared(n, { origin: run.origin, bind: run.bind })}>
            {n.title}
          </button>
        ))}
        <button type="button" className="guide-btn" data-tone="quiet" onClick={() => g.close()}>
          Close
        </button>
      </span>
    </div>
  )
}

/** The highlight in the experience's own grammar. */
/** where the beacon was last (it glides from there to the next target) */
let lastBeacon: { x: number; y: number } | null = null
function Highlight({ box, experience, reduced, id, cursor }: { box: Box; experience: string; reduced: boolean; id: string; cursor?: boolean }) {
  const x = (box.left + box.right) / 2
  const y = (box.top + box.bottom) / 2
  const [from] = useState(() => lastBeacon ?? { x: x - 60, y: y + 40 })
  useEffect(() => {
    lastBeacon = { x, y }
  }, [x, y])
  return (
    <div className="guide-layer" data-experience={experience} data-reduced={reduced || undefined} aria-hidden="true">
      <span key={`glow-${id}`} className="guide-glow" style={{ left: box.left - 6, top: box.top - 6, width: box.right - box.left + 12, height: box.bottom - box.top + 12 }} />
      {/* the beacon glides to the target; a demo that plays itself has the cursor for that */}
      {!reduced && !cursor && box.bottom - box.top < window.innerHeight * 0.6 && <span key={`beacon-${id}`} className="guide-beacon" style={{ ['--from-x' as string]: `${from.x}px`, ['--from-y' as string]: `${from.y}px`, left: x, top: y }} />}
    </div>
  )
}

export function GuideLayer({ experience }: { experience: string }) {
  const run = useGuide((s) => s.run)
  const reduced = useReducedMotion()
  const underModal = useUnderModal()
  useDriver()
  useAuto(run)
  useFence(run)
  useTakeover(run)
  usePlay(run)
  const measured = useTargetBox(run)
  const { box, el } = measured

  // Still: the target lights up like a highlighted line on the paper, as its presence does
  useEffect(() => {
    if (experience !== 'still' || !el) return
    el.classList.add('ask-lit')
    return () => el.classList.remove('ask-lit')
  }, [experience, el])

  const announce = announcement(run, underModal)

  // while a reading step shows, the page says so (html[data-guide-reading]): new approval toasts wait, as they do for a
  // modal, and say what arrived when it ends (shell/approvalToasts); toasts already up move to the top (guided.css)
  const reading = readingNow(run, underModal, !!box)
  useEffect(() => (reading ? holdAsks(document.documentElement) : undefined), [reading])
  // while a demo's caption or answer shows, first-visit hints wait (tour/ViewInfo), so they never cover its controls
  const showing = !!run && !underModal
  useEffect(() => (showing ? markDemo(document.documentElement) : undefined), [showing])
  // a reflow belongs to its reading step only: any other step (or none) ends it
  const readStep = run?.kind === 'demo' && run.m.status !== 'ended' && !!run.script.steps[run.m.step]?.read
  useEffect(() => {
    if (!readStep) endReflow(document.documentElement)
  }, [readStep])

  return createPortal(
    <>
      {/* the demo cursor and marks (guided-play and the showreel share them; the showreel marks inside a warning it opened) */}
      <InkLayer />
      <div className="sr-only guide-live" aria-live="polite" role="status">
        {announce}
      </div>
      {run && !underModal && (
        <>
          {run.kind === 'demo' && box && (run.m.status === 'ready' || run.m.status === 'paused') && <Highlight key={`${run.id}-${run.m.step}`} box={box} experience={experience} reduced={reduced} id={`${run.id}-${run.m.step}`} cursor={!!run.play} />}
          {run.kind === 'demo' ? <Caption run={run} box={run.m.status === 'ready' || run.m.status === 'paused' ? box : null} el={el} measured={measured} /> : <GuideAnswer run={run} />}
        </>
      )}
    </>,
    document.body,
  )
}

/** The demo in the Ask thread: what was said so far, where it stands, and the same controls. */
export function GuideCard() {
  return <GuideCardView run={useGuide((s) => s.run)} />
}

/** GuideCard for a given run (rendered by tests as it renders in the thread). */
export function GuideCardView({ run }: { run: GuideRun | null }) {
  if (!run) return null
  if (run.kind === 'answer') return <GuideAnswer run={run} inThread />
  const word = statusWord(run)
  return (
    <div className="guide-ui guide-card" role="group" aria-label={`Guided demo: ${run.script.title}`} onKeyDown={guideKeys}>
      <p className="guide-eyebrow">
        <span>Demo · {run.script.title}</span>
        <span>{run.script.standing}</span>
      </p>
      <ol className="guide-said">
        {run.said.slice(0, run.m.step + 1).map((t, i) => (
          <li key={i} data-current={i === run.m.step || undefined} data-banked={run.script.steps[i]?.banked ? '' : undefined}>
            {run.script.steps[i]?.banked && (
              <>
                <BankedTag />{' '}
              </>
            )}
            {t}
          </li>
        ))}
      </ol>
      {run.script.steps[run.m.step]?.banked && run.m.status !== 'ended' && <BankedCard step={run.script.steps[run.m.step].banked!} />}
      {word && <p className="guide-status">{word}</p>}
      {/* one control surface (r1.1): the demo's controls are on its caption, owned by the guide; the thread keeps the transcript */}
    </div>
  )
}

/** Every demo, for the help sheet and tests. */
export const READY_DEMOS = GUIDE_SCRIPTS.filter((s) => s.status === 'ready')
