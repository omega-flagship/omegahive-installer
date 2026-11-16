/**
 * The reasoning-module read, strictly, in Root's FLAT TYPED CARRIER, v3 r2 (20261008-154351Z; the initial 153446Z
 * pins are superseded): `read-contract-v3-flat-proposal.json` db2866eb…, `read-result-v3-flat-proposal.schema.json`
 * d535fa8b…, reference check `read_result_flat.py` aafc45d8…, fixtures d943ac2b…. Adoption is the JSON Schema PLUS the
 * reference's semantic checks; both are ported here. One read per mind and module:
 *
 *   POST /api/programs/omega-tools/read  {swarm_id, query: "reasoning-module", params: {ref: "mind:<id>:<module>"}}
 *
 * `result` is one envelope {module, mind_id, revision, observed_at, qualification, available, state,
 * unavailable_reason, items, provenance, explain} with the module's own fields FLAT beside it. Unavailable carries the
 * common envelope only. The caller supplies the expected mind and module; a mismatch is refused.
 *
 * Ported from the schema, check by check (closed keys everywhere, enums, string bounds, UTC times, safe-integer
 * temporal seconds, nonempty [start,end] intervals, typed NALTV or null, typed Assume scalars and projection, typed
 * interval relations, canonical Atom evidence links unique per list, unique ids per list and across temporal content,
 * 64 content / 128 edges / 64 KB aggregate limits, depth 32, ASCII digits in times). Anything else is UNREADABLE, with a
 * fixed refusal code that never echoes the input, never guessed at, never
 * coerced from an older meaning (no list budgets, no string selections, no ISO event times, no interval objects).
 *
 * Surface keeps a few checks STRICTER than v3 (each listed in the review request): no control characters (tab and
 * newline allowed in explanations), skill versions are semver-like, a selected skill must be one of the listed skills,
 * and revisions are tokens (and never drawn).
 *
 * The v1 flat reading of r1–r3 is retired: v3 replaces it (Root: no merging of ambiguous carriers). Nothing here is
 * evidence of real state; a payload of the right shape proves nothing about consent, custody or truth.
 */

export const READ_QUERY = 'reasoning-module'
export const TOOLS_APP_ID = 'omega-tools'
export const MODULES = ['attention', 'self', 'energy', 'scratch', 'assume', 'temporal'] as const
export type ModuleId = (typeof MODULES)[number]
export const MODULE_TITLES: Record<ModuleId, string> = {
  attention: 'Attention',
  self: 'Self-knowledge',
  energy: 'Energy',
  scratch: 'Scratch space',
  assume: 'Assume',
  temporal: 'Temporal',
}
export const LIMITS = { maxContent: 64, maxEdges: 128, maxBytes: 65536, maxDepth: 32 } as const

/** The ref a viewer asks for: always the mind the person opened and one of the six modules. */
export const moduleRef = (mindId: string, module: ModuleId) => `mind:${mindId}:${module}`

export type EnvelopeState = 'current' | 'unavailable' | 'synthetic' | 'banked'
export type UnavailableReason = 'no_reader' | 'withheld' | 'stale'
export type ReadPath = 'host-consent-filtered-snapshot' | 'synthetic-fixture' | 'banked-receipt' | 'none'

export const REASON_CODES = {
  attention: ['sti-contribution', 'lti-contribution', 'freshness-contribution', 'mode-pin', 'task-pin', 'progress-pin', 'next-action-pin', 'stable-ordinal-tie-break'],
  selection: ['prerequisites-present', 'prerequisites-missing', 'selection-unavailable'],
  scratch: ['owner-review-required', 'stale-or-cross-scope', 'expired-scratch', 'private-or-simulation-remains-scratch', 'invalid-scratch-shape'],
} as const
const ENERGY_MODES = ['infer', 'observe', 'act', 'expand', 'retain', 'maintain', 'rest'] as const
const AVAILABILITY = ['available', 'inactive', 'unavailable'] as const
const PROMOTION = ['scratch', 'proposed', 'accepted', 'rejected', 'expired', 'withdrawn'] as const
const EXPECTATIONS = ['pending', 'confirmed', 'disconfirmed', 'expired'] as const
const RELATIONS = ['before', 'after', 'meets', 'met-by', 'overlaps', 'overlapped-by', 'during', 'contains', 'starts', 'started-by', 'finishes', 'finished-by', 'equals'] as const
export type ExpectationState = (typeof EXPECTATIONS)[number]

