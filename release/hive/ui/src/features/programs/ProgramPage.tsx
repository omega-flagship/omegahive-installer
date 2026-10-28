import { PersonSwarmConsentHost } from './PersonSwarmConsent'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { closePage, navigate, sameCreation, type CreationReference } from '../../lib/router'
import { sessionKey } from '../../store/programSession'
import { useHive } from '../../store/store'
import { ConfirmHost } from '../../ui/confirm'
import { askConfirmBound, bindEpoch, onIdentityChange } from '../../lib/identityEpoch'
import { AppAccess } from './AppActivity'
import { OmegaMenu, type OmegaSection } from '../../experiences/OmegaMenu'
import { useEscape } from '../../lib/hooks'
import { Button, EmptyState } from '../../ui/primitives'
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
import { studioCapable } from '../studioLive/api'
import { beginLiveStudio, focusAsk, noteFrameDirty, prepFromAsk } from '../studioLive/store'
import { SETUP_NEEDS_TURN_WORDS } from '../studioLive/refusals'
import { StudioLiveBar } from '../studioLive/DirectingStudio'
import { PersonAppOpener, type PersonAppState } from '../../lib/personAppOpen'
import { useIdentityEpoch } from '../../lib/epochBound'
import { ACTION_LABEL, PERSON_APP_REASONS, type PersonAppReason } from '../../api/personApps'

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

