/**
 * Language features in context (Surface, Code canvas phase 2; gap inventory row 25). Pure helpers over OmegaCode's
 * relayed language routes (service.py language_server_inventory / language_query / completion_preview /
 * apply_completion_preview / apply_language_rename; host relay d5f608a code.py 85–89):
 *
 *   GET  /v1/workspaces/{ws}/language/servers                 read: configured servers per file extension
 *   POST /v1/workspaces/{ws}/language                         read: definition, references, rename (→ a retained
 *                                                             preview), completion (→ a retained query)
 *   POST /v1/workspaces/{ws}/language/completion-previews     read: one item → a retained whole-file preview
 *   POST /v1/workspaces/{ws}/language/completion-applies      EDIT: by preview id, on the same generation
 *   POST /v1/workspaces/{ws}/language/renames                 EDIT: by preview id, on the same generation
 *
 * Everything reads the SAVED source of one generation. Positions are LSP line/character in UTF-16 code units (the
 * service asks servers for utf-16), the same units as the editor. Answers are parsed strictly: anything unexpected is
 * refused, never guessed at. The two edits always go through the host confirm (the canvas's DecisionDialog).
 */

export const LANGUAGE_QUERIES = 'language-server-queries'
export const RENAME_PREVIEW = 'rename-preview'
export const COMPLETION_PREVIEW = 'saved-completion-preview'

export interface LspPos {
  line: number
  character: number
}
export interface Location {
  path: string
  range: { start: LspPos; end: LspPos }
}
export interface RenamePreview {
  preview_id: string
  edits: { path: string; expected_digest: string; content: string }[]
}
export interface CompletionQuery {
  query_id: string
  items: { label: string; detail?: string }[]
}
export interface CompletionPreview {
  id: string
  label: string
  path: string
  content: string
}

export class LanguageAnswerError extends Error {}
const refuse = (what: string): never => {
  throw new LanguageAnswerError(`The language answer was not understood (${what}). Nothing is shown from it.`)
}

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const nat = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const safePath = (p: unknown): p is string => typeof p === 'string' && !!p && p.length <= 1000 && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((x) => x && x !== '.' && x !== '..')
const str = (v: unknown, max = 160): v is string => typeof v === 'string' && !!v && v.length <= max

// ------------------------------------------------------------------ positions

/** Editor offset (UTF-16) → LSP position. */
export function toLsp(text: string, offset: number): LspPos {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)))
  const line = before.split('\n').length - 1
  return { line, character: before.length - (before.lastIndexOf('\n') + 1) }
}

/** LSP position → editor offset, or null when it lies outside the text. */
export function fromLsp(text: string, p: LspPos): number | null {
  if (!nat(p.line) || !nat(p.character)) return null
  let start = 0
  for (let i = 0; i < p.line; i++) {
    const nl = text.indexOf('\n', start)
    if (nl === -1) return null
    start = nl + 1
  }
  const end = text.indexOf('\n', start)
  const len = (end === -1 ? text.length : end) - start
  return p.character <= len ? start + p.character : null
}

/** The identifier under (or just before) an offset. */
export function wordAt(text: string, offset: number): { from: number; to: number; word: string } | null {
  const isW = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c)
  let a = offset
  let z = offset
  if (!isW(text[a]) && isW(text[a - 1])) a = z = offset - 1
  if (!isW(text[a])) return null
  while (a > 0 && isW(text[a - 1])) a--
  while (z < text.length && isW(text[z])) z++
  const word = text.slice(a, z)
  return /^[A-Za-z_]\w*$/.test(word) ? { from: a, to: z, word } : null
}

// ------------------------------------------------------------------ what is offered

/** The configured server for a file (its extension; declared configured, and its executable present), or null. */
export function serverFor(inventory: unknown, path: string): string | null {
  const servers = obj(inventory) && Array.isArray(inventory.servers) ? inventory.servers : []
  const ext = /\.[^./]+$/.exec(path)?.[0]
  if (!ext) return null
  for (const s of servers) {
    if (obj(s) && str(s.id) && Array.isArray(s.extensions) && s.extensions.includes(ext) && s.configured === true && s.executable_present === true) return s.id
  }
  return null
}

