/**
 * The mind's presence on code (Surface, Code canvas phase 1). Jon, 2026-10-06: "someone had already been working on the
 * ability to draw on screen — we need to extend that out to full frontier functionality." This is the Ask presence
 * protocol (UNIVERSAL_ASK_DESIGN §9: look, point, sketch with closed ink shapes) and the Design draft-op stream (2a:
 * cursor with caption, strict validation, the page re-checks) carried over to code:
 *
 *   caret   {line, col16, caption?}         where the mind is, with a short plain caption
 *   select  {from: {line, col16}, to: {…}}  what it is looking at
 *   sketch  {ink, from_line, to_line}       a hand-drawn mark over lines (underline, circle, bracket, arrow, tick, cross)
 *   note    {line, text, tone?}             a short plain note beside a line
 *   type    {hunk, chars}                   the first `chars` characters of a proposed change are written in
 *   clear   {}                              presence ends (ink fades, the caret leaves)
 *
 * Positions, for the live stream's implementers: `line` is 1-based; `col16` is a column in **UTF-16 code units** of
 * that line, exactly as the editor (CodeMirror) and JavaScript strings count, **never bytes** (OmegaCode's hunks are
 * in UTF-8 bytes: convert first, as suggestions/savedSelection does). 👋 is 2 units here and 4 bytes. A column past
 * the end clamps to the end; a column between the two halves of a surrogate pair is refused, as is a bare `col` or any
 * field outside an op's shape.
 *
 * Presentation only, exactly like §9: nothing here edits, saves or decides anything. Captions and notes are plain text
 * (≤ 120), positions are clamped to the document, shapes come from a closed set, a stream has a count cap. Phase 1
 * drives it from the retained proposal (`choreograph`: the change is written in at a watchable pace once the service
 * has retained it); a live Code op stream from the mind (Platform/Codex, modelled on 2a) would feed the same `apply`.
 */

export const INKS = ['underline', 'circle', 'bracket', 'arrow', 'tick', 'cross'] as const
export type Ink = (typeof INKS)[number]
export const CODE_OPS = ['caret', 'select', 'sketch', 'note', 'type', 'clear'] as const
export const MAX_OPS = 400
export const MAX_TEXT = 120

/** 1-based line; column in UTF-16 code units (never bytes). */
export interface Pos {
  line: number
  col16: number
}
export type CodeOp =
  | { op: 'caret'; line: number; col16: number; caption?: string }
  | { op: 'select'; from: Pos; to: Pos }
  | { op: 'sketch'; ink: Ink; from_line: number; to_line: number }
  | { op: 'note'; line: number; text: string; tone?: 'info' | 'warn' }
  | { op: 'type'; hunk: string; chars: number }
  | { op: 'clear' }

/** What the document looks like to the validator: its line count and each line's text (1-based lines, UTF-16). */
export interface DocShape {
  lines: number
  lineText(line: number): string
}

const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const HUNK = /^[A-Za-z0-9_-]{1,80}$/

/** Plain text only: no control characters (a newline becomes a space), at most 120 characters. */
export function plain(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(/\r?\n/g, ' ').trim()
  if (!s || [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return null
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s
}

const exact = (o: Record<string, unknown>, required: string[], optional: string[] = []) => required.every((k) => k in o) && Object.keys(o).every((k) => required.includes(k) || optional.includes(k))
const high = (c: number) => c >= 0xd800 && c <= 0xdbff
const low = (c: number) => c >= 0xdc00 && c <= 0xdfff

/** A position checked against the line's UTF-16 text: clamped to the line, refused inside a surrogate pair. */
function pos(doc: DocShape, raw: unknown): Pos | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!exact(o, ['line', 'col16']) || !int(o.line) || !int(o.col16)) return null
  const l = clamp(o.line, 1, Math.max(1, doc.lines))
  const text = doc.lineText(l)
  const c = clamp(o.col16, 0, text.length)
  if (c > 0 && c < text.length && high(text.charCodeAt(c - 1)) && low(text.charCodeAt(c))) return null
  return { line: l, col16: c }
}

/** One op from outside (a stream, a test), checked against the document on screen; null when it is malformed. */
export function validate(doc: DocShape, raw: unknown): CodeOp | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const lines = Math.max(1, doc.lines)
  switch (o.op) {
    case 'caret': {
      if (!exact(o, ['op', 'line', 'col16'], ['caption'])) return null
      const p = pos(doc, { line: o.line, col16: o.col16 })
      if (!p) return null
      const caption = o.caption === undefined ? undefined : plain(o.caption)
      if (caption === null) return null
      return { op: 'caret', ...p, ...(caption ? { caption } : {}) }
    }
    case 'select': {
      if (!exact(o, ['op', 'from', 'to'])) return null
      const a = pos(doc, o.from)
      const z = pos(doc, o.to)
      if (!a || !z) return null
      const before = a.line < z.line || (a.line === z.line && a.col16 <= z.col16)
      return { op: 'select', from: before ? a : z, to: before ? z : a }
    }
    case 'sketch': {
      if (!exact(o, ['op', 'ink', 'from_line', 'to_line'])) return null
      if (!(INKS as readonly unknown[]).includes(o.ink) || !int(o.from_line) || !int(o.to_line)) return null
      const a = clamp(Math.min(o.from_line, o.to_line), 1, lines)
      const z = clamp(Math.max(o.from_line, o.to_line), 1, lines)
      return { op: 'sketch', ink: o.ink as Ink, from_line: a, to_line: z }
    }
    case 'note': {
      if (!exact(o, ['op', 'line', 'text'], ['tone'])) return null
      const text = plain(o.text)
      if (!int(o.line) || !text || (o.tone !== undefined && o.tone !== 'info' && o.tone !== 'warn')) return null
      return { op: 'note', line: clamp(o.line, 1, lines), text, ...(o.tone ? { tone: o.tone as 'info' | 'warn' } : {}) }
    }
    case 'type':
      if (!exact(o, ['op', 'hunk', 'chars'])) return null
      if (typeof o.hunk !== 'string' || !HUNK.test(o.hunk) || !int(o.chars) || o.chars < 0) return null
      return { op: 'type', hunk: o.hunk, chars: o.chars }
    case 'clear':
      return exact(o, ['op']) ? { op: 'clear' } : null
    default:
      return null
  }
}

