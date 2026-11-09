import { PersonSwarmConsentHost } from './PersonSwarmConsent'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { closePage, navigate, sameCreation, type CreationReference } from '../../lib/router'
import { sessionKey } from '../../store/programSession'
import { useHive } from '../../store/store'
import { ConfirmHost } from '../../ui/confirm'
import { askConfirmBound, bindEpoch, onIdentityChange } from '../../lib/identityEpoch'
import { AppAccess } from './AppActivity'
import { OmegaMenu } from '../../experiences/OmegaMenu'
import { useEscape } from '../../lib/hooks'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import type { Compose, ScreenFacts, ScreenPlan } from '../../screens/screenSpace'
import { appPage, closedPage, menuSections, type ClosedState } from './appPage'
import ProgramHost from './ProgramHost'
import { DISCARD_LABEL, DISCARD_QUESTION, followViewLink, oneQuestion } from './viewLink'
import { ProgramForm } from './ProgramForm'
import { FORM_OVER_FRAME, formFor, GRAMMARS, type Grammar } from '../../forms/contract'
import { experienceById } from '../../experiences/registry'
import { useLook } from '../../shell/uiVariant'
import { AppFrame } from './AppFrame'
import { programBackOrExit } from './style'
import { shown } from '../../lib/displayName'
import { useAppLook } from '../../shell/appLook'
import { useUnsaved } from '../ask/dirty'
import { useAskStore } from '../../store/ask'
import { appRouting } from './pickSwarm'
import { CoordinatorNotice } from './CoordinatorNotice'
import { lookupHomes, type HomesState } from './homesLookup'
import { DrawingEntry, drawingAvailability } from '../studioLive/drawingUi'
import { focusAsk, noteFrameDirty, prepFromAsk } from '../studioLive/store'
import { drawLive } from '../studioLive/drawLive'
import { askFieldWords, subscribeAskFieldWords } from '../ask/useAskField'
import { StudioLiveBar } from '../studioLive/DirectingStudio'
import { PersonAppOpener, type PersonAppState } from '../../lib/personAppOpen'
import { useIdentityEpoch } from '../../lib/epochBound'
import { useAlive } from '../../lib/boundOperation'

const CreateCodeBench = lazy(() => import('../code/CreateCodeBench'))
const FlowStudio = lazy(() => import('../flow/FlowPage').then((m) => ({ default: m.FlowStudio })))
const PlanCanvas = lazy(() => import('../createPlan/PlanCanvas'))

const HOMES_PENDING: HomesState = { kind: 'pending' }
const PERSON_OPENING: PersonAppState = { kind: 'opening' }
const noSubscribe = () => () => undefined
const openingSnapshot = () => PERSON_OPENING
const SWARM_KEY = (id: string) => `omegadots.program.swarm.${id}`

function rememberedSwarm(id: string): string | null {
  try {
    return localStorage.getItem(SWARM_KEY(id))
  } catch {
    return null
  }
}

type ProgramPageProps = { id: string; swarm?: string; source?: CreationReference; view?: 'graph' | 'studio' }

/**
 * #/program/<id>[/<swarm>]: the host as a full page. A program call is scoped to one swarm.
 * The app is named only when the host lists it for this person (town follow-up; stand-in r3): a direct URL to an id the
 * host does not list, before the list arrives, after an identity change or when it cannot be read, is a generic page
 * that names nothing, offers no app's controls and asks the host nothing about that id.
 */
export default function ProgramPage(props: ProgramPageProps) {
  const listed = useHive((s) => !!s.programs?.some((p) => p.id === props.id))
  const programsLoaded = useHive((s) => !!s.programs)
  const programsError = useHive((s) => s.programsError)
  const loadPrograms = useHive((s) => s.loadPrograms)
  useEffect(() => {
    if (!programsLoaded) void loadPrograms().catch(() => undefined)
  }, [programsLoaded, loadPrograms])
  if (listed) return <ListedProgramPage key={props.id} {...props} />
  return <AppUnavailable state={programsLoaded ? 'unlisted' : programsError ? 'unreadable' : 'opening'} retry={() => void loadPrograms().catch(() => undefined)} />
}

