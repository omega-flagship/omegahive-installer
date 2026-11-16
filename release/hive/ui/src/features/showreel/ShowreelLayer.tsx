/**
 * The demo showreel on screen (demo mode only; App.tsx loads this for the simulator in demo mode and never for a real
 * hive): its bar (where it is, Pause / Carry on, How, Voice, Loop, Stop, and the Ask's answers) and the layers of
 * "how"; it drives the shared demo cursor and draw layer (features/ink, drawn by InkLayer). It installs the runner's screen (store setReelEnv) and the Ask's door
 * (hook setShowreelWords) while mounted.
 *
 * The person always wins:
 *  - a real pointer press, wheel, touch or key on the page (not Tab, Shift, Control, Alt, Meta or Caps Lock), or a mouse
 *    move of 24 px or more after a 1.5 s settle (not a small or early one), takes over ("You took over"), and
 *    leaves the page where it stopped;
 *  - a key or press inside the Ask (typing, the microphone), or "/" that opens it, pauses instead;
 *  - the showreel's own bar, the guided caption and the layers are not the page (their controls are its controls).
 * Reduced motion: the cursor jumps, the marks appear without drawing, and their words say what they mark (InkLayer).
 */
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { askOrigin } from '../../store/ask'
import { browserSpeech, loadVoices, pickVoice } from '../../tour/speech'
import { performLocal, reducedMotion, type LocalAct } from '../ask/conductor'
import { closeSwarmDelete, openSwarmDelete, useSwarmDelete, type SwarmDeleteOpen } from '../swarm/deleteRequest'
import { findIn } from '../guided/driver'
import { clearDemoScripts } from '../guided/scripts'
import { markDemo } from '../guided/reading'
import { picksNow } from '../guided/store'
import { clearInk, drawMarks, glideTo } from '../ink/ink'
import { setShowreelWords } from './hook'
import { LayerStack } from './LayerStack'
import { active } from './machine'
import { PLAYLIST, SCENES } from './scenes'
import { placeOf, setReelEnv, showreelWords, useReel, type ReelEnv } from './store'
import './showreel.css'

// ---------------------------------------------------------------- the runner's screen

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

let voice: SpeechSynthesisVoice | null = null
/** the delete warning the showreel opened (put away when it moves on; one the person opens is never touched) */
let opened: SwarmDeleteOpen | null = null
const speech = typeof window === 'undefined' ? null : browserSpeech(() => voice)

/** The runner's screen: the conductor's own executor, the page's targets, the cursor and the marks. */
const liveReelEnv: ReelEnv = {
  act: (act, op, seq, origin, alive) => performLocal(op, seq, { ...act, act_id: `${op}#${seq}` } as LocalAct, origin, alive),
  place: placeOf,
  find: (targets) => findIn(document, targets, picksNow()),
  // the shared cursor and draw layer (features/ink): drawn only, it never presses anything
  cursor: (el, click) => glideTo('showreel', el, click, reducedMotion(), sleep),
  dialog(open) {
    if (open) {
      opened = openSwarmDelete(open.swarm, { name: open.name })
      return
    }
    // only the warning the showreel itself opened, and only while it is still that one
    if (opened && useSwarmDelete.getState().open?.seq === opened.seq) closeSwarmDelete()
    opened = null
  },
  draw: (marks) => drawMarks('showreel', marks),
  clear: () => clearInk('showreel'),
  say(text) {
    speech?.speak(text, 1, { onStart: () => undefined, onEnd: () => undefined, onError: () => undefined })
  },
  hush: () => speech?.cancel(),
  sleep,
}

// ---------------------------------------------------------------- input: take-over and pause

const OURS = '.guide-ui, .ask-root, .sr-bar, .sr-layers'
/** a mouse move counts once it has travelled this far (a hand resting on the mouse is not a take-over) */
const MOVE_PX = 24
/** after a start or a Carry on, the hand that pressed it may still be moving */
const SETTLE_MS = 1500

