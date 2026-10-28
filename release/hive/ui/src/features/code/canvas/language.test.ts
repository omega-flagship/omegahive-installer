import { describe, expect, it } from 'vitest'
import { SimCodeService } from '../../../api/sim/codeService'
import { featuresOf } from './features'
import { fromLsp, languageOffer, lineChanges, minimalChange, parseCompletion, parseCompletionPreview, parseLocations, parseRename, serverFor, toLsp, wordAt } from './language'

// Phase 2, row 25: language features in context, through the relayed /language routes (OmegaCode service.py 300–556)
const T = 'def greet(name):\n    return "hi 👋" + name\n'

describe('positions: UTF-16 line/character, as the language routes use', () => {
  it('converts editor offsets to and from LSP positions, counting 👋 as two', () => {
    const at = T.indexOf('name', 30)
    expect(toLsp(T, at)).toEqual({ line: 1, character: at - 17 })
    expect(fromLsp(T, toLsp(T, at))).toBe(at)
    expect(fromLsp(T, { line: 1, character: 999 })).toBeNull()
    expect(fromLsp(T, { line: 9, character: 0 })).toBeNull()
  })
  it('finds the name under the caret', () => {
    expect(wordAt(T, 6)).toEqual({ from: 4, to: 9, word: 'greet' })
    expect(wordAt(T, 3)).toEqual({ from: 0, to: 3, word: 'def' })
    expect(wordAt(T, 16)).toBeNull()
  })
})

describe('what the loaded service offers (hidden when not declared)', () => {
  const inv = { servers: [{ id: 'py', extensions: ['.py'], configured: true, executable_present: true }, { id: 'ts', extensions: ['.ts'], configured: true, executable_present: false }] }
  it('needs a declared feature, a server for the file’s extension, declared configured, and a present executable', () => {
    expect(serverFor(inv, 'src/a.py')).toBe('py')
    expect(serverFor({ servers: [{ id: 'py', extensions: ['.py'], executable_present: true }] }, 'src/a.py')).toBeNull()
    expect(serverFor({ servers: [{ id: 'py', extensions: ['.py'], configured: false, executable_present: true }] }, 'src/a.py')).toBeNull()
    expect(serverFor(inv, 'src/a.ts')).toBeNull()
    expect(serverFor({ servers: 'x' }, 'a.py')).toBeNull()
    const all = featuresOf({ features: ['language-server-queries', 'rename-preview', 'saved-completion-preview'] })
    expect(languageOffer(all, 'py')).toEqual({ definition: true, rename: true, completion: true })
    expect(languageOffer(featuresOf({ features: ['language-server-queries'] }), 'py')).toEqual({ definition: true, rename: false, completion: false })
    expect(languageOffer(all, null)).toEqual({ definition: false, rename: false, completion: false })
    expect(languageOffer(new Set(), 'py')).toEqual({ definition: false, rename: false, completion: false })
  })
})

describe('strict parsing of the language answers', () => {
  it('locations', () => {
    expect(parseLocations({ result: { locations: [{ path: 'a.py', range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } }, source_digest: 'x' }] } })).toEqual([{ path: 'a.py', range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } } }])
    expect(() => parseLocations({ result: { locations: [{ path: '/etc/x', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] } })).toThrow()
    expect(() => parseLocations({ result: {} })).toThrow()
  })
  it('rename previews and completion answers', () => {
    expect(parseRename({ result: { edits: [{ path: 'a.py', expected_digest: 'd', content: 'x' }], preview_id: 'rp_1', applied: false } })).toEqual({ preview_id: 'rp_1', edits: [{ path: 'a.py', expected_digest: 'd', content: 'x' }] })
    expect(() => parseRename({ result: { edits: [], preview_id: 'rp_1' } })).toThrow()
    expect(parseCompletion({ completion_query_id: 'cq_1', result: { items: [{ label: 'greet', detail: 'def' }, { label: 'g', documentation: { text: 'doc' } }] } })).toEqual({ query_id: 'cq_1', items: [{ label: 'greet', detail: 'def' }, { label: 'g', detail: 'doc' }] })
    expect(() => parseCompletion({ result: { items: [] } })).toThrow()
    expect(parseCompletionPreview({ id: 'cp_1', label: 'greet', path: 'a.py', edits: [{ path: 'a.py', expected_digest: 'd', content: 'y' }] })).toEqual({ id: 'cp_1', label: 'greet', path: 'a.py', content: 'y' })
    expect(() => parseCompletionPreview({ id: 'cp_1', label: 'x', path: 'a.py', edits: [{ path: 'b.py', expected_digest: 'd', content: 'y' }] })).toThrow()
  })
  it('turns a whole-file preview into what changed, for showing in place', () => {
    expect(minimalChange('a gre b', 'a greet b')).toEqual({ from: 5, to: 5, insert: 'et' })
    expect(minimalChange('same', 'same')).toBeNull()
    expect(lineChanges('a\ngreet()\nb\ngreet\n', 'a\nwelcome()\nb\nwelcome\n')).toEqual([
      { line: 2, from: 2, to: 9, before: 'greet()', after: 'welcome()' },
      { line: 4, from: 12, to: 17, before: 'greet', after: 'welcome' },
    ])
  })
})

