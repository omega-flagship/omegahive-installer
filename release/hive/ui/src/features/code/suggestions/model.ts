/**
 * Pure model for WorkbenchSuggestionPanel: hunk state from the retained record, staging of per-hunk decisions with
 * dependent groups, the exact decision payload, dirty-buffer refusal, retry semantics and plain-words errors.
 * No I/O here; the panel supplies responses and the editor state.
 */
import { plural } from '../../../lib/plural'
import { ApiError } from '../../../api/client'
import { GRANT_SCOPE_WORDS, isGrantScope } from '../../../lib/grantScope'
import { ContractError, PROPOSED_EXTENSION_GROUPS, sha256Text, type SuggestionCreateRequest, type SuggestionDecisionResult, type SuggestionDecisionRecord, type SuggestionDecisionRequest, type SuggestionHistoryItem, type SuggestionHunk, type SuggestionRead } from './contract'

export type HunkState =
  | { kind: 'accepted'; decision: SuggestionDecisionRecord }
  | { kind: 'rejected'; decision: SuggestionDecisionRecord }
  /** Undecided, but the proposal no longer binds the current source: it can never be decided from this proposal. */
  | { kind: 'stale' }
  | { kind: 'open' }

/** Recorded decisions first (they are history), then currency. Never a whole-proposal "applied" status. */
export function hunkStates(read: SuggestionRead): Map<string, HunkState> {
  const out = new Map<string, HunkState>()
  for (const d of read.decisions) {
    for (const id of d.accepted_hunk_ids) out.set(id, { kind: 'accepted', decision: d })
    for (const id of d.rejected_hunk_ids) out.set(id, { kind: 'rejected', decision: d })
  }
  for (const h of read.content.hunks) if (!out.has(h.id)) out.set(h.id, read.currency === 'current' ? { kind: 'open' } : { kind: 'stale' })
  return out
}

export interface Tally {
  accepted: number
  rejected: number
  stale: number
  open: number
}
export function tally(read: SuggestionRead): Tally {
  const t: Tally = { accepted: 0, rejected: 0, stale: 0, open: 0 }
  for (const s of hunkStates(read).values()) t[s.kind]++
  return t
}

/** Plain words for the proposal as a whole, derived from per-hunk state (never claims "applied" for a partial accept). */
export function proposalSummary(read: SuggestionRead): string {
  const t = tally(read)
  const parts: string[] = []
  if (t.accepted) parts.push(`${t.accepted} accepted`)
  if (t.rejected) parts.push(`${t.rejected} rejected`)
  if (t.open) parts.push(`${t.open} waiting for you`)
  if (t.stale) parts.push(`${t.stale} stale (source changed; cannot be decided)`)
  return parts.join(' · ')
}

/** Each hunk's dependency group (itself alone unless the proposed groups extension names a group). */
export function groupsOf(read: SuggestionRead): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const g of read.content[PROPOSED_EXTENSION_GROUPS as 'hunk_groups'] ?? []) for (const id of g) out.set(id, g)
  for (const h of read.content.hunks) if (!out.has(h.id)) out.set(h.id, [h.id])
  return out
}

export type Choice = 'accept' | 'reject'
export type Staged = Readonly<Record<string, Choice>>

/**
 * Stage (or clear, with null) a choice for a hunk. A dependent group moves together; staging refuses when any member
 * is not open (already decided, or stale), so a group can never be split across decisions.
 */
export function stage(read: SuggestionRead, staged: Staged, hunkId: string, choice: Choice | null): { staged: Staged; refused?: string } {
  const states = hunkStates(read)
  const group = groupsOf(read).get(hunkId)
  if (!group) return { staged, refused: 'This hunk is not part of the proposal.' }
  const blocked = group.filter((id) => states.get(id)?.kind !== 'open')
  if (blocked.length) {
    const why = blocked.some((id) => states.get(id)?.kind === 'stale') ? 'the source changed since it was proposed (stale)' : 'part of it was already decided'
    return { staged, refused: group.length > 1 ? `This hunk depends on ${group.length - 1} other hunk(s) and ${why}; nothing was staged.` : `This hunk cannot be decided: ${why}.` }
  }
  const next: Record<string, Choice> = { ...staged }
  for (const id of group) {
    if (choice) next[id] = choice
    else delete next[id]
  }
  return { staged: next }
}

