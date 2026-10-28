import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useEscape } from '../lib/hooks'
import { useModalContainment } from '../ui/useModalContainment'
import { useOverlay } from '../ui/overlays'
import { isMenuChoice } from './longPress'

export interface NavMenuAction {
  id: string
  label: string
  run: () => void
  /** A small heading shown above the first action of a run that shares it ("Go to"). */
  section?: string
}

/**
 * The small menu a navigation entry opens on right-click, long-press, Shift+F10 or the context-menu key. It wears the
 * host chrome (xc-menu, xc-item), keeps focus inside while open (useModalContainment), closes on Escape, a click
 * outside or Tab, and returns focus to the entry it came from.
 */
export function NavMenu({ title, at, actions, onClose }: { title: string; at: { x: number; y: number }; actions: NavMenuAction[]; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null)
  const scrim = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState(at)
  // a pointer click counts only after a pointer went down inside the menu: the long-pressing finger lifting over it is
  // not a choice, however late its click lands, and a real tap is never swallowed (longPress.ts isMenuChoice)
  const pressedInside = useRef(false)
  useEscape(onClose)
  useModalContainment(menu, { also: [scrim] })
  useOverlay(menu)
  // keep the whole menu on screen
  useLayoutEffect(() => {
    const r = menu.current?.getBoundingClientRect()
    if (!r) return
    setPlace({ x: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)) })
  }, [at.x, at.y])
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus({ preventScroll: true })
  }, [])
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      onClose()
    }
  }
  return (
    <>
      <div ref={scrim} className="fixed inset-0 z-[88]" onMouseDown={onClose} onContextMenu={(e) => (e.preventDefault(), onClose())} aria-hidden="true" />
      <div
        ref={menu}
        role="menu"
        aria-label={`${title}: options`}
        data-nav-menu=""
        onKeyDown={onKey}
        onPointerDown={() => (pressedInside.current = true)}
        className="xc-menu fixed z-[89] flex w-max max-w-[min(300px,calc(100vw-16px))] min-w-[200px] flex-col py-1 text-[13px]"
        style={{ left: place.x, top: place.y }}
      >
        <div className="xc-ink-3 truncate px-3 pt-1.5 pb-1 text-[11px]" aria-hidden="true">
          {title}
        </div>
        {actions.map((a, i) => [
          a.section && a.section !== actions[i - 1]?.section && (
            <div key={`${a.id}-h`} role="presentation" className="xc-ink-3 xc-divider mt-1 border-t px-3 pt-2 pb-0.5 text-[11px]">
              {a.section}
            </div>
          ),
          <button
            key={a.id}
            role="menuitem"
            data-nav-action={a.id}
            className="xc-item mx-1 flex min-h-9 items-center px-2.5 py-2 text-left pointer-coarse:min-h-11"
            onClick={(e) => {
              if (!isMenuChoice(e.detail, pressedInside.current)) return
              onClose()
              a.run()
            }}
          >
            {a.label}
          </button>,
        ])}
      </div>
    </>
  )
}
