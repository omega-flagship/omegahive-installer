/**
 * PORTED UTILITY (exact semantic port, TypeScript).
 * Source:  the OmegaCode proof of concept (savedSelection.mjs) (Code-owned component utility)
 * sha256:  87d2a9c706c7b552bb0efeaa41a9d0052451529fd64dfcdda379ca809931e44e
 * Handoff: coordination/omegacode/SAVED_SELECTION_ADAPTER_HANDOFF.md
 *
 * Saved UTF-8 bytes <-> editor (CodeMirror) UTF-16 offsets. No scope, edit or network authority: conversion success
 * is never edit authority. The only changes from the original are types and the error class; behaviour, messages and
 * refusal order are the original's. Its own documented checks are reproduced in savedSelection.test.ts.
 */

const encoder = new TextEncoder()
const decoder = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

export async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function saved(bytes: Uint8Array, digest: string, editorText: string): Promise<{ bytes: Uint8Array; text: string }> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 2 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid saved source binding')
  // Own the bytes before awaiting: a caller cannot race mutation of its buffer.
  const owned = bytes.slice()
  if ((await sha256(owned)) !== digest) throw new Error('Saved source digest differs')
  const text = decoder().decode(owned)
  if (typeof editorText !== 'string' || editorText !== text) throw new Error('Save or discard dirty editor changes before selecting saved scope')
  return { bytes: owned, text }
}

function offsets(text: string, positions: number[], mode: 'utf16' | 'bytes'): number[] {
  if (!positions.every(integer)) throw new Error('Invalid source offset')
  const wanted = new Set(positions)
  const result = new Map<number, number>()
  let byte = 0
  let utf16 = 0
  if (wanted.has(0)) result.set(0, 0)
  for (const character of text) {
    byte += encoder.encode(character).length
    utf16 += character.length
    const source = mode === 'utf16' ? utf16 : byte
    if (wanted.has(source)) result.set(source, mode === 'utf16' ? byte : utf16)
  }
  if (result.size !== wanted.size) throw new Error('Offset is outside source or splits a character')
  return positions.map((p) => result.get(p) as number)
}

export interface SavedSelection {
  source_digest: string
  start_byte: number
  end_byte: number
}

/** Editor UTF-16 selection [from, to) on exactly the saved bytes -> saved UTF-8 byte range. Dirty editor text refuses. */
export async function savedSelection(bytes: Uint8Array, digest: string, editorText: string, from: number, to: number): Promise<SavedSelection> {
  const source = await saved(bytes, digest, editorText)
  if (from > to) throw new Error('Reversed selection')
  const [start_byte, end_byte] = offsets(source.text, [from, to], 'utf16')
  return { source_digest: digest, start_byte, end_byte }
}

export interface RetainedHunkInput {
  id: string
  expected_file_digest: string
  start_byte: number
  end_byte: number
  before_digest: string
  replacement: string
}
export interface EditorHunk {
  id: string
  from: number
  to: number
  before: string
  after: string
}

/** Retained hunk byte ranges -> editor UTF-16 positions with verified before text, for display only. */
export async function savedHunkRanges(bytes: Uint8Array, digest: string, editorText: string, input: readonly RetainedHunkInput[]): Promise<EditorHunk[]> {
  if (!Array.isArray(input) || !input.length || input.length > 1000) throw new Error('Invalid hunk count')
  const hunks = input.map((h) => {
    if (!h || typeof h !== 'object') throw new Error('Invalid hunk')
    return { id: h.id, expected_file_digest: h.expected_file_digest, start_byte: h.start_byte, end_byte: h.end_byte, before_digest: h.before_digest, replacement: h.replacement }
  })
  const source = await saved(bytes, digest, editorText)
  const positions = hunks.flatMap((h) => [h.start_byte, h.end_byte])
  const converted = offsets(source.text, positions, 'bytes')
  const result: EditorHunk[] = []
  const ids = new Set<string>()
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i]
    if (typeof h.id !== 'string' || !/^[a-f0-9]{64}$/.test(h.id) || ids.has(h.id) || h.expected_file_digest !== digest || h.start_byte > h.end_byte) throw new Error('Invalid or stale hunk binding')
    ids.add(h.id)
    const before = source.bytes.slice(h.start_byte, h.end_byte)
    if ((await sha256(before)) !== h.before_digest) throw new Error('Hunk before bytes differ')
    if (typeof h.replacement !== 'string' || decoder().decode(encoder.encode(h.replacement)) !== h.replacement || encoder.encode(h.replacement).length > 2 * 1024 * 1024) throw new Error('Invalid replacement text')
    result.push({ id: h.id, from: converted[2 * i], to: converted[2 * i + 1], before: decoder().decode(before), after: h.replacement })
  }
  return result
}
