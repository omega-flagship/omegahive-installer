// Purpose: share the viewport between Classic's conversation and an open workbench drawer.
import { useLayoutEffect, useState } from 'react'
import { ASK_PHONE_MIN, type Placement } from './placement'

interface DrawerBox { left: number; top: number }
interface Bounds { drawer: DrawerBox | null; threadHeight: number }
const EMPTY: Bounds = { drawer: null, threadHeight: 0 }

/** Use a readable column beside the drawer, or share the remaining height on smaller screens. */
export function workbenchLayout(place: Placement, drawer: DrawerBox, viewport: { height: number; contentLeft: number; room: number }) {
  const left = Math.max(12, viewport.contentLeft + 12)
  const width = Math.min(place.width, drawer.left - left - 12)
  if (place.mode === 'desktop' && width >= ASK_PHONE_MIN) return { place: { ...place, left, width }, stacked: false, maxThreadHeight: undefined }
  return { place, stacked: true, maxThreadHeight: Math.max(0, Math.floor((viewport.height - viewport.room - drawer.top - 24) / 2)) }
}

/** Follow mounts, hidden drawers, resizing and completed entrance animations without polling. */
export function useWorkbenchBounds(active: boolean): Bounds {
  const [bounds, setBounds] = useState<Bounds>(EMPTY)
  useLayoutEffect(() => {
    if (!active) return
    let drawer: HTMLElement | null = null
    let panel: HTMLElement | null = null
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    function measure() {
      const nextDrawer = document.querySelector<HTMLElement>('[data-ask-companion]:not([hidden])')
      const nextPanel = document.querySelector<HTMLElement>('.ask-root[data-skin="capsule"] .ask-panel')
      if (drawer !== nextDrawer || panel !== nextPanel) {
        resize?.disconnect()
        drawer = nextDrawer
        panel = nextPanel
        if (drawer) resize?.observe(drawer)
        if (panel) resize?.observe(panel)
      }
      const r = drawer?.getBoundingClientRect()
      const box = r && r.width > 0 && r.height > 0 ? { left: r.left, top: r.top } : null
      const threadHeight = panel?.offsetHeight ?? 0
      setBounds(previous => previous.drawer?.left === box?.left && previous.drawer?.top === box?.top && previous.threadHeight === threadHeight ? previous : { drawer: box, threadHeight })
    }
    measure()
    const changes = new MutationObserver(measure)
    changes.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] })
    window.addEventListener('resize', measure)
    document.addEventListener('animationend', measure)
    return () => { resize?.disconnect(); changes.disconnect(); window.removeEventListener('resize', measure); document.removeEventListener('animationend', measure) }
  }, [active])
  return active ? bounds : EMPTY
}
