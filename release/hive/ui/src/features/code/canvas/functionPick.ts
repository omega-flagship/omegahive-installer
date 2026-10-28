/**
 * Whole-function pick (Surface, Code canvas phase 2; gap inventory row 26), over OmegaCode's relayed
 *   POST /v1/workspaces/{ws}/function-scope-preview   read: the exact saved function around a byte caret
 *   POST /v1/workspaces/{ws}/function-scopes          read action, HUMAN only: a scope of exactly that function
 * (suggestions.py function_scope_preview / create_function_scope; host relay d5f608a code.py 76–77). Python only for now
 * (the service answers 415 function_language otherwise). The preview issues nothing (`scope_issued: false`); the
 * person issues the scope when they ask for a change on the picked function.
 */

export interface FunctionPreview {
  start_byte: number
  end_byte: number
  caret_byte: number
  source_digest: string
  selection_digest: string
}
/** A picked function, bound to the saved file and generation it was picked on, with its editor range. */
export interface FunctionPick extends FunctionPreview {
  name: string
  path: string
  digest: string
  generation: number
  from: number
  to: number
}

const nat = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

/** Strict: the service's preview for `path`, nothing issued, a non-empty range around the caret. */
export function parseFunctionPreview(raw: unknown, path: string): FunctionPreview {
  const bad = (why: string): never => {
    throw new Error(`The function preview was not understood (${why}).`)
  }
  if (!raw || typeof raw !== 'object') return bad('not an object')
  const r = raw as Record<string, unknown>
  const s = r.selection as Record<string, unknown> | undefined
  if (r.scope_issued !== false) bad('a preview must not issue a scope')
  if (typeof r.selection_digest !== 'string' || !/^[a-f0-9]{64}$/.test(r.selection_digest)) bad('selection digest')
  if (!s || typeof s !== 'object' || s.path !== path) bad('another file')
  if (!nat(s!.start_byte) || !nat(s!.end_byte) || !nat(s!.caret_byte) || s!.start_byte >= s!.end_byte || s!.caret_byte < s!.start_byte || s!.caret_byte >= s!.end_byte) bad('range')
  if (typeof s!.source_digest !== 'string') bad('source digest')
  return { start_byte: s!.start_byte as number, end_byte: s!.end_byte as number, caret_byte: s!.caret_byte as number, source_digest: s!.source_digest as string, selection_digest: r.selection_digest as string }
}

/** A saved UTF-8 byte offset → editor (UTF-16) offset; null when it falls inside a character. */
export function utf16At(text: string, byte: number): number | null {
  let b = 0
  let u = 0
  for (const ch of text) {
    if (b === byte) return u
    if (b > byte) return null
    const cp = ch.codePointAt(0)!
    b += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    u += ch.length
  }
  return b === byte ? u : null
}

/** An editor offset → saved UTF-8 byte offset. */
export const byteAt = (text: string, offset: number): number => new TextEncoder().encode(text.slice(0, offset)).length

/** The function or class name at an offset (the name in `def name(` / `class Name`), or null. */
export function defNameAt(text: string, offset: number): string | null {
  const start = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
  const end = text.indexOf('\n', offset)
  const line = text.slice(start, end === -1 ? text.length : end)
  const m = /^(\s*)(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/.exec(line)
  if (!m) return null
  const a = start + m[0].length - m[2].length
  return offset >= a && offset <= a + m[2].length ? m[2] : null
}
