/**
 * The universal Ask's host (Surface universal Ask, phases 1 and 2). Mounted ONCE in App.tsx, outside the route switch,
 * so every classic page and experience has it (ASK-1; experiences/ask.test.ts checks the mount). It:
 *  - binds the thread to the store session and the signed-in identity (a switch clears it);
 *  - draws the experience's skin (skins.ts): Classic's capsule; Still's floating line when its question box is out of
 *    view; Cosmos's transmission console; Flux's liquid capsule; Canvas's note card; Construct's terminal line when
 *    its own prompt (which IS the Ask) is covered by a page. Inside an experience the floating skins are lifted clear of the chrome the
 *    experience keeps clear (`data-xc-keep-clear`, placement.liftClear);
 *  - owns the keyboard summon (⌘K, Ctrl+K, `/` outside text fields) and a "Jump to Ask" skip link;
 *  - sits at z 55: under toasts and the DecisionDialog, inert under any modal, clear of Ω and the safe areas;
 *  - opens the host DecisionDialog for `action-needs-confirm` (the only path from the Ask to an app act);
 *  - draws presence in the experience's own grammar.
 */
import { AnimatePresence } from 'framer-motion'
import { handleAskKey } from './summon'
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { isPageRoute, navigate, useRoute } from '../../lib/router'
import { useRailExpanded } from '../../shell/rail'
import { clockSlotLeft } from '../../shell/clockModel'
import { geometry } from '../../shell/layout'
import { isTypingTarget, useIsDesktop } from '../../lib/hooks'
import { lookState, useLook } from '../../shell/uiVariant'
import { bindAskIdentity, selfMoveAt, setMover, useAskStore } from '../../store/ask'
import { useHive } from '../../store/store'
import { askRoom, setAskRoom } from './askRoom'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { ClassicAsk } from './ClassicAsk'
import { useAuthContext } from '../../lib/useResource'
import { askUnderModal, placeInExperience, type ClearBox } from './placement'
import { CanvasPresence, ClassicPresence, ConstructPresence, CosmosPresence, FluxPresence, StillPresence, usePresenceWords } from './Presence'
import { currentEpoch } from '../../lib/identityEpoch'
import { useResting } from '../../lib/resting'
import { StillLine } from './StillLine'
// the conductor's executor installs itself into the store (acts are applied only where the Ask is mounted)
import './conductor'
import { FloatingAsk } from './ClassicAsk'
import { askBridge } from './bridge'
import { floatingLook, type SkinId } from './skins'
import { shownMind } from './words'
import './ask.css'
import { claimAppAsk, framePresentsAsk, useAppAskStore } from '../../store/appAsk'

/** Always host-owned, including skins which draw no floating Ask. Recovery claims presentation, never ends a turn. */
function AppAskRecovery() {
  const turns = useAppAskStore((s) => s.turns)
  const entry = [...turns].reverse().find((t) => t.current() && (t.offeredLocally || !t.presentation.host_active))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const request = useRef(0)
  useEffect(() => { request.current++; setBusy(false); setError(false) }, [entry?.presentation.operation_id, entry?.presentation.epoch, entry?.offeredLocally])
  if (!entry) return null
  const recover = async () => {
    if (busy) return
    const ticket = ++request.current
    setBusy(true); setError(false)
    try {
      const claimed = await claimAppAsk(entry)
      if (!claimed || !entry.current()) { if (ticket === request.current) setError(true); return }
      await useAskStore.getState().showAppTurn(claimed.operation_id)
    } catch { if (entry.current() && ticket === request.current) setError(true) }
    finally { if (ticket === request.current) setBusy(false) }
  }
  return <div data-app-ask-recovery className="ask-root fixed bottom-4 right-4 z-[55] max-w-[calc(100%-2rem)] rounded-xl border border-line bg-panel p-2 text-sm shadow-lg" role="region" aria-label="Return to Ask">
    <button type="button" className="rounded-lg px-4 py-3 font-medium focus-visible:outline focus-visible:outline-2" disabled={busy} onClick={() => void recover()}>{busy ? 'Returning…' : 'Return to Ask'}</button>
    {error && <p role="status" className="max-w-xs px-3 pb-2">Could not confirm the handover. Check again; your turn has not been replaced.</p>}
  </div>
}

