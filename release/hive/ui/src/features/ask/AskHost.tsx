/** Purpose: mount shared Ask behavior and its sheets.
 * The universal Ask's host (Surface universal Ask, phases 1 and 2). Mounted ONCE in App.tsx, outside the route switch,
 * so every classic page and experience has it (ASK-1; experiences/ask.test.ts checks the mount). It:
 *  - binds the thread to the store session and the signed-in identity (a switch clears it);
 *  - draws the experience's skin (skins.ts): Classic's capsule; Still's floating line when its question box is out of
 *    view; Cosmos's transmission console; Flux's liquid capsule; Canvas's note card; Construct's terminal line when
 *    its own prompt (which IS the Ask) is covered by a page. Inside an experience the floating skins are lifted clear of the chrome the
 *    experience keeps clear (`data-xc-keep-clear`, placement.liftClear);
 *  - draws the Ask MeTTa composes for the person's size on this screen (screens/ask.metta, askScreen.ts): collapsed to
 *    its mark at the start of its row, the bubble above, or the left half, the look's own Ask being the screen's island,
 *    so nothing here places either; an experience's own field (Still's paper, Construct's prompt) is the experience's own
 *    and keeps its place at every size;
 *  - owns the keyboard summon (⌘K, Ctrl+K, `/` outside text fields) and a "Jump to Ask" skip link;
 *  - sits at z 55: under toasts and the DecisionDialog, inert under any modal, clear of Ω and the safe areas;
 *  - opens the host DecisionDialog for `action-needs-confirm` (the only path from the Ask to an app act);
 *  - draws presence in the experience's own grammar.
 */
import { AnimatePresence } from 'framer-motion'
import { handleAskKey } from './summon'
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { isPageRoute, navigate, useRoute } from '../../lib/router'
import { useRailExpanded } from '../../shell/rail'
import { clockSlotLeft } from '../../shell/clockModel'
import { geometry } from '../../shell/layout'
import { isTypingTarget, useIsDesktop } from '../../lib/hooks'
import { lookState, useLook } from '../../shell/uiVariant'
import { bindAskIdentity, selfMoveAt, setMover, useAskStore } from '../../store/ask'
import { useHive } from '../../store/store'
import { askRoom, askRoomFor, setAskRoom } from './askRoom'
import { useWorkbenchBounds, workbenchLayout } from './workbenchLayout'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { ClassicAsk } from './ClassicAsk'
import { useAuthContext } from '../../lib/useResource'
import { askMode, askSideOf, askUnderModal, PINNED_AXIS_SHIFT, placeHalf, placeInExperience, placeMark, type Placement, type PlacementIn } from './placement'
import { changeAskSize, takeFocusWanted, useAskSize } from './askSize'
import { askScreenHost, composeAsk, useMarkState, type AskRegion } from './askScreen'
import { InlineParts } from '../../screens/Screen'
import { AskLeadMark } from '../../brand/AskLeadMark'
import { OmegaGlyph } from '../../brand/OmegaGlyph'
import { setAskOpener } from './askField'
import { usePhase, wakeIntoAsk } from '../../shell/phase'
import { useAskStill, useCardHeight, useKeepClear, useOmegaRight, useOwnBoxVisible, useOwnReservation } from './askMeasure'
import { CanvasPresence, ClassicPresence, ConstructPresence, CosmosPresence, FluxPresence, StillPresence, usePresenceWords } from './Presence'
import { currentEpoch } from '../../lib/identityEpoch'
import { useResting } from '../../lib/resting'
import { StillLine } from './StillLine'
import { ConstructLine } from './ConstructLine'
import { placeConstructField, useConstructFieldPlace } from './constructField'
import { placeStillField, useStillFieldPlace } from './stillField'
// the conductor's executor installs itself into the store (acts are applied only where the Ask is mounted)
import './conductor'
import { FloatingAsk } from './ClassicAsk'
import { askBridge } from './bridge'
import { floatingLook, type SkinId } from './skins'
import { shownMind } from './words'
import './ask.css'
import { framePresentsAsk, useAppAskStore } from '../../store/appAsk'
import { AppAskRecovery } from './AppAskRecovery'

