/* eslint-disable react-refresh/only-export-components -- a Vite entry, not a module others import */
import '@fontsource-variable/inter'
import '../index.css'
import '../forms/lifeMap/lifemap.css'
import '../experiences/still/still.css'
import { AnimatePresence, LazyMotion, MotionConfig } from 'framer-motion'
import { StrictMode, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ActionResult, Program } from '../api/types'
import type { SimClient } from '../api/sim/SimClient'
import { useEscape } from '../lib/hooks'
import { useHive } from '../store/store'
import { useIntro } from '../tour/introStore'
import { DecisionDialog } from './DecisionDialog'
import { askConfirm, ConfirmHost } from './confirm'
import { modalLayers, useModalContainment } from './useModalContainment'
import { AppPicker } from '../features/programs/AppPicker'
import { AppAccessButton } from '../features/programs/AppActivity'
import { SwarmSettingsButton } from '../features/swarm/SwarmSettings'
import CommandPalette from '../features/palette/CommandPalette'
import StopAll from '../features/hive/StopAll'
import TokenReveal from '../features/create/TokenReveal'
import { NewRoom } from '../features/messages/MessagesPage'
import { MoreSheet } from '../shell/Nav'
import { HelpSheet, Welcome } from '../tour/Intro'
import { HiveDirectory } from '../experiences/HiveDirectory'
import { DecisionInspect } from '../experiences/canvas/Inspect'
import { Sheet as StillSheet } from '../experiences/still/Sheets'
import { Reading } from '../experiences/still/Reading'
import { FORMS } from '../forms/contract'
import { fixtureDescribe, fixtureGraph, fixtureProgram } from '../forms/caseFile/fixture'
import { useAtlas } from '../forms/lifeMap/useAtlas'
import { ATLAS_DESCRIBE, sampleGraph } from '../forms/lifeMap/sample'
import { ConsentDialog } from '../forms/lifeMap/parts'
import { AskModal, Modal } from '../forms/lifeMap/panels'

/**
 * Dev-only mounted harness for modal containment (Review A2/B1/E1), a separate Vite entry: /modal-harness.html.
 * Every modal dialog in the UI is mounted over a page with background controls, using the real components and
 * hooks. Data is the in-browser simulator and the forms' synthetic fixtures; nothing leaves the page, no hive is
 * contacted. scripts/.omegaui/modal-containment.mjs drives it in Brave headless.
 */

const loadMotion = () => import('../lib/motionFeatures').then((r) => r.default)

type Probe = {
  ran: Record<string, number>
  bg: number
  ready: boolean
  approvalId: string | null
  top: () => HTMLElement | null
  layers: () => number
  /** The canvas inspect's request: still pending and not being decided. */
  approvalUndecided: () => boolean
}
const probe: Probe = {
  ran: {},
  bg: 0,
  ready: false,
  approvalId: null,
  // the live layer; without containment (the negative control, ?nocontain) the last open aria-modal dialog
  top: () => {
    const all = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')]
    return all.find((el) => modalLayers.isTop(el)) ?? (new URLSearchParams(location.search).has('nocontain') ? (all[all.length - 1] ?? null) : null)
  },
  layers: () => modalLayers.size,
  approvalUndecided: () => {
    const s = useHive.getState()
    const id = probe.approvalId
    return !!id && s.approvals[id]?.status === 'pending' && !s.deciding[id]
  },
}
;(window as unknown as { __modal: Probe }).__modal = probe
const ran = (k: string) => (probe.ran[k] = (probe.ran[k] ?? 0) + 1)

const atlasProgram: Program = { id: 'atlas', name: 'Atlas', version: 'harness', description: 'Invented harness program.', icon: 'flask', capabilities: [], source: 'harness', enabled: true, error: null }

