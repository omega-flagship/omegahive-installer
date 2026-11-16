import { create } from 'zustand'
import { onIdentityChange } from '../lib/identityEpoch'
import { hostAskPresentationMatches, readAppAskPresentation, type AppAskPresentation, type AppAskRecipient } from '../api/appAsk'
import type { AppAskController, AppAskPort } from '../lib/appAsk'

export interface PresentedAsk {
  app: string; appName: string; presentation: AppAskPresentation
  controller: AppAskController; port: AppAskPort; current(): boolean
  /** A local fence offers recovery without inventing a new authoritative owner epoch. */
  offeredLocally: boolean
}
export const useAppAskStore = create<{ turns: PresentedAsk[]; provisional: { operation: string; current(): boolean }[] }>(() => ({ turns: [], provisional: [] }))
export function trackAppAsk(operation: string, current: () => boolean): void {
  if (current()) useAppAskStore.setState((s) => ({ provisional: [...s.provisional.filter((x) => x.operation !== operation), { operation, current }].slice(-32) }))
}
export function recordAppAsk(value: PresentedAsk): boolean {
  if (!value.current()) return false
  const old = useAppAskStore.getState().turns.find((t) => t.presentation.operation_id === value.presentation.operation_id)
  if (old?.current()) {
    const a = old.presentation, p = value.presentation
    if (a.turn_id !== p.turn_id || p.epoch < a.epoch || p.epoch === a.epoch && (p.owner !== a.owner || p.generation_id !== a.generation_id || p.host_active !== a.host_active)) return false
  }
  useAppAskStore.setState((s) => ({ turns: [...s.turns.filter((t) => t.presentation.operation_id !== value.presentation.operation_id), value].slice(-32) }))
  return true
}
export function appAskOwnerCurrent(value: AppAskPresentation): boolean {
  const t = useAppAskStore.getState().turns.find((x) => x.presentation.operation_id === value.operation_id)
  return !!t && t.current() && !t.offeredLocally && t.presentation.turn_id === value.turn_id && t.presentation.owner === value.owner && t.presentation.epoch === value.epoch && t.presentation.generation_id === value.generation_id
}
export function offerAppAsk(operation: string, generation: string): void {
  useAppAskStore.setState((s) => ({ turns: s.turns.map((t) => t.presentation.operation_id === operation && t.presentation.owner === 'frame' && t.presentation.generation_id === generation ? { ...t, offeredLocally: true } : t) }))
}
export function framePresentsAsk(operation: string): boolean {
  const t = useAppAskStore.getState().turns.find((x) => x.presentation.operation_id === operation)
  return !!t && t.current() && !t.offeredLocally && t.presentation.owner === 'frame' && t.controller.active()
}
export function hostPresentsAppAskAct(operation: string, turn: string, recipient: AppAskRecipient | undefined): boolean {
  const t = useAppAskStore.getState().turns.find((x) => x.presentation.operation_id === operation)
  return !!t && t.current() && !t.offeredLocally && hostAskPresentationMatches(t.presentation, operation, turn, recipient)
}
export function appAskTracked(operation: string): boolean {
  const s = useAppAskStore.getState()
  return s.turns.some((t) => t.presentation.operation_id === operation && t.current()) || s.provisional.some((t) => t.operation === operation && t.current())
}
/** Fresh server epoch and an explicit host gesture; this never calls terminal Ask.takeover. */
export async function claimAppAsk(entry: PresentedAsk): Promise<AppAskPresentation | null> {
  if (!entry.current()) return null
  const op = entry.presentation.operation_id
  const current = readAppAskPresentation(await entry.port.askPresentation(op), op)
  if (!entry.current() || !current) return null
  const claimed = readAppAskPresentation(await entry.port.askClaim(op, { expected_epoch: current.epoch }), op)
  if (!entry.current() || claimed?.owner !== 'host') return null
  entry.controller.hostClaimed(claimed)
  recordAppAsk({ ...entry, presentation: claimed, offeredLocally: false })
  return claimed
}
onIdentityChange(() => useAppAskStore.setState({ turns: [], provisional: [] }))
