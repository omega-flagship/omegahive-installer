/**
 * The personal mind's space: one MeTTaScript runner holding the hive's lib_nal, lib_pln and lib_hive (vendored, pinned)
 * and lib_mind, the schema and laws written on them. Synchronous; the worker runs it, and the tests run it directly.
 *
 * What runs where:
 *  - MeTTa (lib_mind over lib_hive/lib_nal/lib_pln): every stored atom, truth value and stamp; revision and the
 *    disjoint-evidence check (hive-integrate!); evidence minting; admission (watermark, id and word tombstones);
 *    forgetting; attention (promotion, decayed as the minds' get-promotion); recall's selection, scoring and ranking;
 *    provenance (the &history journal); PLN inference (|~pln) and its term priors (STV); the merge rules of import.
 *  - TypeScript: argument checks; word fingerprints (salted SHA-256 of the normalised words: MeTTaScript has no hash);
 *    vector similarity (the Embedder, cosine) to find recall candidates; reading results into plain values; the file
 *    header and the check that every atom of an imported file has a known shape.
 */
import { MeTTa, type Atom } from '@mettascript/hyperon'
import { PETTA_STDLIB_SRC } from '@mettascript/core'
import { lexicalEmbedder, normalise, type Embedder } from '../askMemory/embed'
import { sha256 } from '../askMemory/hash'
import { call, evVal, isSym, readStamp, readStv, show, stvVal, sym, toAtom, toVal, type Evidence, type Stv, type Val } from './atoms'
import { MIND_SOURCES } from './sources'
import { VectorIndex, type EntryType } from './vectors'
import {
  ID_RE, KIND_RE, MAX_TEXT, TERM_RE,
  type Belief, type EvidenceOpts, type Explanation, type HistoryEvent, type ImportReport, type InferTrace, type Integrated,
  type Outcome, type Premise, type PlnRule, type RecallItem, type RecallResult, type Refusal, type Refused, type SpaceStats,
  type WhenOpts,
} from './types'

export const FORMAT = 'omegahive-mind-space'
export const FORMAT_VERSION = 1
export const ENGINE = 'MeTTaScript-3.4.0'
/** Recall hands the space this many times `limit` vector candidates (the minds' promotionInflationFactor idea). */
export const RECALL_INFLATION = 3
/** Beliefs below this confidence are not recalled. */
export const RECALL_MIN_CONFIDENCE = 0.05

export class MindError extends Error {
  constructor(readonly code: 'invalid' | 'engine' | 'bad-file', message: string) {
    super(message)
  }
}

export interface MindCoreOptions {
  embedder?: Embedder
  /** seconds since the epoch */
  now?: () => number
  /** this space's evidence agent and salt (fresh random ones by default) */
  self?: string
  salt?: string
  /** stored vectors to reuse on restore, when their embedder matches */
  vectors?: { embedder: string; entries: [string, EntryType, Float32Array][] }
}

const randomHex = (bytes: number) => {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}
const NONE = sym('none')
const classOf = (v: Val): EntryType => (isSym(v, 'Memory') ? 'memory' : 'belief')
/** Said with every answer whose evidence was minted (the caller passed none). */
export const MINTED_WARNING = 'evidence minted: this source sent again without the same evidence ids counts as new evidence and revises'
const refused = (r: Refusal, why?: string): Refused => ({ ok: false, refused: r, ...(why ? { why } : {}) })