/**
 * Professional's skin and presence (professionalSkin.tsx: its card, presence, binding, tokens and CSS), released:
 * fetched with Professional, in every build. A future unreviewed candidate's skin goes behind the build-mode literal
 * at its own import site (`import.meta.env.DEV || (import.meta.env.PROD && import.meta.env.MODE === 'surface-preview')`),
 * as experiences/registry UNREVIEWED_ALLOWED (stand-in OMEGATOWN_PROFESSIONAL R1 finding 3, R2 P2).
 */
const ProfessionalAskSkin = lazy(() => import('./professionalSkin').then((m) => ({ default: m.ProfessionalAskSkin })))
const ProfessionalPresence = lazy(() => import('./professionalSkin').then((m) => ({ default: m.ProfessionalPresence })))

/**
 * Each experience's Ask skin (skins.ts): every experience has one (experiences/ask.test.ts). An experience not listed
 * here draws none (`phase-2`) until it names its own.
 */
export const ASK_SKINS: Record<string, SkinId | 'professional' | 'phase-2'> = {
  classic: 'capsule',
  professional: 'professional',
  still: 'still-line',
  canvas: 'note',
  cosmos: 'transmission',
  construct: 'command-line',
  flux: 'liquid',
}

/** Skins whose experience draws its own field (the heart of that experience); the host's floating line is the fallback. */
const OWN_FIELD: Partial<Record<SkinId, { box: string; input: string }>> = {
  'still-line': { box: '.still .st-ask', input: '.still .st-ask input' },
  'command-line': { box: '.cx-root .cx-cmd', input: '.cx-root .cx-cmd [data-ask-input]' },
}

/**
 * The viewport, re-read in the same frame as a resize or rotation (flushSync), so the Ask is re-placed in the frame the
 * screen changes, together with the chrome placed by CSS (Ω, the OS clock); while the viewport is changing the Ask
 * jumps to its new place instead of gliding (`html[data-ask-resizing]`, ask.css), so it never trails over them.
 */
function useViewport() {
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useEffect(() => {
    const root = document.documentElement
    let settle = 0
    const on = () => {
      root.dataset.askResizing = ''
      window.clearTimeout(settle)
      settle = window.setTimeout(() => delete root.dataset.askResizing, 400)
      flushSync(() => setVp({ w: window.innerWidth, h: window.innerHeight }))
    }
    window.addEventListener('resize', on)
    return () => {
      window.removeEventListener('resize', on)
      window.clearTimeout(settle)
      delete root.dataset.askResizing
    }
  }, [])
  return vp
}

/** Ω's right edge while Ω is on screen (experiences and app frames), measured, not assumed. */
/**
 * The OS clock's slot left edge (shell/clockModel clockSlotLeft) while the clock is mounted (`html[data-os-clock]`,
 * observed, not polled): the Ask ends before it on its row. The slot is fixed and stays reserved while the clock steps
 * aside, so a modal closing, the hour cycle changing or a wider minute never moves the Ask; only the viewport does, and
 * that is read in the same render as the viewport itself.
 */
function useClockSlotLeft(viewportWidth: number): number | null {
  const mounted = useSyncExternalStore(
    (cb) => {
      const mo = new MutationObserver(cb)
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-os-clock'] })
      return () => mo.disconnect()
    },
    () => 'osClock' in document.documentElement.dataset,
    () => false,
  )
  if (!mounted) return null
  const sar = parseFloat(getComputedStyle(safeProbe()).paddingRight) || 0
  return clockSlotLeft(viewportWidth, sar)
}
let probe: HTMLElement | null = null
/** One hidden element whose right padding is the device's right safe area (env() is only readable through layout). */
function safeProbe(): HTMLElement {
  if (!probe || !probe.isConnected) {
    probe = document.createElement('div')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-right:env(safe-area-inset-right,0px)'
    document.body.appendChild(probe)
  }
  return probe
}

/**
 * True while the Ask sits under a modal layer: an aria-modal dialog not its own, or a layer that made it inert (a nav
 * menu over the rail or over the More sheet). It dims exactly while it cannot be used, and stays dimmed through a menu
 * opened inside a sheet (placement.ts askUnderModal).
 */
function useUnderModal(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mo = new MutationObserver(cb)
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-modal', 'inert'] })
      return () => mo.disconnect()
    },
    () => askUnderModal(document, document.getElementById('ask')),
    () => false,
  )
}