function Btn({ id, children, onClick }: { id: string; children: ReactNode; onClick: () => void }) {
  return (
    <button id={id} type="button" onClick={onClick} style={{ padding: '6px 10px', margin: 3, borderRadius: 8, border: '1px solid #444', background: '#15152a', color: 'var(--color-ink)', font: '13px system-ui' }}>
      {children}
    </button>
  )
}

/** The primitive alone, with nothing focusable in it (a loading state). */
function ZeroDialog({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  useEscape(onClose)
  useModalContainment(box)
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgb(0 0 0 / 0.6)', display: 'grid', placeItems: 'center' }}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby="zero-h" style={{ background: '#111', padding: 24, borderRadius: 16 }}>
        <h2 id="zero-h">Reading… (nothing to press yet)</h2>
      </div>
    </div>
  )
}

/** The Still grammar host closes its pages with Esc itself (experiences/still/index.tsx); this stands in for it. */
function StillHost({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  useEscape(onClose)
  return (
    <div className="still" style={{ position: 'fixed', inset: 0, zIndex: 50 }}>
      {children}
    </div>
  )
}

function LifeMapConsent({ which, onClose }: { which: 'consent' | 'ask' | 'one'; onClose: () => void }) {
  const [graph] = useState(() => sampleGraph())
  const target = graph.items.find((i) => i.kind === 'hypothesis')?.id ?? graph.items[0].id
  const atlas = useAtlas({
    program: atlasProgram,
    graph,
    describe: ATLAS_DESCRIBE,
    grammar: 'classic',
    focus: () => {},
    viewer: { isOwner: true },
    act: async (): Promise<ActionResult> => {
      ran('lifemap-consent')
      return { status: 'done', message: 'synthetic only' }
    },
  })
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    if (which === 'consent') atlas.request('investigate', [target])
    if (which === 'ask') atlas.setPanel('ask')
  })
  // the consent and the Ask modal close themselves through the atlas; tell the harness when they have
  const was = useRef(false)
  const showing = which === 'consent' ? !!atlas.draft : which === 'ask' ? atlas.panel === 'ask' : true
  useEffect(() => {
    if (showing) was.current = true
    else if (was.current) onClose()
  })
  return (
    <div className="lm" data-grammar="classic" style={{ position: 'fixed', inset: 0, zIndex: 50, pointerEvents: 'none' }}>
      <div style={{ pointerEvents: 'auto' }}>
        {which === 'consent' && <ConsentDialog atlas={atlas} />}
        {which === 'ask' && atlas.panel === 'ask' && <AskModal atlas={atlas} openMap={() => {}} />}
        {which === 'one' && (
          <Modal title="One control" onClose={onClose}>
            <p className="lm-note">Only the close button can take focus here.</p>
          </Modal>
        )}
      </div>
    </div>
  )
}

const CaseForm = FORMS['case-file']

