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
  /**
   * The context a send goes with once the person picked who answers: the picked mind as `mind`, marked `chosen` so it
   * speaks (a tester on v0.38 picked Create and her own mind answered); a picked swarm by its coordinator
   * (`coordinatorOf`), or by the swarm alone where none is known, which keeps the swarm's usual voice.
   */
  apply(context: AskContext, coordinatorOf: (swarm: string) => string | null | undefined = () => null): AskContext {
    const target = this.get()
    if (!target || 'private' in context || context.mind || context.selection?.some((r) => r.kind === 'mind')) return context
    // the person's explicit choice also beats the mind whose chat is in use
    const { swarm_id: _pageSwarm, with: _inUse, program, selection, view, ...rest } = context
    void _pageSwarm
    void _inUse
    // Program references and view actions belong to the old program's swarm.
    // An explicit recipient change must not carry that scope into another swarm.
    const clean = program ? rest : { ...rest, ...(selection ? { selection } : {}), ...(view ? { view } : {}) }
    if (target.kind === 'swarm') {
      const coordinator = coordinatorOf(target.swarm)
      return coordinator ? { ...clean, mind: coordinator, chosen: true, swarm_id: target.swarm } : { ...clean, swarm_id: target.swarm }
    }
    return { ...clean, mind: target.mind, chosen: true, ...(target.swarm ? { swarm_id: target.swarm } : {}) }
  },
  matches(context: AskContext, coordinatorOf: (swarm: string) => string | null | undefined = () => null): boolean {
    const target = this.get()
    if (!target || 'private' in context) return false
    if (target.kind !== 'swarm') return context.mind === target.mind
    const coordinator = coordinatorOf(target.swarm)
    return context.swarm_id === target.swarm && (coordinator ? context.mind === coordinator && context.chosen === true : !context.mind)
  },
  /** An own-mind selection also requires a fresh host own-mapping check before effects. */
  expectedOwn(context: AskContext): string | undefined {
    const target = this.get()
    return target?.kind === 'own' && this.matches(context) ? target.mind : undefined
  },
}
