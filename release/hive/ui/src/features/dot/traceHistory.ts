import type { HiveClient } from '../../api/client'
import type { Trace, TraceArchiveIndex } from '../../api/types'
import { has, isUnsupported, need } from '../../lib/useResource'

type Phase = 'idle' | 'loading' | 'ready' | 'empty' | 'error' | 'unsupported'
export type HistoryState = {
  phase: Phase
  days: TraceArchiveIndex['days']
  day: string | null
  offset: number
  rows: Trace[]
  error: unknown
}
export const HISTORY_PAGE = 100

/** Read-only, per-client/per-mind history. Superseded responses never cross the selected context. */
export class TraceHistory {
  private state: HistoryState = { phase: 'idle', days: [], day: null, offset: 0, rows: [], error: undefined }
  private listeners = new Set<() => void>()
  private seq = 0
  private stopped = false
  constructor(private client: HiveClient | null, readonly mind: string) {}
  getState = () => this.state
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private set(state: HistoryState) { this.state = state; for (const fn of this.listeners) fn() }
  start() { this.stopped = false }
  stop() { this.stopped = true; this.seq++ }
  clear() {
    this.seq++
    this.set({ phase: 'idle', days: [], day: null, offset: 0, rows: [], error: undefined })
  }
  private failed(error: unknown) {
    // Even refresh failures remove cached private content: this may be a visibility revocation.
    this.set({ ...this.state, phase: isUnsupported(error) ? 'unsupported' : 'error', days: [], rows: [], error })
  }
  async index() {
    const seq = ++this.seq
    this.set({ phase: 'loading', days: [], day: null, offset: 0, rows: [], error: undefined })
    try {
      // An index alone cannot offer a usable history reader.
      if (!has(this.client, 'archivedTraces')) need(this.client, 'archivedTraces', 'Archived history')
      const index = await need(this.client, 'traceArchive', 'Archived history')(this.mind)
      if (seq !== this.seq || this.stopped) return
      if (!Array.isArray(index.days) || index.days.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d.day) || !Number.isSafeInteger(d.entries) || d.entries < 0)) throw new Error('Invalid archive index; refresh the history')
      this.set({ ...this.state, phase: index.days.length ? 'ready' : 'empty', days: index.days })
    } catch (error) { if (seq === this.seq && !this.stopped) this.failed(error) }
  }
  async page(day: string, offset = 0) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid archive page')
    const seq = ++this.seq
    this.set({ ...this.state, phase: 'loading', day, offset, rows: [], error: undefined })
    try {
      const rows = await need(this.client, 'archivedTraces', 'Archived history')(this.mind, day, HISTORY_PAGE, offset)
      if (seq !== this.seq || this.stopped) return
      if (!Array.isArray(rows) || rows.length > HISTORY_PAGE || rows.some(t => t.agent_id !== this.mind || t.created_at.slice(0, 10) !== day || !Number.isSafeInteger(t.id)) || new Set(rows.map(t => t.id)).size !== rows.length) throw new Error('Archive page does not match this mind and day')
      this.set({ ...this.state, phase: rows.length ? 'ready' : 'empty', rows })
    } catch (error) { if (seq === this.seq && !this.stopped) this.failed(error) }
  }
  retry = () => this.state.day ? this.page(this.state.day, this.state.offset) : this.index()
}
