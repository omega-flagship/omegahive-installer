import { describe, expect, it } from 'vitest'
import { OutputReader, type OutputPage } from './runOutput'
const page = (bytes: Uint8Array, extra: Partial<OutputPage> = {}): OutputPage => ({
  run_id: 'run_a', workspace_id: 'ws_a', after: 0, cursor: bytes.length, size_bytes: bytes.length,
  readable_bytes: bytes.length, data: btoa(String.fromCharCode(...bytes)), source: 'live-run-log',
  output_digest: null, status: 'running', eof: true, complete: false, truncated: false, ...extra,
})
describe('bounded output reader', () => {
  it('preserves split UTF-8 and distinguishes live EOF from completion', () => {
    const bytes = new TextEncoder().encode('Ω😀\n')
    const reader = new OutputReader('run_a', 'ws_a')
    expect(reader.append(page(bytes.slice(0, 3), { size_bytes: bytes.length, readable_bytes: bytes.length, eof: false }))).toBe('continue')
    expect(reader.text).toBe('Ω')
    expect(reader.append(page(bytes.slice(3), { after: 3, cursor: bytes.length, size_bytes: bytes.length, readable_bytes: bytes.length }))).toBe('wait')
    expect(reader.text).toBe('Ω😀\n')
    expect(reader.append(page(new Uint8Array(), { after: bytes.length, cursor: bytes.length, size_bytes: bytes.length, readable_bytes: bytes.length }))).toBe('wait')
  })
  it('requires replay when live bytes become a verified artifact', () => {
    const reader = new OutputReader('run_a', 'ws_a')
    reader.append(page(new Uint8Array([65])))
    expect(reader.append(page(new Uint8Array(), { after: 1, cursor: 1, size_bytes: 1, readable_bytes: 1,
      source: 'verified-artifact', output_digest: 'digest', complete: true }))).toBe('replay')
    const frozen = new OutputReader('run_a', 'ws_a')
    expect(frozen.append(page(new Uint8Array([66]), { source: 'verified-artifact', output_digest: 'digest', complete: true }))).toBe('done')
    expect(frozen.text).toBe('B')
  })
  it('refuses wrong selection, gaps, invalid byte counts and changing artifact custody', () => {
    const reader = new OutputReader('run_a', 'ws_a')
    for (const extra of [{ run_id: 'run_other' }, { workspace_id: 'ws_other' }, { after: 1 }, { cursor: 2 }, { readable_bytes: -1 }]) {
      expect(() => reader.append(page(new Uint8Array([65]), extra))).toThrow()
    }
    reader.append(page(new Uint8Array([65]), { source: 'verified-artifact', output_digest: 'digest' }))
    expect(() => reader.append(page(new Uint8Array(), { after: 1, cursor: 1, size_bytes: 1, readable_bytes: 1,
      source: 'verified-artifact', output_digest: 'changed' }))).toThrow('artifact changed')
  })
  it('stops at the readable limit without claiming complete output', () => {
    const reader = new OutputReader('run_a', 'ws_a')
    const truncated = page(new Uint8Array([255]), { truncated: true, size_bytes: 2, readable_bytes: 1, eof: false })
    expect(reader.append(truncated)).toBe('done')
    expect(truncated.complete).toBe(false)
    expect(reader.text).toBe('�')
  })
})
