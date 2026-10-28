import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { useEscape, useIsDesktop, useReducedMotion } from '../lib/hooks'
import { href, isPageRoute, navigate, useRoute, type Route } from '../lib/router'
import { useHive, useHealthAlertCount } from '../store/store'
import { useHeldCalls, useHeldCallsWatch } from '../features/usage/heldCalls'
import { Icon } from '../ui/Icon'
import { CountBadge, Kbd } from '../ui/primitives'
import { cx } from '../lib/cx'
import { countPending, labHealth } from '../store/reducer'
import { isActive, ME_ITEM, navItem, navMenu, navModel, PHONE_TABS, type NavItem, type NavModel, type NavModelSection } from './navItems'
import { goTo } from './navGo'
import { dropPinned, movePinned, setCollapsed, toggleHidden, togglePin, useNavPrefs } from './navPrefs'
import { NavMenu, type NavMenuAction } from './NavMenu'
import { setRailPref, useRailExpanded } from './rail'
import { BAR, geometry } from './layout'
import { useLook, type Layout } from './uiVariant'
import { appTheme, DESIGNED_APPS } from './appLook'
import { useAdminView } from '../lib/useAdmin'
import { longPress } from './longPress'
import { usePointerFine } from './pointerFine'
import { useModalContainment } from '../ui/useModalContainment'
import { ASK_RESERVE, useOverlay } from '../ui/overlays'

function usePending() {
  return useHive((s) => countPending(s.approvals))
}

/** Each nav item's badge: decisions waiting (Inbox), health alerts (Health), calls to settle (Usage). */
function useBadges(): (it: NavItem) => number {
  const pending = usePending()
  const health = useHealthAlertCount()
  const held = useHeldCalls((s) => s.count)
  return (it) => (it.badge === 'pending' ? pending : it.badge === 'health' ? health : it.badge === 'held' ? held : 0)
}

// ---------------------------------------------------------------- the one navigation model, and what a person does to it

/**
 * The navigation this person sees (navModel: admin-only entries for admins, enabled apps by name, their pins, hidden
 * entries and folded sections) and the context-menu and drag actions that change it. Rail, bar, dock and the phone's
 * More sheet all render this.
 */
function useNavActions() {
  const { adminView } = useAdminView()
  const programs = useHive((s) => s.programs)
  const look = useLook()
  const [prefs, update] = useNavPrefs()
  // a member is never shown an admin-only entry; until the hive says an admin is signed in, the member's view (adminViewOf)
  const source = look.current?.apps ?? 'owner'
  const model: NavModel = useMemo(
    () => navModel({ admin: adminView, apps: programs, accentOf: (id) => { const p = programs?.find((x) => x.id === id); return (p && appTheme(p, source)?.accent) || DESIGNED_APPS[id]?.theme.accent } }, prefs),
    [adminView, programs, prefs, source],
  )
  const [menu, setMenu] = useState<{ it: NavItem; x: number; y: number } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState<Record<string, boolean>>({})
  // the touch long-press: off past a 10px drift, on lifting, leaving or cancelling, and when anything scrolls (longPress.ts)
  const [press] = useState(() => longPress())
  const pressed = useRef(false)
  const lastPointer = useRef('')
  useEffect(() => {
    const off = () => press.cancel()
    window.addEventListener('scroll', off, { capture: true, passive: true })
    return () => {
      window.removeEventListener('scroll', off, { capture: true })
      press.cancel()
    }
  }, [press])
  // drag to reorder only with a fine pointer (live): on touch screens an HTML5 drag would take the long-press's pointer
  const fine = usePointerFine()

  const actionsFor = (it: NavItem): NavMenuAction[] =>
    navMenu(it, prefs, model, adminView).map((e) => ({
      id: e.id,
      label: e.label,
      section: e.section,
      run: () => {
        if (e.id === 'pin' || e.id === 'unpin') update((p) => togglePin(p, it.key))
        else if (e.id === 'up' || e.id === 'down') update((p) => movePinned(p, it.key, e.id === 'up' ? -1 : 1))
        else if (e.id === 'hide' || e.id === 'show') update((p) => toggleHidden(p, it.key))
        else if (e.id === 'tab') window.open(`${window.location.pathname}${window.location.search}${href(it.route)}`, '_blank', 'noopener')
        else if (e.id === 'app-settings') goTo({ name: 'programs' }, `[data-tour="program-card-${CSS.escape(it.app!.id)}"]`)
        else if (e.id === 'app-activity') goTo({ name: 'programs' }, '#app-activity-h')
        else if (e.place) goTo(e.place.route, e.place.reveal)
      },
    }))

  /** Props that give an entry its menu: right-click, long-press on touch, Shift+F10 or the context-menu key. */
  const menuProps = (it: NavItem) => {
    const openAt = (el: Element, x?: number, y?: number) => {
      const r = el.getBoundingClientRect()
      setMenu({ it, x: x ?? r.right - 8, y: y ?? r.top + r.height / 2 })
    }
    return {
      onContextMenu: (e: MouseEvent<HTMLElement>) => {
        e.preventDefault()
        press.cancel()
        openAt(e.currentTarget, e.clientX || undefined, e.clientY || undefined)
      },
      onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
        if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
          e.preventDefault()
          e.stopPropagation()
          openAt(e.currentTarget)
        }
      },
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        pressed.current = false
        lastPointer.current = e.pointerType
        if (e.pointerType !== 'touch') return
        const el = e.currentTarget
        const { clientX, clientY } = e
        press.down(clientX, clientY, () => {
          pressed.current = true
          openAt(el, clientX, clientY)
        })
      },
      onPointerMove: (e: PointerEvent<HTMLElement>) => press.move(e.clientX, e.clientY),
      onPointerUp: () => press.cancel(),
      onPointerCancel: () => press.cancel(),
      onPointerLeave: () => press.cancel(),
      // a long-press opened the menu: the finger lifting is not also a tap that leaves the page
      onClickCapture: (e: MouseEvent<HTMLElement>) => {
        if (!pressed.current) return
        pressed.current = false
        e.preventDefault()
        e.stopPropagation()
      },
      'aria-haspopup': 'menu' as const,
    }
  }

  /**
   * Drag any entry into Pinned, or along it to reorder, with a fine pointer only (the menu's Move up/down does the same
   * by keyboard and touch). A drag a finger starts on a hybrid laptop is refused too: the long-press owns touch.
   */
  const dragProps = (it: NavItem) => ({
    draggable: fine,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      if (!fine || lastPointer.current === 'touch') {
        e.preventDefault()
        return
      }
      e.dataTransfer.setData('text/x-nav-key', it.key)
      e.dataTransfer.effectAllowed = 'move'
      // after the browser has taken its drag image: showing the Pinned drop zone now must not move the entry being dragged
      setTimeout(() => setDragging(it.key), 0)
    },
    onDragEnd: () => setDragging(null),
  })
  const dropProps = (before: string | null) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (e.dataTransfer.types.includes('text/x-nav-key')) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      }
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      const key = e.dataTransfer.getData('text/x-nav-key')
      if (!key) return
      e.preventDefault()
      e.stopPropagation()
      setDragging(null)
      if (key !== before) update((p) => dropPinned(p, key, before))
    },
  })

  const menuEl = menu ? <NavMenu key={menu.it.key} title={menu.it.label} at={{ x: menu.x, y: menu.y }} actions={actionsFor(menu.it)} onClose={() => setMenu(null)} /> : null
  const toggleSection = (s: NavModelSection, collapsed = !s.collapsed) => update((p) => setCollapsed(p, s.section.id, collapsed))
  const hiddenShown = (id: string) => !!showHidden[id]
  const toggleHiddenShown = (id: string) => setShowHidden((v) => ({ ...v, [id]: !v[id] }))
  return { model, menuProps, dragProps, dropProps, dragging, menuEl, toggleSection, hiddenShown, toggleHiddenShown }
}