export interface Truth { f: number; c: number }
export interface Edge { from: string; to: string; weight: number; explain: string }
export interface Item { id: string; kind: string; label?: string; explain: string }
export interface ScratchItem { id: string; kind: string; promotion_state: (typeof PROMOTION)[number]; expiry: string | null; explain: string }
export type Interval = [number, number]

export type ModuleBody =
  | { module: 'attention'; focus_ref: string | null; ranked_items: { id: string; label: string; score: number; reason_codes: string[]; explain: string }[]; spread_edges: Edge[] }
  | { module: 'energy'; mode: (typeof ENERGY_MODES)[number] | null; budget: { unit: string; limit: number; reserved: number; spent: number }; next_wake_at: string | null; sleep_until: string | null }
  | { module: 'self'; skills: { id: string; version: string; label: string; availability: (typeof AVAILABILITY)[number]; source_digest: string; explain: string }[]; selected_skill: { id: string; selected_at: string } | null; selection_reason_codes: string[] }
  | { module: 'scratch'; items: ScratchItem[]; promotion_reasons: string[]; demotion_reasons: string[] }
  | {
      module: 'assume'
      model_ref: string | null
      nodes: { id: string; kind: string; label: string; explain: string }[]
      edges: Edge[]
      prediction: { target_ref: string; value: number; unit: string; explain: string } | null
      observed_target: { target_ref: string; value: number; unit: string; observed_at: string; explain: string } | null
      update_delta: { target_ref: string; before: number; after: number; delta: number; unit: string; explain: string } | null
    }
  | {
      module: 'temporal'
      events: { id: string; term: string; occurrence_time: number; recorded_time: number; valid_interval: Interval; truth: Truth | null; evidence_refs: string[]; explain: string }[]
      rules: { id: string; premise: string; conclusion: string; lag: number; truth: Truth | null; evidence_refs: string[]; explain: string }[]
      expectations: { id: string; rule_ref: string; term: string; due_interval: Interval; state: ExpectationState; late: boolean; explain: string }[]
      projection: { source_time: number; target_time: number; truth_before: Truth | null; truth_after: Truth | null; model_ref: string; explain: string } | null
      interval_relations: { left_ref: string; right_ref: string; relation: (typeof RELATIONS)[number]; explain: string }[]
      explanation_refs: string[]
    }

export interface Provenance { source_revision: string | null; read_path: ReadPath; authority: 'none'; evidence_refs: string[] }

export interface Envelope {
  module: ModuleId
  mind_id: string
  /** null only when unavailable; an unavailable read may still carry one (Root schema; r5). Never drawn. */
  revision: string | null
  /** null exactly when unavailable (never a fabricated time) */
  observed_at: string | null
  qualification: string
  available: boolean
  state: EnvelopeState
  unavailable_reason: UnavailableReason | null
  /** general item metadata (every module but scratch, whose items are its body) */
  items: Item[]
  provenance: Provenance
  explain: string
  /** null when unavailable: an unavailable envelope carries no module data */
  body: ModuleBody | null
}

/**
 * A refusal says only a FIXED code (v3 r2: diagnostics never echo input, keys or values). Codes follow the reference
 * check's: wrong-read-context, unreadable-json, unreadable-schema, unreadable-value, aggregate-content-limit,
 * aggregate-edge-limit, duplicate-content-id, duplicate-temporal-id. An answer over the byte limit is `unreadable-value`, as
 * the reference yields it (its read-byte-limit is raised inside the block whose ValueError handler maps it; stand-in r5 P3).
 */
export type RefusalCode = 'wrong-read-context' | 'unreadable-json' | 'unreadable-schema' | 'unreadable-value' | 'aggregate-content-limit' | 'aggregate-edge-limit' | 'duplicate-content-id' | 'duplicate-temporal-id' | 'expected-context-required'
export type Parsed = { ok: true; envelope: Envelope } | { ok: false; why: RefusalCode }

// ------------------------------------------------------------------ primitives (each a narrow, total check)

