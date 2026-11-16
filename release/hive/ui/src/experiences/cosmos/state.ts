import { create } from 'zustand'
import { useHive, type Approval, type Feature } from '../sdk'
import type { DeckPage, DotTab } from './nav'

export type View = { kind: 'galaxy' } | { kind: 'system'; id: string } | { kind: 'mind'; id: string }

interface CosmosState {
  view: View
  hovered: string | null
  approvalsOpen: boolean
  /** The request open in the shared decision dialog, exactly as it was when opened (Review R2/R3). */
  answering: Approval | null
  /** Surface O (O-B1 follow-up): the store session `answering` was shown under, stamped at the press (as Flux does). The dialog answers only in it. */
  answeringSession: string | null
  /** The flight deck: null closed, 'index' the list of everything, else a native page. */
  deck: DeckPage | null
  deckTab: 'history' | 'rules'
  /** A mind feature waiting for you to pick the mind (the minds page shows a picker). */
  pickFor: DotTab | null
  /** The system a deck page opens on (tasks, beliefs), when it was opened from one. */
  deckSwarm: string | null
  /** The motivation the Tasks page opens filtered to: a motivation id, 'none' (Unsorted), or null (any). */
  deckMotivation: string | null
  /** Bumped by "reset view" so the rig drops any manual orbit/zoom. */
  recenter: number
  go(v: View): void
  hover(id: string | null): void
  setApprovals(open: boolean): void
  /** Opens (or, with null, closes) the decision dialog. `session`: the session the request was shown under; omitted, the store's session at the press. */
  answer(a: Approval | null, session?: string): void
  /** A system-scoped feature asked for with no system focused: the shared directory asks which system. */
  pickingSwarm: Feature | null
  pickSwarm(f: Feature | null): void
  setDeck(page: DeckPage | null, opts?: { tab?: 'history' | 'rules'; pickFor?: DotTab | null; swarm?: string | null; motivation?: string | null }): void
  home(): void
  /** home:requested (a surface's X): the galaxy with no deck, transmissions or system pick left open. */
  clearToHome(): void
}

export const useCosmos = create<CosmosState>()((set) => ({
  view: { kind: 'galaxy' },
  hovered: null,
  approvalsOpen: false,
  answering: null,
  answeringSession: null,
  deck: null,
  deckTab: 'history',
  pickFor: null,
  deckSwarm: null,
  deckMotivation: null,
  recenter: 0,
  go: (view) => set((s) => ({ view, recenter: s.recenter + 1 })),
  hover: (hovered) => set({ hovered }),
  answer: (answering, session) => set({ answering, answeringSession: answering ? (session ?? useHive.getState().session) : null }),
  pickingSwarm: null,
  pickSwarm: (pickingSwarm) => set({ pickingSwarm }),
  setApprovals: (approvalsOpen) => set(approvalsOpen ? { approvalsOpen, deck: null } : { approvalsOpen }),
  setDeck: (deck, opts = {}) => set((s) => ({ deck, deckTab: opts.tab ?? s.deckTab, pickFor: opts.pickFor ?? null, deckSwarm: opts.swarm ?? null, deckMotivation: opts.motivation ?? null, approvalsOpen: deck ? false : s.approvalsOpen })),
  home: () => set((s) => ({ view: { kind: 'galaxy' }, recenter: s.recenter + 1 })),
  clearToHome: () => set((s) => ({ deck: null, pickFor: null, deckSwarm: null, deckMotivation: null, approvalsOpen: false, pickingSwarm: null, view: { kind: 'galaxy' }, recenter: s.recenter + 1 })),
}))

/**
 * DOM labels follow 3D points. The scene writes their screen transforms each frame (no React re-render);
 * labels register their element and a world-position getter here.
 */
export interface LabelEntry {
  el: HTMLElement
  /** Writes the anchor point into out; returns false to hide. */
  at(out: { x: number; y: number; z: number }): boolean
  /** Hide when farther than this from the camera. */
  maxDist: number
  minDist?: number
}
export const labels = new Map<string, LabelEntry>()

/** Light pulses requested by the DOM side (e.g. a message you just sent). */
export const pulseQueue: { from: string; to: string | 'core' | 'you'; hue: number }[] = []