describe('the simulator’s invented language server (additive; sim only)', () => {
  const ws = 'ws_lang01'
  const make = async () => {
    const s = new SimCodeService({ workspace_id: ws })
    const h = (await s.proxy('GET', `/v1/workspaces/${ws}`, {}, null)) as { generation: number; tree_digest: string }
    return { s, h }
  }
  it('declares the language features and one Python server', async () => {
    const { s } = await make()
    expect(featuresOf(await s.proxy('GET', '/v1/capabilities', {}, null))).toEqual(expect.objectContaining({}))
    const f = featuresOf(await s.proxy('GET', '/v1/capabilities', {}, null))
    expect(['language-server-queries', 'rename-preview', 'saved-completion-preview'].every((x) => f.has(x))).toBe(true)
    expect(serverFor(await s.proxy('GET', `/v1/workspaces/${ws}/language/servers`, {}, null), 'src/greeting.py')).toBeTruthy()
  })
  it('finds a definition in another file', async () => {
    const { s, h } = await make()
    const raw = await s.proxy('POST', `/v1/workspaces/${ws}/language`, {}, { server_id: 'python-sim', feature: 'definition', path: 'tests/test_greeting.py', expected_generation: h.generation, expected_tree_digest: h.tree_digest, line: 4, character: 12, limit: 50 })
    expect(parseLocations(raw)).toEqual([{ path: 'src/greeting.py', range: { start: { line: 3, character: 4 }, end: { line: 3, character: 9 } } }])
  })
  it('previews a rename across files, applies it only by preview id on the same generation, and refuses a stale one', async () => {
    const { s, h } = await make()
    const raw = await s.proxy('POST', `/v1/workspaces/${ws}/language`, {}, { server_id: 'python-sim', feature: 'rename', path: 'src/greeting.py', expected_generation: h.generation, expected_tree_digest: h.tree_digest, line: 3, character: 5, new_name: 'welcome', limit: 50 })
    const p = parseRename(raw)
    expect(p.edits.map((e) => e.path)).toEqual(['src/greeting.py', 'tests/test_greeting.py'])
    await expect(s.proxy('POST', `/v1/workspaces/${ws}/language`, {}, { server_id: 'python-sim', feature: 'rename', path: 'src/greeting.py', expected_generation: h.generation, expected_tree_digest: h.tree_digest, line: 3, character: 5, new_name: 'class', limit: 50 })).rejects.toMatchObject({ code: 'rename_name' })
    const done = (await s.proxy('POST', `/v1/workspaces/${ws}/language/renames`, {}, { operation_id: 'rn1', preview_id: p.preview_id, expected_generation: h.generation, expected_tree_digest: h.tree_digest })) as { workspace: { generation: number }; change: { paths: string[] } }
    expect(done.workspace.generation).toBe(h.generation + 1)
    expect(done.change.paths).toEqual(['src/greeting.py', 'tests/test_greeting.py'])
    await expect(s.proxy('POST', `/v1/workspaces/${ws}/language/renames`, {}, { operation_id: 'rn2', preview_id: p.preview_id, expected_generation: h.generation, expected_tree_digest: h.tree_digest })).rejects.toMatchObject({ code: 'stale_workspace' })
  })
  it('completes a prefix on the saved file: query, preview one item, apply behind its preview id', async () => {
    const s = new SimCodeService({ workspace_id: ws })
    const h0 = (await s.proxy('GET', `/v1/workspaces/${ws}`, {}, null)) as { generation: number; tree_digest: string }
    const f = (await s.proxy('GET', `/v1/workspaces/${ws}/files`, { path: 'tests/test_greeting.py' }, null)) as { content: string; digest: string }
    const saved = (await s.proxy('POST', `/v1/workspaces/${ws}/patches`, {}, { operation_id: 'p1', expected_generation: h0.generation, expected_tree_digest: h0.tree_digest, edits: [{ path: 'tests/test_greeting.py', expected_digest: f.digest, content: f.content + '    far\n' }] })) as { workspace: { generation: number; tree_digest: string } }
    const h = saved.workspace
    const q = parseCompletion(await s.proxy('POST', `/v1/workspaces/${ws}/language`, {}, { server_id: 'python-sim', feature: 'completion', path: 'tests/test_greeting.py', expected_generation: h.generation, expected_tree_digest: h.tree_digest, line: 5, character: 7, limit: 50 }))
    expect(q.items.map((i) => i.label)).toContain('farewell')
    const pv = parseCompletionPreview(await s.proxy('POST', `/v1/workspaces/${ws}/language/completion-previews`, {}, { query_id: q.query_id, item_index: q.items.findIndex((i) => i.label === 'farewell'), expected_generation: h.generation, expected_tree_digest: h.tree_digest }))
    expect(pv.content.endsWith('    farewell\n')).toBe(true)
    const done = (await s.proxy('POST', `/v1/workspaces/${ws}/language/completion-applies`, {}, { operation_id: 'ca1', preview_id: pv.id, expected_generation: h.generation, expected_tree_digest: h.tree_digest })) as { workspace: { generation: number } }
    expect(done.workspace.generation).toBe(h.generation + 1)
  })
})
