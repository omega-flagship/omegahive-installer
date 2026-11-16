import type { WorkGraph } from '../../api/types'

/**
 * Whose Atlas this is. Jon (2026-10-05): "you can use my data for my atlas - but the atlas other people see
 * would be empty or have a sample dataset".
 *  - owner:  a real graph with a subject, and the viewer is its owner;
 *  - empty:  no subject or no items, OR a viewer who is not the owner (their data is never drawn);
 *  - sample: explicitly chosen ("Explore a sample"); the fictional dataset, labelled SAMPLE throughout.
 */
export type AtlasMode = 'owner' | 'empty' | 'sample'
export type EmptyReason = 'no-items' | 'no-subject' | 'not-owner' | null

export function resolveMode(graph: WorkGraph | null | undefined, viewer: { isOwner: boolean } | undefined, sampleChosen: boolean): { mode: AtlasMode; reason: EmptyReason } {
  if (sampleChosen) return { mode: 'sample', reason: null }
  const items = graph?.items ?? []
  if (!items.length) return { mode: 'empty', reason: 'no-items' }
  if (!items.some((i) => i.kind === 'subject')) return { mode: 'empty', reason: 'no-subject' }
  if (!viewer?.isOwner) return { mode: 'empty', reason: 'not-owner' }
  return { mode: 'owner', reason: null }
}

/** Actions that would change real records or reach a worker. In sample mode they are simulated and say so. */
export const CONSEQUENTIAL = new Set(['investigate', 'revoke-request', 'cancel-request'])
