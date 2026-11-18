import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProgramAction } from '../../api/types'
import { experienceById } from '../../experiences/registry'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import type { PendingInput } from '../../store/programSession'
import { actForm, appActions, formFields, sentParams, startValues, ticked, type Values } from './actForm'

/** The composer for the look being worn. */
function useLookCompose() {
  return useCompose(experienceById(useLook().current?.experience).id)
}

/**
 * The form for an action's inputs (program.metta program-act): MeTTa composes it, this keeps what the person typed and
 * hands a Send its params in the types the app declared; a blank field is left out. Only the Send button runs the
 * action: the form's own submission is inert (enterGuard.test.ts), since an app action can change things outside.
 */
export function ActionForm({ input, def, busy, onSend, onCancel }: { input: PendingInput; def?: ProgramAction; busy: boolean; onSend(params: Record<string, unknown>): void; onCancel(): void }) {
  const compose = useLookCompose()
  const fields = useMemo(() => formFields(input, def), [input, def])
  const [values, setValues] = useState<Values>(() => startValues(input, fields))
  const { plan, data } = useMemo(() => actForm(input, def, fields, values, compose), [input, def, fields, values, compose])
  const box = useRef<HTMLFormElement>(null)
  useEffect(() => {
    const t = setTimeout(() => box.current?.querySelector<HTMLElement>('input, select')?.focus(), 80)
    return () => clearTimeout(t)
  }, [])
  const send = () => {
    if (!busy && fields.length) onSend(sentParams(input, fields, values))
  }
  return (
    <form ref={box} onSubmit={(e) => e.preventDefault()} aria-label={`${def?.label ?? input.action}: what it takes`} className="rounded-2xl border border-accent-2/30 p-3.5"
      style={{ background: 'linear-gradient(180deg, color-mix(in oklab, var(--color-accent-2) 6%, transparent), color-mix(in oklab, var(--color-accent-2) 2%, transparent)), color-mix(in oklab, var(--color-abyss) 90%, transparent)' }}>
      <Screen plan={plan} className="space-y-3" host={{
        data,
        busy,
        // a field's input comes back with its name first in scope (the stack item it is in)
        onInput: (bind, value, scope) => {
          const name = scope?.[0]
          if (bind === 'field.value' && name) setValues((v) => ({ ...v, [name]: value }))
        },
        onAction: (action, item, on) => {
          if (action === 'act-send') send()
          else if (action === 'act-cancel') onCancel()
          else if (action === 'act-tick') {
            const f = fields.find((x) => x.name === (Array.isArray(item.scope) ? String(item.scope[0]) : ''))
            if (f) setValues((v) => ticked(v, f, String(item.id), on === true))
          }
        },
      }} />
    </form>
  )
}

/** The actions that need no item (program.metta program-actions); a press runs one, which asks first when it declares inputs. */
export function AppActions({ actions, onAct }: { actions: ProgramAction[]; onAct(a: ProgramAction): void }) {
  const compose = useLookCompose()
  const { plan, data } = useMemo(() => appActions(actions, compose), [actions, compose])
  if (!plan.parts.length) return null
  return (
    <Screen plan={plan} className="space-y-2" host={{
      data,
      onOpen: (target, item) => {
        const a = actions.find((x) => x.id === item.id)
        if (target === 'act' && a) onAct(a)
      },
    }} />
  )
}