/**
 * The summon key or the skip link on a collapsed Ask: a look at rest wakes first, as typing there does, and waking asks
 * for the field (shell/phase wakeIntoAsk), which opens it; awake, it opens at the size it was collapsed from.
 */
function summonCollapsed(): void {
  const p = usePhase.getState()
  if (p.phased && p.phase === 'rest') wakeIntoAsk('type')
  else changeAskSize('open')
}

export function AskHost({ experience }: { experience: string }) {
  const skin = ASK_SKINS[experience] ?? 'phase-2'
  const isPro = skin === 'professional'
  const client = useHive((s) => s.client)
  const session = useHive((s) => s.session)
  const inits = useHive((s) => s.inits)
  // the client's current sign-in (Platform person-session): every credential change re-reads who is signed in
  const signIn = useAuthContext(client)
  const displayedContext = String(currentEpoch())
  const resting = useResting((s) => s.resting)
  const route = useRoute()
  const look = useLook()
  const desktop = useIsDesktop()
  const vp = useViewport()
  // the person's size on this kind of screen, for which MeTTa composes the Ask (composeAsk, below)
  const size = useAskSize()
  const mode = askMode(vp.w, vp.h)
  const still = useAskStill(route.name)
  const omegaRight = useOmegaRight(`${experience}|${route.name}`, still)
  const clockLeft = useClockSlotLeft(vp.w)
  // the classic desktop rail (also on a landscape phone): the Ask starts right of it, as pages do (--rail-x)
  const railExpanded = useRailExpanded()
  const railX = isPro
    ? desktop && vp.h >= 560 && route.name === 'hive' ? (vp.w <= 1100 ? 182 : 216) : null
    : desktop && experience === 'classic' && look.layout === 'rail' && route.name !== 'program' ? geometry('rail', railExpanded).railX : null
  const underModal = useUnderModal()
  const page = isPageRoute(route.name) || route.name === 'dot' || route.name === 'new'
  const own = skin === 'phase-2' || isPro ? undefined : OWN_FIELD[skin as SkinId]
  const ownBox = useOwnBoxVisible(own?.box ?? null, still)
  // inside an experience, the floating Ask keeps clear of the experience's own chrome on screen. It is measured whenever an experience is mounted: a route over it (a page, or one the experience draws itself, like a
  // mind's conversation) is told apart by what is actually on top, not by the route's name
  const keep = useKeepClear(experience !== 'classic' && skin !== 'phase-2', still)
  const inputRef = useRef<HTMLInputElement>(null)
  // a callback ref: the card mounts after its lazy skin loads, and the measuring effect follows it
  const [professionalBox, setProfessionalBox] = useState<HTMLDivElement | null>(null)
  const [floatingBox, setFloatingBox] = useState<HTMLDivElement | null>(null)
  const confirm = useAskStore((s) => s.confirm)
  const threadOpen = useAskStore((s) => s.threadOpen)
  const pinned = useAskStore((s) => s.pinned)
  const thread = useAskStore((s) => s.thread)
  const openOperation = useAskStore((s) => s.open)
  const appTurns = useAppAskStore((s) => s.turns)
  const inApp = appTurns.some((t) => t.current() && !t.offeredLocally && t.presentation.owner === 'frame' && t.controller.active() && (!openOperation || t.presentation.operation_id === openOperation))

  // The card's options/thread can grow: canonical pages and toasts clear its actual height, not a capsule guess.
  const professionalHeight = useCardHeight(professionalBox, isPro && !resting && !still, displayedContext)
  const floatingHeight = useCardHeight(floatingBox, !isPro && !still, displayedContext)
  const workbench = useWorkbenchBounds(skin === 'capsule' && experience === 'classic' && threadOpen && !inApp)

  // ---- bound to the store session and the signed-in identity: a switch clears the thread. The store resets the
  // thread synchronously on a credential change (store/ask watchAuth); this reads me() again under the new sign-in
  // and binds only if that sign-in is still current when the answer arrives (bindAskIdentity, Review B1 06ce9e7).
  // A re-init of the same client resets the thread too: bind it again for whoever is signed in now.
  useEffect(() => (client ? bindAskIdentity(client, session, inits) : undefined), [client, session, inits, signIn])

  // ---- how the mind moves the page here: instantly, or (when it asks to animate) the experience's own transition:
  // Classic glides and fades through a soft veil; Still turns the page; Cosmos jumps through a warp streak; Flux pours
  // through a liquid wash (and ripples the liquid); Construct tears through a scanline glitch; Canvas pulls focus, as a
  // camera does across a table. Reduced motion always
  // moves instantly.
  useEffect(() => {
    setMover((r, animate) => {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches || lookState().saved?.variant?.motion === 'none'
      if (animate && !reduced) {
        if (experience === 'still') {
          const el = document.querySelector('.still')
          el?.setAttribute('data-ask-turn', '')
          window.setTimeout(() => el?.removeAttribute('data-ask-turn'), 720)
        } else {
          const veil = document.createElement('div')
          veil.className = 'ask-move-veil'
          veil.dataset.look = experience
          veil.setAttribute('aria-hidden', 'true')
          document.body.appendChild(veil)
          window.setTimeout(() => veil.remove(), 650)
          if (experience === 'flux') askBridge('flux')?.ripple?.(window.innerWidth / 2, window.innerHeight / 2, 1.4)
        }
      }
      navigate(r)
    })
    return () => setMover(null)
  }, [experience])

  // ---- the person always wins: clicking or scrolling the page, or Back, pauses the mind's moves for the turn.
  // Typing in the Ask is steering and never counts; reading the thread does not either.
  useEffect(() => {
    const on = (e: Event) => {
      if (!e.isTrusted || !useAskStore.getState().open) return
      const t = e.target instanceof Element ? e.target : null
      if (t?.closest('[data-app-ask-recovery]') || framePresentsAsk(useAskStore.getState().open!)) return
      // the Ask's own surfaces: the floating skins, and an experience's own field that IS the Ask (Construct's prompt)
      const inAsk = !!t?.closest('.ask-root, [data-ask-zone]')
      if (e.type === 'popstate') {
        if (Date.now() - selfMoveAt < 700 || document.activeElement?.closest?.('.ask-root, [data-ask-zone]')) return
      } else if (inAsk && !t?.closest('[data-takeover]')) return
      if (e.type === 'keydown') {
        const k = (e as KeyboardEvent).key
        if (inAsk || (!isTypingTarget(t) && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(k))) return
      }
      useAskStore.getState().personTookOver()
    }
    const opts = { capture: true, passive: true }
    const kinds = ['pointerdown', 'wheel', 'touchmove', 'keydown'] as const
    kinds.forEach((k) => window.addEventListener(k, on, opts))
    window.addEventListener('popstate', on)
    return () => {
      kinds.forEach((k) => window.removeEventListener(k, on, opts))
      window.removeEventListener('popstate', on)
    }
  }, [])

  // SIM ONLY: the browser checks play "someone else signs in" (a fresh init of the store) from the console
  useEffect(() => {
    if (client?.mode !== 'sim') return
    const w = window as unknown as { __hiveAsk?: unknown }
    w.__hiveAsk = { reinit: () => useHive.getState().init(client), state: () => useAskStore.getState(), rebuild: () => useAskStore.getState().rebuild() }
    return () => {
      delete w.__hiveAsk
    }
  }, [client])

  // a page or sheet over the paper (or the terminal) hides the experience's own field (covered, even when "in view"):
  // the floating line takes over
  const ownLive = ownBox && !page
  const constructPlace = useConstructFieldPlace()
  useLayoutEffect(() => { if (skin === 'command-line') placeConstructField(ownLive ? 'native' : 'floating') }, [skin, ownLive])
  useLayoutEffect(() => () => { if (skin === 'command-line') placeConstructField('native', null) }, [skin])
  const stillPlace = useStillFieldPlace()
  useLayoutEffect(() => {
    if (skin === 'still-line') placeStillField(ownLive ? 'paper' : 'floating')
  }, [skin, ownLive])
  useLayoutEffect(() => () => { if (skin === 'still-line') placeStillField('paper', null) }, [skin])
  const showStillLine = skin === 'still-line' && stillPlace === 'floating'
  const floating = skin === 'phase-2' || isPro ? null : floatingLook(skin as SkinId)
  const showFloating = !!floating && (skin !== 'command-line' || constructPlace === 'floating')
  // the host draws the Ask here (any look's floating Ask, Still's floating line, Professional's card), so its size applies
  const shown = !inApp && (showFloating || showStillLine || (isPro && !resting))
  // MeTTa composes the Ask for this look at the person's size on this screen (screens/ask.metta): the region its own Ask
  // lays itself out in, and the mark when collapsed while it is drawn here. This only draws the answer
  const ask = composeAsk(experience, size, mode, shown)
  const region = ask.region
  const collapsed = region === 'mark'
  const half = region === 'half-left'
  const mark = useMarkState(collapsed && shown)
  // A departed dock's last measurement must not reserve space for the next look's field, nor a hidden one's (collapsed);
  // at half, Professional's card is the left half's column, not a dock across the foot
  const measuredDockHeight = collapsed || (isPro && half) ? 0 : isPro ? (professionalBox ? professionalHeight : 0) : (floatingBox ? floatingHeight : 0)
  // where the thread sits beside the view (one source for data-ask-side, which the scene frames by, and the Ask's axis)
  const side = askSideOf({ floating: showFloating, threadOpen, pinned: pinned && !workbench.drawer, mode, half: half && shown })
  const placeIn = useMemo<PlacementIn>(
    () => ({ width: vp.w, height: vp.h, layout: isPro ? 'topbar' : look.layout, page, tabBar: !desktop && experience === 'classic' && (route.name === 'hive' || (isPageRoute(route.name) && route.name !== 'program')), omegaRight, railX, clockLeft, pageAxis: route.name === 'hive', axisShift: experience === 'cosmos' && side === 'desktop' ? PINNED_AXIS_SHIFT : 0 }),
    [vp, look.layout, isPro, page, desktop, experience, omegaRight, route.name, railX, clockLeft, side],
  )
  // inside an experience it is lifted clear of the kept-clear chrome, and widened once it is above Ω and the clock; the
  // mark and the half size start where the Ask's row starts. The bubble's place is the Ask's row in every size: a look
  // that aligns with the Ask (Professional's home column) keeps aligning with it while the Ask is the mark or the column
  const bubblePlace = useMemo(() => placeInExperience(placeIn, keep.boxes, keep.sab), [placeIn, keep])
  const normalPlace = useMemo(
    () => (collapsed ? placeMark(placeIn, keep.boxes, keep.sab) : half ? placeHalf(placeIn, keep.boxes, keep.sab) : bubblePlace),
    [placeIn, keep, collapsed, half, bubblePlace],
  )
  // the workbench shares the screen with the bubble's thread; the half size has its own column
  const shared = workbench.drawer && region === 'bubble' ? workbenchLayout(normalPlace, workbench.drawer, { height: vp.h - keep.sab, contentLeft: railX ?? 0, room: askRoom(normalPlace, false, measuredDockHeight) }) : null
  const place = shared?.place ?? normalPlace
  const row = region === 'bubble' ? place : bubblePlace
  // Only the workbench clears the conversation as well as the composer. Other pages keep their normal reservation.
  useLayoutEffect(() => {
    const root = document.documentElement
    if (shared?.stacked && workbench.threadHeight > 0) root.style.setProperty('--ask-companion-room', `calc(var(--sab, 0px) + ${askRoom(place, false, measuredDockHeight) + workbench.threadHeight + 8}px)`)
    else root.style.removeProperty('--ask-companion-room')
    return () => { root.style.removeProperty('--ask-companion-room') }
  }, [shared?.stacked, place.bottom, measuredDockHeight, workbench.threadHeight])
  const nativeConstruct = !inApp && skin === 'command-line' && constructPlace === 'native' && ownLive
  const nativeReservation = useOwnReservation(nativeConstruct ? '.cx-cmd' : null)

  // ---- room for the Ask: pages pad their scroll so their last row clears it; phone toasts stack above it
  useEffect(() => {
    const root = document.documentElement
    if (!shown && !nativeReservation) {
      setAskRoom(root, null)
      root.style.removeProperty('--ask-left')
      root.style.removeProperty('--ask-width')
      delete root.dataset.ask
      delete root.dataset.askNative
      return
    }
    // the Ask's room for pages, sheets, toasts and the looks' panels, and for the hive map's fits (features/ask/askRoom,
    // followups-r5): above the foot for a dock, beside the half size's column on the left
    const room = nativeReservation ? { bottom: nativeReservation.room, left: 0 } : askRoomFor(region, place, isPro, measuredDockHeight)
    setAskRoom(root, room.bottom, room.left)
    // Native awake composition aligns with this host-owned dock's row, never a second placement calculation.
    root.style.setProperty('--ask-left', `${nativeReservation?.left ?? row.left}px`)
    root.style.setProperty('--ask-width', `${nativeReservation?.width ?? row.width}px`)
    root.dataset.ask = place.mode
    if (nativeReservation) root.dataset.askNative = 'construct'
    else delete root.dataset.askNative
    // a side sheet (landscape) or a pinned column (desktop): toasts keep to the other side of it
    if (side) root.dataset.askSide = side
    else delete root.dataset.askSide
    return () => {
      setAskRoom(root, null)
      root.style.removeProperty('--ask-left')
      root.style.removeProperty('--ask-width')
      delete root.dataset.ask
      delete root.dataset.askSide
      delete root.dataset.askNative
    }
  }, [shown, place, row, region, isPro, side, measuredDockHeight, nativeReservation])

  // ---- opened from its mark or with the summon key: the field takes the cursor once it is drawn (askSize.openAsk)
  useLayoutEffect(() => {
    if (!collapsed && takeFocusWanted()) inputRef.current?.focus()
  }, [collapsed])
  // ---- while collapsed, anything asking for the Ask's field opens it: a look's port (typing at rest, Ω), a card's
  //      words (fillAsk), the summon key (askField.focusAskField)
  useEffect(() => {
    if (!(collapsed && shown)) return
    setAskOpener(() => {
      changeAskSize('open')
      return true
    })
    return () => setAskOpener(null)
  }, [collapsed, shown])

  // ---- ⌘K / Ctrl+K / `/` focus the Ask (captured first, so the palette's same keys do not also fire), except where a
  //      region owns ⌘K (lib/shortcutOwner); a collapsed Ask opens first, at the size it was collapsed from
  useEffect(() => {
    if (skin === 'phase-2') return
    // the whole decision is features/ask/summon.handleAskKey (tested as behaviour there); the experience's own field
    // (Still's question box, Construct's prompt) answers while it is on screen
    const onKey = (e: KeyboardEvent) =>
      void handleAskKey(e, {
        stillBox: own && ownLive ? () => document.querySelector<HTMLInputElement>(own.input) : null,
        input: () => (collapsed && shown ? { focus: summonCollapsed } : inputRef.current),
        modalOpen: () => !!document.querySelector('[aria-modal="true"]'),
      })
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [skin, own, ownLive, collapsed, shown])

  // words the orchestrator is referring to, lit in Still's letter
  const words = usePresenceWords()

  if (skin === 'phase-2') return createPortal(<AppAskRecovery />, document.body)

  const jump = () => {
    if (own && ownLive) document.querySelector<HTMLInputElement>(own.input)?.focus()
    else if (collapsed && shown) summonCollapsed()
    else inputRef.current?.focus()
  }

  return createPortal(
    <>
      <AppAskRecovery />
      {!inApp && (!isPro || !resting) && <a href="#ask" className="ask-skip" data-experience={experience} onClick={(e) => (e.preventDefault(), jump())}>
        Jump to Ask
      </a>}
      {/* one Ask landmark: here, unless Construct's own prompt is the Ask (it is its own section then) */}
      {!inApp && !(skin === 'command-line' && constructPlace === 'native') && (
        <section aria-label="Ask" className="ask-root" data-skin={skin} data-under-modal={underModal || undefined} id="ask">
          {/* the screen MeTTa composed: collapsed, the mark stands in for the look's Ask, which stays mounted and hidden
              (its unsent words kept), since the screen keeps its island wherever it places it */}
          <InlineParts plan={ask.plan} host={askScreenHost({
            place, mark, onOpen: () => changeAskSize('open'),
            glyph: <AskLeadMark experience={experience} typing={false} fallback={<OmegaGlyph className="h-[17px] w-[19px]" />} />,
            island: <LookAsk skin={skin} experience={experience} place={place} region={region} inputRef={inputRef} floatingBox={setFloatingBox} professionalBox={setProfessionalBox}
              workbench={shared ?? undefined} floating={showFloating} line={showStillLine} awake={!resting} ctx={displayedContext} words={words} />,
          })} />
        </section>
      )}
      {!inApp && !underModal && <SkinPresence skin={skin} />}
      <AnimatePresence>
        {confirm && (
          <DecisionDialog
            key={confirm.proposal.id}
            icon="apps"
            eyebrow={`Proposed by ${shownMind(thread?.mind.name, thread?.mind.id)}`}
            title={confirm.proposal.label}
            facts={[
              ['App', confirm.proposal.program],
              ['Action', confirm.proposal.action],
              ['Items', confirm.proposal.items.length ? confirm.proposal.items.join(', ') : 'none'],
              ...Object.entries(confirm.proposal.params).slice(0, 12).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)] as [string, string]),
              ['Why you see this', 'A mind composed this request. Nothing happens unless you confirm it here.'],
            ]}
            bound={{ kind: 'ready' }}
            thing="This proposal"
            actions={[{ label: 'Confirm', busyLabel: 'Confirming', tone: 'primary', run: () => useAskStore.getState().confirmAct() }]}
            onClose={() => useAskStore.getState().declineAct()}
            dismissLabel="Not now"
            restoreFocus={() => (own && ownLive ? document.querySelector<HTMLInputElement>(own.input) : null) ?? inputRef.current}
          />
        )}
      </AnimatePresence>
    </>,
    document.body,
  )
}