function Harness({ sim }: { sim: SimClient }) {
  const [open, setOpen] = useState<string | null>(null)
  const [bg, setBg] = useState(0)
  const [program, setProgram] = useState<{ id: string; name: string } | null>(null)
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const approvals = useHive((s) => s.approvals)
  const paletteOpen = useHive((s) => s.paletteOpen)
  const stopAllOpen = useHive((s) => s.stopAllOpen)
  const welcome = useIntro((s) => s.welcome)
  const help = useIntro((s) => s.help)
  const swarm = Object.values(swarms)[0]
  const agent = Object.values(agents)[0]
  const approval = Object.values(approvals).find((a) => a.status === 'pending')
  const [now] = useState(() => Date.now())
  useEffect(() => {
    void sim.programs().then((ps) => setProgram(ps[0] ? { id: ps[0].id, name: ps[0].name } : null))
  }, [sim])
  useEffect(() => {
    probe.approvalId = approval?.id ?? null
    probe.ready = !!swarm && !!agent && !!program
    probe.bg = bg
  })
  const close = () => setOpen(null)
  const o = (k: string) => () => setOpen(k)

  return (
    <div style={{ padding: 16, font: '14px system-ui' }}>
      <h1 style={{ fontSize: 18 }}>Modal containment harness (synthetic, simulator only)</h1>
      <section aria-label="Background" style={{ margin: '8px 0', padding: 8, border: '1px dashed #555' }}>
        <button id="bg-a" type="button" onClick={() => setBg((n) => n + 1)} style={{ padding: '10px 14px', marginRight: 8 }}>
          Background action
        </button>
        <button id="bg-b" type="button" style={{ padding: '10px 14px', marginRight: 8 }}>
          More · 3
        </button>
        <a id="bg-link" href="#nowhere" style={{ color: '#9cf' }}>
          Background link
        </a>
        <span id="bg-count" style={{ marginLeft: 12 }}>
          {bg}
        </span>
      </section>
      <section aria-label="Openers" style={{ display: 'flex', flexWrap: 'wrap' }}>
        <Btn id="open-decision" onClick={o('decision')}>DecisionDialog</Btn>
        <Btn id="open-confirm-dialog" onClick={() => useHive.getState().setStopAll(true)}>ConfirmDialog (Stop all)</Btn>
        <Btn
          id="open-confirm-host"
          onClick={() => {
            void askConfirm('Invented question: continue?', 'Continue').then((ok) => ok && ran('confirm-host'))
          }}
        >
          ConfirmHost
        </Btn>
        <Btn id="open-app-picker" onClick={o('app-picker')}>AppPicker</Btn>
        <Btn id="open-app-picker-loading" onClick={o('app-picker-loading')}>AppPicker loading</Btn>
        <Btn id="open-app-picker-empty" onClick={o('app-picker-empty')}>AppPicker empty</Btn>
        <Btn id="open-app-picker-error" onClick={o('app-picker-error')}>AppPicker error</Btn>
        {program && <AppAccessButton programId={program.id} name={program.name} />}
        {swarm && <SwarmSettingsButton swarm={swarm} />}
        <Btn id="open-lifemap-consent" onClick={o('lifemap-consent')}>Atlas consent</Btn>
        <Btn id="open-lifemap-ask" onClick={o('lifemap-ask')}>Atlas Ask modal</Btn>
        <Btn id="open-lifemap-one" onClick={o('lifemap-one')}>Atlas modal, one control</Btn>
        <Btn id="open-hive-directory" onClick={o('hive-directory')}>HiveDirectory</Btn>
        <Btn id="open-canvas-inspect" onClick={o('canvas-inspect')}>Canvas inspect</Btn>
        <Btn id="open-still-sheet" onClick={o('still-sheet')}>Still sheet</Btn>
        <Btn id="open-still-reading" onClick={o('still-reading')}>Still reading</Btn>
        <Btn id="open-more-sheet" onClick={o('more-sheet')}>Phone More sheet</Btn>
        <Btn id="open-palette" onClick={() => useHive.getState().setPalette(true)}>CommandPalette</Btn>
        <Btn id="open-token-reveal" onClick={() => agent && useHive.setState({ reveal: { agent, token: 'invented-harness-token-0000' } })}>TokenReveal</Btn>
        <Btn id="open-new-room" onClick={o('new-room')}>Messages: new conversation</Btn>
        <Btn id="open-welcome" onClick={() => useIntro.getState().showWelcome()}>Welcome</Btn>
        <Btn id="open-help" onClick={() => useIntro.getState().setHelp(true)}>Help sheet</Btn>
        <Btn id="open-zero" onClick={o('zero')}>Primitive, nothing focusable</Btn>
      </section>
      <section aria-label="Case file (synthetic fixture, Still grammar)" style={{ marginTop: 12, height: 520, overflow: 'auto', background: '#f6f0e3' }}>
        <Suspense fallback={null}>
          <CaseForm program={fixtureProgram} describe={fixtureDescribe} graph={fixtureGraph} grammar="still" focus={() => {}} act={async () => (ran('case-sheet'), { status: 'done', message: 'synthetic only' })} />
        </Suspense>
      </section>

      <ConfirmHost />
      <AnimatePresence>
        {open === 'decision' && (
          <DecisionDialog
            key="decision"
            eyebrow="Synthetic"
            title="Invented decision"
            facts={[
              ['Effect', 'Harness counter only'],
              ['Cost', 'None (invented)'],
            ]}
            bound={{ kind: 'ready' }}
            thing="This decision"
            onClose={close}
            actions={[
              {
                label: 'Confirm',
                tone: 'primary',
                run: async () => {
                  ran('decision')
                  return true
                },
              },
            ]}
          />
        )}
      </AnimatePresence>
      {stopAllOpen && <StopAll />}
      {open?.startsWith('app-picker') && swarm && (
        <AppPicker
          appName="Invented app"
          swarmId={open === 'app-picker' ? swarm.id : `s_${open.slice('app-picker-'.length)}`}
          accept={['artifact', 'asset']}
          kinds={null}
          onChoose={() => (ran('app-picker'), close())}
          onCancel={close}
        />
      )}
      {open?.startsWith('lifemap-') && <LifeMapConsent which={open === 'lifemap-consent' ? 'consent' : open === 'lifemap-ask' ? 'ask' : 'one'} onClose={close} />}
      {open === 'hive-directory' && (
        <div style={{ position: 'fixed', left: 0, bottom: 0, zIndex: 80 }}>
          <HiveDirectory experience="classic" onClose={close} />
        </div>
      )}
      {open === 'canvas-inspect' && approval && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, ['--card' as string]: '#fbfaf7', ['--ink' as string]: '#1b1b1f', ['--ink-2' as string]: '#444', ['--ink-3' as string]: '#666', ['--line' as string]: '#ddd', ['--line-2' as string]: '#ccc' }}>
          <DecisionInspect id={approval.id} now={now} onClose={close} fallbackFocus={() => document.getElementById('open-canvas-inspect')} />
        </div>
      )}
      <AnimatePresence>
        {open === 'still-sheet' && (
          <StillHost key="sheet" onClose={close}>
            <StillSheet kind="goals" onClose={close} onOpenMind={() => {}} onLaunch={() => {}} />
          </StillHost>
        )}
        {open === 'still-reading' && agent && (
          <StillHost key="reading" onClose={close}>
            <Reading id={agent.id} onClose={close} />
          </StillHost>
        )}
        {open === 'more-sheet' && <MoreSheet key="more" onClose={close} />}
        {paletteOpen && <CommandPalette key="palette" />}
      </AnimatePresence>
      <TokenReveal />
      {open === 'new-room' && <NewRoom onClose={close} onCreated={close} />}
      <AnimatePresence>
        {welcome && <Welcome key="welcome" />}
        {help && <HelpSheet key="help" />}
      </AnimatePresence>
      {open === 'zero' && <ZeroDialog onClose={close} />}
    </div>
  )
}

async function boot() {
  const { SimClient } = await import('../api/sim/SimClient')
  const sim = new SimClient({ extraDots: 0, speed: 0.001 })
  // invented picker states, by swarm id: loading never answers, empty has nothing, error refuses
  const arts = sim.swarmArtifacts.bind(sim)
  const files = sim.listAssets.bind(sim)
  const by = <T,>(id: string | undefined, real: () => Promise<T[]>): Promise<T[]> =>
    id === 's_loading' ? new Promise<T[]>(() => {}) : id === 's_empty' ? Promise.resolve([]) : id === 's_error' ? Promise.reject(new Error('invented failure')) : real()
  sim.swarmArtifacts = (id, opts) => by(id, () => arts(id, opts))
  sim.listAssets = (id) => by(id, () => files(id))
  await useHive.getState().init(sim)
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <LazyMotion features={loadMotion} strict>
        <MotionConfig reducedMotion="user">
          <Harness sim={sim} />
        </MotionConfig>
      </LazyMotion>
    </StrictMode>,
  )
}
void boot()