/**
 * The plans this page's screens were composed into, kept across mounts (the same look and facts always compose the
 * same plan): useCompose keeps its answers per mount, and an app page is mounted afresh for every app and every
 * identity, so opening one again asks MeTTa nothing new. A plan that could not be composed (the plain unavailable
 * notice, which has no title) is never kept. Up to KEPT plans, oldest dropped.
 */
const KEPT = 128
const kept = new Map<string, ScreenPlan>()
function useKeptCompose(look: string): Compose {
  const compose = useCompose(look)
  return useCallback((screen: string, facts: ScreenFacts) => {
    const key = `${look}|${screen}|${JSON.stringify(facts)}`
    const hit = kept.get(key)
    if (hit) return hit
    const plan = compose(screen, facts)
    if (plan.title !== null) {
      if (kept.size >= KEPT) kept.delete(kept.keys().next().value as string)
      kept.set(key, plan)
    }
    return plan
  }, [compose, look])
}

/** What the page for an app this person may not open says as its heading (screen readers), by where it stands. */
const CLOSED_TITLE: Record<ClosedState, string> = {
  opening: 'Opening the app',
  unreadable: 'The apps list could not be read',
  unlisted: "This app isn't available to you here",
}

/**
 * How the composed parts sit in a page that fills the screen. Each class only places what MeTTa composed: a part's
 * wrapper the renderer leaves empty takes no room, the space-y spacing gives way to these, and nothing here decides
 * whether a part shows.
 * - CHROME, above the app: the composed notes and tabs get the page's margins and sit over the app's motif; islands
 *   bring their own.
 * - STAGE, the app's place: a surface (marked data-fill) fills it; the states before the app opens sit centred; the
 *   dialogs and Ω (fixed, drawn by their islands) take no room.
 * - CLOSED, the page for an app that is not available: the Stop on top, the state centred, Ω fixed.
 */
const FLOW = '[&>[data-screen-part]]:mb-0 [&>[data-screen-row]]:mb-0 [&>[data-screen-part]:empty]:hidden'
const CHROME = `shrink-0 ${FLOW} [&>:not([data-block=island])]:relative [&>:not([data-block=island])]:z-[1] [&>:not([data-block=island])]:mx-3 [&>:not([data-block=island])]:mt-3`
const STAGE = `flex h-full flex-col justify-center gap-4 ${FLOW} [&>[data-screen-part]:has(>[data-fill])]:min-h-0 [&>[data-screen-part]:has(>[data-fill])]:flex-1 [&>[data-block=island]:not(:has(>[data-fill]))]:contents [&>:not([data-block=island])]:self-center [&>:not([data-block=island])]:px-6`
const CLOSED = `flex h-full flex-col items-center gap-4 ${FLOW} [&>[data-block=island]]:self-stretch [&>[data-block=island]:first-child]:mb-auto [&>[data-screen-part]:empty+*]:mt-auto [&>[data-block=island]:last-child]:mt-auto [&>:not([data-block=island])]:px-6`

/** The page for an app this person may not open here, or not yet known to be one they may: no name, no app controls. */
export function AppUnavailable({ state, retry }: { state: ClosedState; retry?: () => void }) {
  const leave = () => closePage(() => navigate({ name: 'programs' }))
  useEscape(leave)
  const look = experienceById(useLook().current?.experience).id
  const compose = useKeptCompose(look)
  const plan = useMemo(() => compose('program-closed', closedPage(state, !!retry).facts), [compose, state, retry])
  return (
    <section aria-label="App" data-presence-region="app" data-app-unavailable={state} className="fixed inset-x-0 top-0 z-[30] flex h-dvh flex-col overflow-hidden" style={{ background: 'linear-gradient(180deg, color-mix(in oklab, var(--color-abyss) 97%, transparent), color-mix(in oklab, var(--color-void) 99%, transparent))' }}>
      <h1 className="sr-only">{CLOSED_TITLE[state]}</h1>
      <Screen plan={plan} className={CLOSED} host={{
        data: {},
        islands: {
          'studio-live': <StudioLiveBar inline />,
          'omega-menu': <OmegaMenu heading="Apps" context={look} sections={[{ items: [{ label: 'Back to Apps', run: leave }] }]} />,
        },
        onAction: (action) => {
          if (action === 'retry') retry?.()
          else if (action === 'leave') leave()
        },
      }} />
    </section>
  )
}