/** The page for an app this person may not open here, or not yet known to be one they may: no name, no app controls. */
export function AppUnavailable({ state, retry }: { state: 'opening' | 'unlisted' | 'unreadable'; retry?: () => void }) {
  const leave = () => closePage(() => navigate({ name: 'programs' }))
  useEscape(leave)
  const lookExperience = experienceById(useLook().current?.experience).id
  const title = state === 'opening' ? 'Opening the app' : state === 'unreadable' ? 'The apps list could not be read' : "This app isn't available to you here"
  return (
    <section aria-label="App" data-presence-region="app" data-app-unavailable={state} className="fixed inset-x-0 top-0 z-[30] flex h-dvh flex-col overflow-hidden" style={{ background: 'linear-gradient(180deg, rgb(10 10 32 / 0.97), rgb(6 6 22 / 0.99))' }}>
      <h1 className="sr-only">{title}</h1>
      <StudioLiveBar inline />
      <div className="relative min-h-0 flex-1">
        {state === 'opening' ? (
          <div className="grid h-full place-items-center text-[13px] text-ink-3">Opening the app…</div>
        ) : (
          <div className="grid h-full place-items-center p-6">
            <EmptyState
              icon={state === 'unlisted' ? 'shield' : 'apps'}
              title={title}
              body={state === 'unlisted'
                ? "This hive doesn't offer that app to you. Your Apps page shows every app you can open."
                : 'Try again, or go to your Apps page.'}
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  {state === 'unreadable' && retry && <Button variant="primary" onClick={retry}>Try again</Button>}
                  <Button onClick={leave}>Back to Apps</Button>
                </div>
              }
            />
          </div>
        )}
      </div>
      <OmegaMenu heading="Apps" context={lookExperience} sections={[{ items: [{ label: 'Back to Apps', run: leave }] }]} />
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
  const name = program ? shown(program.name) : 'the app'   // listed (ProgramPage above): never the route's id
  const [access, setAccess] = useState(false)
  const leave = () => closePage(exit)
  const back = () => {
    if (access) return
    if (current) programBackOrExit(sessionKey(id, current), leave)
    else leave()
  }
  useEscape(back)
  // Apps are UIs in their own right (the owner): they take the whole screen in their own form and identity; only Ω remains.
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
  const formLabel = form === 'design-canvas' ? 'Canvas' : 'App'
  const viewSection: OmegaSection | null =
    current && (program?.ui || form)
      ? {
          title: 'View',
          items: [
            ...(form ? [{ label: formLabel, checked: !graph && !(program?.ui && own), run: () => switchView(false, false) }] : []),
            ...(program?.ui ? [{ label: form ? 'Studio' : 'App', checked: !graph && (!form || own), run: () => switchView(false, true) }] : []),
            { label: 'Graph', checked: graph, run: () => switchView(true, own) },
          ],
        }
      : null
  const swarmSection: OmegaSection | null =
    sorted.length > 1 && !personApp ? { title: 'Works in', items: sorted.map((s) => ({ label: shown(s.name), checked: s.id === current, run: () => navigate({ name: 'program', id, swarm: s.id }) })) } : null
  // J3 r4.3 O3: start live drawing in Studio, from what the Ask prepared (the setup card in the Ask thread). Only where
  // the host says it has live Studio sessions and something prepared the card (today: the simulator only).
  const askSettings = useAskStore((s) => s.settings)
  const liveStudio = !!current && !!program?.ui && id === 'omegadesign' && studioCapable(client as never, askSettings) && !!client?.studioSetupProposal
  const startLive = () => {
    if (!current || !client?.studioSetupProposal) return
    // r1.13: the live card draws on one of the person's SAVED canvases in their own Studio space (picked from a list read
    // through the host); the intent is recorded on their Ask turn (live). The simulator has its own Ask.
    const turn = client.mode === 'sim' ? null : prepFromAsk()
    if (client.mode !== 'sim' && !turn) { useHive.getState().toast({ tone: 'info', title: 'Studio starts from your Ask', body: SETUP_NEEDS_TURN_WORDS, action: { label: 'Ask what to draw', run: focusAsk } }); focusAsk(); return }
    useAskStore.getState().setThreadOpen(true)
    void beginLiveStudio(id, turn)
  }
  const appSection: OmegaSection = {
    items: [
      { label: `Leave ${name}`, run: leave },
      ...(liveStudio ? [{ label: 'Draw live with a mind…', run: startLive }] : []),
      ...(client && ('programActivations' in client || 'programActivity' in client) ? [{ label: 'Where it runs…', run: () => setAccess(true) }] : []),
    ],
  }
  return (
    <section
      aria-label={`${name} app`}
      data-presence-region="app"
      data-app={look ? id : undefined}
      data-app-type={look?.type}
      className="fixed inset-x-0 top-0 z-[30] flex h-dvh flex-col overflow-hidden"
      style={{ ...look?.style, background: 'linear-gradient(180deg, var(--look-page-a, rgb(10 10 32 / 0.97)), var(--look-page-b, rgb(6 6 22 / 0.99)))' }}
    >
      {look && look.motif !== 'none' && <div className="app-motif" data-motif={look.motif} aria-hidden="true" />}
      <h1 className="sr-only">{title ?? name}</h1>
      {current && homes && homes.length > 0 && !homes.some((h) => h.swarm_id === current) && (
        <div className="relative z-[1] m-3 flex flex-wrap items-center gap-2 rounded-xl border border-warn/25 bg-warn/[0.06] px-3 py-2 text-[12.5px] text-ink-2">
          <span>{name} is not set up in {shown(swarms[current]?.name)}. It works in:</span>
          {homes.filter((h) => swarms[h.swarm_id]).map((h) => (
            <button key={h.swarm_id} onClick={() => navigate({ name: 'program', id, swarm: h.swarm_id })} className="rounded-lg border border-line px-2 py-0.5 text-ink hover:bg-white/[0.06]">
              {shown(swarms[h.swarm_id].name)}
            </button>
          ))}
        </div>
      )}
      {/* never land on a swarm whose coordinator is asleep without saying so: a request there is not answered on its own */}
      {!personApp && <CoordinatorNotice swarm={sw} agents={agents} />}
      {current && personState.kind === 'ready' && <PersonAppReadyNotes name={name} state={personState} opener={liveOpener} />}
      {/* J3 r4.3 O3: the one Stop, in this page's flow above the app (never over its toolbar); hidden when no session */}
      <StudioLiveBar inline />
      <div className="relative min-h-0 flex-1">
        {/* the app frame stays mounted under Graph, so switching views keeps the app's state (platform 03e49a7) */}
        {current && program?.ui && (!form || own) && (
          <div hidden={graph} className="h-full"><AppFrame key={`${id}-${current}-${JSON.stringify(opened ?? null)}`} programId={id} swarmId={current} source={opened} onDirty={onDirty} onBack={back} /></div>
        )}
        {current && program?.ui && !graph && (!form || own) ? null : current && form && program && !graph ? (
          <ProgramForm key={`${id}-${current}-form`} form={form} program={program} swarmId={current} grammar={grammar} source={opened} onDirty={onDirty} openOwn={program.ui ? openOwn : undefined} onExit={leave} />
        ) : current ? (
          <div className="h-full overflow-y-auto pt-3"><ProgramHost key={`${id}-${current}`} programId={id} swarmId={current} variant="page" onExit={leave} /></div>
        ) : personApp ? (
          <PersonAppHostState name={name} state={personState} opener={liveOpener} leave={leave} />
        ) : homesState.kind === 'failed' ? (
          <div className="grid h-full place-items-center p-6">
            <EmptyState
              icon="alert"
              title={`Couldn't check where ${name} works`}
              body={homesState.denied
                ? `This hive did not let you see where ${name} is set up. Nothing was opened. Try again, or pick a swarm from Ω → Works in.`
                : `The hive did not answer where ${name} is set up. Nothing was opened. Try again, or pick a swarm from Ω → Works in.`}
              action={<Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}
            />
          </div>
        ) : homes && homes.length === 0 ? (
          <div className="grid h-full place-items-center p-6">
            {/* P14: a real failure only (an admin installs a swarm app with "Use in"); one action */}
            <EmptyState
              icon="apps"
              title={`${name} isn't turned on in a swarm you can use`}
              body="An admin turns this app on for swarms when they install it. Ask an admin, or pick a swarm from Ω → Works in."
              action={<Button onClick={leave}>Back to Apps</Button>}
            />
          </div>
        ) : pick === null ? (
          <div className="grid h-full place-items-center p-6">
            <EmptyState
              icon="swarms"
              title={`Choose where to open ${name}`}
              body={homesState.kind === 'absent'
                ? `Couldn't tell where it's set up. ${name} works inside a swarm${choices.length ? '; pick one.' : '. Pick one from Ω → Works in.'}`
                : choices.length
                ? `${name} works inside a swarm. Pick one you can use.`
                : `There is no swarm here that you can use for ${name} yet. Ask its owner, or pick one from Ω → Works in.`}
              action={choices.length ? (
                <div className="flex flex-wrap justify-center gap-2">
                  {choices.map((s) => <Button key={s.id} onClick={() => navigate({ name: 'program', id, swarm: s.id })}>{shown(s.name)}</Button>)}
                </div>
              ) : undefined}
            />
          </div>
        ) : (
          <div className="grid h-full place-items-center text-[13px] text-ink-3">Opening {name}…</div>
        )}
      </div>
      <OmegaMenu heading={`${name}${sw ? ` · ${shown(sw.name)}` : ''}`} context={lookExperience} sections={[appSection, ...(viewSection ? [viewSection] : []), ...(swarmSection ? [swarmSection] : [])]} />
      {access && <AppAccess programId={id} name={name} onClose={() => setAccess(false)} />}
      <ConfirmHost />
      {(!personApp || (current && personState.kind === 'ready' && personState.helpers !== 'key' && personState.helpers !== 'declined')) && (
        <PersonSwarmConsentHost key={`${id}-${current}-${JSON.stringify(opened ?? null)}`} programId={id} swarmId={current} generation={`${current ?? ''}\0${JSON.stringify(opened ?? null)}`}
          spaceLine={askingHelpers ? personState.spaceLine ?? undefined : undefined}
          onSettle={askingHelpers ? liveOpener?.settled : undefined} />
      )}
    </section>
  )
}

