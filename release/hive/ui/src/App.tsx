import { AnimatePresence, LazyMotion, MotionConfig } from 'framer-motion'
import { Suspense, useEffect } from 'react'
import { lazyRoute } from './lib/lazyRoute'
import { useIsDesktop } from './lib/hooks'
import { isPageRoute, navigate, useRoute } from './lib/router'
import { HiveScene } from './scene/HiveScene'
import { useScene } from './scene/sceneStore'
import { useViewerSync } from './scene/viewer'
import { ActivityTicker, BootScreen, DotDirectory, EmptyHive, Login, SceneControls } from './shell/Ambient'
import { SetupNudge } from './features/setup/SetupChecklist'
import { useApprovalToasts } from './shell/approvalToasts'
import { useLiveNotices } from './shell/liveNotices'
import { Toasts, TopBar } from './shell/Hud'
import { Nav } from './shell/Nav'
import { useRailExpanded } from './shell/rail'
import { geometry } from './shell/layout'
import { useLook } from './shell/uiVariant'
import { loadLookBound } from './shell/lookIdentity'
import { LookPreviewBar } from './shell/LookPreviewBar'
import { LookConflictNotice } from './shell/LookConflictNotice'
import { ClassicPhaseHost, ClassicProChrome, ExperienceHost } from './experiences/ExperienceHost'
import { GuideLayer } from './features/guided/GuideLayer'
import { FpsMeter } from './shell/FpsMeter'
import { chromeFor, experienceById } from './experiences/registry'
import { PreviewBuildBanner } from './shell/PreviewBuildBanner'
import { HeldExperienceNotice } from './shell/HeldExperienceNotice'
import { applyChrome } from './experiences/chrome'
import { useShortcuts } from './shell/shortcuts'
import { useHive } from './store/store'
import { IntroLayer } from './tour/IntroLayer'
import { PresenceLazy } from './ui/PresenceLazy'
import { isDemoClient } from './features/showreel/hook'
import { demoFromSearch, startFirstLight, useFlDoor } from './features/firstlight/door'
import { PowerHost } from './features/power/PowerHost'
import { GoogleConnectorReturn } from './features/settings/GoogleConnectorSettings'
import { AskHost } from './features/ask/AskHost'
import { StudioLiveBar } from './features/studioLive/DirectingStudio'
import { MindInboxCollector } from './features/mind/Collector'
import { OsClock } from './shell/OsClock'
import { useMotivationWatch } from './lib/motivations'
import { useSwarmDelete } from './features/swarm/deleteRequest'
import { SwarmSheetSkeleton } from './features/swarm/SwarmSheetSkeleton'
// per person: Recent conversations' sent-to list is emptied on an identity change (registered at start, mind-chat r1)
import './features/dot/recent'