/**
 * Professional's skin and presence (professionalSkin.tsx: its card, presence, binding, tokens and CSS), released:
 * fetched with Professional, in every build. A future unreviewed candidate's skin goes behind the build-mode literal
 * at its own import site (`import.meta.env.DEV || (import.meta.env.PROD && import.meta.env.MODE === 'surface-preview')`),
 * as experiences/registry UNREVIEWED_ALLOWED (stand-in OMEGATOWN_PROFESSIONAL R1 finding 3, R2 P2).
 */
const ProfessionalAskSkin = lazy(() => import('./professionalSkin').then((m) => ({ default: m.ProfessionalAskSkin })))
const ProfessionalPresence = lazy(() => import('./professionalSkin').then((m) => ({ default: m.ProfessionalPresence })))
/** OmegaTown's skin and presence (townSkin.tsx), released: fetched with Town, in every build. */
const TownAskSkin = lazy(() => import('./townSkin').then((m) => ({ default: m.TownAskSkin })))
const TownPresence = lazy(() => import('./townSkin').then((m) => ({ default: m.TownPresence })))

/**
 * Each experience's Ask skin (skins.ts): every experience has one (experiences/ask.test.ts). An experience not listed
 * here draws none (`phase-2`) until it names its own.
 */
export const ASK_SKINS: Record<string, SkinId | 'town-capsule' | 'professional' | 'phase-2'> = {
  classic: 'capsule',
  omegatown: 'town-capsule',
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

function useOmegaRight(dep: unknown): number | null {
  const [right, setRight] = useState<number | null>(null)
  useEffect(() => {
    const measure = () => {
      const o = document.querySelector('[data-omega-button]')?.getBoundingClientRect()
      setRight(o && o.width ? o.right : null)
    }
    measure()
    const t = window.setInterval(measure, 800)
    return () => window.clearInterval(t)
  }, [dep])
  return right
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

/** Is the experience's own field (Still's question box, Construct's prompt) on screen and live? */
function useOwnBoxVisible(selector: string | null): boolean {
  const active = !!selector
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    if (!active) return
    let io: IntersectionObserver | null = null
    let el: Element | null = null
    let inView = true
    const check = () => {
      const box = document.querySelector(selector!)
      if (box !== el) {
        io?.disconnect()
        el = box
        if (box) {
          io = new IntersectionObserver((es) => {
            inView = es[es.length - 1].isIntersecting
            setVisible(inView && !box.closest('[inert]'))
          })
          io.observe(box)
        }
      }
      setVisible(!!el && inView && !el.closest('[inert]'))
    }
    check()
    const t = window.setInterval(check, 400)
    return () => {
      window.clearInterval(t)
      io?.disconnect()
    }
  }, [active, selector])
  return active ? visible : false
}

/** The bottom safe area, measured (the Ask's `bottom` is above it). */
function readSab(): number {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom,0px)'
  document.body.appendChild(probe)
  const v = parseFloat(getComputedStyle(probe).paddingBottom) || 0
  probe.remove()
  return v
}

/**
 * The chrome an experience keeps clear (`data-xc-keep-clear`: navigators, pills, docks, chip rows), measured while the
 * experience is in front, re-measured on a slow poll and on resize; the Ask's own marks and Ω are not counted (Ω is
 * placeAsk's). State changes only when a box really moved.
 */
function useKeepClear(active: boolean): { boxes: ClearBox[]; sab: number } {
  const [v, setV] = useState<{ boxes: ClearBox[]; sab: number; sig: string }>({ boxes: [], sab: 0, sig: '' })
  useEffect(() => {
    if (!active) return
    const measure = () => {
      const boxes: ClearBox[] = []
      for (const el of document.querySelectorAll('[data-xc-keep-clear]')) {
        if (el.closest('.ask-root, [data-omega-button]')) continue
        if (el.closest('[inert],[aria-hidden="true"]')) continue
        const r = el.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) continue
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
        // only chrome actually on top at its centre (a classic page over the experience covers it); the Ask's own
        // layers and presence are looked through, since the Ask may be sitting on the very chrome it must clear
        const cx = Math.min(window.innerWidth - 1, Math.max(0, (r.left + r.right) / 2))
        const cy = Math.min(window.innerHeight - 1, Math.max(0, (r.top + r.bottom) / 2))
        const top = (document.elementsFromPoint?.(cx, cy) ?? []).find((t) => !t.closest('.ask-root, .ask-presence-layer, .ask-move-veil'))
        if (top && !el.contains(top) && !top.contains(el)) continue
        boxes.push({ left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) })
      }
      const sab = readSab()
      const sig = `${sab}|${boxes.map((b) => `${b.left},${b.top},${b.right},${b.bottom}`).join(';')}`
      setV((p) => (p.sig === sig ? p : { boxes, sab, sig }))
    }
    measure()
    const t = window.setInterval(measure, 700)
    window.addEventListener('resize', measure)
    return () => {
      window.clearInterval(t)
      window.removeEventListener('resize', measure)
    }
  }, [active])
  return active ? v : NO_KEEP
}
const NO_KEEP = { boxes: [] as ClearBox[], sab: 0 }