class Bad extends Error {
  constructor(readonly code: RefusalCode) {
    super(code)
  }
}
/** `_detail` names the rule for the reader of this code only; it is never kept, shown or returned. */
const bad = (_detail: string, code: RefusalCode = 'unreadable-schema'): never => {
  throw new Bad(code)
}
const badValue = (detail: string): never => bad(detail, 'unreadable-value')
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
/**
 * UTC ISO-8601 with seconds and any number of fraction digits (v3 + v2 helper, r5: aligned), ASCII digits only; the
 * calendar is checked by a round trip on the exact year (r5: years 1–99 too; year 0 does not exist).
 */
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|\+00:00)$/
/** Surface stricter than v3: a semver-like skill version (1–3 numeric parts, optional alpha/beta/rc/dev). */
const VERSION = /^\d{1,6}(\.\d{1,6}){0,2}(-(alpha|beta|rc|dev)(\.\d{1,6})?)?$/
/** v3: a skill source digest is 64 lowercase hex (no prefix). */
const DIGEST = /^[a-f0-9]{64}$/
/** Surface stricter than v3: a revision is a token (no spaces), and is never drawn. */
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
/** OmegaAtom's canonical evidence link `ev:<owner>:<sequence>` (omegaatom/envelope.py TOKEN and sequence rules). */
const ATOM_OWNER = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
// eslint-disable-next-line no-control-regex
const CONTROL_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f]/
/** an Atom evidence sequence is a positive signed 64-bit integer */
const MAX_SEQUENCE = BigInt('9223372036854775807')

function obj(v: unknown, where: string, required: readonly string[], optional: readonly string[] = []): Obj {
  if (!isObj(v)) bad(`${where}: not an object`)
  const o = v as Obj
  const allowed = new Set([...required, ...optional])
  for (const k of Object.keys(o)) if (!allowed.has(k)) bad(`${where}: an unknown key`)
  for (const k of required) if (!(k in o)) bad(`${where}: missing ${k}`)
  return o
}
function str(v: unknown, where: string, max: number): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > max || CONTROL.test(v)) bad(`${where}: not a string of 1–${max}`)
  return v as string
}
/** Plain-word text (explanations): tab and newline allowed. */
function text(v: unknown, where: string, max = 2000): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > max || CONTROL_TEXT.test(v)) bad(`${where}: not a text of 1–${max}`)
  return v as string
}
const nullable = <T,>(v: unknown, read: (x: unknown) => T): T | null => (v === null ? null : read(v))
function oneOf<T extends string>(v: unknown, where: string, allowed: readonly T[]): T {
  if (!allowed.includes(v as T)) bad(`${where}: not one of the published values`)
  return v as T
}
function time(v: unknown, where: string): string {
  const m = typeof v === 'string' && v.length <= 40 ? ISO_UTC.exec(v) : null
  if (!m) return bad(`${where}: not an ASCII ISO-8601 UTC time`)
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number)
  // proleptic Gregorian years 1..9999, as the reference's datetime; year 0 does not exist
  if (y < 1) badValue(`${where}: year 0`)
  // the EXACT year: Date.UTC would read years 0–99 as 1900–1999 (Root 161705Z), so build it with setUTCFullYear
  const t = new Date(0)
  t.setUTCFullYear(y, mo - 1, d)
  t.setUTCHours(h, mi, se, 0)
  // a round trip: 2026-02-30, 0100-02-29 or 24:00 would normalise to another moment, so it is not this time
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || t.getUTCHours() !== h || t.getUTCMinutes() !== mi || t.getUTCSeconds() !== se) badValue(`${where}: not a calendar time`)
  return v as string
}
/** v3 temporal coordinate: a non-negative safe integer (Unix seconds); never an ISO string. */
function seconds(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) bad(`${where}: not non-negative safe integer seconds`)
  return v as number
}
/** v3 interval: [start, end] in seconds, nonempty (start < end); never an object. */
function interval(v: unknown, where: string): Interval {
  if (!Array.isArray(v) || v.length !== 2) bad(`${where}: not a [start, end] pair`)
  const [s, e] = [seconds((v as unknown[])[0], `${where}[0]`), seconds((v as unknown[])[1], `${where}[1]`)]
  if (s >= e) badValue(`${where}: empty or backwards`)
  return [s, e]
}
function num(v: unknown, where: string, min = -Infinity, max = Infinity): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) bad(`${where}: not a number in range`)
  return v as number
}
function list(v: unknown, where: string, max: number): unknown[] {
  if (!Array.isArray(v)) bad(`${where}: not a list`)
  if ((v as unknown[]).length > max) bad(`${where}: over the limit of ${max}`)
  return v as unknown[]
}
const rows = <T,>(v: unknown, where: string, each: (o: unknown, w: string) => T, max = 64): T[] => list(v, where, max).map((x, i) => each(x, `${where}[${i}]`))
/** ids unique within each list (v3 reference check). */
function uniqueIds(xs: { id: string }[], where: string): void {
  if (new Set(xs.map((x) => x.id)).size !== xs.length) bad(`${where}: a repeated id`, where === 'temporal content' ? 'duplicate-temporal-id' : 'duplicate-content-id')
}
function evidenceRef(v: unknown, where: string): string {
  const s = str(v, where, 160)
  const m = /^ev:(.+):([1-9][0-9]*)$/.exec(s)
  if (!m || !ATOM_OWNER.test(m[1]) || BigInt(m[2]) > MAX_SEQUENCE) badValue(`${where}: not a canonical Atom evidence link`)
  return s
}
function refs(v: unknown, where: string, max: number): string[] {
  const out = rows(v, where, evidenceRef, max)
  // evidence links are unique within one list; repeats across rows are allowed
  if (new Set(out).size !== out.length) badValue(`${where}: a repeated reference`)
  return out
}
const codes = (v: unknown, where: string, allowed: readonly string[]) => rows(v, where, (x, w) => oneOf(x, w, allowed), 16)
function truth(v: unknown, where: string): Truth | null {
  // typed NALTV {f, c}: f in [0, 1], c in [0, 1); null is unknown truth (never computed here)
  if (v === null) return null
  const o = obj(v, where, ['f', 'c'])
  const c = num(o.c, `${where}.c`, 0, 1)
  if (c >= 1) bad(`${where}.c: confidence must be below 1`)
  return { f: num(o.f, `${where}.f`, 0, 1), c }
}
const edges = (v: unknown, where: string): Edge[] =>
  rows(v, where, (x, w) => {
    const o = obj(x, w, ['from', 'to', 'weight', 'explain'])
    return { from: str(o.from, `${w}.from`, 160), to: str(o.to, `${w}.to`, 160), weight: num(o.weight, `${w}.weight`), explain: text(o.explain, `${w}.explain`) }
  }, LIMITS.maxEdges)