/**
 * The look's own Ask as the host draws it, the island the Ask's screen places (screens/ask.metta): Classic's capsule, a
 * floating look's field and thread, Construct's terminal line over a page, Professional's card while it is awake, or
 * Still's floating line, each laying itself out in the region MeTTa gave the person's size.
 */
export function LookAsk({ skin, experience, place, region, inputRef, floatingBox, professionalBox, workbench, floating, line, awake, ctx, words }: {
  skin: SkinId | 'professional'
  experience: string
  place: Placement
  region: AskRegion
  inputRef: RefObject<HTMLInputElement | null>
  floatingBox: (box: HTMLDivElement | null) => void
  professionalBox: (box: HTMLDivElement | null) => void
  workbench?: { maxThreadHeight?: number }
  /** the host draws the look's floating Ask here (Construct's terminal line only while a page covers its own prompt) */
  floating: boolean
  /** Still's floating line is drawn (its paper's question box is out of view or covered) */
  line: boolean
  /** the look is awake: Professional's card shows only then */
  awake: boolean
  /** the displayed sign-in: a new one draws a fresh line, and a fresh card */
  ctx: string
  /** words the mind is referring to, lit in Still's letter */
  words: string[]
}) {
  const look = skin === 'professional' ? null : floatingLook(skin)
  return (
    <>
      {skin === 'capsule' && <ClassicAsk place={place} experience={experience} inputRef={inputRef} boxRef={floatingBox} workbench={workbench} region={region} />}
      {floating && skin === 'command-line' && <ConstructLine key={ctx} place={place} inputRef={inputRef} region={region} />}
      {floating && look && skin !== 'capsule' && skin !== 'command-line' && <FloatingAsk place={place} experience={experience} inputRef={inputRef} look={look} boxRef={floatingBox} region={region} />}
      {skin === 'professional' && awake && <Suspense fallback={null}><ProfessionalAskSkin place={place} experience={experience} inputRef={inputRef} ctx={ctx} boxRef={professionalBox} region={region} /></Suspense>}
      {line && <StillLine key={ctx} place={place} inputRef={inputRef} words={words} region={region} />}
    </>
  )
}

/** Presence in the experience's own grammar (Presence.tsx). */
function SkinPresence({ skin }: { skin: SkinId | 'professional' }) {
  const resting = useResting((s) => s.resting)
  if (skin === 'professional') return resting ? null : <Suspense fallback={null}><ProfessionalPresence /></Suspense>
  if (skin === 'still-line') return <StillPresence />
  if (skin === 'transmission') return <CosmosPresence />
  if (skin === 'liquid') return <FluxPresence />
  if (skin === 'command-line') return <ConstructPresence />
  if (skin === 'note') return <CanvasPresence />
  return <ClassicPresence />
}