/** Up/Down (and Home/End) move between entries and section headings; Left folds a section, Right opens it. */
function onListKeys(e: KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-nav-focus]')].filter((el) => el.offsetParent !== null)
  const i = all.indexOf(document.activeElement as HTMLElement)
  if (i < 0) return
  e.preventDefault()
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : Math.min(all.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))
  all[next]?.focus()
}

const sectionBadge = (s: NavModelSection, badgeOf: (it: NavItem) => number) => s.items.reduce((n, it) => n + badgeOf(it), 0)

const ORB_STYLE = {
  background: 'radial-gradient(circle at 35% 30%, #ffffff, var(--look-orb-mid, #c8bcff) 40%, var(--look-orb-end, #8f7bff) 100%)',
  boxShadow: '0 0 0 1px rgb(255 255 255 / 0.3) inset, 0 10px 34px -6px var(--look-orb-glow, rgb(143 123 255 / 0.85))',
}

function CreateButton({ big, wide }: { big?: boolean; wide?: boolean }) {
  const route = useRoute()
  const on = route.name === 'new'
  if (wide) {
    return (
      <button
        onClick={() => navigate({ name: 'new' })}
        data-tour="nav-create"
        aria-label="Create a new mind"
        title="New mind (N)"
        className={cx('flex h-11 w-full items-center gap-3 rounded-xl px-1.5 text-left text-[14px] font-semibold text-ink transition-colors hover:bg-white/[0.06]', on && 'bg-white/[0.08]')}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] text-[var(--look-orb-ink,#0d0a24)]" style={ORB_STYLE}>
          <Icon name="plus" size={18} strokeWidth={2.2} />
        </span>
        <span className="flex-1">New mind</span>
        <Kbd>N</Kbd>
      </button>
    )
  }
  return (
    <button
      onClick={() => navigate({ name: 'new' })}
      data-tour="nav-create"
      aria-label="Create a new mind"
      title="New mind (N)"
      className={cx(
        'group relative flex shrink-0 items-center justify-center rounded-2xl text-[var(--look-orb-ink,#0d0a24)] transition-transform active:scale-95',
        big ? 'size-[52px] -translate-y-1.5' : 'size-11',
        on && 'ring-2 ring-white/40',
      )}
      style={ORB_STYLE}
    >
      <Icon name="plus" size={big ? 24 : 20} strokeWidth={2.2} />
    </button>
  )
}

/** Search stays at the top of the navigation, on pages too (the HUD's "Jump to…" hides there). */
function SearchButton({ wide }: { wide: boolean }) {
  const setPalette = useHive((s) => s.setPalette)
  return (
    <button
      onClick={() => setPalette(true)}
      data-tour="nav-search"
      aria-label="Search and commands"
      aria-keyshortcuts="Meta+K Control+K /"
      title="Search and commands (⌘K)"
      className={cx(
        'flex shrink-0 items-center rounded-xl text-ink-2 transition-colors hover:bg-white/[0.06] hover:text-ink pointer-coarse:min-h-11',
        wide ? 'h-9 w-full gap-3 border border-line bg-white/[0.03] px-2.5 text-left text-[13.5px]' : 'size-10 justify-center pointer-coarse:size-11',
      )}
    >
      <Icon name="search" size={wide ? 17 : 19} className="shrink-0" />
      {wide && (
        <>
          <span className="flex-1">Search</span>
          <span className="flex gap-0.5">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </>
      )}
    </button>
  )
}

export function Nav() {
  useHeldCallsWatch()
  const desktop = useIsDesktop()
  const { layout } = useLook()
  const expanded = useRailExpanded()
  // pages, the ticker and the camera controls make room for whichever navigation is showing
  useEffect(() => {
    const root = document.documentElement
    const vars = ['--rail-x', '--page-top', '--page-bottom', '--hud-bottom']
    if (desktop) {
      const g = geometry(layout, expanded)
      root.style.setProperty('--rail-x', `${g.railX}px`)
      root.style.setProperty('--page-top', `${g.pageTop}px`)
      root.style.setProperty('--page-bottom', `${g.pageBottom}px`)
      root.style.setProperty('--hud-bottom', `${g.hudBottom}px`)
    }
    return () => vars.forEach((v) => root.style.removeProperty(v))
  }, [desktop, layout, expanded])
  if (!desktop) return <PhoneBar />
  return layout === 'rail' ? <Rail /> : <BarNav layout={layout} />
}

// ---------------------------------------------------------------- desktop rail

interface Tip {
  it: NavItem
  y: number
  x: number
}

function Rail() {
  const route = useRoute()
  const badgeOf = useBadges()
  const expanded = useRailExpanded()
  const nav = useNavActions()
  const [tip, setTip] = useState<Tip | null>(null)
  const onPage = isPageRoute(route.name)

  const show = (it: NavItem) => (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    setTip({ it, y: r.top + r.height / 2, x: r.right + 12 })
  }
  const hide = () => setTip(null)
  const top = onPage ? 12 : 88

  const button = (it: NavItem, opts: { pinned?: boolean; dim?: boolean } = {}) => (
    <RailButton
      key={it.key}
      it={it}
      expanded={expanded}
      active={isActive(it, route)}
      badge={badgeOf(it)}
      dim={opts.dim}
      extra={it.key === 'lab' ? <LabDot inline={expanded} /> : null}
      onShow={show(it)}
      onHide={hide}
      more={{ ...nav.menuProps(it), ...nav.dragProps(it), ...(opts.pinned ? nav.dropProps(it.key) : {}) }}
    />
  )
  const showPinned = nav.model.pinned.length > 0 || nav.dragging !== null

  return (
    <>
      <nav
        aria-label="Main"
        className={cx('glass fixed left-4 z-20 flex flex-col rounded-2xl p-1.5', expanded ? 'w-[204px]' : 'w-14 pointer-coarse:w-[60px]')}
        style={{ top, maxHeight: `calc(100dvh - ${top + 16}px)`, transition: 'top 200ms' }}
      >
        <div className={cx('flex shrink-0 flex-col gap-1 pb-1', !expanded && 'items-center')}>
          <CreateButton wide={expanded} />
          <SearchButton wide={expanded} />
        </div>
        <div className={cx('thin-scroll flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain', !expanded && 'items-center')} onScroll={hide} onKeyDown={onListKeys}>
          {showPinned && (
            <div role="group" aria-label="Pinned" data-nav-section="pinned" className={cx('flex flex-col gap-0.5 rounded-xl', !expanded && 'items-center', nav.dragging && 'outline-1 outline-dashed outline-line-2')} {...nav.dropProps(null)}>
              {expanded ? (
                <div className="rail-group px-2.5 pt-2 pb-1 text-[11.5px] font-medium text-ink-3" aria-hidden="true">
                  Pinned
                </div>
              ) : (
                <div className="my-1 text-[9.5px] font-semibold tracking-wide text-ink-3 uppercase" aria-hidden="true">Pin</div>
              )}
              {nav.model.pinned.map((it) => button(it, { pinned: true }))}
              {nav.model.pinned.length === 0 && <div className={cx('rounded-lg px-2.5 py-2 text-[12px] text-ink-3', !expanded && 'sr-only')}>Drop here to pin</div>}
            </div>
          )}
          {nav.model.sections.map((s, si) => {
            const id = `rail-sec-${s.section.id}`
            const fixed = !!s.section.fixed
            const activeInside = s.collapsed ? s.items.find((it) => isActive(it, route)) : undefined
            const reveal = nav.hiddenShown(s.section.id)
            return (
              <div key={s.section.id} role="group" aria-label={s.section.label} data-nav-section={s.section.id} className={cx('flex flex-col gap-0.5', !expanded && 'items-center')}>
                {fixed ? (
                  !expanded && (si > 0 || showPinned) && <div className="my-1.5 h-px w-7 shrink-0 bg-line" aria-hidden="true" />
                ) : (
                  <SectionHeader s={s} expanded={expanded} controls={id} badge={sectionBadge(s, badgeOf)} onToggle={() => nav.toggleSection(s)} onFold={(v) => nav.toggleSection(s, v)} />
                )}
                {!s.collapsed ? (
                  <div id={id} className={cx('flex flex-col gap-0.5', !expanded && 'items-center')}>
                    {s.items.map((it) => button(it))}
                    {s.moreApps > 0 && expanded && <div className="px-2.5 text-[11.5px] text-ink-3">{s.moreApps} more in All apps</div>}
                    {reveal && s.hidden.map((it) => button(it, { dim: true }))}
                    {s.hidden.length > 0 && (
                      <HiddenToggle n={s.hidden.length} open={reveal} expanded={expanded} label={s.section.label} onClick={() => nav.toggleHiddenShown(s.section.id)} />
                    )}
                  </div>
                ) : (
                  activeInside && button(activeInside)
                )}
              </div>
            )
          })}
        </div>
        <div className={cx('mt-1 flex shrink-0 border-t border-line pt-1.5', expanded ? 'items-center gap-1' : 'flex-col items-center gap-1')}>
          <ProfileButton expanded={expanded} active={isActive(ME_ITEM, route)} onShow={show(ME_ITEM)} onHide={hide} />
          <button
            onClick={() => {
              hide()
              setRailPref(expanded ? 'closed' : 'open')
            }}
            aria-label={expanded ? 'Hide menu labels' : 'Show menu labels'}
            aria-pressed={expanded}
            title={expanded ? 'Hide labels' : 'Show labels'}
            className="flex size-9 shrink-0 items-center justify-center rounded-xl text-ink-3 transition-colors hover:bg-white/[0.06] hover:text-ink pointer-coarse:size-11"
          >
            <Icon name={expanded ? 'panelClose' : 'panelOpen'} size={18} />
          </button>
        </div>
      </nav>
      {nav.menuEl}
      <AnimatePresence>
        {tip && !nav.menuEl && (
          <m.div
            key={tip.it.key}
            role="tooltip"
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.08 } }}
            transition={{ duration: 0.12 }}
            className="glass-strong pointer-events-none fixed z-[60] max-w-[280px] rounded-xl px-3 py-2"
            style={{ left: tip.x, top: tip.y, y: '-50%' }}
          >
            <TipBody it={tip.it} />
          </m.div>
        )}
      </AnimatePresence>
    </>
  )
}