/** A listed app's page: from here on the host has listed the app for this person, so its name and controls may show. */
function ListedProgramPage({ id, swarm, source, view }: ProgramPageProps) {
  const swarms = useHive((s) => s.swarms)
  const program = useHive((s) => s.programs?.find((p) => p.id === id))
  const sorted = useMemo(() => Object.values(swarms).sort((a, b) => a.name.localeCompare(b.name)), [swarms])
  const client = useHive((s) => s.client)
  // P14: a person app opens straight into the person's own context, which only the host names; no swarm is picked
  const personApp = program?.placement === 'person' && !!client?.openPersonApp
  // one opener per app, client and identity epoch; its answers land only while all three are still the current ones
  const epoch = useIdentityEpoch()
  const liveOpener = useMemo(() => {
    if (!personApp || !client) return null
    const binding = bindEpoch()
    return new PersonAppOpener(client, id, () => binding.current() && useHive.getState().client === client)
    // epoch: a same-client identity change makes a fresh opener (bindEpoch above is per identity)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personApp, client, id, epoch])
  useEffect(() => {
    if (!liveOpener) return
    void liveOpener.open()
    return liveOpener.stop
  }, [liveOpener])
  const personState = useSyncExternalStore(liveOpener?.subscribe ?? noSubscribe, liveOpener?.getSnapshot ?? openingSnapshot, openingSnapshot)
  const personSwarm = personApp && personState.kind === 'ready' ? personState.swarmId : null
  const askingHelpers = personApp && personState.kind === 'ready' && personState.helpers === 'consent'
  const current = personApp ? (swarm && swarm === personSwarm ? swarm : null) : swarm && swarms[swarm] ? swarm : null
  // Create's bench (Jon 10-31: one app, Code/Design/Flow as bench kinds): Studio is the app's own canvas
  const [bench, setBench] = useState<'studio' | 'make' | 'code' | 'flow'>('studio')
  const codeShown = id === 'omegadesign' && !!current && bench === 'code'
  const flowShown = id === 'omegadesign' && !!current && bench === 'flow'
  // Make: one sentence to a planned, built, checked thing (features/createPlan)
  const makeShown = id === 'omegadesign' && !!current && bench === 'make'
  const setCodeOpen = (open: boolean) => setBench(open ? 'code' : 'studio')
  const codeDeparture = useRef<((leave: () => void) => void) | null>(null)
  const leaveCode = (leave: () => void) => {
    const binding = bindEpoch()
    const done = () => { binding.commit(leave) }
    if (codeShown && codeDeparture.current) codeDeparture.current(done)
    else done()
  }
  const title = useHive((s) => (current ? s.programSessions[sessionKey(id, current)]?.graph?.title : undefined))

  // Where the app works (configured, activated, opened before): open there, never on whichever swarm sorts first.
  // where the app works: pending, known (maybe empty), absent (no homes route) or failed (never read as "nowhere")
  const [lookup, setLookup] = useState<{ client: unknown; id: string; attempt: number; state: HomesState } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [graph, setGraph] = useState(view === 'graph')
  // a link to the graph view (the guided tour) opens it, also when this page is already open
  // (through the unsaved-edits guard below: viewLink counts the route's asks for it)
  const [linkedView, setLinkedView] = useState(view)
  const [viewLink, setViewLink] = useState(0)
  // r1.13: a link to the app's own view (a live Studio session's canvas) asks for it the same guarded way
  const [ownLink, setOwnLink] = useState(0)
  if (view !== linkedView) {
    setLinkedView(view)
    if (view === 'graph') setViewLink((n) => n + 1)
    if (view === 'studio') setOwnLink((n) => n + 1)
  }
  // an app built for its purpose: its form, in the grammar of the experience the person is in (the graph stays one click away)
  const detail = useHive((s) => s.programDetails[id])
  const loadProgram = useHive((s) => s.loadProgram)
  useEffect(() => {
    if (!detail) void loadProgram(id).catch(() => undefined)
  }, [detail, loadProgram, id])
  // an app with its own interface opens it, unless Surface built a form over the same contract for it (Design's canvas)
  const form = program && (!program.ui || FORM_OVER_FRAME.has(id)) ? formFor(id, detail?.describe ?? null) : null
  const [own, setOwn] = useState(view === 'studio')
  const lookExperience = experienceById(useLook().current?.experience).id
  const grammar: Grammar = (GRAMMARS as string[]).includes(lookExperience) ? (lookExperience as Grammar) : 'classic'   // apps with their own interface open in it; the graph view stays one click away
  // a reply for an earlier client (identity change), app or attempt is dropped (lookupHomes' cancel) and never shown
  useEffect(() => (personApp ? undefined : lookupHomes(client, id, (state) => setLookup({ client, id, attempt, state }))), [personApp, client, id, attempt])
  const homesState: HomesState = lookup && lookup.client === client && lookup.id === id && lookup.attempt === attempt ? lookup.state : HOMES_PENDING
  const homes = homesState.kind === 'known' ? homesState.homes : null
  // pick the swarm: the route's, else the last used or the person's default (when the person may use it and the app
  // works there), else a home (or, on a host that cannot say where it works, a swarm) that the person may use, that is
  // not private, with an awake coordinator first. Never the swarm that sorts first by name; nothing qualifies: the
  // chooser below, never a guess (stand-in r1 P1).
  const agents = useHive((s) => s.agents)
  const defaultSwarm = useAskStore((s) => s.settings?.swarm_id ?? null)
  // where the app may open by itself: only the homes the host returned (it limits them to swarms the person sees);
  // the Ask's `eligible` (where the Ask may route) is not consulted here (r2.2). No homes route: the chooser.
  const routing = useMemo(
    () => (personApp ? { pick: personSwarm ?? undefined, choices: [] } : current || !sorted.length ? { pick: undefined, choices: [] } : appRouting({ swarms, agents, homesState, remembered: rememberedSwarm(id), defaultSwarm })),
    [personApp, personSwarm, current, sorted, swarms, agents, homesState, id, defaultSwarm],
  )
  const pick = routing.pick
  const choices = routing.choices
  useEffect(() => {
    if (pick && pick !== swarm) navigate({ name: 'program', id, swarm: pick }, { replace: true })
  }, [pick, id, swarm])
  useEffect(() => {
    if (!current || personApp) return
    try {
      localStorage.setItem(SWARM_KEY(id), current)
    } catch {
      /* optional */
    }
  }, [current, id, personApp])

  // An app's unsaved edits are never replaced silently: a new source (or leaving the tab) asks first.
  const dirty = useRef(false)
  const [unsaved, setUnsaved] = useState(false)   // the same fact as state, for the View menu's guard
  // r1.13: Studio's unsaved local work is also told to the live session (shown only: a pending open never overrides it)
  const onDirty = useCallback((d: boolean) => { dirty.current = d; setUnsaved(d); noteFrameDirty(d) }, [])
  // and in the shared registry: an app's edits live in its frame, out of the page's sight, so a deploy's reload and a
  // proposed move must hold for them too (stand-in r4 P1). The frame's disposal reports clean; leaving the page releases it.
  useUnsaved(unsaved)
  const [opened, setOpened] = useState<CreationReference | undefined>(source)
  // a new source and the graph view in one route event ask once: both share this question's answer (followups-r5)
  const [discardAsk] = useState(oneQuestion)
  // Both route guards are bound to the identity epoch (lib/identityEpoch; followups-r7, stand-in r6 P2): an identity
  // change that keeps this page mounted (a same-client re-init: `inits` moves, the app stays listed) answers the open
  // question no at once (askConfirmBound), and each guard checks the epoch again immediately before it applies or
  // restores, so nothing acts for the earlier identity.
  const askDiscard = useCallback((binding: ReturnType<typeof bindEpoch>) =>
    discardAsk(() => askConfirmBound(DISCARD_QUESTION, DISCARD_LABEL, { danger: true, binding })), [discardAsk])
  useEffect(() => {
    if (sameCreation(source, opened)) return
    if (!dirty.current) { setOpened(source); return }
    let live = true
    const binding = bindEpoch()
    void askDiscard(binding).then((ok) => {
      if (!live || !binding.current()) return
      if (ok) { dirty.current = false; setOpened(source) }
      else navigate({ name: 'program', id, swarm, ...(opened ? { source: opened } : {}) }, { replace: true })   // keep what is on screen
    })
    return () => { live = false }
  }, [source, opened, id, swarm, askDiscard])
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty.current) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  const exit = () => navigate({ name: 'programs' })
  const sw = current ? swarms[current] : null
  const look = useAppLook(program)
  // listed (ProgramPage above): never the route's id; the Studio app is Create (Jon 10-31, 11-05: one Create app)
  const name = id === 'omegadesign' ? 'Create' : program ? shown(program.name) : 'the app'
  const [access, setAccess] = useState(false)
  const leave = () => leaveCode(() => closePage(exit))
  const back = () => {
    if (codeShown || flowShown) { leaveCode(() => setCodeOpen(false)); return }
    if (access) return
    if (current) programBackOrExit(sessionKey(id, current), leave)
    else leave()
  }
  useEscape(back)
  // Apps are UIs in their own right (Jon): they take the whole screen in their own form and identity; only Ω remains.
  // switching away from a form that holds unsaved edits asks first (the same rule as opening another creation)
  // Bound to the identity epoch (followups-r7.1, stand-in r7: a late yes after a same-client re-init switched the view
  // and unmounted the native form, losing its canvas document and history): an identity change answers the question no
  // at once, and the switch is committed only if the epoch is still the one it was asked under, checked in the same
  // tick as both setters (binding.commit).
  const switchView = useCallback((g: boolean, o: boolean) => {
    if (!unsaved) { setGraph(g); setOwn(o); return }
    const binding = bindEpoch()
    void askConfirmBound('This design has unsaved edits. Switching the view discards them.', 'Discard and switch', { danger: true, binding }).then((ok) => {
      if (!ok) return
      binding.commit(() => {
        setGraph(g)   // the form unmounts and reports itself clean (forms/designCanvas/useCanvas)
        setOwn(o)
      })
    })
  }, [unsaved])
  // After an identity change that keeps this page mounted (a same-client re-init), the open question has been
  // cancelled and its continuation does nothing. The route is then put back to what is on screen (the creation shown,
  // and the graph view only if it shows), by this fresh reconciliation under the current epoch, never by the old
  // question's continuation (followups-r7.1, stand-in r7 P2: the route was stranded on ?source=B&view=graph while A
  // stayed on screen).
  const [identityChanges, setIdentityChanges] = useState(0)
  useEffect(() => onIdentityChange(() => setIdentityChanges((n) => n + 1)), [])
  const reconciled = useRef(0)
  useEffect(() => {
    if (identityChanges === reconciled.current) return
    reconciled.current = identityChanges
    if (sameCreation(source, opened) && (view !== 'graph' || graph)) return   // the route already says what is shown
    navigate({ name: 'program', id, ...(swarm ? { swarm } : {}), ...(opened ? { source: opened } : {}), ...(view === 'graph' && graph ? { view: 'graph' as const } : {}) }, { replace: true })
  }, [identityChanges, source, opened, view, graph, id, swarm])
  // the route asked for the graph view on the open page: as the View menu does, unsaved edits ask first; kept, the
  // route goes back to the page as it was
  useEffect(() => {
    if (!viewLink) return
    // answered after the page went away (an unmount, an identity change: the ConfirmHost answers no): nothing acts,
    // as the source guard above (followups-r6), so a late "no" never navigates back to an app the person has left
    let live = true
    const binding = bindEpoch()
    void followViewLink({
      isDirty: () => dirty.current,
      confirm: () => askDiscard(binding),
      apply: () => { if (live && binding.current()) setGraph(true) },
      // back to the page as it was: the creation on screen (a new source asked in the same event is declined with it)
      restore: () => { if (live && binding.current()) navigate({ name: 'program', id, ...(swarm ? { swarm } : {}), ...(opened ? { source: opened } : {}) }, { replace: true }) },
    })
    return () => { live = false }
    // only a new ask from the route runs this; the guard reads the edits as they are then (dirty.current, at call time)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewLink])
  const openOwn = useCallback(() => switchView(false, true), [switchView])
  // r1.13: the route asked for the app's own (native) view on an open page: through the same unsaved-edits guard
  useEffect(() => {
    // also from the graph view (own stays true with the frame hidden): the admitted drawing must be on screen.
    // Asked after this render (as the graph link's guarded follow-up is), never as a state change inside the effect
    if (!ownLink || !(graph || !own)) return
    let live = true
    void Promise.resolve().then(() => { if (live) switchView(false, true) })
    return () => { live = false }
    // only a new ask from the route runs this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownLink])
  // J3 r4.3 O3: start live drawing in Studio, from what the Ask prepared (the setup card in the Ask thread). Only where
  // the host says it has live Studio sessions and something prepared the card (today: the simulator only).
  const askSettings = useAskStore((s) => s.settings)
  const askLog = useAskStore((s) => s.log)
  const askTurns = useAskStore((s) => s.turns)
  const drawingTurn = useMemo(() => prepFromAsk(), [askLog, askTurns])
  // the words still in the Ask: Draw live asks them first (recordDrawTurn), so typing and pressing Draw live just works
  const askWords = useSyncExternalStore(subscribeAskFieldWords, askFieldWords, () => '')
  const drawing = drawingAvailability(client as never, askSettings, !!current, !!program?.ui, !!drawingTurn, !!askWords)
  // what Draw live could not do, said here under its button (never a toast); cleared by the next press
  const [drawNote, setDrawNote] = useState<string | null>(null)
  const [drawBusy, setDrawBusy] = useState(false)
  // a press belongs to this page while it is shown: leaving it (or this page going away) cancels it, silently
  const drawAlive = useAlive()
  const drawAbort = useRef<AbortController | null>(null)
  useEffect(() => () => drawAbort.current?.abort(), [])
  const startLive = async () => {
    if (id !== 'omegadesign') return
    setDrawNote(null)
    const currentClient = useHive.getState().client
    const precheck = drawingAvailability(currentClient as never, useAskStore.getState().settings, !!current, !!program?.ui, !!prepFromAsk(), !!askFieldWords())
    if (!precheck.available || !currentClient?.studioSetupProposal) { setDrawNote(precheck.reason ?? 'Live drawing is unavailable here.'); return }
    drawAbort.current ??= new AbortController()
    setDrawBusy(true)
    // one press, from the Ask turn to the picker (studioLive/drawLive): a second press joins it; it carries this press's
    // person and thread to the moment the picker opens
    const r = await drawLive({ programId: id, alive: drawAlive, signal: drawAbort.current.signal, sim: currentClient?.mode === 'sim' })
    if (!drawAlive()) return
    setDrawBusy(false)
    if ('reason' in r) setDrawNote(r.reason)
  }
  const canAccess = !!client && ('programActivations' in client || 'programActivity' in client)
  // where the page stands, as facts and values for MeTTa (appPage.ts, program.metta): it composes the notes over the
  // app, the states before it opens, which of the app's own surfaces show, and the app's Ω entries
  const homesKnown = useMemo(() => (homes ?? []).filter((h) => swarms[h.swarm_id]).map((h) => ({ id: h.swarm_id, name: shown(swarms[h.swarm_id].name) })), [homes, swarms])
  const page = useMemo(() => appPage({
    name, swarm: current, swarmName: current ? shown(swarms[current]?.name) : '', ui: !!program?.ui, form, create: id === 'omegadesign',
    person: personApp, personState, view: { graph, own, code: codeShown, flow: flowShown, make: makeShown, access }, canAccess, homesState, homesKnown, pick,
    choices: choices.map((s) => ({ id: s.id, name: shown(s.name) })), swarms: sorted.map((s) => ({ id: s.id, name: shown(s.name) })),
  }), [name, current, swarms, program?.ui, form, id, personApp, personState, graph, own, codeShown, flowShown, makeShown, access, canAccess, homesState, homesKnown, pick, choices, sorted])
  const compose = useKeptCompose(lookExperience)
  const chrome = useMemo(() => compose('program', page.facts), [compose, page])
  const stage = useMemo(() => compose('program-stage', page.facts), [compose, page])
  const menuPlan = useMemo(() => compose('program-menu', page.facts), [compose, page])
  const swarmOf = (item: Record<string, unknown>) => (typeof item.id === 'string' ? item.id : '')
  // what a press asks for: from a composed part, or from one of the app's Ω entries
  const press = (action: string, item: Record<string, unknown> = {}) => {
    if (action === 'leave') leave()
    else if (action === 'retry-homes') setAttempt((n) => n + 1)
    else if (action === 'settings') navigate({ name: 'settings' })
    else if (action === 'person-reopen' || action === 'person-try') void liveOpener?.open()
    else if (action === 'person-setup') void liveOpener?.open(true)
    else if (action === 'person-helpers') liveOpener?.askHelpers()
    else if (action === 'bench-code') leaveCode(() => setCodeOpen(!codeShown))
    else if (action === 'bench-flow') leaveCode(() => setBench(flowShown ? 'studio' : 'flow'))
    else if (action === 'bench-make') leaveCode(() => setBench(makeShown ? 'studio' : 'make'))
    else if (action === 'draw-live') void startLive()
    else if (action === 'access') setAccess(true)
    else if (action === 'view-form') leaveCode(() => { setCodeOpen(false); switchView(false, false) })
    else if (action === 'view-own') leaveCode(() => { setCodeOpen(false); switchView(false, true) })
    else if (action === 'view-graph') leaveCode(() => { setCodeOpen(false); switchView(true, own) })
    else if ((action === 'home' || action === 'works-in') && swarmOf(item)) leaveCode(() => navigate({ name: 'program', id, swarm: swarmOf(item) }))
    else if (action === 'choose' && swarmOf(item)) navigate({ name: 'program', id, swarm: swarmOf(item) })
  }
  const entries = useMemo(() => menuSections(menuPlan, page.data), [menuPlan, page])
  // the app's own surfaces, each offered with what it needs to draw; whether and where each shows is MeTTa's
  // (program-stage). The frame stays mounted, hidden, under the graph and the benches, so the app keeps its state.
  const surfaces = current ? {
    'app-frame': <div data-fill="" className="h-full"><AppFrame key={`${id}-${current}-${JSON.stringify(opened ?? null)}`} programId={id} swarmId={current} source={opened} onDirty={onDirty} onBack={back} /></div>,
    'app-form': form && program ? <div data-fill="" className="h-full"><ProgramForm key={`${id}-${current}-form`} form={form} program={program} swarmId={current} grammar={grammar} source={opened} onDirty={onDirty} openOwn={program.ui ? openOwn : undefined} onExit={leave} /></div> : null,
    'app-graph': <div data-fill="" className="h-full overflow-y-auto pt-3"><ProgramHost key={`${id}-${current}`} programId={id} swarmId={current} variant="page" onExit={leave} /></div>,
    'code-bench': <div data-fill="" className="h-full"><Suspense fallback={<p role="status" className="p-4">Opening Code…</p>}>
      <CreateCodeBench key={`${id}-${current}-${epoch}`} onBack={() => setCodeOpen(false)} departure={codeDeparture} />
    </Suspense></div>,
    'flow-bench': <div data-fill="" className="h-full overflow-y-auto" data-flow-bench=""><Suspense fallback={<p role="status" className="p-4">Opening Flow…</p>}>
      <FlowStudio key={`${id}-${current}-${epoch}-flow`} />
    </Suspense></div>,
    'make-bench': <div data-fill="" className="h-full overflow-y-auto" data-make-bench=""><Suspense fallback={<p role="status" className="p-4">Opening Make…</p>}>
      <PlanCanvas key={`${id}-${current}-${epoch}-make`} />
    </Suspense></div>,
  } : {}
  const host = {
    data: page.data,
    onAction: (action: string) => press(action),
    onOpen: (target: string, item: Record<string, unknown>) => press(target, item),
    // Create's bench tabs: pressing the bench already shown does nothing
    onInput: (bind: string, value: string) => {
      if (bind === 'bench' && value !== page.data.bench && (value === 'studio' || value === 'make' || value === 'code' || value === 'flow')) leaveCode(() => setBench(value))
    },
  }
  return (
    <section
      aria-label={`${name} app`}
      data-presence-region="app"
      data-app={look ? id : undefined}
      data-app-type={look?.type}
      className="fixed inset-x-0 top-0 z-[30] flex h-dvh flex-col overflow-hidden"
      style={{ ...look?.style, background: 'linear-gradient(180deg, var(--look-page-a, color-mix(in oklab, var(--color-abyss) 97%, transparent)), var(--look-page-b, color-mix(in oklab, var(--color-void) 99%, transparent)))' }}
    >
      {/* the app's identity: its motif behind the page (an app without one shows none) */}
      <div className="app-motif" data-motif={look?.motif ?? 'none'} aria-hidden="true" />
      <h1 className="sr-only">{title ?? name}</h1>
      <Screen plan={chrome} className={CHROME} host={{
        ...host,
        islands: {
          'coordinator': <CoordinatorNotice swarm={sw} agents={agents} />,
          'studio-live': <StudioLiveBar inline />,
          'drawing-entry': <DrawingEntry availability={drawing} start={() => void startLive()} ask={focusAsk} note={drawNote} busy={drawBusy} />,
        },
      }} />
      <div className="relative min-h-0 flex-1">
        <Screen plan={stage} className={STAGE} host={{
          ...host,
          islands: {
            ...surfaces,
            'omega-menu': <OmegaMenu heading={`${name}${sw ? ` · ${shown(sw.name)}` : ''}`} context={lookExperience} sections={entries.map((x) => ({ ...x, items: x.items.map(({ action, item, ...entry }) => ({ ...entry, run: () => press(action, item) })) }))} />,
            'app-access': <AppAccess programId={id} name={name} onClose={() => setAccess(false)} />,
            'confirm': <ConfirmHost />,
            'consent': <PersonSwarmConsentHost key={`${id}-${current}-${JSON.stringify(opened ?? null)}`} programId={id} swarmId={current} generation={`${current ?? ''}\0${JSON.stringify(opened ?? null)}`}
              spaceLine={askingHelpers ? personState.spaceLine ?? undefined : undefined}
              onSettle={askingHelpers ? liveOpener?.settled : undefined} />,
          },
        }} />
      </div>
    </section>
  )
}