/** Null when the staged set may be submitted; otherwise why not. */
export function stagedProblem(read: SuggestionRead, staged: Staged): string | null {
  const ids = Object.keys(staged)
  if (!ids.length) return 'Choose Accept or Reject on at least one hunk.'
  if (read.currency !== 'current') return 'The source changed since this proposal was made. Its undecided hunks are stale and cannot be decided; ask for a fresh proposal on the current source.'
  const states = hunkStates(read)
  for (const id of ids) if (states.get(id)?.kind !== 'open') return 'A staged hunk is no longer open. Reload the proposal.'
  for (const group of new Set(groupsOf(read).values())) {
    const choices = new Set(group.map((id) => staged[id]))
    if (choices.size > 1) return 'Dependent hunks must be accepted or rejected together.'
  }
  return null
}

/** Undecided open hunks that would be left behind: after any acceptance they become stale for good. */
export function leftBehind(read: SuggestionRead, staged: Staged): SuggestionHunk[] {
  const states = hunkStates(read)
  return read.content.hunks.filter((h) => states.get(h.id)?.kind === 'open' && !staged[h.id])
}

/**
 * The exact decision request: binds record.digest (not the inner normalized digest), the proposal's own retained
 * generation/tree, and the original hunk IDs in retained order.
 */
export function decisionRequest(read: SuggestionRead, staged: Staged, operationId: string): SuggestionDecisionRequest {
  const problem = stagedProblem(read, staged)
  if (problem) throw new Error(problem)
  const order = read.content.hunks.map((h) => h.id)
  return {
    operation_id: operationId,
    suggestion_id: read.record.id,
    suggestion_digest: read.record.digest,
    expected_generation: read.content.binding.generation,
    expected_tree_digest: read.content.binding.tree_digest,
    accepted_hunk_ids: order.filter((id) => staged[id] === 'accept'),
    rejected_hunk_ids: order.filter((id) => staged[id] === 'reject'),
  }
}

export interface EditorBuffer {
  path: string | null
  dirty: boolean
}
/**
 * Dirty buffers are never overwritten: accepting a hunk on a file with unsaved editor changes refuses. Rejection never
 * edits source, so it is allowed. A dirty buffer on another file is preserved (the workbench keeps it).
 */
export function dirtyConflict(read: SuggestionRead, staged: Staged, editor: EditorBuffer): string | null {
  if (!editor.dirty || !editor.path) return null
  const touched = read.content.hunks.some((h) => staged[h.id] === 'accept' && h.path === editor.path)
  return touched ? `${editor.path} has unsaved edits in the editor. Accepting would change that file underneath them. Save or discard your edits first; nothing was decided.` : null
}

/** The decision a person reviewed, frozen. A retry resends exactly this (same operation ID, identical payload). */
export interface PendingDecision {
  request: SuggestionDecisionRequest
  /** Set when the last attempt ended without a definitive answer. */
  unknown?: string
  /**
   * A deliberate resend of a decision that was already recorded (same operation ID, identical payload), to check the
   * service returns the original receipt and applies nothing twice. Holds that original receipt.
   */
  resend?: Receipt
}
export interface Receipt {
  decision_id: string
  change_id: string | null
  /** The candidate's generation right after the decision was recorded. */
  generation: number
}
export const receiptOf = (r: SuggestionDecisionResult): Receipt => ({ decision_id: r.decision.id, change_id: r.change?.id ?? null, generation: r.workspace.generation })