/** A lone (unpaired) UTF-16 surrogate: a string that cannot be encoded as UTF-8. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
/**
 * The reference's `_json_tree`, ported: nesting deeper than 32 is `unreadable-value`; any string VALUE that is not
 * well-formed Unicode (an unpaired surrogate) is `unreadable-json`, before any shape is read (stand-in r4 P2). Keys are
 * left to the closed-key rule (an unknown key is unreadable-schema), as in the reference.
 */
function tree(v: unknown, d = 0): void {
  if (d > LIMITS.maxDepth) badValue('nested too deeply')
  if (typeof v === 'string') {
    if (LONE_SURROGATE.test(v)) bad('not well-formed Unicode', 'unreadable-json')
  } else if (Array.isArray(v)) v.forEach((x) => tree(x, d + 1))
  else if (isObj(v)) Object.values(v).forEach((x) => tree(x, d + 1))
}
function bytes(v: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(v)).length
  } catch {
    return Infinity
  }
}

// ------------------------------------------------------------------ the envelope

const COMMON = ['module', 'mind_id', 'revision', 'observed_at', 'qualification', 'available', 'state', 'unavailable_reason', 'items', 'provenance', 'explain'] as const
export const MODULE_FIELDS: Record<ModuleId, readonly string[]> = {
  attention: ['focus_ref', 'ranked_items', 'spread_edges'],
  energy: ['mode', 'budget', 'next_wake_at', 'sleep_until'],
  self: ['skills', 'selected_skill', 'selection_reason_codes'],
  scratch: ['promotion_reasons', 'demotion_reasons'],
  assume: ['model_ref', 'nodes', 'edges', 'prediction', 'observed_target', 'update_delta'],
  temporal: ['events', 'rules', 'expectations', 'projection', 'interval_relations', 'explanation_refs'],
}
const STATES: readonly EnvelopeState[] = ['current', 'unavailable', 'synthetic', 'banked']
const REASONS: readonly UnavailableReason[] = ['no_reader', 'withheld', 'stale']
const READ_PATH: Record<EnvelopeState, ReadPath> = { current: 'host-consent-filtered-snapshot', synthetic: 'synthetic-fixture', banked: 'banked-receipt', unavailable: 'none' }

