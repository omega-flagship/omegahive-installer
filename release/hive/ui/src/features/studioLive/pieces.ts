/**
 * J3 r4.3 O3 r1.13: the piece a live Studio session draws on is one of the person's SAVED canvases in their own Studio
 * space, read exactly (Dot 234718Z, Design 234756Z):
 *  - listed with the host's artifact list (kind `studio-source`) of the person's own "<Name>'s Studio" swarm only (host
 *    `_source` requires owner_swarm == the session swarm);
 *  - read through Studio's own view at focus `studio-source:{exact ref}` (forms/designCanvas/model.ts sourceFocus);
 *  - its scene id is the verified source's `data.source.current.scene.id` (schema omega-studio-source-1), and the view's
 *    `data.reference` must deep-equal the ref that was asked for. Nothing is derived from a digest; nothing is invented.
 * Canvas sources only: a deck or any other schema is never a live canvas.
 */
import type { WorkGraph } from '../../api/types'

export const STUDIO_SOURCE_KIND = 'studio-source'
export const CANVAS_SOURCE_SCHEMA = 'omega-studio-source-1'

export interface PieceRef { artifact_id: string; revision: number; digest: string }
export interface PieceListed extends PieceRef { title: string }
export type PieceRead =
  | { ok: true; scene_id: string; pin: { scene_id: string; revision: number | null; digest: string | null } }
  | { ok: false; why: 'unreadable' | 'not-a-canvas' | 'mismatch' }

export const exactPieceRef = (r: PieceRef): PieceRef => ({ artifact_id: r.artifact_id, revision: r.revision, digest: r.digest })
export const samePiece = (a: PieceRef | null | undefined, b: PieceRef | null | undefined) =>
  !!a && !!b && a.artifact_id === b.artifact_id && a.revision === b.revision && a.digest === b.digest

/** The person's listed canvases (exact refs, as listed); anything not a studio source or without an exact ref is dropped. */
export function readPieceList(v: unknown): PieceListed[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((a) => {
    const o = a && typeof a === 'object' ? (a as Record<string, unknown>) : null
    if (!o || o.kind !== STUDIO_SOURCE_KIND || typeof o.artifact_id !== 'string' || !o.artifact_id || !Number.isSafeInteger(o.revision) || typeof o.digest !== 'string' || !o.digest) return []
    return [{ artifact_id: o.artifact_id, revision: o.revision as number, digest: o.digest, title: String(o.title ?? 'Untitled canvas').slice(0, 120) }]
  })
}

/**
 * Studio's view of one exact saved canvas: the `editable-source` item's data. Its reference must be EXACTLY the ref asked
 * for, its schema a canvas source, and its scene id the source's current scene id.
 */
export function readPieceScene(graph: WorkGraph | null | undefined, ref: PieceRef): PieceRead {
  const item = graph?.items?.find((x) => (x as { id?: unknown }).id === 'editable-source') as { data?: unknown } | undefined
  const data = item?.data && typeof item.data === 'object' ? (item.data as { source?: unknown; reference?: unknown }) : null
  if (!data) return { ok: false, why: 'unreadable' }
  const r = data.reference && typeof data.reference === 'object' ? (data.reference as Record<string, unknown>) : null
  if (!r || Object.keys(r).length !== 3 || r.artifact_id !== ref.artifact_id || r.revision !== ref.revision || r.digest !== ref.digest) return { ok: false, why: 'mismatch' }
  const s = data.source && typeof data.source === 'object' ? (data.source as { schema?: unknown; current?: unknown }) : null
  if (!s || s.schema !== CANVAS_SOURCE_SCHEMA) return { ok: false, why: 'not-a-canvas' }
  const cur = s.current && typeof s.current === 'object' ? (s.current as { scene?: unknown; revision?: unknown; digest?: unknown }) : null
  const scene = cur?.scene && typeof cur.scene === 'object' ? (cur.scene as { id?: unknown }) : null
  if (!scene || typeof scene.id !== 'string' || !scene.id || scene.id.length > 200) return { ok: false, why: 'unreadable' }
  return { ok: true, scene_id: scene.id, pin: { scene_id: scene.id, revision: typeof cur?.revision === 'number' ? cur.revision : null, digest: typeof cur?.digest === 'string' ? cur.digest : null } }
}
