/** Recoverable local text only. Never a grant, source receipt or automatic write. */
export interface DraftOwner {
  readonly client: object
  readonly context: string
  readonly principal: string
  readonly task: string
  readonly repository: string
  readonly workspace: string
  readonly path: string
  readonly slot: number
}
export interface RetainedEmbeddedDraft {
  readonly slot: number
  readonly task: string
  readonly repository: string
  readonly workspace: string
  readonly path: string
  readonly text: string
}
// The actual client and sign-in context own these tab-lifetime copies. Nothing
// crosses a new client/sign-in or is persisted into another person's storage.
const drafts = new WeakMap<object, Map<number, { owner: DraftOwner; text: string }>>()
let nextSlot = 0
export function newDraftOwner(owner: Omit<DraftOwner, 'slot'>): DraftOwner {
  return Object.freeze({ ...owner, slot: ++nextSlot })
}
export function retainEmbeddedDraft(owner: DraftOwner, text: string): void {
  let entries = drafts.get(owner.client)
  if (!entries) drafts.set(owner.client, entries = new Map())
  entries.set(owner.slot, { owner, text })
}
export function forgetEmbeddedDraft(owner: DraftOwner): void {
  drafts.get(owner.client)?.delete(owner.slot)
}
export function retainedEmbeddedDrafts(client: object | null | undefined, context: string, principal: string | null | undefined): RetainedEmbeddedDraft[] {
  if (!client || !principal) return []
  return [...(drafts.get(client)?.values() ?? [])]
    .filter(({ owner }) => owner.context === context && owner.principal === principal)
    .map(({ owner, text }) => ({ slot: owner.slot, task: owner.task, repository: owner.repository,
      workspace: owner.workspace, path: owner.path, text }))
    .sort((a, b) => a.slot - b.slot)
}
