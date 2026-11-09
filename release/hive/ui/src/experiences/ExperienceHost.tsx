import { Component, createElement, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { escapeAndSay } from './escapeSay'
import { useExperienceNotices } from '../shell/experienceStage'
import { useReducedMotion } from '../lib/hooks'
import { useRoute } from '../lib/router'
import { phasesOptedIn, releasedPhasesOn, usePhase } from '../shell/phase'
import { createAskPort } from '../features/ask/askPort'
import { bindEpoch, currentEpoch, onIdentityChange } from '../lib/identityEpoch'
import { landingOf, rememberLanding } from '../shell/landing'
import { useAwakeApps } from '../shell/awakeApps'
import { useRestWaiting } from '../shell/restNotices'
import { holdPhaseMotion } from '../shell/phaseMotion'
import { askHasWords, onAskWords } from '../features/ask/askField'
import { useAskMark } from '../brand/askMark'
import { lookState } from '../shell/uiVariant'
import { useHive } from '../store/store'
import { CLASSIC, EXPERIENCES, experienceById, type ExperienceDef, type ExperiencePhases } from './registry'
import { OmegaMenu } from './OmegaMenu'
import { PhaseAnchor } from './phaseAnchor'

/**
 * If an experience throws (while rendering or while its code loads), the person is returned to the Classic hive
 * immediately and locally; saving that choice happens afterwards and cannot hold them in a broken experience (Review R1).
 */
class Guard extends Component<{ children: ReactNode; onFail: (e: unknown) => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(e: unknown) {
    this.props.onFail(e)
  }
  render() {
    return this.state.failed ? <Stage>Returning to the Classic hive…</Stage> : this.props.children
  }
}

/** The bare stage while an experience loads or hands back: its chrome's surface and ink, never the classic void. */
function Stage({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="xc-ink-2 fixed inset-0 grid place-items-center text-[13px]" style={{ background: 'var(--xc-texture), var(--xc-surface)', fontFamily: 'var(--xc-font)' }}>
      {children}
    </div>
  )
}

/** One lazy component per experience, made once at module load (never during render). A failed load is replaced so the next visit retries. */
const lazyFor = (e: ExperienceDef) => lazy(e.load!)
const LAZY = new Map<string, ComponentType>(EXPERIENCES.filter((e) => e.load).map((e) => [e.id, lazyFor(e)]))

/** Classic keeps its existing Pro UI and the one Ask mounted around its candidate phase layer. */
export function ClassicPhaseHost() {
  return (import.meta.env.PROD ? import.meta.env.MODE === 'surface-preview' : true) ? <PhaseLayer def={CLASSIC} /> : null
}

export function ClassicProChrome({ children }: { children: ReactNode }) {
  const held = usePhase((s) => s.phased && s.phase !== 'pro')
  const covered = useRoute().name !== 'hive'
  const hidden = (import.meta.env.PROD ? import.meta.env.MODE === 'surface-preview' : true) && held && !covered
  return <div className="classic-pro-chrome" inert={hidden} style={{ display: hidden ? 'none' : 'contents' }}>{children}</div>
}

export function ExperienceHost({ id }: { id: string }) {
  const def = experienceById(id)
  const Comp = LAZY.get(def.id)
  const route = useRoute()
  // in front (no classic page or sheet over it): notices keep clear of the experience's chrome (request Q)
  // the Pro notice stage only while Pro is in front: rest and awake are not Pro's stage (Codex 3 Nov: it polled at 4 Hz)
  const phasedHome = usePhase((s) => s.phased && s.phase !== 'pro')
  useExperienceNotices(!!Comp && route.name === 'hive' && !phasedHome)
  if (!Comp) return null
  return (
    <>
      <Guard
        key={def.id}
        onFail={(e) => {
          if (def.load) LAZY.set(def.id, lazyFor(def)) // a failed lazy load is retried next time, not cached as broken
          void escapeAndSay(`${def.name} hit a problem; you are back in the Classic hive`, { body: e instanceof Error ? e.message : undefined, when: 'always' })
        }}
      >
        <PhaseLayer def={def}>
          <Suspense fallback={<Stage>Opening {def.name}…</Stage>}>
            {createElement(Comp)}
          </Suspense>
        </PhaseLayer>
      </Guard>
      <EscapeHatch name={def.name} id={def.id} />
    </>
  )
}

/**
 * The shell's rest → awake → Pro (shell/phase.ts), for an experience that draws them (ExperienceDef.phases, a candidate).
 * The shell owns the state and the root's `data-shell-phase` (which hides the one Ask and the shell's corners at rest,
 * without remounting them); the experience's own renderers draw each state and its hooks start its flights. Without
 * phases, or without the person's opt-in, the state is Pro: the experience exactly as today.
 */
function PhaseLayer({ def, children }: { def: ExperienceDef; children?: ReactNode }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [opted] = useState(() => !!def.phases && (def.phasesReviewed ? releasedPhasesOn() : phasesOptedIn()))
  const [mod, setMod] = useState<ExperiencePhases | null>(null)
  const phase = usePhase((s) => s.phase)
  const from = usePhase((s) => s.from)
  const reduced = useReducedMotion()
  // one Ask port per identity (contract R1.1 #2): a port made for one person is dead after a change, so make a new one
  const [epoch, setEpoch] = useState(currentEpoch)
  useEffect(() => onIdentityChange(() => setEpoch(currentEpoch())), [])
  const ask = useMemo(() => createAskPort(def.id), [def.id, epoch])
  const apps = useAwakeApps(opted)
  const typing = useSyncExternalStore(onAskWords, askHasWords, () => false)
  const presence = useAskMark(def.id, typing)
  const waiting = useRestWaiting()
  const last = useRef(phase)
  // before the first paint: an opted-in experience starts at rest, never flashing its Pro chrome first
  useLayoutEffect(() => {
    if (!opted || !def.phases) return
    usePhase.getState().setPhased(true, def.id, landingOf(lookState().saved))
    let live = true
    // the shell's own phase styles come with the first phased experience
    void import('../shell/phase.css')
    def.phases().then(
      (m) => {
        if (!live) return
        setMod(m)
        // only an experience that draws rest or awake takes part; otherwise straight to its home (today's behaviour)
        if (!(m.rest || m.awake)) usePhase.getState().setPhased(false)
      },
      () => live && usePhase.getState().setPhased(false),
    )
    return () => {
      live = false
      setMod(null)
      // stepping out (an app opened full screen, another look, a crash): keep this experience's place for its return
      usePhase.getState().setPhased(false, def.id)
    }
  }, [opted, def])
  const phased = usePhase((s) => s.phased)
  // a page over the experience (Apps, keys, usage…) covers rest and awake too: their layers and the root's state step
  // aside (the phase is kept, and the one Ask is the page's as usual) and come back when the page closes
  const covered = useRoute().name !== 'hive'
  // rest only (Surface review of Codex's shared motion R1): at rest nothing visible uses framer-motion, so the hidden Pro
  // tree is frozen whole; awake shows the one Ask, whose panels and thread animate, so awake stops hidden motion at its
  // source instead (the ticker, the stats, a chosen rest's toasts; shell/Ambient, shell/Hud)
  useLayoutEffect(() => {
    if (phased && !covered && phase === 'rest') return holdPhaseMotion()
  }, [phased, covered, phase])
  useLayoutEffect(() => {
    const root = document.documentElement
    if (!phased || covered) {
      delete root.dataset.shellPhase
      delete root.dataset.shellExperience
      return
    }
    root.dataset.shellPhase = phase
    root.dataset.shellExperience = def.id
    return () => {
      delete root.dataset.shellPhase
      delete root.dataset.shellExperience
    }
  }, [phased, phase, covered, def.id])
  // the experience's hooks start its own flights; the shell never waits on them to move the state
  useEffect(() => {
    const prev = last.current
    last.current = phase
    if (!mod || prev === phase) return
    if (phase === 'pro') void Promise.resolve(mod.toPro?.(prev)).catch(() => undefined)
    else if (prev === 'pro') void Promise.resolve(mod.fromPro?.()).catch(() => undefined)
    // where this person lands next time (contract R1.1 §7): Pro when they went there from awake, awake when they came back;
    // bound now, to whoever made the move, so a save landing after a sign-in change writes nothing
    const to = phase === 'pro' && prev === 'awake' ? 'pro' : prev === 'pro' && phase === 'awake' ? 'awake' : null
    if (to) void rememberLanding(useHive.getState().client, to, bindEpoch()).catch(() => undefined)
  }, [phase, mod])
  const shown = phased && !!mod && !covered
  // (the renderers are the experience's own; they stay mounted through every state and play their own way in and out)
  const Rest = shown ? mod?.rest : undefined
  const Awake = shown ? mod?.awake : undefined
  return (
    <PhaseAnchor.Provider value={setAnchor}>
      {children}
      {Rest && <Rest anchor={anchor} phase={phase} from={from} reduced={reduced} ask={ask} apps={apps} presence={presence} waiting={waiting} />}
      {Awake && <Awake anchor={anchor} phase={phase} from={from} reduced={reduced} ask={ask} apps={apps} presence={presence} waiting={waiting} />}
    </PhaseAnchor.Provider>
  )
}

/** The experience's Ω: the shared menu plus the way back to the Classic hive. Outside the Guard, so it survives a crash. */
function EscapeHatch({ name, id }: { name: string; id: string }) {
  const toClassic = () =>
    void escapeAndSay('Back to the Classic hive', { when: 'local' })
  return <OmegaMenu heading={`You are in ${name}`} context={id} footer={[{ label: 'Back to the Classic hive', run: toClassic }]} />
}