function provenance(v: unknown, state: EnvelopeState): Provenance {
  const p = obj(v, 'provenance', ['source_revision', 'evidence_refs', 'read_path', 'authority'])
  const read_path = oneOf(p.read_path, 'provenance.read_path', ['host-consent-filtered-snapshot', 'synthetic-fixture', 'banked-receipt', 'none'] as const)
  if (read_path !== READ_PATH[state]) bad('provenance.read_path: not the one for this state')
  if (p.authority !== 'none') bad('provenance.authority: not none')
  const source_revision = nullable(p.source_revision, (x) => str(x, 'provenance.source_revision', 128))
  if (state === 'current' && source_revision === null) bad('provenance.source_revision: required on a current read')
  if (state === 'unavailable' && source_revision !== null) bad('provenance.source_revision: on an unavailable read')
  const evidence_refs = refs(p.evidence_refs, 'provenance.evidence_refs', 64)
  if (state === 'unavailable' && evidence_refs.length) bad('provenance.evidence_refs: on an unavailable read')
  return { source_revision, read_path, authority: 'none', evidence_refs }
}

function generalItems(v: unknown): Item[] {
  const out = rows(v, 'items', (x, w) => {
    const o = obj(x, w, ['id', 'kind', 'explain'], ['label'])
    return { id: str(o.id, `${w}.id`, 160), kind: str(o.kind, `${w}.kind`, 80), ...('label' in o ? { label: str(o.label, `${w}.label`, 128) } : {}), explain: text(o.explain, `${w}.explain`) }
  })
  uniqueIds(out, 'items')
  return out
}

