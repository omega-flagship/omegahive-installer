/**
 * What an experience may use. Everything goes through the same store and router as the classic UI, so every
 * experience sees the same minds, swarms, beliefs, messages, approvals and goals, and acts through the same
 * reviewed actions (send, wake/sleep, decide, create goal). Never call fetch or the client directly.
 */
export type { Decision } from '../store/store'
/** A surface's X (the owner 2026-10-08): home, with every experience's own panels closed (home:requested). */
export { closeToHome, navigate, useRoute, useHomeRequested, type Route } from '../lib/router'
export { shown } from '../lib/displayName'
export { plural, pluralAtLeast } from '../lib/plural'
export { hsl, surenessColor, surenessMeter, surenessRgb } from '../lib/color'
export { useReducedMotion, useIsDesktop } from '../lib/hooks'
import { useMediaQuery } from '../lib/hooks'
/**
 * Surface O: room for the wide layout needs height as well as width. A phone on its side (844×390) is wide but short;
 * width alone gave it side panels with no room inside them, so it takes the phone layout.
 */
export const ROOMY = '(min-width: 768px) and (min-height: 560px)'
export const useRoomyLayout = () => useMediaQuery(ROOMY)
export { openGallery } from '../shell/uiVariant'
/** followups-r9: a row the experience's layout reserves for the host's one-line notice, open while one shows there. */
export { NOTICE_ROW, useNoticeRow } from '../shell/experienceStage'
export { countPending } from '../store/reducer'
/** This page is resting (features/power/RestScreen.tsx): pause expensive loops; the rest draws its own, lighter scene. */
export { useResting } from '../lib/resting'
/** Surface K1: tag a read's answer with the identity (client and more) it was read under; show it only for that identity. */
export { readContext, taggedFor, type Tagged } from '../lib/readContext'
export type { Agent, Swarm, Belief, Message, Approval, Goal } from '../api/types'
/** uifix-r3 (S3, a11y-07): beliefs and truth values as plain words, the one shared helper; notation only "as written". */
export { asWritten, beliefLine, beliefText, beliefTopic, compareSureness, expectation, plainText, sayBelief, truthPhrase, truthWords } from '../lib/beliefSentence'
export { AsWritten, BeliefSentence, PlainText, Sureness } from '../ui/Belief'
/** The host's Remind / Sleep / own-mind flags (Platform r2.4), for an experience's Ask world and its own acts. */
export { askFlags, hostAllows, notAllowedWords, readAskFlags } from '../api/idleMinds'
/** The identity an act started under (Health idle r1.4): pass it to the store's checked Remind / Sleep. */
export { storeIdentity } from '../store/store'

import { navigate } from '../lib/router'
import { useHive } from '../store/store'
/** Open a classic page over the experience (it closes back to the experience). */
export const openClassic = navigate
/** The command palette, available in every experience. */
/** Open the palette, optionally with a query typed in. Safe as a click handler: an event is not a query. */
export const openPalette = (query?: unknown) => useHive.getState().openPalette(typeof query === 'string' ? query : '')

import { SURFACE_PREVIEW } from './registry'
import type { Approval } from '../api/types'

/**
 * In the Surface preview build, approvals made inside an experience go to the classic approvals page instead
 * (Review R2–R4 are open for experience approval UIs). Everything else reaches the store unchanged.
 *
 * UI review 2026-10-12 S5: the hold is deliberate, so it is never reported as a failure. It opens the Inbox, says so
 * once (a toast), and answers with PREVIEW_HELD: nothing was answered, nothing failed. A caller closes its dialog on
 * it and never says "approved" or "not confirmed" (heldForInbox). A release build never holds (guarded below).
 */
export const PREVIEW_HELD_WORDS = {
  title: 'Opened the Inbox to answer this',
  body: 'This preview build answers requests in the Inbox. Nothing has been answered yet: answer it there.',
} as const
/**
 * The hold's answer (Kimi r2 #2): its own kind, never dressed as an Approval. An experience's `decide` (through this
 * SDK) resolves to the store's Approval | null, or this; nothing can read an approval's fields off a hold without first
 * telling the two apart (heldForInbox).
 */
