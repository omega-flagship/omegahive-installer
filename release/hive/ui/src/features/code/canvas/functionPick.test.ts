import { describe, expect, it } from 'vitest'
import type { CodeContext } from '../../../api/client'
import { SimCodeService } from '../../../api/sim/codeService'
import type { WorkspaceHead } from '../suggestions/contract'
import { defNameAt, parseFunctionPreview, utf16At } from './functionPick'
import { scopeWords } from './vibe'
import { intentsKit } from './vibeIntents.testkit'
import { VibeSession, type SavedFile } from './vibeSession'

// Phase 2.2, row 26: whole-function pick through function-scope-preview / function-scopes (OmegaCode suggestions.py 85–140)
const WS = 'ws_fn01'
const CTX: CodeContext = { task_id: 'g_fn', grant_id: 'grant_fn', repository_id: 'sim-suggestions' }

describe('picking a function', () => {
  it('converts saved byte offsets to editor offsets (👋 is 4 bytes, 2 units)', () => {
    const t = 'a👋b'
    expect(utf16At(t, 0)).toBe(0)
    expect(utf16At(t, 5)).toBe(3)
    expect(utf16At(t, 6)).toBe(4)
    expect(utf16At(t, 3)).toBeNull() // inside 👋
  })
  it('knows a double-click on a function’s name', () => {
    const t = 'class A:\n    def go(self):\n        return 1\n'
    expect(defNameAt(t, t.indexOf('go') + 1)).toBe('go')
    expect(defNameAt(t, t.indexOf('A'))).toBe('A')
    expect(defNameAt(t, t.indexOf('self'))).toBeNull()
    expect(defNameAt(t, t.indexOf('return'))).toBeNull()
  })
  it('parses the preview strictly', () => {
    const ok = { selection: { start_byte: 0, end_byte: 10, path: 'a.py', generation: 1, tree_digest: 't', source_digest: 's', caret_byte: 3 }, selection_digest: 'a'.repeat(64), scope_issued: false }
    expect(parseFunctionPreview(ok, 'a.py')).toMatchObject({ start_byte: 0, end_byte: 10, selection_digest: 'a'.repeat(64) })
    expect(() => parseFunctionPreview({ ...ok, scope_issued: true }, 'a.py')).toThrow()
    expect(() => parseFunctionPreview(ok, 'b.py')).toThrow()
    expect(() => parseFunctionPreview({ ...ok, selection: { ...ok.selection, end_byte: 0 } }, 'a.py')).toThrow()
  })
})

describe('the simulator’s invented function parser (sim only)', () => {
  async function setup() {
    const svc = new SimCodeService({ workspace_id: WS, task_id: CTX.task_id })
    const ws = (await svc.proxy('GET', `/v1/workspaces/${WS}`, {}, null)) as WorkspaceHead
    const f = (await svc.proxy('GET', `/v1/workspaces/${WS}/files`, { path: 'src/greeting.py' }, null)) as { content: string; digest: string }
    return { svc, ws, f }
  }
  it('finds the function around a caret, refuses a stale digest and a non-Python file', async () => {
    const { svc, ws, f } = await setup()
    const caret = new TextEncoder().encode(f.content.slice(0, f.content.indexOf('print'))).length
    const p = parseFunctionPreview(await svc.proxy('POST', `/v1/workspaces/${WS}/function-scope-preview`, {}, { expected_generation: ws.generation, expected_tree_digest: ws.tree_digest, path: 'src/greeting.py', source_digest: f.digest, caret_byte: caret }), 'src/greeting.py')
    const bytes = new TextEncoder().encode(f.content)
    expect(new TextDecoder().decode(bytes.slice(p.start_byte, p.end_byte))).toBe('def greet(name):\n    message = "Hello, " + name + "!"\n    print(message)\n    return message')
    await expect(svc.proxy('POST', `/v1/workspaces/${WS}/function-scope-preview`, {}, { expected_generation: ws.generation, expected_tree_digest: ws.tree_digest, path: 'src/greeting.py', source_digest: '0'.repeat(64), caret_byte: caret })).rejects.toMatchObject({ code: 'function_scope_stale' })
    await expect(svc.proxy('POST', `/v1/workspaces/${WS}/function-scope-preview`, {}, { expected_generation: ws.generation, expected_tree_digest: ws.tree_digest, path: 'README.md', source_digest: f.digest, caret_byte: 0 })).rejects.toMatchObject({ code: 'function_language' })
  })
  it('a change asked on a picked function is scoped by function-scopes to exactly that function, and the confirm says so', async () => {
    const { svc, ws, f } = await setup()
    const kit = intentsKit(svc, { ctx: CTX })
    const client = kit.client
    const file: SavedFile = { path: 'src/greeting.py', content: f.content, digest: f.digest }
    const caret = new TextEncoder().encode(f.content.slice(0, f.content.indexOf('print'))).length
    const raw = await svc.proxy('POST', `/v1/workspaces/${WS}/function-scope-preview`, {}, { expected_generation: ws.generation, expected_tree_digest: ws.tree_digest, path: 'src/greeting.py', source_digest: f.digest, caret_byte: caret })
    const pv = parseFunctionPreview(raw, 'src/greeting.py')
    const from = utf16At(f.content, pv.start_byte)!
    const to = utf16At(f.content, pv.end_byte)!
    const session = new VibeSession({ set: () => 0 as unknown as ReturnType<typeof setTimeout>, clear: () => undefined }, { pollMs: [5] })
    session.setDeps({ client, ctx: CTX, ws, onWorkspace: async () => undefined, turn: kit.turn })
    await session.ask('use an f-string', { from, to }, file, false, () => 'Anvil', true, { ...pv, name: 'greet', path: 'src/greeting.py', digest: f.digest, generation: ws.generation, from, to })
    const r = session.getState().result!
    expect(r.read.content.scope['src/greeting.py']).toEqual([[pv.start_byte, pv.end_byte]])
    expect(r.scope).toEqual({ path: 'src/greeting.py', lines: { first: 4, last: 7 }, fn: 'greet' })
    expect(scopeWords(r.scope)).toBe('Function greet (lines 4–7) of src/greeting.py')
  })
})