const FlowPage = lazyRoute(() => import('./features/flow/FlowPage'))
const DotPanel = lazyRoute(() => import('./features/dot/DotPanel'))
const SwarmsIndex = lazyRoute(() => import('./features/swarm/SwarmsIndex'))
const SwarmView = lazyRoute(() => import('./features/swarm/SwarmView'))
const CreateFlow = lazyRoute(() => import('./features/create/CreateFlow'))
const TokenReveal = lazyRoute(() => import('./features/create/TokenReveal'))
const UsageView = lazyRoute(() => import('./features/usage/UsageView'))
const CommandPalette = lazyRoute(() => import('./features/palette/CommandPalette'))
const ApprovalsView = lazyRoute(() => import('./features/approvals/ApprovalsView'))
const TasksPage = lazyRoute(() => import('./features/tasks/TasksPage'))
const MotivationsPage = lazyRoute(() => import('./features/tasks/MotivationsPage'))
const StopAll = lazyRoute(() => import('./features/hive/StopAll'))
const SwarmDeleteDialog = lazyRoute(() => import('./features/swarm/SwarmDeleteDialog'))
const LabView = lazyRoute(() => import('./features/lab/LabView'))
const ProgramsIndex = lazyRoute(() => import('./features/programs/ProgramsIndex'))
const ProgramPage = lazyRoute(() => import('./features/programs/ProgramPage'))
const ModelsPage = lazyRoute(() => import('./features/models/ModelsPage'))
const ProfilePage = lazyRoute(() => import('./features/keys/ProfilePage'))
const PersonalMindPage = lazyRoute(() => import('./features/mind/PersonalMindPage'))
const PeoplePage = lazyRoute(() => import('./features/people/PeoplePage'))
const HealthPage = lazyRoute(() => import('./features/health/HealthPage'))
const UpdatesPage = lazyRoute(() => import('./features/updates/UpdatesPage'))
const MessagesPage = lazyRoute(() => import('./features/messages/MessagesPage'))
const SettingsPage = lazyRoute(() => import('./features/settings/SettingsPage'))
const ExplorePage = lazyRoute(() => import('./features/explore/ExplorePage'))
const LifecyclePage = lazyRoute(() => import('./features/lifecycle/LifecyclePage'))
const CodePage = lazyRoute(() => import('./features/code/CodePage'))
const LaunchSwarm = lazyRoute(() => import('./features/launch/LaunchSwarm'))
const RolesPage = lazyRoute(() => import('./features/roles/RolesPage'))
const ConnectHarness = lazyRoute(() => import('./features/harness/ConnectHarness'))
const ArtifactsPage = lazyRoute(() => import('./features/artifacts/ArtifactsPage'))
const ToolsPage = lazyRoute(() => import('./features/tools/ToolsPage'))
const SetupPage = lazyRoute(() => import('./features/setup/SetupPage'))
const RecentConversationsPage = lazyRoute(() => import('./features/dot/RecentConversationsPage'))
const AssetsPage = lazyRoute(() => import('./features/assets/AssetsPage'))
const ChangeUi = lazyRoute(() => import('./shell/ChangeUi'))
/** demo mode only (the simulator with invented people): the showreel that plays the hive by itself (Surface D4) */
const ShowreelLayer = lazyRoute(() => import('./features/showreel/ShowreelLayer'))
/** First Light (onboarding R2): loaded only once it is asked for (#/first-light, the Ask, or the simulator's ?firstlight=) */
const FirstLightLayer = lazyRoute(() => import('./features/firstlight/FirstLightLayer'))

/**
 * Each lazy view is wrapped in PresenceLazy (ui/PresenceLazy.tsx): its own Suspense boundary, and a view that is
 * already leaving never appears for the first time (Surface M). Its Shown marker must stay inside that same Suspense
 * boundary as the view; see PresenceLazy before changing either.
 */
const Lazy = PresenceLazy

const loadMotion = () => import('./lib/motionFeatures').then((r) => r.default)

/**
 * Warm the lazy chunks once the hive is idle so the first open is instant. A warm-up that fails is nobody's business
 * (a deploy since this page loaded, a dropped connection): it is caught here and never reaches the chunk recovery
 * (lib/chunkReload.ts), which acts only on a view the person is opening.
 */
const warm = (p: Promise<unknown>) => void p.catch(() => {})
function prefetch() {
  const go = () => {
    warm(import('./features/dot/DotPanel'))
    warm(import('./features/palette/CommandPalette'))
    warm(import('./features/swarm/SwarmView'))
    warm(import('./features/create/CreateFlow'))
    warm(import('./features/swarm/SwarmsIndex'))
    warm(import('./features/usage/UsageView'))
    warm(import('./features/create/TokenReveal'))
    warm(import('./features/approvals/ApprovalsView'))
    warm(import('./features/tasks/TasksPage'))
    warm(import('./features/lab/LabView'))
    warm(import('./features/programs/ProgramsIndex'))
  }
  if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 4000 })
  else setTimeout(go, 2500)
}

