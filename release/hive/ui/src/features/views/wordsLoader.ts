// Purpose: loads the composed words (ComposedWords.tsx, which brings the screen engine) once for the page and keeps
// them, so the words slot (Words.tsx) draws them at once after a load and lazily before one, and a test, or a page
// about to draw many words, can load them first.
import type { ComponentType } from 'react'
import type { WordsProps } from './Words'

let composed: ComponentType<WordsProps> | null = null

/** Load the composed words now (a test, or a page about to draw many), so words drawn after it draw without waiting. */
export function loadWords(): Promise<{ default: ComponentType<WordsProps> }> {
  return import('./ComposedWords').then((m) => {
    composed = m.default
    return m
  })
}

/** The composed words once they have loaded, else null. */
export const loadedWords = (): ComponentType<WordsProps> | null => composed