export function AskHost({ experience }: { experience: string }) {
  const skin = ASK_SKINS[experience] ?? 'phase-2'
  const isPro = skin === 'professional'
  const isTown = skin === 'town-capsule'
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
  const omegaRight = useOmegaRight(`${experience}|${route.name}`)
  const clockLeft = useClockSlotLeft(vp.w)
  // the classic desktop rail (also on a landscape phone): the Ask starts right of it, as pages do (--rail-x)
  const railExpanded = useRailExpanded()
  const railX = isPro
    ? desktop && vp.h >= 560 && route.name === 'hive' ? (vp.w <= 1100 ? 182 : 216) : null
    : desktop && experience === 'classic' && look.layout === 'rail' && route.name !== 'program' ? geometry('rail', railExpanded).railX : null
  const underModal = useUnderModal()
  const page = isPageRoute(route.name) || route.name === 'dot' || route.name === 'new'
  const own = skin === 'phase-2' || isTown || isPro ? undefined : OWN_FIELD[skin as SkinId]
  const ownBox = useOwnBoxVisible(own?.box ?? null)
  // inside an experience, the floating Ask keeps clear of the experience's own chrome on screen. It is measured whenever an experience is mounted: a route over it (a page, or one the experience draws itself, like a
  // mind's conversation) is told apart by what is actually on top, not by the route's name
  const keep = useKeepClear(experience !== 'classic' && skin !== 'phase-2')
  const inputRef = useRef<HTMLInputElement>(null)
  // a callback ref: the card mounts after its lazy skin loads, and the measuring effect follows it
  const [professionalBox, setProfessionalBox] = useState<HTMLDivElement | null>(null)
  const [professionalHeight, setProfessionalHeight] = useState(0)
  const confirm = useAskStore((s) => s.confirm)
  const threadOpen = useAskStore((s) => s.threadOpen)
  const pinned = useAskStore((s) => s.pinned)
  const thread = useAskStore((s) => s.thread)
  const openOperation = useAskStore((s) => s.open)
  const appTurns = useAppAskStore((s) => s.turns)
  const inApp = appTurns.some((t) => t.current() && !t.offeredLocally && t.presentation.owner === 'frame' && t.controller.active() && (!openOperation || t.presentation.operation_id === openOperation))

  // The card's options/thread can grow: canonical pages and toasts clear its actual height, not a capsule guess.
  useEffect(() => {
    if (!isPro || resting) return
    const box = professionalBox
    if (!box) return
    const measure = () => setProfessionalHeight(Math.ceil(box.getBoundingClientRect().height))
    const initial = window.requestAnimationFrame(measure)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(box)
    window.addEventListener('resize', measure)
    return () => { window.cancelAnimationFrame(initial); observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [isPro, resting, displayedContext, professionalBox])

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

  // inside an experience it is lifted clear of the kept-clear chrome, and widened once it is above Ω and the clock
  const place = useMemo(
    () => placeInExperience({ width: vp.w, height: vp.h, layout: isPro ? 'topbar' : look.layout, page, tabBar: !desktop && experience === 'classic' && (route.name === 'hive' || (isPageRoute(route.name) && route.name !== 'program')), omegaRight, railX, clockLeft }, keep.boxes, keep.sab),
    [vp, look.layout, isPro, page, desktop, experience, omegaRight, route.name, railX, clockLeft, keep],
  )
  // a page or sheet over the paper (or the terminal) hides the experience's own field (covered, even when "in view"):
  // the floating line takes over
  const ownLive = ownBox && !page
  const showStillLine = skin === 'still-line' && !ownLive
  const floating = skin === 'phase-2' || isTown || isPro ? null : floatingLook(skin as SkinId)
  const showFloating = !!floating && !(skin === 'command-line' && ownLive)
  const shown = !inApp && (showFloating || showStillLine || ((isTown || isPro) && !resting))

  // ---- room for the Ask: pages pad their scroll so their last row clears it; phone toasts stack above it
  useEffect(() => {
    const root = document.documentElement
    if (!shown) {
      setAskRoom(root, null)
      delete root.dataset.ask
      return
    }
    // the Ask's room for pages, sheets and toasts, and for the hive map's fits (features/ask/askRoom, followups-r5)
    setAskRoom(root, askRoom(place, isPro, professionalHeight))
    root.dataset.ask = place.mode
    // a side sheet (landscape) or a pinned column (desktop): toasts keep to the other side of it
    const side = (showFloating || isTown) && threadOpen && (place.mode === 'landscape' || (place.mode === 'desktop' && pinned))
    if (side) root.dataset.askSide = place.mode
    else delete root.dataset.askSide
    return () => {
      setAskRoom(root, null)
      delete root.dataset.ask
      delete root.dataset.askSide
    }
  }, [shown, place, isPro, isTown, showFloating, threadOpen, pinned, professionalHeight])

  // ---- ⌘K / Ctrl+K / `/` focus the Ask (captured first, so the palette's same keys do not also fire), except where a
  //      region owns ⌘K (lib/shortcutOwner)
  useEffect(() => {
    if (skin === 'phase-2') return
    // the whole decision is features/ask/summon.handleAskKey (tested as behaviour there); the experience's own field
    // (Still's question box, Construct's prompt) answers while it is on screen
    const onKey = (e: KeyboardEvent) =>
      void handleAskKey(e, {
        stillBox: own && ownLive ? () => document.querySelector<HTMLInputElement>(own.input) : null,
        input: () => inputRef.current,
        modalOpen: () => !!document.querySelector('[aria-modal="true"]'),
      })
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [skin, own, ownLive])

  // words the orchestrator is referring to, lit in Still's letter
  const words = usePresenceWords()

  if (skin === 'phase-2') return createPortal(<AppAskRecovery />, document.body)

  const jump = () => {
    if (own && ownLive) document.querySelector<HTMLInputElement>(own.input)?.focus()
    else inputRef.current?.focus()
  }

  return createPortal(
    <>
      <AppAskRecovery />
      {!inApp && ((!isPro && !isTown) || !resting) && <a href="#ask" className="ask-skip" data-experience={experience} onClick={(e) => (e.preventDefault(), jump())}>
        Jump to Ask
      </a>}
      {/* one Ask landmark: here, unless Construct's own prompt is the Ask (it is its own section then) */}
      {!inApp && !(skin === 'command-line' && ownLive) && (
        <section aria-label="Ask" className="ask-root" data-skin={skin} data-under-modal={underModal || undefined} id="ask">
          {skin === 'capsule' && <ClassicAsk place={place} experience={experience} inputRef={inputRef} />}
          {showFloating && skin !== 'capsule' && <FloatingAsk place={place} experience={experience} inputRef={inputRef} look={floating!} />}
        {isTown && !resting && <Suspense fallback={null}><TownAskSkin place={place} experience={experience} inputRef={inputRef} ctx={displayedContext} /></Suspense>}
        {isPro && !resting && <Suspense fallback={null}><ProfessionalAskSkin place={place} experience={experience} inputRef={inputRef} ctx={displayedContext} boxRef={setProfessionalBox} /></Suspense>}
          {showStillLine && <StillLine place={place} inputRef={inputRef} words={words} />}
        </section>
      )}
      {!inApp && !underModal && <SkinPresence skin={skin} />}
      <AnimatePresence>
        {confirm && (
          <DecisionDialog
            key={confirm.proposal.id}
            icon="apps"
            eyebrow={`Proposed by ${shownMind(thread?.mind.name)}`}
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

/** Presence in the experience's own grammar (Presence.tsx). */
function SkinPresence({ skin }: { skin: SkinId | 'town-capsule' | 'professional' }) {
  const resting = useResting((s) => s.resting)
  if (skin === 'professional') return resting ? null : <Suspense fallback={null}><ProfessionalPresence /></Suspense>
  if (skin === 'town-capsule') return resting ? null : <Suspense fallback={null}><TownPresence /></Suspense>
  if (skin === 'still-line') return <StillPresence />
  if (skin === 'transmission') return <CosmosPresence />
  if (skin === 'liquid') return <FluxPresence />
  if (skin === 'command-line') return <ConstructPresence />
  if (skin === 'note') return <CanvasPresence />
  return <ClassicPresence />
}
