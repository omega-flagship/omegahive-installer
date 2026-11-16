// Types for Design's pinned native maker-trace module (maker-trace.mjs, vendored byte-exact; see PIN.json).
export interface MakerTraceEntry { event: unknown; receipt: { after: { scene_id: string; revision: number; digest: string }; [k: string]: unknown } }
export const STUDIO_MAKER_TRACE_LIMIT: number
export const STUDIO_MAKER_TRACE_BYTES: number
export function verifyMakerTrace(trace: unknown, history: unknown[]): Promise<MakerTraceEntry[]>
export function retainedMakerTrace<E extends MakerTraceEntry>(trace: E[], history: { scene: { id: string }; revision: number; digest: string }[]): E[]
