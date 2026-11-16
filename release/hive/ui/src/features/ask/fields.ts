/**
 * Fields a page lets the Ask conductor fill (ASK_CONDUCTOR_ACTION_VOCABULARY_v1 §3). A page declares one with
 * `useAskFillable`, handing over the field's own setter; the conductor's `fill` calls exactly that setter, so the
 * value goes through React like the person's typing does. Nothing here touches the DOM, and nothing ever submits:
 * sending, saving or acting stays the page's own act, through its existing paths and gates.
 *
 * A field the page did not declare cannot be filled (`not_declared`).
 *
 * Declared today: palette.search (CommandPalette), code.change-prompt (CodeCanvas).
 * TODO(conductor: declare-motivations-field): once surface/motivations merges, declare the new-motivation field and
 * its region on the Motivations page (and the new-task field on Tasks) with useAskFillable, and point the simulator's
 * "show me around motivations" demo at them. The earlier Goals declarations were removed: Goals and Boards are
 * replaced by Motivations above Tasks (Jon, 2026-10-07).
 */
import { useEffect, useRef } from 'react'
import { conformingField, type AskField } from '../../api/ask'

interface Entry {
  field: AskField
  set: (text: string) => void
}

const fields = new Map<string, Entry>()

/** Declare a fillable field while the component is mounted. `set` is the field's own value setter. */
export function useAskFillable(id: string, label: string, kind: AskField['kind'], set: (text: string) => void): void {
  const setter = useRef(set)
  useEffect(() => {
    setter.current = set
  })
  useEffect(() => {
    // only a field the host takes (Platform r2 Q1): id matching VIEW_NAME, label 1–80 without control characters
    const field = conformingField({ id, label, kind })
    if (!field) return
    const mine: Entry = { field, set: (t) => setter.current(t) }
    fields.set(id, mine)
    return () => {
      if (fields.get(id) === mine) fields.delete(id)
    }
  }, [id, label, kind])
}

/** The fields declared on screen now. */
export const listFields = (): AskField[] => [...fields.values()].map((e) => e.field)

/** Put words in a declared field (its own setter). False when no such field is declared. Never submits. */
export function fillField(id: string, text: string): AskField | null {
  const e = fields.get(id)
  if (!e) return null
  e.set(text)
  return e.field
}

/** Tests only: declare or clear a field without React (the same conformance as the hook). */
export function declareFieldForTest(field: AskField, set: ((text: string) => void) | null): boolean {
  const ok = conformingField(field)
  if (set && ok) fields.set(ok.id, { field: ok, set })
  else fields.delete(field.id)
  return !!(set && ok)
}