function checkStv(t: Stv): void {
  // No default frequency: a source that cannot give one must say so by not storing a truth value it does not have.
  if (!t || typeof t.f !== 'number' || !Number.isFinite(t.f) || t.f < 0 || t.f > 1) throw new MindError('invalid', 'frequency must be given, in [0, 1]')
  if (typeof t.c !== 'number' || !Number.isFinite(t.c) || t.c <= 0 || t.c >= 1) throw new MindError('invalid', 'confidence must be in (0, 1)')
}
function checkId(id: string, what = 'id'): void {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new MindError('invalid', `${what} must match ${ID_RE}`)
}
function checkText(text: string): void {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) throw new MindError('invalid', `text must be 1..${MAX_TEXT} characters`)
}
function checkEvidence(ev: Evidence[]): void {
  if (!Array.isArray(ev) || ev.length === 0 || ev.length > 256) throw new MindError('invalid', 'evidence must be 1..256 items')
  for (const e of ev) {
    if (typeof e?.agent !== 'string' || !e.agent || e.agent.length > 128 || !Number.isInteger(e.n) || e.n < 0) throw new MindError('invalid', 'evidence is (agent, n)')
  }
}

export class MindCore {
  private readonly m: MeTTa
  readonly vectors: VectorIndex
  private readonly now: () => number
  private salts: string[] = []

  private constructor(opts: MindCoreOptions) {
    this.m = new MeTTa()
    this.m.run(PETTA_STDLIB_SRC)
    for (const [, src] of MIND_SOURCES) this.m.run(src)
    this.vectors = new VectorIndex(opts.embedder ?? lexicalEmbedder)
    this.now = opts.now ?? (() => Date.now() / 1000)
  }

  /** A new, empty space. */
  static create(opts: MindCoreOptions = {}): MindCore {
    const core = new MindCore(opts)
    const self = opts.self ?? `m-${randomHex(8)}`
    const salt = opts.salt ?? randomHex(16)
    core.eval(call('mind-put-all!', [[sym('Self'), self, salt], [sym('Salt'), salt]]))
    core.salts = [salt]
    return core
  }

  /** This space's own saved record (export text), restored as it was: no merge rules, but every atom shape-checked. */
  static restore(text: string, opts: MindCoreOptions = {}): MindCore {
    const core = new MindCore(opts)
    const { mind, history } = core.parseFile(text)
    if (!mind.some((a) => Array.isArray(a) && isSym(a[0], 'Self'))) throw new MindError('bad-file', 'no Self')
    core.eval(call('mind-put-all!', mind))
    core.eval(call('history-put-all!', history))
    core.loadSalts()
    const stored = opts.vectors && opts.vectors.embedder === core.vectors.embedder.id ? new Map(opts.vectors.entries.map(([id, , v]) => [id, v])) : null
    core.reindex(stored)
    return core
  }

  // ---- engine plumbing -----------------------------------------------------------------------------------------

  private eval(atom: Atom): Val {
    const out = this.m.evaluateAtom(atom)
    if (out.length !== 1) throw new MindError('engine', `${String(atom).slice(0, 80)} answered ${out.length} times`)
    const v = toVal(out[0])
    if (Array.isArray(v) && isSym(v[0], 'Error')) throw new MindError('engine', show(v).slice(0, 200))
    return v
  }

  private loadSalts(): void {
    const self = this.eval(call('mind-self'))
    const own = this.list(this.m.run('!(collapse (match &mind (Self $x $s) $s))')[0])
    const all = this.list(this.m.run('!(collapse (match &mind (Salt $s) $s))')[0])
    if (typeof self !== 'string' || own.length !== 1 || typeof own[0] !== 'string') throw new MindError('bad-file', 'Self must be (Self tag salt)')
    this.salts = [own[0] as string, ...all.filter((s): s is string => typeof s === 'string' && s !== own[0]).sort()]
  }

  private list(atoms: Atom[] | undefined): Val[] {
    const v = atoms && atoms.length === 1 ? toVal(atoms[0]) : []
    return Array.isArray(v) ? v : []
  }

  /** The words' fingerprint under every salt this space knows (own salt first). */
  fingerprints(text: string): string[] {
    const n = normalise(text)
    return this.salts.map((salt) => sha256(`mind-space-words:v1\n${salt}\n${n}`))
  }

  private reindex(stored: Map<string, Float32Array> | null): void {
    this.vectors.clear()
    for (const row of this.list([this.m.evaluateAtom(call('mind-texts'))[0]])) {
      const [id, cls, text] = row as [string, Val, string]
      this.vectors.put(id, classOf(cls), text, stored?.get(id))
    }
  }

