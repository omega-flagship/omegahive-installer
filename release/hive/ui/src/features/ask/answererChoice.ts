import type { AskContext } from '../../api/ask'

/** A person's explicit local recipient choice. Routing hint only; host authority
 * still decides every read, wake and Ask. No preference write lives here. */
export type AnswererTarget =
  | { kind: 'own'; mind: string; swarm?: string; name: string }
  | { kind: 'swarm'; swarm: string; name: string }
  | { kind: 'thread'; mind: string; swarm?: string; name: string }
interface Choice { target: AnswererTarget; current(): boolean }
let choice: Choice | null = null
const listeners = new Set<() => void>()
const emit = () => { for (const listener of listeners) listener() }

export const answererChoice = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  get(): AnswererTarget | null { return choice?.current() ? choice.target : null },
  select(target: AnswererTarget, current: () => boolean): boolean {
    if (!current()) return false
    choice = { target: { ...target }, current }
    emit()
    return true
  },
  clear(): void { if (choice) { choice = null; emit() } },
  apply(context: AskContext): AskContext {
    const target = this.get()
    if (!target || 'private' in context || context.mind || context.selection?.some((r) => r.kind === 'mind')) return context
    const { swarm_id: _pageSwarm, program, selection, view, ...rest } = context
    void _pageSwarm
    // Program references and view actions belong to the old program's swarm.
    // An explicit recipient change must not carry that scope into another swarm.
    const clean = program ? rest : { ...rest, ...(selection ? { selection } : {}), ...(view ? { view } : {}) }
    return target.kind === 'swarm' ? { ...clean, swarm_id: target.swarm }
      : { ...clean, mind: target.mind, ...(target.swarm ? { swarm_id: target.swarm } : {}) }
  },
  matches(context: AskContext): boolean {
    const target = this.get()
    if (!target || 'private' in context) return false
    return target.kind === 'swarm' ? !context.mind && context.swarm_id === target.swarm : context.mind === target.mind
  },
  /** An own-mind selection also requires a fresh host own-mapping check before effects. */
  expectedOwn(context: AskContext): string | undefined {
    const target = this.get()
    return target?.kind === 'own' && this.matches(context) ? target.mind : undefined
  },
}
