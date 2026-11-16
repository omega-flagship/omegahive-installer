export interface OutputPage {
  run_id: string
  workspace_id: string
  after: number
  cursor: number
  size_bytes: number
  readable_bytes: number
  data: string
  source: 'live-run-log' | 'unverified-run-log' | 'verified-artifact'
  output_digest: string | null
  status: string
  eof: boolean
  complete: boolean
  truncated: boolean
}

/** Decode byte pages incrementally; replay frozen output after a live-to-artifact transition. */
export class OutputReader {
  cursor = 0
  text = ''
  private source: OutputPage['source'] | null = null
  private digest: string | null = null
  private decoder = new TextDecoder()
  constructor(readonly run: string, readonly workspace: string) {}
  append(page: OutputPage): 'continue' | 'wait' | 'done' | 'replay' {
    if (page.run_id !== this.run || page.workspace_id !== this.workspace || page.after !== this.cursor ||
        ![page.cursor, page.size_bytes, page.readable_bytes].every(Number.isSafeInteger) ||
        page.cursor < page.after || page.cursor > page.readable_bytes || page.readable_bytes > 4194304 ||
        page.readable_bytes < 0 || page.readable_bytes > page.size_bytes) throw new Error('Output page does not match the selected run or cursor')
    const bytes = Uint8Array.from(atob(page.data), (c) => c.charCodeAt(0))
    if (bytes.length > 16384 || page.cursor !== this.cursor + bytes.length) throw new Error('Output byte cursor is invalid')
    if (this.source && this.source !== 'verified-artifact' && page.source === 'verified-artifact' && this.cursor > 0) return 'replay'
    if (this.source === 'verified-artifact' && (page.source !== this.source || page.output_digest !== this.digest)) throw new Error('Output artifact changed while reading')
    this.source = page.source; this.digest = page.output_digest
    this.cursor = page.cursor
    const done = page.complete || (page.truncated && this.cursor === page.readable_bytes)
    this.text += this.decoder.decode(bytes, { stream: !done })
    if (done) return 'done'
    return bytes.length && this.cursor < page.readable_bytes ? 'continue' : 'wait'
  }
}