/** What the canvas offers for a file: only what the loaded service declares and a server exists for. */
export function languageOffer(features: ReadonlySet<string>, server: string | null): { definition: boolean; rename: boolean; completion: boolean } {
  const q = !!server && features.has(LANGUAGE_QUERIES)
  return { definition: q, rename: q && features.has(RENAME_PREVIEW), completion: q && features.has(COMPLETION_PREVIEW) }
}

// ------------------------------------------------------------------ answers

const pos = (v: unknown): LspPos => (obj(v) && nat(v.line) && nat(v.character) ? { line: v.line, character: v.character } : refuse('position'))

export function parseLocations(raw: unknown): Location[] {
  const r = obj(raw) && obj(raw.result) ? raw.result : refuse('no result')
  if (!Array.isArray(r.locations)) refuse('no locations')
  return (r.locations as unknown[]).slice(0, 100).map((l) => {
    if (!obj(l) || !safePath(l.path) || !obj(l.range)) return refuse('location')
    return { path: l.path, range: { start: pos(l.range.start), end: pos(l.range.end) } }
  })
}

const edits = (v: unknown) => {
  if (!Array.isArray(v) || !v.length || v.length > 200) refuse('edits')
  return (v as unknown[]).map((e) => (obj(e) && safePath(e.path) && typeof e.expected_digest === 'string' && typeof e.content === 'string' ? { path: e.path, expected_digest: e.expected_digest, content: e.content } : refuse('edit')))
}

export function parseRename(raw: unknown): RenamePreview {
  const r = obj(raw) && obj(raw.result) ? raw.result : refuse('no result')
  if (!str(r.preview_id)) refuse('no preview id')
  return { preview_id: r.preview_id as string, edits: edits(r.edits) }
}

export function parseCompletion(raw: unknown): CompletionQuery {
  if (!obj(raw) || !str(raw.completion_query_id) || !obj(raw.result) || !Array.isArray(raw.result.items)) return refuse('completion')
  const items = (raw.result.items as unknown[]).slice(0, 100).map((i) => {
    if (!obj(i) || typeof i.label !== 'string' || !i.label || i.label.length > 400) return refuse('item')
    const doc = obj(i.documentation) && typeof i.documentation.text === 'string' ? i.documentation.text : undefined
    const detail = typeof i.detail === 'string' ? i.detail : doc
    return { label: i.label, ...(detail ? { detail: detail.slice(0, 200) } : {}) }
  })
  return { query_id: raw.completion_query_id, items }
}

export function parseCompletionPreview(raw: unknown): CompletionPreview {
  if (!obj(raw) || !str(raw.id) || !safePath(raw.path)) return refuse('completion preview')
  const e = edits(raw.edits)
  if (e.length !== 1 || e[0].path !== raw.path) refuse('a completion changes only its own file')
  return { id: raw.id, label: typeof raw.label === 'string' ? raw.label : '', path: raw.path, content: e[0].content }
}

// ------------------------------------------------------------------ showing a preview in place

/** The smallest single change from `before` to `after` (UTF-16 offsets into before), or null when equal. */
export function minimalChange(before: string, after: string): { from: number; to: number; insert: string } | null {
  if (before === after) return null
  let a = 0
  while (a < before.length && a < after.length && before[a] === after[a]) a++
  let zb = before.length
  let za = after.length
  while (zb > a && za > a && before[zb - 1] === after[za - 1]) {
    zb--
    za--
  }
  return { from: a, to: zb, insert: after.slice(a, za) }
}

/** Changed whole lines (1-based) when the line count is unchanged (a rename); else one block from minimalChange. */
export function lineChanges(before: string, after: string): { line: number; from: number; to: number; before: string; after: string }[] {
  const b = before.split('\n')
  const a = after.split('\n')
  if (b.length !== a.length) {
    const m = minimalChange(before, after)
    if (!m) return []
    const line = before.slice(0, m.from).split('\n').length
    return [{ line, from: m.from, to: m.to, before: before.slice(m.from, m.to), after: m.insert }]
  }
  const out: { line: number; from: number; to: number; before: string; after: string }[] = []
  let at = 0
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== a[i]) out.push({ line: i + 1, from: at, to: at + b[i].length, before: b[i], after: a[i] })
    at += b[i].length + 1
  }
  return out
}