function body(m: ModuleId, o: Obj): ModuleBody {
  switch (m) {
    case 'attention': {
      const ranked_items = rows(o.ranked_items, 'ranked_items', (x, w) => {
        const r = obj(x, w, ['id', 'label', 'score', 'reason_codes', 'explain'])
        return { id: str(r.id, `${w}.id`, 160), label: str(r.label, `${w}.label`, 128), score: num(r.score, `${w}.score`), reason_codes: codes(r.reason_codes, `${w}.reason_codes`, REASON_CODES.attention), explain: text(r.explain, `${w}.explain`) }
      })
      uniqueIds(ranked_items, 'ranked_items')
      return { module: m, focus_ref: nullable(o.focus_ref, (x) => str(x, 'focus_ref', 160)), ranked_items, spread_edges: edges(o.spread_edges, 'spread_edges') }
    }
    case 'energy': {
      const b = obj(o.budget, 'budget', ['unit', 'limit', 'reserved', 'spent'])
      return {
        module: m,
        mode: nullable(o.mode, (x) => oneOf(x, 'mode', ENERGY_MODES)),
        budget: { unit: str(b.unit, 'budget.unit', 80), limit: num(b.limit, 'budget.limit', 0), reserved: num(b.reserved, 'budget.reserved', 0), spent: num(b.spent, 'budget.spent', 0) },
        next_wake_at: nullable(o.next_wake_at, (x) => time(x, 'next_wake_at')),
        sleep_until: nullable(o.sleep_until, (x) => time(x, 'sleep_until')),
      }
    }
    case 'self': {
      const skills = rows(o.skills, 'skills', (x, w) => {
        const s = obj(x, w, ['id', 'version', 'label', 'availability', 'source_digest', 'explain'])
        if (typeof s.version !== 'string' || !VERSION.test(s.version)) bad(`${w}.version: not a version`)
        if (typeof s.source_digest !== 'string' || !DIGEST.test(s.source_digest)) bad(`${w}.source_digest: not 64 lowercase hex`)
        return { id: str(s.id, `${w}.id`, 160), version: s.version as string, label: str(s.label, `${w}.label`, 128), availability: oneOf(s.availability, `${w}.availability`, AVAILABILITY), source_digest: s.source_digest as string, explain: text(s.explain, `${w}.explain`) }
      })
      uniqueIds(skills, 'skills')
      const selected_skill = nullable(o.selected_skill, (x) => {
        const s = obj(x, 'selected_skill', ['id', 'selected_at'])
        return { id: str(s.id, 'selected_skill.id', 160), selected_at: time(s.selected_at, 'selected_skill.selected_at') }
      })
      // Surface stricter than v3: the latest selection names one of the skills read with it
      if (selected_skill && !skills.some((s) => s.id === selected_skill.id)) bad('selected_skill: not one of the skills')
      return { module: m, skills, selected_skill, selection_reason_codes: codes(o.selection_reason_codes, 'selection_reason_codes', REASON_CODES.selection) }
    }
    case 'scratch': {
      // scratch's items ARE its body: {id, kind, promotion_state, expiry, explain}; no text, ever
      const items = rows(o.items, 'items', (x, w) => {
        const s = obj(x, w, ['id', 'kind', 'promotion_state', 'expiry', 'explain'])
        return { id: str(s.id, `${w}.id`, 160), kind: str(s.kind, `${w}.kind`, 80), promotion_state: oneOf(s.promotion_state, `${w}.promotion_state`, PROMOTION), expiry: nullable(s.expiry, (t) => time(t, `${w}.expiry`)), explain: text(s.explain, `${w}.explain`) }
      })
      uniqueIds(items, 'items')
      return { module: m, items, promotion_reasons: codes(o.promotion_reasons, 'promotion_reasons', REASON_CODES.scratch), demotion_reasons: codes(o.demotion_reasons, 'demotion_reasons', REASON_CODES.scratch) }
    }
    case 'assume': {
      const nodes = rows(o.nodes, 'nodes', (x, w) => {
        const n = obj(x, w, ['id', 'kind', 'label', 'explain'])
        return { id: str(n.id, `${w}.id`, 160), kind: str(n.kind, `${w}.kind`, 80), label: str(n.label, `${w}.label`, 128), explain: text(n.explain, `${w}.explain`) }
      })
      uniqueIds(nodes, 'nodes')
      const scalar = (x: unknown, w: string, extra: readonly string[]) => obj(x, w, ['target_ref', ...extra, 'unit', 'explain'])
      return {
        module: m,
        model_ref: nullable(o.model_ref, (x) => str(x, 'model_ref', 160)),
        nodes,
        edges: edges(o.edges, 'edges'),
        prediction: nullable(o.prediction, (x) => {
          const p = scalar(x, 'prediction', ['value'])
          return { target_ref: str(p.target_ref, 'prediction.target_ref', 160), value: num(p.value, 'prediction.value'), unit: str(p.unit, 'prediction.unit', 80), explain: text(p.explain, 'prediction.explain') }
        }),
        observed_target: nullable(o.observed_target, (x) => {
          const p = scalar(x, 'observed_target', ['value', 'observed_at'])
          return { target_ref: str(p.target_ref, 'observed_target.target_ref', 160), value: num(p.value, 'observed_target.value'), unit: str(p.unit, 'observed_target.unit', 80), observed_at: time(p.observed_at, 'observed_target.observed_at'), explain: text(p.explain, 'observed_target.explain') }
        }),
        update_delta: nullable(o.update_delta, (x) => {
          const p = scalar(x, 'update_delta', ['before', 'after', 'delta'])
          return { target_ref: str(p.target_ref, 'update_delta.target_ref', 160), before: num(p.before, 'update_delta.before'), after: num(p.after, 'update_delta.after'), delta: num(p.delta, 'update_delta.delta'), unit: str(p.unit, 'update_delta.unit', 80), explain: text(p.explain, 'update_delta.explain') }
        }),
      }
    }
    case 'temporal': {
      const events = rows(o.events, 'events', (x, w) => {
        const e = obj(x, w, ['id', 'term', 'occurrence_time', 'recorded_time', 'valid_interval', 'truth', 'evidence_refs', 'explain'])
        return { id: str(e.id, `${w}.id`, 160), term: str(e.term, `${w}.term`, 512), occurrence_time: seconds(e.occurrence_time, `${w}.occurrence_time`), recorded_time: seconds(e.recorded_time, `${w}.recorded_time`), valid_interval: interval(e.valid_interval, `${w}.valid_interval`), truth: truth(e.truth, `${w}.truth`), evidence_refs: refs(e.evidence_refs, `${w}.evidence_refs`, 16), explain: text(e.explain, `${w}.explain`) }
      })
      const rules = rows(o.rules, 'rules', (x, w) => {
        const r = obj(x, w, ['id', 'premise', 'conclusion', 'lag', 'truth', 'evidence_refs', 'explain'])
        return { id: str(r.id, `${w}.id`, 160), premise: str(r.premise, `${w}.premise`, 512), conclusion: str(r.conclusion, `${w}.conclusion`, 512), lag: seconds(r.lag, `${w}.lag`), truth: truth(r.truth, `${w}.truth`), evidence_refs: refs(r.evidence_refs, `${w}.evidence_refs`, 16), explain: text(r.explain, `${w}.explain`) }
      })
      const expectations = rows(o.expectations, 'expectations', (x, w) => {
        const e = obj(x, w, ['id', 'rule_ref', 'term', 'due_interval', 'state', 'late', 'explain'])
        if (typeof e.late !== 'boolean') bad(`${w}.late: not a boolean`)
        return { id: str(e.id, `${w}.id`, 160), rule_ref: str(e.rule_ref, `${w}.rule_ref`, 160), term: str(e.term, `${w}.term`, 512), due_interval: interval(e.due_interval, `${w}.due_interval`), state: oneOf(e.state, `${w}.state`, EXPECTATIONS), late: e.late as boolean, explain: text(e.explain, `${w}.explain`) }
      })
      uniqueIds(events, 'events')
      uniqueIds(rules, 'rules')
      uniqueIds(expectations, 'expectations')
      // evidence-bearing temporal content ids are unique across events, rules and expectations too
      uniqueIds([...events, ...rules, ...expectations], 'temporal content')
      return {
        module: m,
        events,
        rules,
        expectations,
        projection: nullable(o.projection, (x) => {
          const p = obj(x, 'projection', ['source_time', 'target_time', 'truth_before', 'truth_after', 'model_ref', 'explain'])
          return { source_time: seconds(p.source_time, 'projection.source_time'), target_time: seconds(p.target_time, 'projection.target_time'), truth_before: truth(p.truth_before, 'projection.truth_before'), truth_after: truth(p.truth_after, 'projection.truth_after'), model_ref: str(p.model_ref, 'projection.model_ref', 160), explain: text(p.explain, 'projection.explain') }
        }),
        interval_relations: rows(o.interval_relations, 'interval_relations', (x, w) => {
          const r = obj(x, w, ['left_ref', 'right_ref', 'relation', 'explain'])
          return { left_ref: str(r.left_ref, `${w}.left_ref`, 160), right_ref: str(r.right_ref, `${w}.right_ref`, 160), relation: oneOf(r.relation, `${w}.relation`, RELATIONS), explain: text(r.explain, `${w}.explain`) }
        }, LIMITS.maxEdges),
        explanation_refs: refs(o.explanation_refs, 'explanation_refs', 64),
      }
    }
  }
}