export interface PreviewHold {
  readonly kind: 'held-for-inbox'
}
const PREVIEW_HELD: PreviewHold = Object.freeze({ kind: 'held-for-inbox' })
/** The answer was held for the classic Inbox (a surface-preview build): not given, and not a failure. */
export const heldForInbox = (r: Approval | PreviewHold | null | undefined): r is PreviewHold => !!r && 'kind' in r && r.kind === 'held-for-inbox'
export const previewDecide = async (): Promise<PreviewHold> => {
  navigate({ name: 'approvals' })
  useHive.getState().toast({ tone: 'info', icon: 'inbox', group: 'preview-hold', ttl: 10_000, ...PREVIEW_HELD_WORDS })
  return PREVIEW_HELD
}
type Store = ReturnType<typeof useHive.getState>
/** The store as an experience sees it: the same, except that `decide` may be held for the Inbox (a preview build). */
export type SdkState = Omit<Store, 'decide'> & { decide: (...a: Parameters<Store['decide']>) => Promise<Approval | PreviewHold | null> }
type SdkHive = {
  (): SdkState
  <T>(selector: (s: SdkState) => T): T
  getState: () => SdkState
} & Omit<typeof useHive, 'getState'>
/**
 * One guarded object per store state (the store replaces its state object on every change). Without this cache every
 * read made a fresh object, so a whole-state reader (`useHive()`, as OmegaTown and the scoped picker use) never saw a
 * stable snapshot and React looped to "Maximum update depth exceeded" in the surface-preview build only.
 */
const guardedOf = new WeakMap<object, SdkState>()
function guarded(s: Store): SdkState {
  if (!SURFACE_PREVIEW) return s
  if (!guardedOf.has(s)) guardedOf.set(s, { ...s, decide: previewDecide })
  return guardedOf.get(s)!
}
const wrapped = (<T,>(selector?: (s: SdkState) => T) => useHive((s) => (selector ? selector(guarded(s)) : guarded(s)))) as SdkHive
const previewHive: SdkHive = Object.assign(wrapped, { ...useHive, getState: () => guarded(useHive.getState()) })
export { previewHive as useHive }

/** Read-only: this hive's people and invitations (null when the hive does not list them, e.g. a member's view). */
export async function readPeople(): Promise<{ people: import('../api/client').Person[]; invites: import('../api/client').Invite[] } | null> {
  const c = useHive.getState().client
  if (!c?.listPeople) return null
  const r = await c.listPeople()
  return { people: r.people, invites: r.invites }
}
/** Open any feature from the registry where it really lives (a page, a mind's panel tab, or a host action). */
export { openFeature, targetFor } from './targets'
export { FEATURES, GROUP_LABEL, type Feature } from '../features/registry'
export { applyChrome } from './chrome'
/** Review D1: a goal's done/failed/cancel/re-open change, decided in the shared decision dialog. */
export { GoalDecision } from './GoalDecision'
// Motivations above Tasks: the why above the work, the same in every experience (lib/motivations.ts)
export { atLeast, countsPartial, creatorLine, isUnsorted, ownerLine, PARTIAL_WORDS, progressOf, sortMotivations, STATUS_WORDS, tasksOf, useCountsPartial, useMotivationData, WORDS as WORK_WORDS } from '../lib/motivations'
export { confirmGoalChange, GOAL_TO, goalBound, goalDrift, goalEffect, seenOf, type GoalSeen, type GoalVerb } from '../lib/goalDecision'

/** Exact native authenticated self, with readMe/useResource freshness; never infer self from People. */
export { useMe, useAdminView, adminViewOf } from '../lib/useAdmin'
export { useAuthContext } from '../lib/useResource'
/** Presentation coverage and the existing conductor view, not a second action protocol. */
export { useCovered } from '../ui/overlays'
export { useAskView, type PageView } from '../features/ask/view'

/** Native navigation scope, including member-accessible Inbox places; display scope is never a grant. */
export { featureOffered, routeOffered } from './navigationScope'
export { ScopedFeaturePicker } from './ScopedFeaturePicker'
export { viewIsLive } from './viewOrigin'
/** Exact existing presence vocabulary; local scenery/person controllers are not native entities. */
export { presenceRef } from '../lib/presence'

/** Existing native Ask presentation/act paths. Addressing prepares a field; explicit submission uses its ordinary policy. */
export { addressAskMind, releaseAskAddress } from '../features/ask/useAskField'
export { askOrigin, useAskStore } from '../store/ask'
export { registerActHandler } from '../features/ask/handlers'