/** Null when a resend returned exactly the original receipt; otherwise what differed. */
export function receiptCheck(original: Receipt, again: SuggestionDecisionResult): string | null {
  const got = receiptOf(again)
  const diff: string[] = []
  if (got.decision_id !== original.decision_id) diff.push(`decision ${got.decision_id} instead of ${original.decision_id}`)
  if (got.change_id !== original.change_id) diff.push(`ChangeSet ${got.change_id ?? 'none'} instead of ${original.change_id ?? 'none'}`)
  return diff.length ? `The resend did not return the original receipt: ${diff.join('; ')}.` : null
}
export function retryRequest(p: PendingDecision): SuggestionDecisionRequest {
  return { ...p.request, accepted_hunk_ids: [...p.request.accepted_hunk_ids], rejected_hunk_ids: [...p.request.rejected_hunk_ids] }
}

export type Failure =
  | { kind: 'unavailable'; text: string }
  | { kind: 'stale'; text: string }
  | { kind: 'decided'; text: string }
  | { kind: 'revoked'; text: string }
  | { kind: 'conflict'; text: string }
  | { kind: 'refused'; text: string }
  | { kind: 'limit'; text: string }
  | { kind: 'contract'; text: string }
  /** No definitive answer: the decision may or may not have been recorded. Retry the identical operation. */
  | { kind: 'unknown'; text: string }

export function describeFailure(e: unknown): Failure {
  if (e instanceof ContractError) return { kind: 'contract', text: `${e.message}. Nothing is shown as decided from this answer.` }
  if (e instanceof ApiError) {
    const m = e.message
    // the service's own status when relayed (next8 sends a service 401 as 403 + upstream_status 401)
    const st = e.source === 'omegacode' && e.upstreamStatus !== undefined ? e.upstreamStatus : e.status
    // availability is read from the hive's real answer, never from a list kept in the UI
    if (e.code === 'not_relayed') return { kind: 'unavailable', text: `This hive does not relay this suggestion route to OmegaCode (it answered 404 not_relayed${m ? `: ${m}` : ''}).` }
    if (e.code === 'service_unavailable') return { kind: 'unavailable', text: 'OmegaCode is not connected to this hive (503 service_unavailable).' }
    // relayed, but the loaded OmegaCode release has no such route (FastAPI's bare 404, no contract error code)
    if (e.code === 'http_404' && e.source === 'omegacode') return { kind: 'unavailable', text: 'The hive relays this route, but the OmegaCode release it reaches does not answer it (404 with no error code).' }
    if (['stale_workspace', 'suggestion_stale', 'stale_file', 'context_policy_changed', 'function_scope_stale'].includes(e.code)) return { kind: 'stale', text: `The source changed since this was bound (${e.code}). Nothing was decided; remaining hunks are stale and need a fresh proposal.` }
    if (e.code === 'suggestion_decided') return { kind: 'decided', text: 'Some of these hunks were already decided (perhaps by someone else). Reload to see the record.' }
    if (e.code === 'operation_conflict') return { kind: 'conflict', text: 'This operation ID was already used with a different payload. Nothing new was decided.' }
    // a read-only grant asked to change code: the grant still works for looking (platform bfbb100)
    if (isGrantScope(e)) return { kind: 'refused', text: GRANT_SCOPE_WORDS }
    if (['invalid_capability', 'grant_invalid', 'grant_required', 'authentication_required'].includes(e.code) || (e.source === 'omegacode' && st === 401)) return { kind: 'revoked', text: `Authority was withdrawn (yours or the scope issuer's: ${e.code}). Nothing was decided. A person must open the work again and issue a fresh scope.` }
    if (st === 429) return { kind: 'limit', text: `${m} (${e.code}). Retained history is never evicted to make room.` }
    if (st >= 500 || e.status >= 500 || e.status === 0) return { kind: 'unknown', text: `No definitive answer (${e.code}: ${m}). The decision may or may not have been recorded. Retry sends the identical decision; the service returns the original result if it was recorded.` }
    return { kind: 'refused', text: `${m} (${e.code}). Nothing was decided.` }
  }
  return { kind: 'unknown', text: `No definitive answer (${e instanceof Error ? e.message : String(e)}). The decision may or may not have been recorded. Retry sends the identical decision.` }
}

