import { useCallback, useMemo, useState } from 'react'
import type { ActionResult, ProgramAction } from '../../api/types'
import type { ActContext, FormProps } from '../contract'
import { buildCase, gateOf, type Gate } from './model'

export interface Sheet {
  action: ProgramAction
  items: string[]
  gate: Gate | null
  /** Opened from the keyboard: that key must be released before a key can confirm. */
  viaKey: boolean
  /** Unique per opening, so a re-opened sheet is a fresh request with a fresh arm interval. */
  seq: number
}

export interface Outcome {
  action: string
  label: string
  items: string[]
  result: ActionResult
  at: number
}

let seq = 0

/** One case file's state, shared by every grammar: what is weighed, what is selected, what is being asked. */
export function useCase(props: FormProps) {
  const { graph, describe, act, focus } = props
  const model = useMemo(() => buildCase(graph, describe), [graph, describe])
  const [targetPick, setTarget] = useState<string | null>(null)
  const target = targetPick && model.balances.has(targetPick) ? targetPick : model.primary
  const [selectedPick, setSelected] = useState<string | null>(null)
  const selected = selectedPick && graph.items.some((i) => i.id === selectedPick) ? selectedPick : null
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [outcomes, setOutcomes] = useState<Outcome[]>([])

  const select = useCallback(
    (id: string | null) => {
      setSelected(id)
      focus(id)
    },
    [focus],
  )

  const run = useCallback(
    async (action: ProgramAction, items: string[], params?: Record<string, unknown>, ctx?: ActContext) => {
      setRunning(action.id)
      try {
        const result = await (ctx ? act(action.id, items, params, ctx) : act(action.id, items, params))
        setOutcomes((o) => [{ action: action.id, label: action.label ?? action.id, items, result, at: Date.now() }, ...o].slice(0, 6))
        return result
      } catch (e) {
        const result: ActionResult = { status: 'error', message: e instanceof Error ? e.message : String(e) }
        setOutcomes((o) => [{ action: action.id, label: action.label ?? action.id, items, result, at: Date.now() }, ...o].slice(0, 6))
        return result
      } finally {
        setRunning(null)
      }
    },
    [act],
  )

  /** Ask for an action: anything gated or with parameters opens the sheet; the rest runs at once. */
  const request = useCallback(
    (actionId: string, items: string[], viaKey = false) => {
      const action = describe?.actions.find((a) => a.id === actionId)
      if (!action) return
      const gate = gateOf(action.id)
      if (gate || (action.params && Object.keys(action.params).length)) setSheet({ action, items, gate, viaKey, seq: ++seq })
      else void run(action, items)
    },
    [describe, run],
  )

  const byId = useMemo(() => new Map(graph.items.map((i) => [i.id, i])), [graph])

  return {
    model,
    byId,
    target,
    setTarget,
    selected,
    select,
    sheet,
    closeSheet: () => setSheet(null),
    request,
    run,
    running: running ?? (props.busy ? 'busy' : null),
    outcomes,
    dismiss: (at: number) => setOutcomes((o) => o.filter((x) => x.at !== at)),
  }
}

export type CaseState = ReturnType<typeof useCase>