function TipBody({ it }: { it: NavItem }) {
  return (
    <>
      <div className="flex items-center gap-2 text-[13px] font-medium whitespace-nowrap text-ink">
        {it.label}
        {it.keys && (
          <span className="flex gap-0.5">
            {it.keys.map((k, i) => (
              <Kbd key={i}>{k}</Kbd>
            ))}
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[12px] leading-snug text-ink-3">{it.blurb}</div>
      <div className="mt-1 text-[11px] text-ink-3">Right-click for pin, hide and more</div>
    </>
  )
}

/** A section's heading: folds and opens it. Folded, it carries the section's badges so nothing waiting is hidden. */
function SectionHeader({ s, expanded, controls, badge, onToggle, onFold }: { s: NavModelSection; expanded: boolean; controls: string; badge: number; onToggle: () => void; onFold: (collapsed: boolean) => void }) {
  const keys = (e: KeyboardEvent<HTMLButtonElement>) => {
    const fold = e.key === 'ArrowLeft' && !s.collapsed ? true : e.key === 'ArrowRight' && s.collapsed ? false : null
    if (fold === null) return
    e.preventDefault()
    onFold(fold)
  }
  const label = `${s.section.label}${badge && s.collapsed ? `, ${badge} waiting` : ''}`
  if (!expanded) {
    // icon rail: a folded section is its icon (open it), an open one a slim divider (fold it)
    return s.collapsed ? (
      <button data-nav-focus="" onClick={onToggle} onKeyDown={keys} aria-expanded={false} aria-controls={controls} aria-label={label} title={`${s.section.label} (open)`} className="relative mt-1.5 flex size-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-line text-ink-3 hover:bg-white/[0.06] hover:text-ink pointer-coarse:size-11">
        <Icon name={s.section.icon} size={18} />
        <CountBadge n={badge} className="absolute -top-0.5 -right-0.5" />
      </button>
    ) : (
      <button data-nav-focus="" onClick={onToggle} onKeyDown={keys} aria-expanded={true} aria-controls={controls} aria-label={s.section.label} title={`${s.section.label} (fold)`} className="group my-0.5 flex h-4 w-10 shrink-0 items-center justify-center rounded-md hover:bg-white/[0.06] pointer-coarse:h-11 pointer-coarse:w-11">
        <span className="h-px w-7 bg-line group-hover:bg-line-2" aria-hidden="true" />
      </button>
    )
  }
  return (
    <button
      data-nav-focus=""
      onClick={onToggle}
      onKeyDown={keys}
      aria-expanded={!s.collapsed}
      aria-controls={controls}
      aria-label={label}
      className="rail-group mt-1 flex h-7 w-full shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-left text-[11.5px] font-medium text-ink-3 transition-colors hover:bg-white/[0.04] hover:text-ink-2 pointer-coarse:min-h-11"
    >
      <span className="flex-1">{s.section.label}</span>
      {s.collapsed && <CountBadge n={badge} className="relative" />}
      <Icon name="chevronDown" size={13} className={cx('shrink-0 transition-transform', s.collapsed && '-rotate-90')} />
    </button>
  )
}

function HiddenToggle({ n, open, expanded, label, onClick }: { n: number; open: boolean; expanded: boolean; label: string; onClick: () => void }) {
  return (
    <button
      data-nav-focus=""
      onClick={onClick}
      aria-pressed={open}
      aria-label={`${open ? 'Hide' : 'Show'} ${n} hidden in ${label}`}
      title={`${open ? 'Hide' : 'Show'} hidden (${n})`}
      className={cx('shrink-0 rounded-lg text-[11.5px] text-ink-3 hover:bg-white/[0.04] hover:text-ink-2 pointer-coarse:min-h-11', expanded ? 'h-7 w-full px-2.5 text-left' : 'h-6 w-10')}
    >
      {expanded ? `${open ? 'Hide' : 'Show'} hidden (${n})` : `+${n}`}
    </button>
  )
}

// ---------------------------------------------------------------- top bar and dock (desktop layouts from a UI variant)

/** The same navigation as one horizontal bar: across the top under the HUD, or as a floating dock at the bottom. */
function BarNav({ layout }: { layout: Exclude<Layout, 'rail'> }) {
  const route = useRoute()
  const badgeOf = useBadges()
  const nav = useNavActions()
  const [tip, setTip] = useState<{ it: NavItem; x: number; y: number } | null>(null)
  const top = layout === 'topbar'
  const onPage = isPageRoute(route.name)
  const show = (it: NavItem) => (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    setTip({ it, x: r.left + r.width / 2, y: top ? r.bottom + 10 : r.top - 10 })
  }
  const hide = () => setTip(null)
  const height = top ? BAR.height : BAR.dock
  const place = top ? { top: onPage ? BAR.margin : BAR.hudTop, transition: 'top 200ms' } : { bottom: BAR.margin }
  const groups = [...(nav.model.pinned.length ? [{ id: 'pinned', label: 'Pinned', items: nav.model.pinned }] : []), ...nav.model.sections.map((s) => ({ id: s.section.id, label: s.section.label, items: s.items }))]

  return (
    <>
      <nav
        aria-label="Main"
        data-layout={layout}
        className={cx('glass fixed left-1/2 z-20 flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-1 px-1.5', top ? 'rounded-2xl' : 'rounded-3xl')}
        style={{ height, ...place }}
      >
        <CreateButton />
        <SearchButton wide={false} />
        <div className="thin-scroll flex min-w-0 items-center gap-0.5 overflow-x-auto overscroll-contain" onScroll={hide}>
          {groups.map((g, gi) => (
            <div key={g.id} role="group" aria-label={g.label} className="flex shrink-0 items-center gap-0.5">
              {gi > 0 && <div className="mx-1 h-6 w-px shrink-0 bg-line" aria-hidden="true" />}
              {g.items.map((it) => (
                <BarButton
                  key={it.key}
                  it={it}
                  dock={!top}
                  active={isActive(it, route)}
                  badge={badgeOf(it)}
                  extra={it.key === 'lab' ? <LabDot /> : null}
                  onShow={show(it)}
                  onHide={hide}
                  more={nav.menuProps(it)}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="mx-1 h-6 w-px shrink-0 bg-line" aria-hidden="true" />
        <ProfileButton expanded={false} active={isActive(ME_ITEM, route)} onShow={show(ME_ITEM)} onHide={hide} />
      </nav>
      {nav.menuEl}
      <AnimatePresence>
        {tip && !nav.menuEl && (
          <m.div
            key={tip.it.key}
            role="tooltip"
            initial={{ opacity: 0, y: top ? -4 : 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.08 } }}
            transition={{ duration: 0.12 }}
            className="glass-strong pointer-events-none fixed z-[60] max-w-[280px] rounded-xl px-3 py-2"
            style={top ? { left: tip.x, top: tip.y, x: '-50%' } : { left: tip.x, bottom: window.innerHeight - tip.y, x: '-50%' }}
          >
            <TipBody it={tip.it} />
          </m.div>
        )}
      </AnimatePresence>
    </>
  )
}

/** The icon of an entry: an app shows its own icon in its identity colour. */
function ItemIcon({ it, size, className }: { it: NavItem; size: number; className?: string }) {
  return <Icon name={it.icon} size={size} className={className} style={it.app?.accent ? { color: it.app.accent } : undefined} />
}

type MoreProps = Record<string, unknown>

function BarButton({ it, dock, active, badge = 0, extra, onShow, onHide, more }: { it: NavItem; dock: boolean; active: boolean; badge?: number; extra?: ReactNode; onShow: (el: HTMLElement) => void; onHide: () => void; more: MoreProps }) {
  const reduced = useReducedMotion()
  return (
    <button
      {...more}
      onClick={() => {
        onHide()
        navigate(it.route)
      }}
      onMouseEnter={(e) => onShow(e.currentTarget)}
      onMouseLeave={onHide}
      onFocus={(e) => onShow(e.currentTarget)}
      onBlur={onHide}
      data-tour={`nav-${it.key}`}
      data-nav-key={it.key}
      data-nav-href={href(it.route)}
      data-presence-feature={it.feature}
      aria-label={badge ? `${it.label}, ${badge} waiting` : it.label}
      aria-keyshortcuts={it.keys ? `${it.keys[0]} ${it.keys[1]}` : undefined}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'relative flex shrink-0 items-center justify-center rounded-xl transition-[color,background-color,transform] duration-150',
        dock ? 'size-11' : 'size-10 pointer-coarse:size-11',
        dock && !reduced && 'hover:-translate-y-1 hover:scale-110',
        active ? 'text-ink' : 'text-ink-3 hover:bg-white/[0.06] hover:text-ink',
      )}
    >
      {active && (
        <m.span
          layoutId={reduced ? undefined : 'bar-active'}
          className="absolute inset-0 rounded-xl border border-line-2 bg-white/[0.08]"
          transition={{ type: 'spring', stiffness: 500, damping: 36 }}
        />
      )}
      <ItemIcon it={it} size={dock ? 22 : 20} className="relative shrink-0" />
      <CountBadge n={badge} className="absolute -top-0.5 -right-0.5" />
      {extra}
      {dock && active && <span className="absolute -bottom-1 size-1 rounded-full bg-accent" aria-hidden="true" />}
    </button>
  )
}

function RailButton({
  it,
  expanded,
  active,
  badge = 0,
  dim,
  extra,
  onShow,
  onHide,
  more,
}: {
  it: NavItem
  expanded: boolean
  active: boolean
  badge?: number
  dim?: boolean
  extra?: ReactNode
  onShow: (el: HTMLElement) => void
  onHide: () => void
  more: MoreProps
}) {
  const reduced = useReducedMotion()
  return (
    <button
      {...more}
      onClick={() => {
        onHide()
        navigate(it.route)
      }}
      onMouseEnter={(e) => onShow(e.currentTarget)}
      onMouseLeave={onHide}
      onFocus={(e) => onShow(e.currentTarget)}
      onBlur={onHide}
      data-nav-focus=""
      data-tour={`nav-${it.key}`}
      data-nav-key={it.key}
      data-nav-href={href(it.route)}
      data-presence-feature={it.feature}
      aria-label={`${it.label}${badge ? `, ${badge} waiting` : ''}${dim ? ' (hidden)' : ''}`}
      aria-keyshortcuts={it.keys ? `${it.keys[0]} ${it.keys[1]}` : undefined}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'relative flex shrink-0 items-center rounded-xl transition-colors',
        expanded ? 'rail-item h-9 w-full gap-3 px-2.5 text-left text-[13.5px] pointer-coarse:min-h-11' : 'size-10 justify-center pointer-coarse:size-11',
        active ? 'text-ink' : 'text-ink-2 hover:bg-white/[0.06] hover:text-ink',
        dim && 'opacity-60',
      )}
    >
      {active && (
        <m.span
          layoutId={reduced ? undefined : 'rail-active'}
          className="absolute inset-0 rounded-xl border border-line-2 bg-white/[0.08]"
          transition={{ type: 'spring', stiffness: 500, damping: 36 }}
        />
      )}
      <ItemIcon it={it} size={expanded ? 18 : 20} className="relative shrink-0" />
      {expanded ? (
        <>
          <span className="relative min-w-0 flex-1 truncate">{it.label}</span>
          {extra}
          <CountBadge n={badge} className="relative" />
        </>
      ) : (
        <>
          <CountBadge n={badge} className="absolute -top-0.5 -right-0.5" />
          {extra}
        </>
      )}
    </button>
  )
}

function ProfileButton({ expanded, active, onShow, onHide }: { expanded: boolean; active: boolean; onShow: (el: HTMLElement) => void; onHide: () => void }) {
  return (
    <button
      onClick={() => {
        onHide()
        navigate(ME_ITEM.route)
      }}
      onMouseEnter={(e) => onShow(e.currentTarget)}
      onMouseLeave={onHide}
      onFocus={(e) => onShow(e.currentTarget)}
      onBlur={onHide}
      data-tour="nav-me"
      data-nav-key={ME_ITEM.key}
      data-nav-href={href(ME_ITEM.route)}
      data-presence-feature={ME_ITEM.feature}
      aria-label={ME_ITEM.label}
      aria-keyshortcuts="G K"
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex shrink-0 items-center rounded-xl transition-colors',
        expanded ? 'h-10 min-w-0 flex-1 gap-2.5 px-1.5 text-left text-[13px] pointer-coarse:min-h-11' : 'size-10 justify-center pointer-coarse:size-11',
        active ? 'bg-white/[0.08] text-ink' : 'text-ink-2 hover:bg-white/[0.06] hover:text-ink',
      )}
    >
      <span className={cx('flex size-7 shrink-0 items-center justify-center rounded-full border bg-white/[0.04]', active ? 'border-line-2' : 'border-line')}>
        <Icon name="user" size={15} />
      </span>
      {expanded && <span className="min-w-0 flex-1 truncate">{ME_ITEM.label}</span>}
    </button>
  )
}

/** The Lab's last-run state as a tiny status light on its nav entry. */
function LabDot({ inline }: { inline?: boolean }) {
  const suites = useHive((s) => s.labSuites)
  const health = labHealth(suites)
  if (health.state === 'unknown') return null
  const color = health.state === 'failing' ? '#fb7185' : health.state === 'running' ? '#7dd3fc' : '#4ade80'
  const label = health.state === 'failing' ? 'Lab: failing' : health.state === 'running' ? 'Lab: running' : 'Lab: passing'
  return (
    <span
      className={cx('pointer-events-none size-2 shrink-0 rounded-full', inline ? 'relative' : 'absolute top-1.5 right-1.5', health.state === 'running' && 'animate-pulse')}
      style={{ background: color, boxShadow: `0 0 0 2px rgb(8 8 28), 0 0 8px ${color}` }}
      title={label}
      aria-hidden="true"
    />
  )
}

// ---------------------------------------------------------------- phone bar and its More sheet

function PhoneBar() {
  const route = useRoute()
  const badgeOf = useBadges()
  const [more, setMore] = useState(false)
  // long-press a tab for its menu too (pin, new tab, its places: Decision history, Archived swarms…)
  const nav = useNavActions()
  const onBar: string[] = [...PHONE_TABS.before, ...PHONE_TABS.after]
  const inMore = route.name !== 'new' && !onBar.some((k) => isActive(navItem(k), route))

  return (
    <>
      <nav
        aria-label="Main"
        // above a classic page (z-25), under its sheets (z-30): More is one tap away from any page; the Ask sits above it (features/ask/placement)
        className={cx('glass-strong fixed inset-x-0 bottom-0 flex items-end justify-around rounded-t-[22px] px-1 pt-1.5', isPageRoute(route.name) ? 'z-[29]' : 'z-20')}
        // the OS clock sits at the bar's right end (shell/osClock.css --os-clock-room)
        style={{ paddingBottom: 'calc(var(--sab) + 6px)', paddingRight: 'max(4px, var(--os-clock-room, 0px))' }}
      >
        {PHONE_TABS.before.map((k) => {
          const it = navItem(k)
          return <TabButton key={k} it={it} active={isActive(it, route)} more={nav.menuProps(it)} />
        })}
        <CreateButton big />
        {PHONE_TABS.after.map((k) => {
          const it = navItem(k)
          return <TabButton key={k} it={it} active={isActive(it, route)} badge={badgeOf(it)} more={nav.menuProps(it)} />
        })}
        <button
          onClick={() => setMore(true)}
          data-tour="nav-more"
          aria-haspopup="dialog"
          aria-expanded={more}
          aria-label="More pages"
          className={cx('relative flex min-h-12 min-w-11 min-[376px]:min-w-12 flex-col items-center justify-center gap-0.5 transition-colors', inMore || more ? 'text-ink' : 'text-ink-3')}
        >
          {inMore && <m.span layoutId="tab-glow" className="absolute -top-1.5 h-0.5 w-6 rounded-full bg-accent" style={{ boxShadow: '0 0 12px var(--color-accent)' }} />}
          <Icon name="grid" size={21} />
          <span className="text-[10.5px] font-medium">More</span>
        </button>
      </nav>
      <AnimatePresence>{more && <MoreSheet key="more" onClose={() => setMore(false)} />}</AnimatePresence>
      {nav.menuEl}
    </>
  )
}

function TabButton({ it, active, badge = 0, more = {} }: { it: NavItem; active: boolean; badge?: number; more?: MoreProps }) {
  return (
    <button
      {...more}
      onClick={() => navigate(it.route)}
      data-tour={`nav-${it.key}`}
      data-nav-key={it.key}
      data-nav-href={href(it.route)}
      data-presence-feature={it.feature}
      aria-current={active ? 'page' : undefined}
      aria-label={badge ? `${it.label}, ${badge} waiting` : undefined}
      className={cx('relative flex min-h-12 min-w-11 min-[376px]:min-w-12 flex-col items-center justify-center gap-0.5 transition-colors [-webkit-touch-callout:none] select-none', active ? 'text-ink' : 'text-ink-3')}
    >
      {active && <m.span layoutId="tab-glow" className="absolute -top-1.5 h-0.5 w-6 rounded-full bg-accent" style={{ boxShadow: '0 0 12px var(--color-accent)' }} />}
      <span className="relative">
        <Icon name={it.icon} size={21} />
        <CountBadge n={badge} className="absolute -top-1.5 -right-2.5" />
      </span>
      <span className="text-[10.5px] font-medium">{it.label}</span>
    </button>
  )
}

/**
 * Every destination not on the phone bar, from the same model as the desktop rail: Pinned first, then the sections
 * (foldable), the person's hidden entries under "Show hidden", and their profile. Long-press an entry for its menu.
 */
export function MoreSheet({ onClose }: { onClose: () => void }) {
  const route = useRoute()
  const badgeOf = useBadges()
  const reduced = useReducedMotion()
  const setPalette = useHive((s) => s.setPalette)
  const nav = useNavActions()
  const ref = useRef<HTMLDivElement>(null)
  const scrim = useRef<HTMLDivElement>(null)
  useEscape(onClose, !nav.menuEl)
  // the scrim is this layer's sibling: it stays live so a tap on it still closes the sheet
  useModalContainment(ref, { also: [scrim] })
  // the hive's first-visit hint waits while the sheet is open (it belongs to the hive view, not to the menu)
  useOverlay(ref)
  useEffect(() => {
    const t = setTimeout(() => ref.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true }), 60)
    return () => clearTimeout(t)
  }, [])
  const onBar: string[] = [...PHONE_TABS.before, ...PHONE_TABS.after]
  const go = (r: Route) => {
    onClose()
    navigate(r)
  }
  const row = (it: NavItem, dim?: boolean) => <SheetRow key={it.key} it={it} active={isActive(it, route)} badge={badgeOf(it)} dim={dim} onClick={() => go(it.route)} more={nav.menuProps(it)} />

  return (
    <div className="xc-dress contents">
      <m.div ref={scrim} className="fixed inset-0 z-40 bg-black/50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} aria-hidden="true" />
      <m.div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="More pages"
        initial={{ y: reduced ? 0 : '100%', opacity: reduced ? 0 : 1 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: reduced ? 0 : '100%', opacity: reduced ? 0 : 1, transition: { duration: 0.2 } }}
        transition={{ type: 'spring', stiffness: 420, damping: 40 }}
        className="xc-frame xc-flush-b glass-strong fixed inset-x-0 bottom-0 z-[41] flex max-h-[85dvh] flex-col rounded-t-[26px] !bg-[#0b0b22]/[0.97]"
        // the list ends above the universal Ask (always on screen, never covering): its room is kept clear here
        style={{ paddingBottom: `calc(${ASK_RESERVE} + 8px)` }}
      >
        <div className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-1">
          <h2 className="flex-1 font-display text-[18px] font-semibold tracking-tight">More</h2>
          <button
            onClick={() => {
              onClose()
              setPalette(true)
            }}
            className="flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-[13px] text-ink-2 hover:bg-white/[0.06]"
          >
            <Icon name="search" size={16} /> Search
          </button>
          <button onClick={onClose} className="flex size-11 items-center justify-center rounded-xl text-ink-3 hover:bg-white/[0.06] hover:text-ink" aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2" onKeyDown={onListKeys}>
          {nav.model.pinned.length > 0 && (
            <section aria-label="Pinned" data-nav-section="pinned" className="mt-2">
              <h3 className="px-3 pt-1 pb-1 text-[12px] font-medium text-ink-3">Pinned</h3>
              {nav.model.pinned.map((it) => row(it))}
            </section>
          )}
          {nav.model.sections.map((s) => {
            const items = s.items.filter((it) => !onBar.includes(it.key))
            if (!items.length && !s.hidden.length) return null
            const id = `more-sec-${s.section.id}`
            const reveal = nav.hiddenShown(s.section.id)
            const badge = sectionBadge({ ...s, items }, badgeOf)
            return (
              <section key={s.section.id} aria-label={s.section.label} data-nav-section={s.section.id} className="mt-2">
                {s.section.fixed ? (
                  <h3 className="px-3 pt-1 pb-1 text-[12px] font-medium text-ink-3">{s.section.label}</h3>
                ) : (
                  <button
                    data-nav-focus=""
                    onClick={() => nav.toggleSection(s)}
                    aria-expanded={!s.collapsed}
                    aria-controls={id}
                    className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-[12.5px] font-medium text-ink-3 hover:bg-white/[0.04]"
                  >
                    <span className="flex-1">{s.section.label}</span>
                    {s.collapsed && <CountBadge n={badge} />}
                    <Icon name="chevronDown" size={14} className={cx('transition-transform', s.collapsed && '-rotate-90')} />
                  </button>
                )}
                {!s.collapsed && (
                  <div id={id}>
                    {items.map((it) => row(it))}
                    {s.moreApps > 0 && <p className="px-3 pb-1 text-[12px] text-ink-3">{s.moreApps} more in All apps</p>}
                    {reveal && s.hidden.map((it) => row(it, true))}
                    {s.hidden.length > 0 && (
                      <button data-nav-focus="" onClick={() => nav.toggleHiddenShown(s.section.id)} aria-pressed={reveal} className="flex min-h-11 w-full items-center rounded-xl px-3 text-left text-[12.5px] text-ink-3 hover:bg-white/[0.04]">
                        {reveal ? 'Hide' : 'Show'} hidden ({s.hidden.length})
                      </button>
                    )}
                  </div>
                )}
              </section>
            )
          })}
          <div className="mx-3 my-2 h-px bg-line" />
          <SheetRow it={ME_ITEM} active={isActive(ME_ITEM, route)} onClick={() => go(ME_ITEM.route)} />
        </div>
      </m.div>
      {nav.menuEl}
    </div>
  )
}

function SheetRow({ it, active, badge = 0, dim, onClick, more = {} }: { it: NavItem; active: boolean; badge?: number; dim?: boolean; onClick: () => void; more?: MoreProps }) {
  return (
    <button
      {...more}
      onClick={onClick}
      data-nav-focus=""
      data-tour={`more-${it.key}`}
      data-nav-key={it.key}
      data-nav-href={href(it.route)}
      data-presence-feature={it.feature}
      aria-current={active ? 'page' : undefined}
      aria-label={`${it.label}${badge ? `, ${badge} waiting` : ''}${dim ? ' (hidden)' : ''}`}
      className={cx('flex min-h-14 w-full items-center gap-3 rounded-2xl px-3 text-left transition-colors [-webkit-touch-callout:none]', active ? 'bg-white/[0.08]' : 'hover:bg-white/[0.05] active:bg-white/[0.07]', dim && 'opacity-60')}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-line bg-white/[0.03] text-ink-2">
        <ItemIcon it={it} size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14.5px] font-medium text-ink">{it.label}</span>
        <span className="block text-[12.5px] leading-snug text-ink-3">{it.blurb}</span>
      </span>
      <CountBadge n={badge} />
      {it.key === 'lab' && <LabDot inline />}
    </button>
  )
}
