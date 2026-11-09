import { describe, expect, it } from 'vitest'
import { savedHunkRanges, savedSelection, sha256 } from './savedSelection'

// Reproduces the utility's own documented checks (check_saved_selection.mjs) against the port.
const encode = (text: string) => new TextEncoder().encode(text)

describe('savedSelection port: roundtrip every character and EOF', () => {
  for (const text of ['abc\n', 'Ω😀é\r\n尾\n', '﻿😀\n', '']) {
    it(`roundtrips ${JSON.stringify(text)}`, async () => {
      const bytes = encode(text)
      const digest = await sha256(bytes)
      let utf16 = 0
      let byte = 0
      for (const character of text) {
        const next16 = utf16 + character.length
        const nextByte = byte + encode(character).length
        expect(await savedSelection(bytes, digest, text, utf16, next16)).toEqual({ source_digest: digest, start_byte: byte, end_byte: nextByte })
        const h = { id: 'a'.repeat(64), expected_file_digest: digest, start_byte: byte, end_byte: nextByte, before_digest: await sha256(encode(character)), replacement: '✓' }
        expect(await savedHunkRanges(bytes, digest, text, [h])).toEqual([{ id: h.id, from: utf16, to: next16, before: character, after: '✓' }])
        if (character.length === 2) await expect(savedSelection(bytes, digest, text, utf16 + 1, next16)).rejects.toThrow(/splits/)
        if (nextByte - byte > 1) await expect(savedHunkRanges(bytes, digest, text, [{ ...h, start_byte: byte + 1 }])).rejects.toThrow(/splits/)
        utf16 = next16
        byte = nextByte
      }
      expect((await savedSelection(bytes, digest, text, text.length, text.length)).start_byte).toBe(bytes.length)
    })
  }
})

describe('savedSelection port: refusals', () => {
  const text = 'Ω😀\r\nx'
  const bytes = encode(text)

  it('handoff example: emoji UTF-16 offsets 1–3 map to exact bytes 2–6 and back', async () => {
    const digest = await sha256(bytes)
    expect(await savedSelection(bytes, digest, text, 1, 3)).toEqual({ source_digest: digest, start_byte: 2, end_byte: 6 })
    const h = { id: 'c'.repeat(64), expected_file_digest: digest, start_byte: 2, end_byte: 6, before_digest: await sha256(encode('😀')), replacement: '🙂' }
    expect(await savedHunkRanges(bytes, digest, text, [h])).toEqual([{ id: h.id, from: 1, to: 3, before: '😀', after: '🙂' }])
  })

  it('dirty / digest / offsets / reversed / invalid UTF-8', async () => {
    const digest = await sha256(bytes)
    await expect(savedSelection(bytes, digest, text + 'dirty', 0, 1)).rejects.toThrow(/dirty/)
    await expect(savedSelection(bytes, 'f'.repeat(64), text, 0, 1)).rejects.toThrow(/digest/)
    for (const from of [-1, NaN, Infinity, 1.5, true as unknown as number, 999]) await expect(savedSelection(bytes, digest, text, from, from)).rejects.toThrow()
    await expect(savedSelection(bytes, digest, text, 3, 0)).rejects.toThrow(/Reversed/)
    const invalid = new Uint8Array([255])
    await expect(savedSelection(invalid, await sha256(invalid), '', 0, 0)).rejects.toThrow()
  })

  it('hunk: before / stale file / unpaired surrogate / range / duplicate', async () => {
    const digest = await sha256(bytes)
    const h = { id: 'b'.repeat(64), expected_file_digest: digest, start_byte: 0, end_byte: 2, before_digest: await sha256(encode('Ω')), replacement: 'ok' }
    expect((await savedHunkRanges(bytes, digest, text, [h]))[0].before).toBe('Ω')
    for (const changed of [{ ...h, before_digest: 'f'.repeat(64) }, { ...h, expected_file_digest: 'f'.repeat(64) }, { ...h, replacement: '\ud800' }, { ...h, end_byte: 0 }]) {
      await expect(savedHunkRanges(bytes, digest, text, [changed])).rejects.toThrow()
    }
    await expect(savedHunkRanges(bytes, digest, text, [h, h])).rejects.toThrow()
  })

  it('caller mutation of bytes or hunk fields cannot race the result', async () => {
    const digest = await sha256(bytes)
    const mutable = bytes.slice()
    const pending = savedSelection(mutable, digest, text, 0, 1)
    mutable.fill(0)
    expect((await pending).end_byte).toBe(2)
    const h = { id: 'b'.repeat(64), expected_file_digest: digest, start_byte: 0, end_byte: 2, before_digest: await sha256(encode('Ω')), replacement: 'ok' }
    const mutableHunk = { ...h }
    const hunkPending = savedHunkRanges(bytes, digest, text, [mutableHunk])
    mutableHunk.replacement = 'raced'
    expect((await hunkPending)[0].after).toBe('ok')
  })
})