/** Merge a refreshed page into what is shown: deduplicate by ID, newest first (cursor pages are positions, not snapshots). */
export function mergeHistory(shown: readonly SuggestionHistoryItem[], page: readonly SuggestionHistoryItem[]): SuggestionHistoryItem[] {
  const by = new Map(shown.map((i) => [i.id, i]))
  for (const i of page) by.set(i.id, i)
  return [...by.values()].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

/** 1-based line span of [from, to) in text (UTF-16 offsets), for display. */
export function lineSpan(text: string, from: number, to: number): { first: number; last: number } {
  const first = text.slice(0, from).split('\n').length
  const last = first + Math.max(0, text.slice(from, to).replace(/\n$/, '').split('\n').length - 1)
  return { first, last }
}

export interface DiffRow {
  left: { n: number; text: string } | null
  right: { n: number; text: string } | null
}
/**
 * Rows for a hunk's diff. `prefix`/`suffix` are the unchanged rest of the first and last lines, so the rows show
 * whole lines. Side-by-side pairs removed and added lines by index; unified lists removed then added.
 */
export function diffRows(before: string, after: string, firstLine: number, prefix = '', suffix = ''): DiffRow[] {
  const split = (s: string) => {
    const lines = (prefix + s + suffix).split('\n')
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    return prefix + s + suffix === '' ? [] : lines
  }
  const l = split(before)
  const r = split(after)
  const rows: DiffRow[] = []
  for (let i = 0; i < Math.max(l.length, r.length); i++) rows.push({ left: i < l.length ? { n: firstLine + i, text: l[i] } : null, right: i < r.length ? { n: firstLine + i, text: r[i] } : null })
  return rows
}

/** A fresh client operation ID for a new decision (never reused for a different payload). */
export const newOperationId = (kind: string) => `${kind}-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Date.now().toString(36)}`

// ------------------------------------------------------------------------------------------ person-authored suggestions

/** One saved range the person picked: exact UTF-8 bytes of the saved file, plus the text it covers (for display + digest). */
export interface PickedRange {
  path: string
  start_byte: number
  end_byte: number
  /** "line 2" / "lines 4–6", display only */
  lines: string
  /** exactly the saved text in [start_byte, end_byte) */
  text: string
}
export const rangeKey = (r: Pick<PickedRange, 'path' | 'start_byte' | 'end_byte'>) => `${r.path}:${r.start_byte}-${r.end_byte}`
const byPosition = (a: PickedRange, z: PickedRange) => (a.path < z.path ? -1 : a.path > z.path ? 1 : a.start_byte - z.start_byte || a.end_byte - z.end_byte)

/**
 * Add a picked range to the scope being assembled. Ranges are kept in path/byte order. Empty, duplicate and overlapping
 * ranges refuse (the service would refuse their hunks as overlapping or ambiguous), and so do more than 100 per file.
 */
export function addRange(ranges: readonly PickedRange[], r: PickedRange): { ranges: PickedRange[]; refused?: string } {
  const keep = [...ranges]
  if (r.start_byte >= r.end_byte) return { ranges: keep, refused: 'Select at least one character.' }
  if (ranges.some((x) => rangeKey(x) === rangeKey(r))) return { ranges: keep, refused: 'That range is already in the scope.' }
  if (ranges.some((x) => x.path === r.path && r.start_byte < x.end_byte && x.start_byte < r.end_byte)) return { ranges: keep, refused: 'That range overlaps one already in the scope. Remove it first, or pick a range that does not touch it.' }
  if (ranges.filter((x) => x.path === r.path).length >= 100) return { ranges: keep, refused: 'A scope holds at most 100 ranges per file.' }
  if (!ranges.some((x) => x.path === r.path) && new Set(ranges.map((x) => x.path)).size >= 100) return { ranges: keep, refused: 'A scope holds at most 100 files.' }
  return { ranges: [...keep, r].sort(byPosition) }
}

/** The scope request's `ranges` field: {path: [[start, end], ...]} in byte order. */
export function scopeRanges(ranges: readonly PickedRange[]): Record<string, [number, number][]> {
  const out: Record<string, [number, number][]> = {}
  for (const r of [...ranges].sort(byPosition)) (out[r.path] ??= []).push([r.start_byte, r.end_byte])
  return out
}

/** An explicit hunk exactly as the service's create route takes it (five fields, nothing else). */
export interface AuthoredHunk {
  path: string
  start_byte: number
  end_byte: number
  replacement: string
  before_digest: string
}

/**
 * The person's own hunks: one per scoped range whose text they changed, replacing that whole range. `before_digest` is
 * sha256 of the replaced saved UTF-8 bytes (suggestion_validation.prepare). Unchanged ranges produce no hunk.
 */
export async function personHunks(ranges: readonly PickedRange[], drafts: Readonly<Record<string, string>>): Promise<AuthoredHunk[]> {
  const out: AuthoredHunk[] = []
  for (const r of [...ranges].sort(byPosition)) {
    const replacement = drafts[rangeKey(r)]
    if (replacement === undefined || replacement === r.text) continue
    out.push({ path: r.path, start_byte: r.start_byte, end_byte: r.end_byte, replacement, before_digest: await sha256Text(r.text) })
  }
  return out
}

/** Null when the drafts may be filed; otherwise why not, in plain words. */
export function authoredProblem(ranges: readonly PickedRange[], drafts: Readonly<Record<string, string>>): string | null {
  if (!ranges.length) return 'Choose a scope first.'
  if (!ranges.some((r) => drafts[rangeKey(r)] !== undefined && drafts[rangeKey(r)] !== r.text)) return 'Change the text of at least one range. Unchanged ranges are not filed.'
  const bytes = new TextEncoder().encode(JSON.stringify(Object.values(drafts))).length
  if (bytes > 4 * 1024 * 1024) return 'The suggestion is larger than the service accepts (4 MiB).'
  return null
}

/** The exact create request: closed shape, no author/model/harness (the service derives the author from the capability). */
export function createRequest(scopeId: string, hunks: readonly AuthoredHunk[], operationId: string): SuggestionCreateRequest {
  if (!hunks.length) throw new Error('A suggestion needs at least one changed range.')
  return { operation_id: operationId, scope_id: scopeId, hunks: hunks.map(({ path, start_byte, end_byte, replacement, before_digest }) => ({ path, start_byte, end_byte, replacement, before_digest })) }
}

/**
 * Check the retained proposal is exactly what the person wrote: same scope, and every sent hunk retained with the same
 * path, bytes, replacement and before digest (and nothing extra). Empty when it matches.
 */
export function authoredMismatch(read: SuggestionRead, sent: SuggestionCreateRequest): string[] {
  const problems: string[] = []
  if (read.content.scope_id !== sent.scope_id) problems.push('the proposal binds another scope')
  const key = (h: AuthoredHunk) => `${h.path}\u0000${h.start_byte}\u0000${h.end_byte}\u0000${h.before_digest}\u0000${h.replacement}`
  const kept = new Set(read.content.hunks.map(key))
  for (const h of sent.hunks) if (!kept.has(key(h))) problems.push(`${h.path} bytes ${h.start_byte}–${h.end_byte} was not retained as written`)
  if (read.content.hunks.length !== sent.hunks.length) problems.push(`${plural(read.content.hunks.length, 'hunk')} ${read.content.hunks.length === 1 ? 'was' : 'were'} retained for ${sent.hunks.length} written`)
  return problems
}

/** Who a retained author is, in plain words: the capability actor only (no harness, model or controller is claimed). */
export function authorLabel(author: string): string {
  if (author.startsWith('agent:')) return `mind ${author.slice(6)}`
  if (author.startsWith('user:')) return `person ${author.slice(5)}`
  return author
}
