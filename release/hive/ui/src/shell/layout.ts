import type { Layout } from './uiVariant'
import { RAIL_X } from './rail'

/** Where the navigation sits for each layout, and the room it leaves for pages, the HUD and the hive camera. */
export const BAR = { height: 52, dock: 60, gap: 8, margin: 12, hudTop: 76 } as const

export interface Geometry {
  /** Left edge for pages and the activity ticker (`--rail-x`). */
  railX: number
  pageTop: number
  pageBottom: number
  /** Extra lift for bottom HUD pieces so they clear a dock (`--hud-bottom`). */
  hudBottom: number
  /** The camera's free space on the hive view. */
  inset: { top: number; left: number; bottom: number }
}

export function geometry(layout: Layout, railExpanded: boolean): Geometry {
  if (layout === 'topbar') {
    const navBottom = BAR.hudTop + BAR.height
    return { railX: BAR.margin, pageTop: BAR.margin + BAR.height + BAR.gap, pageBottom: BAR.margin, hudBottom: 0, inset: { top: navBottom + BAR.gap, left: 0, bottom: 20 } }
  }
  if (layout === 'dock') {
    const lift = BAR.margin + BAR.dock + BAR.gap
    return { railX: BAR.margin, pageTop: BAR.margin, pageBottom: lift, hudBottom: lift, inset: { top: BAR.hudTop, left: 0, bottom: lift + 20 } }
  }
  const railX = railExpanded ? RAIL_X.expanded : RAIL_X.collapsed
  return { railX, pageTop: BAR.margin, pageBottom: BAR.margin, hudBottom: 0, inset: { top: BAR.hudTop, left: railX - 12, bottom: 20 } }
}
