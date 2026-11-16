/**
 * The language features' state, outside React (p2r2: stand-in Review FIX-FIRST on a921ef9). The same discipline as
 * VibeSession:
 *
 * - **One context at a time.** The context is the capability key (client, task, grant, repository, workspace) plus the
 *   workspace's generation and tree. `setContext` is synchronous: a changed context drops the server inventory and
 *   every preview made under the old one before anything else can use them.
 * - **Inventory keyed and fail closed.** No server is offered until THIS context's inventory read has answered; a late
 *   answer for an earlier context is dropped.
 * - **Previews bound to what made them.** Every rename and completion preview carries its context; applying re-checks
 *   that the context is unchanged and that the loaded service still declares the feature, or refuses.
 * - **Answers matched by identity.** Every request has a sequence number; a completion preview is accepted only for the
 *   same query id, item, context and request that asked for it.
 */
import type { WorkspaceHead } from '../suggestions/contract'
import { describeFailure, newOperationId } from '../suggestions/model'
import { languageOffer, lineChanges, minimalChange, parseCompletion, parseCompletionPreview, parseLocations, parseRename, serverFor, toLsp, LanguageAnswerError, type CompletionPreview, type CompletionQuery, type Location, type RenamePreview } from './language'

type Call = <T>(method: 'GET' | 'POST', p: string, body?: unknown, query?: Record<string, string>) => Promise<T>
export interface Ctx {
  /** the capability context (client, task, grant, repository, workspace) */
  key: string
  call: Call | null
  ws: (WorkspaceHead & { generation: number }) | null
  /** what the loaded service declares for this key; empty unless its read is ready */
  features: ReadonlySet<string>
}
export interface SavedFile {
  path: string
  content: string
  digest: string
}
export interface RenameFile {
  path: string
  changes: { line: number; from: number; to: number; before: string; after: string }[]
}
export interface RenameState {
  ctx: string
  from: string
  to: string
  preview: RenamePreview
  files: RenameFile[]
  generation: number
  tree_digest: string
}
export interface CompletionState {
  ctx: string
  at: number
  path: string
  query: CompletionQuery
  generation: number
  tree_digest: string
  active: number
  preview: (CompletionPreview & { change: { from: number; to: number; insert: string } | null; index: number; query_id: string }) | null
}
export interface LanguageState {
  /** the context the inventory below was read for, and whether it has answered */
  inventory: { ctx: string; status: 'checking' | 'ready' | 'failed'; raw: unknown }
  busy: null | 'definition' | 'rename' | 'complete' | 'apply'
  note: string | null
  rename: RenameState | null
  completion: CompletionState | null
}

/** The context identity: capability key + workspace + generation + tree. */
export const contextOf = (c: Pick<Ctx, 'key' | 'ws'>) => `${c.key}|${c.ws?.id ?? ''}|${c.ws?.generation ?? ''}|${c.ws?.tree_digest ?? ''}`
const why = (e: unknown) => (e instanceof LanguageAnswerError ? e.message : describeFailure(e).text)

export class LanguageSession {
  private state: LanguageState = { inventory: { ctx: '', status: 'checking', raw: null }, busy: null, note: null, rename: null, completion: null }
  private ctx: Ctx = { key: '', call: null, ws: null, features: new Set() }
  private seq = 0
  private invSeq = 0
  private subs = new Set<() => void>()
  private apply: (w: WorkspaceHead, touched: string[]) => Promise<void>
  constructor(onWorkspace: (w: WorkspaceHead, touched: string[]) => Promise<void> = async () => undefined) {
    this.apply = onWorkspace
  }
  subscribe = (fn: () => void) => {
    this.subs.add(fn)
    return () => {
      this.subs.delete(fn)
    }
  }
  getState = () => this.state
  private set(patch: Partial<LanguageState>) {
    this.state = { ...this.state, ...patch }
    this.subs.forEach((f) => f())
  }
  get context(): string {
    return contextOf(this.ctx)
  }

  /**
   * The current context. A different one drops (synchronously) the inventory and every preview made under the old
   * one, and starts this context's inventory read. The inventory is per workspace (not per generation), so a moved
   * candidate keeps it but drops its previews.
   */
  setContext(c: Ctx, onWorkspace?: (w: WorkspaceHead, touched: string[]) => Promise<void>) {
    if (onWorkspace) this.apply = onWorkspace
    const before = this.context
    const invBefore = `${this.ctx.key}|${this.ctx.ws?.id ?? ''}|${this.ctx.features.has('language-server-queries')}`
    this.ctx = c
    const now = this.context
    const invNow = `${c.key}|${c.ws?.id ?? ''}|${c.features.has('language-server-queries')}`
    const patch: Partial<LanguageState> = {}
    if (before !== now) {
      this.seq++
      if (this.state.rename && this.state.rename.ctx !== now) patch.rename = null
      if (this.state.completion && this.state.completion.ctx !== now) patch.completion = null
      if (this.state.busy) patch.busy = null
    }
    if (invBefore !== invNow) {
      patch.inventory = { ctx: invNow, status: 'checking', raw: null }
      const mine = ++this.invSeq
      if (c.call && c.ws && c.features.has('language-server-queries')) {
        void c.call<unknown>('GET', `/v1/workspaces/${c.ws.id}/language/servers`).then(
          (raw) => mine === this.invSeq && this.set({ inventory: { ctx: invNow, status: 'ready', raw } }),
          () => mine === this.invSeq && this.set({ inventory: { ctx: invNow, status: 'failed', raw: null } }),
        )
      }
    }
    if (Object.keys(patch).length) this.set(patch)
  }

