// Purpose: loads the composed parts under an Ask answer (AnswerParts.tsx, which brings the screen engine) once for the
// page and keeps them, so the slot (AnswerPartsSlot.tsx) draws them at once after a load and lazily before one, and a
// test, or a page about to draw many answers, can load them first.
import type { ComponentType } from 'react'
import type { AskRow } from '../../store/ask'

export type AnswerPartsProps = { r: AskRow }

let composed: ComponentType<AnswerPartsProps> | null = null

/** Load the composed parts now, so slots mounted after it draw at once. */
export function loadAnswerParts(): Promise<{ default: ComponentType<AnswerPartsProps> }> {
  return import('./AnswerParts').then((m) => {
    composed = m.default
    return m
  })
}

/** The composed parts once they have loaded, else null. */
export const loadedAnswerParts = (): ComponentType<AnswerPartsProps> | null => composed
