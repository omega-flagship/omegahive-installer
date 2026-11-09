import type { Polarity, ProgramRole, ProgramStage, Uncertainty } from '../../api/types'
import { useHive } from '../../store/store'
import type { IconName } from '../../ui/iconPaths'

/** Shared styling and words of the program host (one visual language for every program). */

export const ROLE: Record<ProgramRole, { label: string; color: string; icon: IconName }> = {
  question: { label: 'Question', color: '#b4a6ff', icon: 'question' },
  claim: { label: 'Claim', color: '#93c5fd', icon: 'target' },
  evidence: { label: 'Evidence', color: '#67e8f9', icon: 'doc' },
  hypothesis: { label: 'Hypothesis', color: '#f0abfc', icon: 'sparkles' },
  assessment: { label: 'Assessment', color: '#fcd34d', icon: 'scale' },
  explanation: { label: 'Explanation', color: '#a5b4fc', icon: 'info' },
  gap: { label: 'Gap', color: '#fda4af', icon: 'search' },
  source: { label: 'Source', color: '#cbd5e1', icon: 'link' },
  other: { label: 'Item', color: '#a1a1c2', icon: 'layers' },
}

export const POL: Record<Polarity, { label: string; color: string }> = {
  support: { label: 'supports', color: '#34d399' },
  oppose: { label: 'opposes', color: 'var(--color-bad)' },
  qualify: { label: 'qualifies', color: 'var(--color-warn)' },
  neutral: { label: 'related', color: 'var(--color-ink-3)' },
}

export const SURFACE = 'linear-gradient(180deg, color-mix(in oklab, var(--color-ink) 3.5%, transparent), color-mix(in oklab, var(--color-ink) 1.2%, transparent)), var(--look-panel, color-mix(in oklab, var(--color-abyss) 72%, transparent))'
/** Cards on the stage are opaque so links pass behind them cleanly. */
export const CARD = 'linear-gradient(180deg, color-mix(in oklab, var(--color-ink) 4.5%, transparent), color-mix(in oklab, var(--color-ink) 1.5%, transparent)), var(--look-card, var(--color-abyss))'

/**
 * A role or status colour as text. The colours are pastels measured on the dark classic stage; a light chrome
 * (index.css .xc-dress, --tone-tint) draws them mostly in its ink, so they keep their hue and pass WCAG AA there
 * (demo audit P1 #7). Classic and dark chromes show them as they are.
 */
export const toneInk = (color: string) => `color-mix(in srgb, ${color} var(--tone-tint, 100%), var(--color-ink))`

export const num = (v: unknown) => (typeof v === 'number' ? v : Number(v))

/** The free label an open-ended method carries. */
export const ulabel = (u: Uncertainty) => {
  const l = (u as { label?: unknown }).label
  return typeof l === 'string' && l ? l : 'unlabelled'
}

export const f2 = (v: unknown) => (Number.isFinite(num(v)) ? num(v).toFixed(2) : String(v))

/** Value + confidence for the two numeric methods (never converted into each other). */
export function numeric(u: Uncertainty | null | undefined): { method: 'nal' | 'pln'; value: number; conf: number; vName: string; cName: string } | null {
  if (!u) return null
  if (u.method === 'nal' && 'f' in u) return { method: 'nal', value: num(u.f), conf: num(u.c), vName: 'frequency', cName: 'confidence' }
  if (u.method === 'pln' && 'strength' in u) return { method: 'pln', value: num(u.strength), conf: num(u.confidence), vName: 'strength', cName: 'confidence' }
  return null
}

/** The words for an uncertainty, exact numbers and method included (for labels and tooltips). */
export function uncertaintyText(u: Uncertainty | null | undefined): string {
  if (!u) return 'Unassessed: no uncertainty given'
  const n = numeric(u)
  if (n) return `${n.method.toUpperCase()} · ${n.vName} ${f2(n.value)} · ${n.cName} ${f2(n.conf)}`
  if (u.method === 'qualitative') return `Qualitative · ${String((u as { status?: unknown }).status ?? '')}`
  return `${ulabel(u)} · method “${u.method}”`
}

export const FLAG_TEXT: Record<string, { label: string; why: string }> = {
  'affected-by-correction': { label: 'Affected by a correction', why: 'Something this depends on was corrected. Review whether it still holds.' },
}

export const SOURCE_STATUS: Record<string, { label: string; color: string }> = {
  inspected: { label: 'Inspected', color: '#34d399' },
  retrieved: { label: 'Retrieved', color: '#7dd3fc' },
  cited: { label: 'Cited', color: '#b4a6ff' },
  unavailable: { label: 'Unavailable', color: 'var(--color-bad)' },
}

export const SPRING = { type: 'spring' as const, stiffness: 170, damping: 26, mass: 0.9 }

export const STAGE_WORDS = { unfold: 'Unfold', map: 'Map', compare: 'Compare', detail: 'Detail' } as const

export const ACTION_ICON: Record<string, IconName> = {
  'inspect-source': 'external',
  compare: 'columns',
  challenge: 'scale',
  'investigate-gap': 'search',
  correct: 'edit',
}

export const STAGE_ICON: Record<ProgramStage, IconName> = { unfold: 'unfold', map: 'graph', compare: 'columns', detail: 'doc' }

/** Back one step, or leave the program when already at the first. */
export function programBackOrExit(key: string, exit: () => void) {
  if (!useHive.getState().programBack(key)) exit()
}