  /** The server for a file: only from THIS context's answered inventory. */
  server(path: string | null): string | null {
    const inv = this.state.inventory
    const invNow = `${this.ctx.key}|${this.ctx.ws?.id ?? ''}|${this.ctx.features.has('language-server-queries')}`
    if (!path || inv.ctx !== invNow || inv.status !== 'ready') return null
    return serverFor(inv.raw, path)
  }
  offer(path: string | null) {
    return languageOffer(this.ctx.features, this.server(path))
  }

  setNote(n: string | null) {
    this.set({ note: n })
  }
  clearRename() {
    this.set({ rename: null })
  }
  clearCompletion() {
    this.set({ completion: null })
  }

  private async query(feature: 'definition' | 'rename' | 'completion', file: SavedFile, offset: number, extra: Record<string, unknown> = {}) {
    const { call, ws } = this.ctx
    const server = this.server(file.path)
    if (!call || !ws || !server) throw new Error('not available')
    const p = toLsp(file.content, offset)
    return call<unknown>('POST', `/v1/workspaces/${ws.id}/language`, { server_id: server, feature, path: file.path, expected_generation: ws.generation, expected_tree_digest: ws.tree_digest, line: p.line, character: p.character, limit: 50, ...extra })
  }
  private savedOnly(dirty: boolean, what: string) {
    if (!dirty) return false
    this.set({ note: `${what} reads the saved file. Save your edits first (⌘S), then try again.` })
    return true
  }

  async definition(file: SavedFile | null, dirty: boolean, offset: number): Promise<Location[] | null> {
    if (!file || !this.offer(file.path).definition || this.savedOnly(dirty, 'Go to definition')) return null
    const mine = ++this.seq
    this.set({ busy: 'definition', note: null })
    try {
      const found = parseLocations(await this.query('definition', file, offset))
      if (mine !== this.seq) return null
      this.set({ busy: null, note: found.length ? null : 'No definition was found in this code (it may come from outside it).' })
      return found
    } catch (e) {
      if (mine === this.seq) this.set({ busy: null, note: `Go to definition did not work: ${why(e)}` })
      return null
    }
  }

  async previewRename(file: SavedFile | null, dirty: boolean, offset: number, from: string, to: string) {
    const { call, ws } = this.ctx
    if (!file || !call || !ws || !this.offer(file.path).rename || this.savedOnly(dirty, 'Rename')) return
    const mine = ++this.seq
    const ctx = this.context
    this.set({ busy: 'rename', note: null, rename: null })
    try {
      const preview = parseRename(await this.query('rename', file, offset, { new_name: to }))
      const files = await Promise.all(
        preview.edits.map(async (e) => {
          const before = e.path === file.path ? file.content : (await call<{ content: string }>('GET', `/v1/workspaces/${ws.id}/files`, undefined, { path: e.path, expected_generation: String(ws.generation) })).content
          return { path: e.path, changes: lineChanges(before, e.content) }
        }),
      )
      if (mine !== this.seq || ctx !== this.context) return
      this.set({ busy: null, rename: { ctx, from, to, preview, files, generation: ws.generation, tree_digest: ws.tree_digest } })
    } catch (e) {
      if (mine === this.seq) this.set({ busy: null, note: `No rename preview: ${why(e)}` })
    }
  }

  /** Why the shown rename cannot be applied now, or null. */
  renameBlocked(): string | null {
    const r = this.state.rename
    if (!r) return 'There is no rename preview.'
    if (r.ctx !== this.context) return 'The code or the service changed since this preview; preview the rename again.'
    if (!this.ctx.features.has('language-server-queries') || !this.ctx.features.has('rename-preview')) return 'The code service no longer says it supports renaming here.'
    return null
  }

  async applyRename(): Promise<true> {
    const { call, ws } = this.ctx
    const r = this.state.rename
    if (!call || !ws || !r) return true
    const blocked = this.renameBlocked()
    if (blocked) {
      this.set({ rename: null, note: `The rename was not applied: ${blocked}` })
      return true
    }
    const mine = ++this.seq
    const ctx = this.context
    const apply = this.apply
    this.set({ busy: 'apply' })
    try {
      const done = await call<{ workspace: WorkspaceHead }>('POST', `/v1/workspaces/${ws.id}/language/renames`, { operation_id: newOperationId('rename'), preview_id: r.preview.preview_id, expected_generation: r.generation, expected_tree_digest: r.tree_digest })
      if (mine !== this.seq || ctx !== this.context) return true
      if (!this.ctx.features.has('language-server-queries') || !this.ctx.features.has('rename-preview')) {
        this.set({ rename: null, busy: null, note: 'The service capabilities changed while waiting. Refresh this workspace to inspect the outcome.' })
        return true
      }
      this.set({ rename: null, note: null, busy: null })
      await apply(done.workspace, r.files.map((f) => f.path))
    } catch (e) {
      if (mine !== this.seq || ctx !== this.context) return true
      this.set({ rename: null, busy: null, note: `The rename was not applied: ${why(e)}` })
    }
    return true
  }