/** P14: banners over the open app, never instead of it: the host key card, helpers turned down, the privacy line. */
export function PersonAppReadyNotes({ name, state, opener }: { name: string; state: Extract<PersonAppState, { kind: 'ready' }>; opener: PersonAppOpener | null }) {
  const key = state.helpers === 'key' || state.needs.length > 0
  return (
    <div className="relative z-[1] mx-3 mt-2 flex flex-wrap items-center gap-2 text-[12px] text-ink-3" data-person-app-ready="">
      {key && (
        <span className="flex flex-wrap items-center gap-2 rounded-xl border border-warn/25 bg-warn/[0.06] px-3 py-1.5 text-ink-2" data-host-key-card="">
          {name}'s helpers run on your own AI key{state.needs.includes('monthly_total') ? ', within a monthly total you set' : ''}. Opening it costs nothing; they stay unavailable until then.
          <button type="button" onClick={() => navigate({ name: 'settings' })} className="rounded-lg border border-line px-2 py-0.5 text-ink hover:bg-white/[0.06]">Add your AI key</button>
          <button type="button" onClick={() => void opener?.open()} className="rounded-lg border border-line px-2 py-0.5 text-ink hover:bg-white/[0.06]">I've added it</button>
        </span>
      )}
      {state.helpers === 'declined' && (
        <span className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white/[0.04] px-3 py-1.5 text-ink-2" data-person-app-declined="">
          Your helpers are off. Nothing was set up, so helper features are unavailable.
          <button type="button" onClick={() => opener?.askHelpers()} className="rounded-lg border border-line px-2 py-0.5 text-ink hover:bg-white/[0.06]">Set up helpers</button>
        </span>
      )}
      <span data-person-app-private="">{PRIVATE_NOTE}</span>
    </div>
  )
}

const PRIVATE_NOTE = 'Private to you; hive admins can audit.'

/** P14: what a person app's page shows until its context is open: opening, or one failure. */
export function PersonAppHostState({ name, state, opener, leave }: { name: string; state: PersonAppState; opener: PersonAppOpener | null; leave: () => void }) {
  if (state.kind === 'failed') return <PersonAppFailure reason={state.reason} opener={opener} leave={leave} />
  return <div className="grid h-full place-items-center text-[13px] text-ink-3">Opening {name}…</div>
}

/** One approved reason in fixed words, with its one host action. Nothing from the answer is shown. */
export function PersonAppFailure({ reason, opener, leave }: { reason: PersonAppReason; opener: PersonAppOpener | null; leave: () => void }) {
  const { text, action } = PERSON_APP_REASONS[reason]
  const run = action === 'try_again' ? () => void opener?.open() : action === 'set_up_again' ? () => void opener?.open(true) : leave
  return (
    <div className="grid h-full place-items-center p-6" data-person-app-failure={reason}>
      <EmptyState icon={reason === 'not_available_to_you' ? 'shield' : 'alert'} title={text}
        action={<Button variant={action === 'back' || action === 'ask_admin' ? undefined : 'primary'} onClick={run}>{ACTION_LABEL[action]}</Button>} />
    </div>
  )
}