export function App() {
  const client = useHive((s) => s.client)
  const ready = useHive((s) => s.ready)
  const bootError = useHive((s) => s.bootError)
  const connection = useHive((s) => s.connection)
  const paletteOpen = useHive((s) => s.paletteOpen)
  const reveal = useHive((s) => s.reveal)
  const stopAllOpen = useHive((s) => s.stopAllOpen)
  // "Delete swarm and its minds": one warning over every page and experience (its settings and the Ask open it)
  const swarmDeleteOpen = useSwarmDelete((s) => !!s.open)
  const hydrate = useHive((s) => s.hydrate)
  const route = useRoute()
  const setDimmed = useScene((s) => s.setDimmed)
  useShortcuts()
  useApprovalToasts()
  // what someone can no longer read leaves every experience's screen (stand-in P1-1 on 61936cb)
  useMotivationWatch()
  useLiveNotices()
  // who is looking, for the one visibility helper (the map, the Ask's context, the swarm lists)
  useViewerSync()

  const page = isPageRoute(route.name)
  useEffect(() => setDimmed(page), [page, setDimmed])
  // looking at Health resolves the alerts that drive its navigation badge
  const healthAlerts = useHive((s) => s.healthAlerts)
  const resolveHealthAlerts = useHive((s) => s.resolveHealthAlerts)
  useEffect(() => {
    if (route.name === 'health') resolveHealthAlerts()
  }, [route.name, healthAlerts, resolveHealthAlerts])
  // keep the camera centred in the space the HUD leaves free
  const desktop = useIsDesktop()
  const setInset = useScene((s) => s.setInset)
  const railOpen = useRailExpanded()
  const look = useLook()
  // only an experience this build offers mounts; a saved unknown or unreviewed one shows the classic hive
  const experience = experienceById(look.current?.experience).id
  useEffect(() => {
    setInset('hud', ready ? (desktop ? geometry(look.layout, railOpen).inset : { top: 150, bottom: 128 }) : null)
  }, [desktop, ready, setInset, railOpen, look.layout])
  // the person's saved look, once signed in
  useEffect(() => {
    if (ready) void loadLookBound(client)
  }, [ready, client])
  useEffect(() => {
    if (ready) prefetch()
  }, [ready])
  // every shared window (and any classic page opened over an experience, or an app's windows) wears the chrome of the
  // experience the person is in; classic restores the classic chrome
  useEffect(() => {
    let live = true
    if (experience === 'classic') applyChrome(null)
    else void chromeFor(experience).then((c) => live && applyChrome(c))
    return () => {
      live = false
    }
  }, [experience])

  // First Light: #/first-light[?beat=…] asks for it and lands on the hive (the journey moves the screen from there);
  // on the simulator, ?firstlight=pip|juno plays the invented newcomer's demo
  const flAsked = useFlDoor((s) => !!s.asked)
  const flRoute = route.name === 'hive' ? route.firstLight : undefined
  useEffect(() => {
    if (!ready || flRoute === undefined) return
    startFirstLight({ mode: 'live', ...(flRoute ? { beat: flRoute } : {}) })
    navigate({ name: 'hive' }, { replace: true })
  }, [ready, flRoute])
  useEffect(() => {
    if (!ready || !isDemoClient(client)) return
    const demo = demoFromSearch(window.location.search)
    if (demo) startFirstLight(demo)
  }, [ready, client])

  // unknown mind ids fall back to the hive once data is in
  useEffect(() => {
    if (route.name === 'swarm' && ready && !useHive.getState().swarms[route.id]) navigate({ name: 'swarms' }, { replace: true })
  }, [route, ready])

  const needsLogin = !!client && (connection === 'unauthorized' || (client.needsAuth() && !ready))

  return (
    <LazyMotion features={loadMotion} strict>
      <MotionConfig reducedMotion={look.motion === 'none' ? 'always' : 'user'}>
        {(experience === 'classic' || !ready || needsLogin) && <HiveScene />}
        {needsLogin ? (
          <Login />
        ) : !ready ? (
          <BootScreen error={bootError} onRetry={() => void hydrate()} />
        ) : (
          <>
            <GoogleConnectorReturn />
            {route.name === 'program' ? null : experience !== 'classic' ? (
              <ExperienceHost id={experience} />
            ) : (
              <>
                <ClassicPhaseHost />
                <ClassicProChrome>
                {!page && <TopBar />}
                <Nav />
                <ActivityTicker />
                <SceneControls />
                <DotDirectory />
                <EmptyHive />
                <SetupNudge />
                </ClassicProChrome>
              </>
            )}
            {/* classic pages, sheets and dialogs: dressed in the experience's chrome when one is active (index.css .xc-dress) */}
            <div className="xc-dress contents">
            <AnimatePresence>
              {route.name === 'dot' && (
                <Lazy key="dot">
                  <DotPanel id={route.id} tab={route.tab} program={route.program} />
                </Lazy>
              )}
              {route.name === 'new' && (
                <Lazy key="new">
                  <CreateFlow swarmId={route.swarm} />
                </Lazy>
              )}
            </AnimatePresence>
            <AnimatePresence mode="wait">
              {route.name === 'flow' && <Lazy key="flow"><FlowPage /></Lazy>}
              {route.name === 'swarms' && (
                <Lazy key="swarms">
                  <SwarmsIndex />
                </Lazy>
              )}
              {route.name === 'swarm' && (
                <Lazy key={`swarm-${route.id}`} fallback={<SwarmSheetSkeleton id={route.id} />}>
                  <SwarmView id={route.id} statement={route.statement} tab={route.tab} />
                </Lazy>
              )}
              {route.name === 'usage' && (
                <Lazy key="usage">
                  <UsageView />
                </Lazy>
              )}
              {route.name === 'approvals' && (
                <Lazy key="approvals">
                  <ApprovalsView />
                </Lazy>
              )}
              {route.name === 'lab' && (
                <Lazy key="lab">
                  <LabView />
                </Lazy>
              )}
              {route.name === 'programs' && (
                <Lazy key="programs">
                  <ProgramsIndex />
                </Lazy>
              )}
              {route.name === 'program' && (
                <Lazy key={`program-${route.id}`}>
                  <ProgramPage id={route.id} swarm={route.swarm} source={route.source} view={route.view} />
                </Lazy>
              )}
              {/* Motivations above Tasks: #/goals and #/boards parse to Tasks (lib/router.ts), so they never render here */}
              {route.name === 'tasks' && (
                <Lazy key="tasks">
                  <TasksPage swarm={route.swarm} mind={route.mind} motivation={route.motivation} view={route.view} task={route.task} />
                </Lazy>
              )}
              {route.name === 'motivations' && (
                <Lazy key={`motivations-${route.id ?? ''}`}>
                  <MotivationsPage id={route.id} />
                </Lazy>
              )}
              {route.name === 'connect' && (
                <Lazy key="connect">
                  <ConnectHarness />
                </Lazy>
              )}
              {route.name === 'roles' && (
                <Lazy key="roles">
                  <RolesPage />
                </Lazy>
              )}
              {route.name === 'launch' && (
                <Lazy key="launch">
                  <LaunchSwarm />
                </Lazy>
              )}
              {route.name === 'code' && (
                <Lazy key={`code-${route.target ?? ''}`}>
                  {/* the route is passed, never read inside: a leaving Code page keeps its own view (Surface S) */}
                  <CodePage route={route} />
                </Lazy>
              )}
              {route.name === 'lifecycle' && (
                <Lazy key={`lifecycle-${route.swarm}`}>
                  <LifecyclePage swarmId={route.swarm} />
                </Lazy>
              )}
              {route.name === 'explore' && (
                <Lazy key="explore">
                  <ExplorePage />
                </Lazy>
              )}
              {route.name === 'settings' && (
                <Lazy key="settings">
                  <SettingsPage />
                </Lazy>
              )}
              {route.name === 'artifacts' && (
                <Lazy key="artifacts">
                  <ArtifactsPage />
                </Lazy>
              )}
              {route.name === 'tools' && (
                <Lazy key="tools">
                  <ToolsPage id={route.id} />
                </Lazy>
              )}
              {route.name === 'conversations' && (
                <Lazy key="conversations">
                  <RecentConversationsPage />
                </Lazy>
              )}
              {route.name === 'setup' && (
                <Lazy key="setup">
                  <SetupPage />
                </Lazy>
              )}
              {route.name === 'assets' && (
                <Lazy key="assets">
                  <AssetsPage swarm={route.swarm} />
                </Lazy>
              )}
              {route.name === 'messages' && (
                <Lazy key="messages">
                  <MessagesPage room={route.room} message={route.message} />
                </Lazy>
              )}
              {route.name === 'updates' && (
                <Lazy key="updates">
                  <UpdatesPage />
                </Lazy>
              )}
              {route.name === 'health' && (
                <Lazy key="health">
                  <HealthPage />
                </Lazy>
              )}
              {route.name === 'people' && (
                <Lazy key="people">
                  <PeoplePage />
                </Lazy>
              )}
              {route.name === 'me' && route.view !== 'mind' && (
                <Lazy key="me">
                  <ProfilePage />
                </Lazy>
              )}
              {route.name === 'me' && route.view === 'mind' && (
                <Lazy key="me-mind">
                  <PersonalMindPage />
                </Lazy>
              )}
              {route.name === 'models' && (
                <Lazy key="models">
                  <ModelsPage />
                </Lazy>
              )}
            </AnimatePresence>
            <AnimatePresence>
              {reveal && (
                <Lazy key="reveal">
                  <TokenReveal />
                </Lazy>
              )}
            </AnimatePresence>
            <AnimatePresence>
              {stopAllOpen && (
                <Lazy key="stop-all">
                  <StopAll />
                </Lazy>
              )}
            </AnimatePresence>
            <AnimatePresence>
              {swarmDeleteOpen && (
                <Lazy key="swarm-delete">
                  <SwarmDeleteDialog />
                </Lazy>
              )}
            </AnimatePresence>
            <AnimatePresence>
              {look.galleryOpen && (
                <Lazy key="change-ui">
                  <ChangeUi />
                </Lazy>
              )}
            </AnimatePresence>
            <LookPreviewBar />
            <LookConflictNotice />
            <AnimatePresence>
              {paletteOpen && (
                <Lazy key="palette">
                  <CommandPalette />
                </Lazy>
              )}
            </AnimatePresence>
            </div>
            {/* the universal Ask: ONE mount, outside the route switch, so every page and experience has it (ASK-1) */}
            <AskHost experience={experience} />
            <StudioLiveBar />
            {/* the personal mind's swarm talk, collected into this browser's memory while the page is open */}
            <MindInboxCollector />
            {/* guided demos by Ask: the runner, the presence on its target and its caption, in every experience */}
            <GuideLayer experience={experience} />
            {/* demo mode only: the showreel (its cursor, drawing, layers of how); never loaded for a real hive */}
            {isDemoClient(client) && (
              <Suspense fallback={null}>
                <ShowreelLayer />
              </Suspense>
            )}
            {/* First Light: the onboarding journey on the real hive screens, once asked for */}
            {flAsked && (
              <Suspense fallback={null}>
                <FirstLightLayer experience={experience} />
              </Suspense>
            )}
            {/* the OS clock: ONE mount, the same bottom-right corner in every experience, page and app form */}
            <OsClock experience={experience} />
          </>
        )}
        <div className="xc-dress contents">
          <Toasts />
        </div>
        <IntroLayer />
        {/* hive power: Off over every view and experience (sign-in stays above it), and Quiet when idle */}
        <PowerHost experience={experience} signedIn={!!client && !needsLogin} ready={ready} />
        {/* a surface-preview build says so on every screen, live or simulated; a release renders nothing (shell/PreviewBuildMarker) */}
        <PreviewBuildBanner />
        {/* a saved choice this preview build holds back (Still, Canvas) is said, not silently shown as Classic (TF-03) */}
        <HeldExperienceNotice />
        <FpsMeter place={experience !== 'classic' && ready && !needsLogin ? 'escape' : 'centre'} />
      </MotionConfig>
    </LazyMotion>
  )
}