  async complete(file: SavedFile | null, dirty: boolean, offset: number) {
    const { ws } = this.ctx
    if (!file || !ws || !this.offer(file.path).completion || this.savedOnly(dirty, 'Completion')) return
    const mine = ++this.seq
    const ctx = this.context
    this.set({ busy: 'complete', note: null, completion: null })
    try {
      const q = parseCompletion(await this.query('completion', file, offset))
      if (mine !== this.seq || ctx !== this.context) return
      if (!q.items.length) this.set({ busy: null, note: 'No completions here.' })
      else this.set({ busy: null, completion: { ctx, at: offset, path: file.path, query: q, generation: ws.generation, tree_digest: ws.tree_digest, active: 0, preview: null } })
    } catch (e) {
      if (mine === this.seq) this.set({ busy: null, note: `No completions: ${why(e)}` })
    }
  }

  /** Highlight one item: its exact preview is fetched; the answer is accepted only for this query, item and context. */
  async choose(index: number, file: SavedFile | null) {
    const { call, ws } = this.ctx
    const c = this.state.completion
    if (!call || !ws || !c || !file) return
    const mine = ++this.seq
    const ask = { ctx: c.ctx, query_id: c.query.query_id, index }
    this.set({ completion: { ...c, active: index, preview: null } })
    try {
      const pv = parseCompletionPreview(await call<unknown>('POST', `/v1/workspaces/${ws.id}/language/completion-previews`, { query_id: ask.query_id, item_index: index, expected_generation: c.generation, expected_tree_digest: c.tree_digest }))
      const now = this.state.completion
      if (mine !== this.seq || !now || now.query.query_id !== ask.query_id || now.ctx !== ask.ctx || ask.ctx !== this.context || now.active !== index) return
      if (pv.path !== now.path || file.path !== now.path) throw new LanguageAnswerError('The completion preview is for another file.')
      this.set({ completion: { ...now, preview: { ...pv, change: minimalChange(file.content, pv.content), index, query_id: ask.query_id } } })
    } catch (e) {
      if (mine === this.seq) this.set({ note: `That completion cannot be previewed: ${why(e)}` })
    }
  }

  completionBlocked(): string | null {
    const c = this.state.completion
    if (!c?.preview) return 'There is no completion preview.'
    if (c.ctx !== this.context || c.preview.query_id !== c.query.query_id) return 'The code or the service changed since this preview; ask for completions again.'
    if (!this.ctx.features.has('language-server-queries') || !this.ctx.features.has('saved-completion-preview')) return 'The code service no longer says it supports completions here.'
    return null
  }

  async applyCompletion(): Promise<true> {
    const { call, ws } = this.ctx
    const c = this.state.completion
    if (!call || !ws || !c?.preview) return true
    const blocked = this.completionBlocked()
    if (blocked) {
      this.set({ completion: null, note: `The completion was not applied: ${blocked}` })
      return true
    }
    const mine = ++this.seq
    const ctx = this.context
    const apply = this.apply
    this.set({ busy: 'apply' })
    try {
      const done = await call<{ workspace: WorkspaceHead }>('POST', `/v1/workspaces/${ws.id}/language/completion-applies`, { operation_id: newOperationId('complete'), preview_id: c.preview.id, expected_generation: c.generation, expected_tree_digest: c.tree_digest })
      if (mine !== this.seq || ctx !== this.context) return true
      if (!this.ctx.features.has('language-server-queries') || !this.ctx.features.has('saved-completion-preview')) {
        this.set({ completion: null, busy: null, note: 'The service capabilities changed while waiting. Refresh this workspace to inspect the outcome.' })
        return true
      }
      this.set({ completion: null, note: null, busy: null })
      await apply(done.workspace, [c.path])
    } catch (e) {
      if (mine !== this.seq || ctx !== this.context) return true
      this.set({ completion: null, busy: null, note: `The completion was not applied: ${why(e)}` })
    }
    return true
  }
}

/** The open file's part of a rename preview, as drawn in place: every changed line, its text exactly (no trimming). */
export function renameViews(r: RenameState | null, path: string | null): { id: string; n: number; from: number; to: number; after: string; state: 'keep' }[] {
  const f = r?.files.find((x) => x.path === path)
  return f ? f.changes.map((c, i) => ({ id: `rename-${i}`, n: i + 1, from: c.from, to: c.to, after: c.after, state: 'keep' as const })) : []
}