  private when(opts: WhenOpts | undefined): { at: number; turn: Val } {
    const at = opts?.at ?? this.now()
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) throw new MindError('invalid', 'at must be seconds since the epoch')
    if (opts?.turn !== undefined) checkId(opts.turn, 'turn')
    return { at, turn: opts?.turn ?? NONE }
  }

  private given(opts: EvidenceOpts | undefined): Val {
    if (!opts?.evidence) {
      if (opts?.strictEvidence) throw new MindError('invalid', 'evidence is required (strictEvidence)')
      return sym('mint')
    }
    checkEvidence(opts.evidence)
    return opts.evidence.map(evVal)
  }

  private integrated(id: string, v: Val, minted: boolean): Integrated | Refused {
    if (Array.isArray(v) && isSym(v[0], 'refused')) return refused(((v[1] as { sym: string })?.sym ?? 'invalid') as Refusal)
    if (!Array.isArray(v) || !isSym(v[0], 'integrated') || v.length !== 4) throw new MindError('engine', `unexpected ${show(v)}`)
    const [, before, input, result] = v as [Val, Val[], Val[], Val[]]
    const held = (pair: Val[]) => ({ stv: readStv(pair[0]), stamp: readStamp(pair[1]) })
    const outcome = (result[0] as { sym: string }).sym as Outcome
    return {
      ok: true,
      id,
      outcome,
      before: before.length ? held(before[0] as Val[]) : null,
      input: held(input),
      after: held([result[1], result[2]]),
      ...(minted ? { minted: true as const, warning: MINTED_WARNING } : {}),
    }
  }

  private learn(cls: 'Belief' | 'Memory', id: string, kind: string, text: string, stv: Stv, opts?: EvidenceOpts): Integrated | Refused {
    checkId(id)
    if (typeof kind !== 'string' || !KIND_RE.test(kind)) throw new MindError('invalid', `kind must match ${KIND_RE}`)
    checkText(text)
    checkStv(stv)
    const { at, turn } = this.when(opts)
    const given = this.given(opts)
    const r = this.integrated(id, this.eval(call('mind-learn!', sym(cls), id, kind, text, this.fingerprints(text), stvVal(stv), given, at, turn)), isSym(given, 'mint'))
    if (r.ok && !this.vectors.has(id)) this.vectors.put(id, cls === 'Belief' ? 'belief' : 'memory', text)
    return r
  }

  // ---- the API ---------------------------------------------------------------------------------------------------

  /**
   * Learn a distilled belief about the person: `(Current (Belief id) (stv f c) stamp)` with `(Said id kind text at)`.
   * A repeat of the same id and words is new evidence for it (hive-integrate!: revised when the stamps are disjoint,
   * otherwise a choice). The frequency is the caller's: there is no default of 1.0.
   *
   * EVIDENCE CONTRACT: pass the source's evidence ids (`opts.evidence`). Without them a fresh stamp is minted, so the
   * same source sent twice counts twice and revises (the answer then carries `minted: true` and a warning);
   * `strictEvidence: true` refuses instead.
   */
  addBelief(id: string, kind: string, statement: string, stv: Stv, opts?: EvidenceOpts): Integrated | Refused {
    return this.learn('Belief', id, kind, statement, stv, opts)
  }

  /**
   * Remember an exchange or episode (`kind`: exchange, episode, swarm-talk, ...): `(Current (Memory id) (stv f c)
   * stamp)` with `(Said id kind text at)`, Platform's minds' carrier. Same law, same evidence contract as addBelief.
   * Its truth value is the caller's (e.g. (stv 1.0 c) for "this was said", with c how sure the record is).
   */
  remember(id: string, kind: string, text: string, stv: Stv, opts?: EvidenceOpts): Integrated | Refused {
    return this.learn('Memory', id, kind, text, stv, opts)
  }

  /** New evidence for a held belief or memory, through the same law (revision by lib_hive / lib_nal Truth_Revision). */
  reviseBelief(id: string, stv: Stv, opts?: EvidenceOpts): Integrated | Refused {
    checkId(id)
    checkStv(stv)
    const { at, turn } = this.when(opts)
    const given = this.given(opts)
    return this.integrated(id, this.eval(call('mind-revise!', id, stvVal(stv), given, at, turn)), isSym(given, 'mint'))
  }

  /** It was used in a turn: promote it (+1, at most 10, as the minds' promote). */
  use(id: string, opts?: WhenOpts): { ok: true; attention: number } | Refused {
    checkId(id)
    const { at, turn } = this.when(opts)
    const v = this.eval(call('mind-use!', id, at, turn))
    if (Array.isArray(v) && isSym(v[0], 'used')) return { ok: true, attention: v[2] as number }
    return refused('unknown')
  }

  /**
   * Forget one belief or memory: everything held for it goes, and `(Forgotten id fp at)` refuses it ever after. The
   * same words held under other ids (as old or older) go too (`alsoForgot`).
   */
  forget(id: string, opts?: WhenOpts): { ok: true; removed: number; alsoForgot: string[] } {
    checkId(id)
    const { at, turn } = this.when(opts)
    const v = this.eval(call('mind-forget!', id, at, turn)) as Val[]
    const also = v[3] as string[]
    for (const x of [id, ...also]) this.vectors.delete(x)
    return { ok: true, removed: v[2] as number, alsoForgot: also }
  }

  /** Forget everything held; the watermark `(ForgetAll at)` refuses anything older, from any copy. */
  forgetAll(opts?: WhenOpts): { ok: true; watermark: number; removed: number } {
    const { at, turn } = this.when(opts)
    const v = this.eval(call('mind-forget-all!', at, turn)) as Val[]
    this.vectors.clear()
    return { ok: true, watermark: v[1] as number, removed: v[2] as number }
  }

  /**
   * Recall: the vector index proposes the `limit * RECALL_INFLATION` nearest held ids (TypeScript); the space keeps
   * those held and confident enough, scores them (similarity, truth expectation, attention) and ranks them (MeTTa).
   */
  recall(query: string, limit = 5, opts?: { now?: number; minConfidence?: number }): RecallResult {
    if (typeof query !== 'string') throw new MindError('invalid', 'query must be text')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new MindError('invalid', 'limit must be 1..100')
    const now = opts?.now ?? this.now()
    const minc = opts?.minConfidence ?? RECALL_MIN_CONFIDENCE
    const near = this.vectors.nearest(query, limit * RECALL_INFLATION)
    const embedder = this.vectors.embedder.id
    if (!near.length) return { items: [], candidates: 0, embedder }
    const v = this.eval(call('mind-recall', near.map((n) => [n.id, n.similarity]), limit, now, minc)) as Val[]
    const items: RecallItem[] = v.map((c) => {
      const [, neg, id, cls, similarity, attention, tv, stamp, said] = c as Val[]
      const [kind, text] = said as [string, string]
      return {
        id: id as string, type: classOf(cls), similarity: similarity as number, attention: attention as number, score: -(neg as number),
        text, kind, stv: readStv(tv), stamp: readStamp(stamp),
      }
    })
    return { items, candidates: near.length, embedder }
  }

  /** Where a belief came from: its own journal events, and what else was touched in those turns. */
  explain(id: string): Explanation {
    checkId(id)
    const v = this.eval(call('mind-explain', id)) as Val[]
    const events = (v[2] as Val[]).map((e): HistoryEvent => {
      const [, n, op, at, turn, eid, detail] = e as Val[]
      return {
        event: readStamp([n])[0], op: (op as { sym: string }).sym, at: at as number,
        turn: typeof turn === 'string' ? turn : null, id: typeof eid === 'string' ? eid : null, detail: show(detail),
      }
    })
    const linked = (v[3] as Val[]).map((l) => {
      const [turn, other] = l as [string, string]
      return { turn, id: other, held: this.held(other) }
    })
    return { id, held: this.held(id), events, linked }
  }

  private held(id: string): boolean {
    const v = this.eval(call('mind-held', id))
    return Array.isArray(v) && v.length > 0
  }

  /** A held belief or memory (`type` says which), or null. */
  belief(id: string): Belief | null {
    checkId(id)
    const v = this.eval(call('mind-item', id))
    if (isSym(v, 'none')) return null
    const [, cls, , said, tv, stamp] = v as Val[]
    const [kind, statement, at] = said as [string, string, number]
    return { id, type: classOf(cls), kind, statement, at, stv: readStv(tv), stamp: readStamp(stamp) }
  }

  /**
   * One PLN inference with lib_pln's |~pln on two Inheritance/Implication premises, with the trace the "how" layer
   * shows: premises, rule, the formula's inputs (term priors and premise truths) and the conclusion's truth.
   */
  infer(p1: Premise, p2: Premise): InferTrace | Refused {
    const prem = [p1, p2].map((p) => {
      if (p.link !== 'Inheritance' && p.link !== 'Implication') throw new MindError('invalid', 'link must be Inheritance or Implication')
      if (!TERM_RE.test(p.from) || !TERM_RE.test(p.to)) throw new MindError('invalid', `terms must match ${TERM_RE}`)
      let stv = p.stv
      if (p.belief !== undefined) {
        const b = this.belief(p.belief)
        if (!b) return null
        stv = b.stv
      }
      if (!stv) throw new MindError('invalid', 'a premise needs a truth value or a held belief')
      checkStv(stv)
      return { link: p.link, from: p.from, to: p.to, stv, ...(p.belief !== undefined ? { belief: p.belief } : {}) }
    })
    if (prem.some((p) => p === null)) return refused('unknown', 'premise belief is not held')
    const [a, b] = prem as NonNullable<(typeof prem)[number]>[]
    const atom = (p: typeof a): Val => [[sym(p.link), sym(p.from), sym(p.to)], stvVal(p.stv)]
    const out = this.eval(call('mind-infer', atom(a), atom(b))) as Val[]
    const conclusions = out.map((c) => {
      const [[link, from, to], tv] = c as [[Val, Val, Val], Val]
      const L = (link as { sym: string }).sym, F = (from as { sym: string }).sym, T = (to as { sym: string }).sym
      let rule: PlnRule = 'other'
      let terms: [string, string, string] | null = null
      if (a.link === b.link && L === a.link) {
        if (a.to === b.from && F === a.from && T === b.to) { rule = 'deduction'; terms = [a.from, a.to, b.to] }
        else if (a.from === b.from && F === a.to && T === b.to) { rule = 'induction'; terms = [a.to, b.to, a.from] }
        else if (a.to === b.to && F === a.from && T === b.from) { rule = 'abduction'; terms = [a.from, b.from, a.to] }
      }
      const priors: Record<string, Stv> = {}
      if (terms) {
        const pv = this.eval(call('mind-priors', sym(terms[0]), sym(terms[1]), sym(terms[2]))) as Val[]
        terms.forEach((t, i) => { priors[t] = readStv(pv[i]) })
      }
      const formula = rule === 'deduction' ? 'Truth__Deduction' : rule === 'induction' ? 'Truth__Induction' : rule === 'abduction' ? 'Truth__Abduction' : 'unknown'
      return { rule, formula, inputs: { priors, T1: a.stv, T2: b.stv }, link: L as Premise['link'], from: F, to: T, stv: readStv(tv) }
    })
    return { ok: true, premises: [a, b], conclusions }
  }

  stats(): SpaceStats {
    const v = this.eval(call('mind-stats')) as Val[]
    return { beliefs: v[1] as number, memories: v[2] as number, tombstones: v[3] as number, events: v[4] as number, watermark: v[5] as number }
  }

  // ---- the file: export and import -------------------------------------------------------------------------------

  /** The whole space as MeTTa text: a versioned header, the &mind atoms, then the journal as (History event), each sorted. */
  export(): string {
    const mind = this.list([this.m.evaluateAtom(call('mind-dump'))[0]])
    const history = this.list([this.m.evaluateAtom(call('history-dump'))[0]])
    const lines = [
      `; ${FORMAT} ${FORMAT_VERSION}`,
      `; engine ${ENGINE}; libs lib_nal lib_pln lib_hive (PIN.json) + lib_mind`,
      // canonical order (sorted text), so the same space always exports the same file
      ...mind.map((a) => String(toAtom(a))).sort(),
      ...history.map((a) => `(History ${String(toAtom(a))})`).sort(),
    ]
    return lines.join('\n') + '\n'
  }

  private parseFile(text: string): { mind: Val[]; history: Val[] } {
    if (typeof text !== 'string') throw new MindError('bad-file', 'not text')
    const first = text.slice(0, text.indexOf('\n') >>> 0)
    const m = /^; (\S+) (\d+)$/.exec(first.trim())
    if (!m || m[1] !== FORMAT) throw new MindError('bad-file', 'not a mind space file')
    if (Number(m[2]) !== FORMAT_VERSION) throw new MindError('bad-file', `format version ${m[2]} is not ${FORMAT_VERSION}`)
    let atoms: Val[]
    try {
      atoms = this.m.parseAll(text).map(toVal)
    } catch (e) {
      throw new MindError('bad-file', `unreadable: ${(e as Error).message}`)
    }
    const mind: Val[] = []
    const history: Val[] = []
    for (const a of atoms) {
      if (Array.isArray(a) && isSym(a[0], 'History') && a.length === 2 && checkHistory(a[1])) history.push(a[1])
      else if (checkMind(a)) mind.push(a)
      else throw new MindError('bad-file', `unexpected atom ${show(a).slice(0, 120)}`)
    }
    return { mind, history }
  }

  /**
   * Merge another copy of this person's space (a backup, another tab): tombstones and salts are a union, the watermark
   * the later, evidence counters the larger; beliefs go through hive-integrate! (so the same evidence twice never
   * raises confidence); then everything held is checked again against the merged tombstones and watermark.
   */
  import(text: string, opts?: WhenOpts): ImportReport {
    const { at } = this.when(opts)
    const { mind, history } = this.parseFile(text)
    const of = (head: string) => mind.filter((a) => isSym((a as Val[])[0], head)) as Val[][]
    for (const [, s] of of('Salt')) this.eval(call('mind-merge-salt!', s))
    this.loadSalts()
    for (const [, w] of of('ForgetAll')) this.eval(call('mind-set-watermark!', w))
    let tombstones = 0
    for (const [, id, fp, t] of of('Forgotten')) if (isSym(this.eval(call('mind-merge-tomb!', id, fp, t)), 'added')) tombstones++
    for (const [, agent, n] of of('EvCounter')) this.eval(call('mind-merge-counter!', agent, n))
    for (const h of history) {
      const hv = h as Val[]
      if (isSym(hv[0], 'EvCounter')) this.eval(call('history-merge-counter!', hv[1], hv[2]))
      else this.eval(call('mind-merge-event!', ...hv.slice(1)))
    }
    const currents = new Map(of('Current').map((c) => [((c[1] as Val[])[1]) as string, c]))
    const beliefs = { merged: 0, skipped: 0 }
    const memories = { merged: 0, skipped: 0 }
    for (const [, id, kind, words, t] of of('Said')) {
      const cur = currents.get(id as string)
      const cls = cur ? ((cur[1] as Val[])[0] as Val) : null
      const count = cls && isSym(cls, 'Memory') ? memories : beliefs
      const r = cur ? this.eval(call('mind-merge-item!', cls as Val, id, kind, words, this.fingerprints(words as string), t, cur[2], cur[3])) : null
      if (r && Array.isArray(r) && isSym(r[0], 'merged')) {
        count.merged++
        if (!this.vectors.has(id as string)) this.vectors.put(id as string, classOf(cls as Val), words as string)
      } else count.skipped++
    }
    for (const [, id, v, last] of of('Promotion')) this.eval(call('mind-merge-promotion!', id, v, last))
    for (const [, s, k, o] of of('Chosen')) this.eval(call('mind-merge-chosen!', s, k, o))
    // everything held, checked again against the merged tombstones and watermark
    const items = this.list([this.m.evaluateAtom(call('mind-texts'))[0]]).map((row) => {
      const [id, , words, t] = row as [string, Val, string, number]
      return [id, this.fingerprints(words), t] as Val
    })
    const purged = items.length ? (this.eval(call('mind-sweep!', items, at)) as string[]) : []
    for (const id of purged) this.vectors.delete(id)
    return { ok: true, beliefs, memories, tombstones, watermark: this.stats().watermark, purged }
  }
}