/** Content and edge totals, as v3 counts them (general items + content lists + non-null singletons; edges apart). */
function totals(env: Envelope): { content: number; edges: number } {
  const b = env.body
  const general = b?.module === 'scratch' ? 0 : env.items.length
  if (!b) return { content: general, edges: 0 }
  switch (b.module) {
    case 'attention':
      return { content: general + b.ranked_items.length, edges: b.spread_edges.length }
    case 'energy':
      return { content: general, edges: 0 }
    case 'self':
      return { content: general + b.skills.length + (b.selected_skill ? 1 : 0), edges: 0 }
    case 'scratch':
      return { content: b.items.length, edges: 0 }
    case 'assume':
      return { content: general + b.nodes.length + [b.prediction, b.observed_target, b.update_delta].filter(Boolean).length, edges: b.edges.length }
    case 'temporal':
      return { content: general + b.events.length + b.rules.length + b.expectations.length + (b.projection ? 1 : 0), edges: b.interval_relations.length }
  }
}

/**
 * Read one answer strictly against v3. `expect` is what the caller asked for (v3: required); an envelope for another
 * mind or module is refused. Unavailable carries the common envelope only.
 */
export function parseReasoningRead(raw: unknown, expect: { mindId: string; module: ModuleId }): Parsed {
  try {
    if (typeof expect.mindId !== 'string' || !expect.mindId || !MODULES.includes(expect.module)) bad('the expected mind and module are required', 'expected-context-required')
    if (bytes(raw) > LIMITS.maxBytes) bad('over the byte limit', 'unreadable-value')
    tree(raw)
    if (!isObj(raw)) bad('not an object')
    const o0 = raw as Obj
    const m = oneOf(o0.module, 'module', MODULES)
    const state = oneOf(o0.state, 'state', STATES)
    const unavailable = state === 'unavailable'
    const o = obj(raw, 'envelope', unavailable ? COMMON : [...COMMON, ...MODULE_FIELDS[m]])
    const mind_id = str(o.mind_id, 'mind_id', 100)
    if (mind_id !== expect.mindId || m !== expect.module) bad('not the mind and module asked for', 'wrong-read-context')
    if (o.available !== !unavailable) bad('available: disagrees with state')
    let unavailable_reason: UnavailableReason | null = null
    if (unavailable) unavailable_reason = oneOf(o.unavailable_reason, 'unavailable_reason', REASONS)
    else if (o.unavailable_reason !== null) bad('unavailable_reason: must be null when available')
    const observed_at = unavailable ? (o.observed_at === null ? null : bad('observed_at: must be null when unavailable')) : time(o.observed_at, 'observed_at')
    const revision = o.revision === null ? (unavailable ? null : bad('revision: required when available')) : str(o.revision, 'revision', 128)
    if (revision !== null && !REVISION.test(revision)) bad('revision: not a token')
    const env: Envelope = {
      module: m,
      mind_id,
      revision,
      observed_at,
      qualification: str(o.qualification, 'qualification', 400),
      available: o.available as boolean,
      state,
      unavailable_reason,
      items: m === 'scratch' && !unavailable ? [] : generalItems(o.items),
      provenance: provenance(o.provenance, state),
      explain: text(o.explain, 'explain'),
      body: null,
    }
    if (unavailable) {
      if (env.items.length) bad('items: on an unavailable read')
      return { ok: true, envelope: env }
    }
    env.body = body(m, o)
    const t = totals(env)
    if (t.content > LIMITS.maxContent) bad('over the content limit', 'aggregate-content-limit')
    if (t.edges > LIMITS.maxEdges) bad('over the edge limit', 'aggregate-edge-limit')
    return { ok: true, envelope: env }
  } catch (e) {
    if (e instanceof Bad) return { ok: false, why: e.code }
    return { ok: false, why: 'unreadable-value' }
  }
}

