import type { CSSProperties } from 'react'
import type { Rect } from './layout'

export const place = (r: Rect): CSSProperties => ({ position: 'absolute', left: 0, top: 0, width: r.w, height: r.h, transform: `translate(${r.x}px, ${r.y}px)` })

/** Screen-constant length inside the scaled world. */
export const sc = (px: number) => `calc(${px}px * var(--iz, 1))`

export const ring = (on: boolean): CSSProperties => (on ? { boxShadow: `0 0 0 ${sc(2)} var(--accent), var(--shadow)` } : {})