// ---- file shape checks (TypeScript checks shapes only; what the atoms mean is the space's) ------------------------

const str = (v: Val | undefined, max = MAX_TEXT): v is string => typeof v === 'string' && v.length <= max
const num = (v: Val | undefined): v is number => typeof v === 'number' && Number.isFinite(v)
const id = (v: Val | undefined): v is string => typeof v === 'string' && ID_RE.test(v)
const turnOk = (v: Val | undefined) => isSym(v, 'none') || id(v)
// the API's bounds, and the 0.99 that revision can reach: f in [0, 1], c in (0, 1)
const stvOk = (v: Val | undefined) => {
  try {
    const t = readStv(v as Val)
    return Number.isFinite(t.f) && Number.isFinite(t.c) && t.f >= 0 && t.f <= 1 && t.c > 0 && t.c < 1
  } catch {
    return false
  }
}
const stampOk = (v: Val | undefined) => { try { readStamp(v as Val); return true } catch { return false } }
const stmt = (v: Val | undefined) => Array.isArray(v) && v.length === 2 && (isSym(v[0], 'Belief') || isSym(v[0], 'Memory')) && id(v[1])

function checkMind(a: Val): boolean {
  if (!Array.isArray(a) || !a.length) return false
  const [h, ...r] = a
  if (isSym(h, 'Self')) return r.length === 2 && str(r[0], 128) && str(r[1], 128)
  if (isSym(h, 'Salt')) return r.length === 1 && str(r[0], 128)
  if (isSym(h, 'Said')) return r.length === 4 && id(r[0]) && typeof r[1] === 'string' && KIND_RE.test(r[1]) && str(r[2]) && num(r[3])
  if (isSym(h, 'Words')) return r.length === 2 && id(r[0]) && str(r[1], 128)
  if (isSym(h, 'Current')) return r.length === 3 && stmt(r[0]) && stvOk(r[1]) && stampOk(r[2])
  if (isSym(h, 'Chosen')) return r.length === 3 && stmt(r[0]) && stampOk(r[1]) && stampOk(r[2])
  if (isSym(h, 'EvCounter')) return r.length === 2 && str(r[0], 128) && num(r[1])
  if (isSym(h, 'Promotion')) return r.length === 3 && id(r[0]) && num(r[1]) && num(r[2])
  if (isSym(h, 'Forgotten')) return r.length === 3 && id(r[0]) && (isSym(r[1], 'none') || str(r[1], 128)) && num(r[2])
  if (isSym(h, 'ForgetAll')) return r.length === 1 && num(r[0])
  return false
}

function checkHistory(a: Val): boolean {
  if (!Array.isArray(a) || !a.length) return false
  const [h, ...r] = a
  if (isSym(h, 'EvCounter')) return r.length === 2 && str(r[0], 128) && num(r[1])
  if (isSym(h, 'Event')) return r.length === 6 && stampOk([r[0]]) && isSym(r[1]) && num(r[2]) && turnOk(r[3]) && (isSym(r[4], 'none') || id(r[4]))
  return false
}