/**
 * Root's `meaningful_state()` field table (v3 r2 `empty_semantics`), exactly: a field is present when it is neither
 * null nor an empty list. Empty only when no meaningful field is held; a primary list may be empty while secondary
 * state is present, and that state is shown. The energy budget object is itself held. The overall explanation,
 * qualification and provenance never count.
 */
export const MEANINGFUL: Record<ModuleId, readonly string[]> = {
  attention: ['items', 'focus_ref', 'ranked_items', 'spread_edges'],
  energy: ['items', 'mode', 'budget', 'next_wake_at', 'sleep_until'],
  self: ['items', 'skills', 'selected_skill', 'selection_reason_codes'],
  scratch: ['items', 'promotion_reasons', 'demotion_reasons'],
  assume: ['items', 'model_ref', 'nodes', 'edges', 'prediction', 'observed_target', 'update_delta'],
  temporal: ['items', 'events', 'rules', 'expectations', 'projection', 'interval_relations', 'explanation_refs'],
}
/** The meaningful fields present (names only, as the reference's `present_fields`); [] when unavailable. */
export function presentFields(env: Envelope): string[] {
  const b = env.body as Record<string, unknown> | null
  if (!b) return []
  const value = (k: string) => (k === 'items' ? (env.module === 'scratch' ? b.items : env.items) : b[k])
  return MEANINGFUL[env.module].filter((k) => {
    const v = value(k)
    return v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)
  })
}

/**
 * How much the module holds (a count for the metadata-only PageView). Zero exactly when `presentFields` is empty
 * (Root's meaningful_state): "nothing held right now".
 */
export function heldCount(env: Envelope): number {
  const b = env.body
  if (!b) return 0
  const general = b.module === 'scratch' ? 0 : env.items.length
  switch (b.module) {
    case 'attention':
      return general + b.ranked_items.length + (b.focus_ref ? 1 : 0) + b.spread_edges.length
    case 'energy':
      return general + 1 + (b.mode ? 1 : 0) + (b.next_wake_at ? 1 : 0) + (b.sleep_until ? 1 : 0)
    case 'self':
      return general + b.skills.length + (b.selected_skill ? 1 : 0) + b.selection_reason_codes.length
    case 'scratch':
      return b.items.length + b.promotion_reasons.length + b.demotion_reasons.length
    case 'assume':
      return general + b.nodes.length + b.edges.length + (b.model_ref ? 1 : 0) + [b.prediction, b.observed_target, b.update_delta].filter(Boolean).length
    case 'temporal':
      return general + b.events.length + b.rules.length + b.expectations.length + (b.projection ? 1 : 0) + b.interval_relations.length + b.explanation_refs.length
  }
}