function useInput(playing: boolean, token: number) {
  useEffect(() => {
    if (!playing) return
    const since = Date.now()
    let travel = 0
    let last: { x: number; y: number } | null = null
    const inOurs = (t: EventTarget | null) => t instanceof Element && !!t.closest(OURS)
    const inAsk = (t: EventTarget | null) => t instanceof Element && !!t.closest('.ask-root')
    const takeover = () => useReel.getState().send({ type: 'takeover' })
    const pause = () => useReel.getState().send({ type: 'pause', why: 'ask' })
    const onPress = (e: Event) => {
      if (!e.isTrusted) return
      if (inAsk(e.target)) return pause()
      if (inOurs(e.target)) return
      takeover()
    }
    const onKey = (e: KeyboardEvent) => {
      if (!e.isTrusted || ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab'].includes(e.key)) return
      // "/" opens the Ask (to ask "why?"): a pause, not a take-over
      if (inAsk(e.target) || e.key === '/') return pause()
      if (inOurs(e.target)) return
      takeover()
    }
    const onMove = (e: PointerEvent) => {
      if (!e.isTrusted || e.pointerType === 'touch') return
      if (inOurs(e.target)) {
        last = null
        return
      }
      if (last) travel += Math.hypot(e.clientX - last.x, e.clientY - last.y)
      last = { x: e.clientX, y: e.clientY }
      if (Date.now() - since > SETTLE_MS && travel >= MOVE_PX) takeover()
    }
    const opts = { capture: true, passive: true }
    window.addEventListener('pointerdown', onPress, opts)
    window.addEventListener('wheel', onPress, opts)
    window.addEventListener('touchstart', onPress, opts)
    window.addEventListener('keydown', onKey, opts)
    window.addEventListener('pointermove', onMove, opts)
    return () => {
      window.removeEventListener('pointerdown', onPress, opts)
      window.removeEventListener('wheel', onPress, opts)
      window.removeEventListener('touchstart', onPress, opts)
      window.removeEventListener('keydown', onKey, opts)
      window.removeEventListener('pointermove', onMove, opts)
    }
  }, [playing, token])
}

/** Fenced like the Ask: when the sign-in, session or client changes, it stops (the runner checks too). */
function useFence(on: boolean) {
  useEffect(() => {
    if (!on) return
    const o = askOrigin()
    const t = window.setInterval(() => {
      if (!o.ok()) useReel.getState().stop()
    }, 1000)
    return () => window.clearInterval(t)
  }, [on])
}

// ---------------------------------------------------------------- the bar

function statusWords(status: string, paused?: string): string {
  if (status === 'playing') return 'Playing by itself'
  if (status === 'paused') return paused === 'ask' ? 'Paused while you ask' : paused === 'layers' ? 'Paused on the layers of how' : 'Paused'
  if (status === 'took-over') return 'You took over. The showreel stopped here.'
  if (status === 'ended') return 'The showreel finished.'
  return ''
}

function Bar() {
  const { reel, note, answer, voice: voiceOn, layers } = useReel()
  const item = PLAYLIST[reel.at]
  const s = useReel.getState()
  if (reel.status === 'idle') return null
  const sceneNo = item ? item.si + 1 : 0
  const stepOf = item ? `${item.i + 1} of ${item.scene.steps.length}` : ''
  return (
    <section className="guide-ui sr-bar" role="region" aria-label="Demo showreel" data-xc-keep-clear="" data-status={reel.status}>
      <p className="guide-eyebrow">
        <span>Showreel · simulated hive</span>
        {item && (
          <span>
            Scene {sceneNo} of {SCENES.length}
            {item.scene.steps.length > 1 ? ` · step ${stepOf}` : ''}
          </span>
        )}
      </p>
      {item && reel.status !== 'ended' && <p className="sr-title">{item.scene.title}</p>}
      <p className="guide-status sr-status" role="status">
        {statusWords(reel.status, reel.paused)}
      </p>
      {note && reel.status !== 'ended' && <p className="guide-note">{note}</p>}
      {answer && reel.status !== 'playing' && reel.status !== 'ended' && (
        <div className="sr-answer" role="group" aria-label="The Ask’s answer">
          <p className="sr-q">You asked “{answer.q}”</p>
          <p className="guide-text">{answer.text}</p>
        </div>
      )}
      <span className="guide-controls" role="group" aria-label="Showreel controls">
        {reel.status === 'playing' && (
          <button type="button" className="guide-btn" onClick={() => s.send({ type: 'pause', why: 'person' })}>
            Pause
          </button>
        )}
        {(reel.status === 'paused' || reel.status === 'took-over') && (
          <button type="button" className="guide-btn" data-tone="primary" onClick={() => (layers ? s.closeLayers() : s.send({ type: 'resume' }))}>
            Carry on
          </button>
        )}
        {active(reel) && (
          <button type="button" className="guide-btn" aria-expanded={!!layers} onClick={() => (layers ? s.hideLayers() : s.openLayers('screen'))}>
            {answer?.kind === 'step' && !layers ? 'Show me more about this' : layers ? 'Hide how' : 'How, all the way down'}
          </button>
        )}
        {reel.status === 'ended' && (
          <button type="button" className="guide-btn" data-tone="primary" onClick={() => s.start()}>
            Play again
          </button>
        )}
        {reel.status !== 'ended' && (
          <label className="guide-auto">
            <input type="checkbox" checked={reel.loop} onChange={(e) => s.send({ type: 'loop', on: e.target.checked })} /> Loop
          </label>
        )}
        <label className="guide-auto">
          <input type="checkbox" checked={voiceOn} onChange={(e) => s.setVoice(e.target.checked)} /> Voice
        </label>
        {reel.status === 'ended' || reel.status === 'took-over' ? (
          <button type="button" className="guide-btn" data-tone="quiet" onClick={() => s.close()}>
            Close
          </button>
        ) : (
          <button type="button" className="guide-btn" data-tone="quiet" onClick={() => s.stop()}>
            Stop
          </button>
        )}
      </span>
    </section>
  )
}

function Layers() {
  const { reel, layers } = useReel()
  const s = useReel.getState()
  const item = PLAYLIST[reel.at]
  if (!layers || !item || !active(reel)) return null
  return (
    <LayerStack
      trace={item.step.trace}
      title={item.scene.title}
      at={layers.at}
      deepest={layers.deepest}
      onAt={(k) => s.openLayers(k)}
      onDeeper={() => s.deeper()}
      onBackUp={() => s.closeLayers()}
      onClose={() => s.hideLayers()}
    />
  )
}

export default function ShowreelLayer() {
  const reel = useReel((s) => s.reel)
  useEffect(() => {
    setReelEnv(liveReelEnv)
    setShowreelWords(showreelWords)
    void loadVoices().then((v) => {
      voice = pickVoice(v)
    })
    return () => {
      setShowreelWords(null)
      setReelEnv(null)
      useReel.getState().stop()
      clearDemoScripts()
    }
  }, [])
  // the marks and cursor are the playing step's: gone when it ends, kept while paused or taken over
  useEffect(() => {
    if (reel.status === 'idle' || reel.status === 'ended') clearInk('showreel', { cursor: true })
  }, [reel.status])
  // while it shows, first-visit hints wait (tour/ViewInfo), as they do for a guided demo's caption
  const showing = active(reel)
  useEffect(() => (showing ? markDemo(document.documentElement) : undefined), [showing])
  useInput(reel.status === 'playing', reel.token)
  useFence(active(reel))
  return createPortal(
    <>
      <Bar />
      <Layers />
    </>,
    document.body,
  )
}