/** What is drawn now: the fold of every op so far. */
export interface Presence {
  caret: (Pos & { caption?: string }) | null
  selection: { from: Pos; to: Pos } | null
  inks: { id: number; ink: Ink; from_line: number; to_line: number }[]
  notes: { line: number; text: string; tone: 'info' | 'warn' }[]
  /** characters of each hunk's replacement written in so far */
  typed: Record<string, number>
  count: number
}
export const EMPTY: Presence = { caret: null, selection: null, inks: [], notes: [], typed: {}, count: 0 }

/** Apply one validated op. Over the count cap, ops are ignored (the stream is presentation only). */
export function apply(p: Presence, op: CodeOp): Presence {
  if (p.count >= MAX_OPS && op.op !== 'clear') return p
  const n = { ...p, count: p.count + 1 }
  switch (op.op) {
    case 'caret':
      return { ...n, caret: { line: op.line, col16: op.col16, ...(op.caption ? { caption: op.caption } : {}) } }
    case 'select':
      return { ...n, selection: { from: op.from, to: op.to } }
    case 'sketch':
      // at most 12 marks on screen: the oldest fades first
      return { ...n, inks: [...p.inks, { id: p.count, ink: op.ink, from_line: op.from_line, to_line: op.to_line }].slice(-12) }
    case 'note': {
      const others = p.notes.filter((x) => x.line !== op.line)
      return { ...n, notes: [...others, { line: op.line, text: op.text, tone: op.tone ?? 'info' }].slice(-24) }
    }
    case 'type':
      return { ...n, typed: { ...p.typed, [op.hunk]: Math.max(p.typed[op.hunk] ?? 0, op.chars) } }
    case 'clear':
      return { ...EMPTY, typed: p.typed, notes: p.notes, count: n.count }
  }
}

/** A proposed change as the canvas places it: editor lines and the text it writes. */
export interface PlacedChange {
  id: string
  /** 1-based first and last line of the original text */
  line: number
  lastLine: number
  /** column of the change's start on its first line, in UTF-16 code units */
  col16: number
  after: string
  /** the plain words for it (vibe.describeChange) */
  words: string
}
export interface Step {
  at: number
  op: CodeOp
}

/**
 * The watchable script for a retained proposal: for each change, the caret goes there with its words, the lines are
 * selected and marked, the new text is written in a few characters at a time, and a note is left beside it. Total time
 * is capped (`budget`, ms) however long the change is. Reduced motion: no script; `finalState` is drawn at once.
 */
export function choreograph(changes: readonly PlacedChange[], who: string, budget = 6000): Step[] {
  const steps: Step[] = []
  if (!changes.length) return steps
  const per = Math.max(700, Math.min(2400, budget / changes.length))
  let t = 0
  changes.forEach((c, i) => {
    const caption = plain(`${who}: ${c.words}`) ?? undefined
    steps.push({ at: t, op: { op: 'caret', line: c.line, col16: c.col16, ...(caption ? { caption } : {}) } })
    steps.push({ at: t + per * 0.12, op: { op: 'select', from: { line: c.line, col16: c.col16 }, to: { line: c.lastLine, col16: Number.MAX_SAFE_INTEGER } } })
    steps.push({ at: t + per * 0.2, op: { op: 'sketch', ink: c.lastLine > c.line ? 'bracket' : 'underline', from_line: c.line, to_line: c.lastLine } })
    const chars = [...c.after].length
    const slices = Math.max(1, Math.min(18, chars))
    for (let k = 1; k <= slices; k++) steps.push({ at: t + per * (0.3 + (0.55 * k) / slices), op: { op: 'type', hunk: c.id, chars: Math.round((chars * k) / slices) } })
    steps.push({ at: t + per * 0.9, op: { op: 'note', line: c.lastLine, text: `${i + 1}. ${c.words}` } })
    t += per
  })
  steps.push({ at: t, op: { op: 'clear' } })
  return steps
}

/** Where the script ends, drawn at once (reduced motion, or a person who skips ahead). */
export function finalState(changes: readonly PlacedChange[]): Presence {
  let p = EMPTY
  changes.forEach((c, i) => {
    p = apply(p, { op: 'type', hunk: c.id, chars: [...c.after].length })
    p = apply(p, { op: 'note', line: c.lastLine, text: `${i + 1}. ${c.words}` })
  })
  return p
}
