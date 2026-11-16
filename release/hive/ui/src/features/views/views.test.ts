import { describe, expect, it, vi } from 'vitest'
import { composeArtifacts, NO_FILTER, type CreationRow } from '../artifacts/artifacts'
import { artifactsScreen, type ArtifactRow, type Names } from '../artifacts/data'
import { luminance, themeOf } from './hostContext'
import { isHtmlDocument } from './htmlDocument'
import { lastMentions } from './mentions'
import { namedArtifacts, refPieces, withoutIds } from '../../lib/artifactRefs'
import { plainText } from '../../lib/beliefSentence'
import { fileName, MCP_APPS_PROTOCOL, RPC, ViewBridge, type DisplayMode, type DownloadFile, type ViewHost } from './viewBridge'

// The host side of MCP Apps against a stand-in frame: what a view asks, what the hive answers, and what reaches the
// view when. INVENTED views and words.

type Sent = { jsonrpc: string; id?: string | number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; message: string } }

function rig({ acting = false, message = true, save = true }: { acting?: boolean; message?: boolean; save?: boolean } = {}) {
  const sent: Sent[] = []
  const targets: string[] = []
  const win = { postMessage: (m: Sent, target: string) => { sent.push(m); targets.push(target) } } as unknown as Window
  const host = {
    size: vi.fn(), displayMode: vi.fn((m: DisplayMode) => m), openLink: vi.fn(async (_url: URL) => save), download: vi.fn(async (_file: DownloadFile) => save), log: vi.fn(),
    requestTeardown: vi.fn(), acting: () => acting, ...(message ? { message: vi.fn() } : {}),
  }
  const bridge = new ViewBridge(() => win, host as ViewHost, { theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] })
  const from = (data: unknown, source: unknown = win) => bridge.receive({ source, data })
  let id = 0
  const ask = async (method: string, params: Record<string, unknown> = {}) => {
    const mine = ++id
    from({ jsonrpc: '2.0', id: mine, method, params })
    await new Promise((r) => setTimeout(r, 0))
    return sent.find((m) => m.id === mine)!
  }
  const init = async (appCapabilities: Record<string, unknown> = {}, protocolVersion = MCP_APPS_PROTOCOL) => {
    const answer = await ask('ui/initialize', { appInfo: { name: 'tip', version: '1' }, appCapabilities, protocolVersion })
    from({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} })
    return answer
  }
  return { sent, targets, win, host, bridge, from, ask, init }
}

describe('the hive answers a view the way MCP Apps hosts do', () => {
  it('takes messages only from its own frame, and posts to it with "*" since its origin is opaque', async () => {
    const r = rig()
    expect(r.from({ jsonrpc: '2.0', id: 1, method: 'ping' }, {} as Window)).toBe(false)
    expect(r.from({ jsonrpc: '2.0', id: 1, method: 'ping' }, null)).toBe(false)
    await new Promise((x) => setTimeout(x, 0))
    expect(r.sent).toEqual([])
    expect(await r.ask('ping')).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
    expect(r.targets).toEqual(['*'])
    expect(r.from('not json-rpc')).toBe(true)   // its own noise is swallowed, never thrown
  })

  it('answers ui/initialize with the version, what it offers, who it is and the context', async () => {
    const r = rig()
    const answer = await r.init({ availableDisplayModes: ['inline'] })
    expect(answer.result).toEqual({
      protocolVersion: MCP_APPS_PROTOCOL,
      hostCapabilities: { openLinks: {}, downloadFile: {}, logging: {}, message: { text: {} } },
      hostInfo: { name: 'OmegaHive', version: '1' },
      hostContext: { theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] },
    })
    expect((await rig().init({}, '2099-01-01')).result!.protocolVersion).toBe(MCP_APPS_PROTOCOL)   // unknown: the latest
    expect((await rig({ message: false }).init()).result!.hostCapabilities).toEqual({ openLinks: {}, downloadFile: {}, logging: {} })
  })

  it('sends nothing before initialized, then only the context fields that changed', async () => {
    const r = rig()
    r.bridge.setContext({ theme: 'light', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] })
    r.bridge.teardown('closed')
    expect(r.sent).toEqual([])
    const answer = await r.ask('ui/initialize', { appInfo: {}, appCapabilities: {}, protocolVersion: MCP_APPS_PROTOCOL })
    expect(answer.result!.hostContext).toMatchObject({ theme: 'light' })   // the latest context, in the answer
    r.bridge.setContext({ theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] })
    expect(r.sent.filter((m) => m.method)).toEqual([])   // still not initialized
    r.from({ jsonrpc: '2.0', method: 'ui/notifications/initialized' })
    r.bridge.setContext({ theme: 'dark', displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] })
    expect(r.sent.at(-1)).toEqual({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode: 'fullscreen' } })
    const before = r.sent.length
    r.bridge.setContext({ theme: 'dark', displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] })
    expect(r.sent.length).toBe(before)   // nothing changed, nothing sent
    r.bridge.teardown('closed')
    expect(r.sent.at(-1)).toMatchObject({ method: 'ui/resource-teardown', params: { reason: 'closed' } })
  })

  it('a reloaded view starts again: nothing reaches it until it says initialized once more', async () => {
    const r = rig()
    await r.init()
    await r.ask('ui/initialize', { appInfo: {}, appCapabilities: {}, protocolVersion: MCP_APPS_PROTOCOL })
    const before = r.sent.length
    r.bridge.setContext({ theme: 'light' })
    expect(r.sent.length).toBe(before)
    expect(r.bridge.ready).toBe(false)
  })

  it('switches display mode only to a mode both sides draw, and says the mode in force', async () => {
    const r = rig()
    await r.init({ availableDisplayModes: ['inline', 'fullscreen'] })
    expect((await r.ask('ui/request-display-mode', { mode: 'fullscreen' })).result).toEqual({ mode: 'fullscreen' })
    expect(r.host.displayMode).toHaveBeenCalledWith('fullscreen')
    expect((await r.ask('ui/request-display-mode', { mode: 'pip' })).result).toEqual({ mode: 'inline' })   // never pip
    const narrow = rig()
    await narrow.init({ availableDisplayModes: ['inline'] })
    expect((await narrow.ask('ui/request-display-mode', { mode: 'fullscreen' })).result).toEqual({ mode: 'inline' })
    expect(narrow.host.displayMode).not.toHaveBeenCalled()
  })

  it('a message from the view needs the person\'s click in the frame, and takes text only', async () => {
    const idle = rig()
    await idle.init()
    const denied = await idle.ask('ui/message', { role: 'user', content: [{ type: 'text', text: 'Split it three ways' }] })
    expect(denied.error).toMatchObject({ code: RPC.denied })
    expect(idle.host.message).not.toHaveBeenCalled()
    const clicked = rig({ acting: true })
    await clicked.init()
    expect((await clicked.ask('ui/message', { role: 'user', content: [{ type: 'text', text: 'Split it' }, { type: 'text', text: 'three ways' }] })).result).toEqual({})
    expect(clicked.host.message).toHaveBeenCalledWith('Split it\nthree ways')
    expect((await clicked.ask('ui/message', { role: 'user', content: { type: 'text', text: 'One block' } })).result).toEqual({})   // the draft's form
    for (const params of [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }, { role: 'user', content: [{ type: 'image', data: 'x' }] }, { role: 'user', content: [{ type: 'text', text: '  ' }] }]) {
      expect((await clicked.ask('ui/message', params)).error).toMatchObject({ code: RPC.invalidParams })
    }
    expect((await rig({ acting: true, message: false }).ask('ui/message', { role: 'user', content: [] })).error).toMatchObject({ code: RPC.methodNotFound })
  })

  it('opens http and https links only, after a click and the person\'s own click on the link the hive shows', async () => {
    const r = rig({ acting: true })
    await r.init()
    expect((await r.ask('ui/open-link', { url: 'javascript:alert(1)' })).error).toMatchObject({ code: RPC.denied })
    expect((await r.ask('ui/open-link', { url: 'not a url' })).error).toMatchObject({ code: RPC.invalidParams })
    expect((await r.ask('ui/open-link', { url: 'https://example.com/menu' })).result).toEqual({})
    expect(r.host.openLink.mock.calls[0][0].href).toBe('https://example.com/menu')
    const idle = rig()
    expect((await idle.ask('ui/open-link', { url: 'https://example.com' })).error).toMatchObject({ code: RPC.denied })
    // the person is shown the link and declines it
    const declined = rig({ acting: true, save: false })
    expect((await declined.ask('ui/open-link', { url: 'https://example.com/menu' })).error).toMatchObject({ code: RPC.denied, message: 'Link opening denied by user' })
  })

  it('saves an inline file under a safe name after a click and the person\'s yes, and never fetches a link', async () => {
    const r = rig({ acting: true })
    const text = { contents: [{ type: 'resource', resource: { uri: 'file:///exports/../../split.csv', mimeType: 'text/csv', text: 'name,share\nA,28.17' } }] }
    expect((await r.ask('ui/download-file', text)).result).toEqual({})
    const file = r.host.download.mock.calls[0][0]
    expect([file.name, file.mimeType, new TextDecoder().decode(file.bytes)]).toEqual(['split.csv', 'text/csv', 'name,share\nA,28.17'])
    const blob = { contents: [{ type: 'resource', resource: { uri: 'chart.png', blob: btoa('PNG') } }] }
    expect((await r.ask('ui/download-file', blob)).result).toEqual({})
    expect(r.host.download.mock.calls[1][0]).toMatchObject({ name: 'chart.png', mimeType: 'application/octet-stream' })
    expect((await r.ask('ui/download-file', { contents: [{ type: 'resource_link', uri: 'https://example.com/q4.pdf' }] })).error).toMatchObject({ code: RPC.invalidParams })
    expect((await rig({ acting: true, save: false }).ask('ui/download-file', text)).error).toMatchObject({ code: RPC.denied })
    expect((await rig().ask('ui/download-file', text)).error).toMatchObject({ code: RPC.denied })
  })

  it('offers no tools, resources, sampling or model context to an artifact view', async () => {
    const r = rig({ acting: true })
    await r.init()
    for (const method of ['tools/call', 'tools/list', 'resources/read', 'sampling/createMessage', 'ui/update-model-context']) {
      expect((await r.ask(method)).error).toMatchObject({ code: RPC.methodNotFound })
    }
  })

  it('takes size reports, logs and teardown requests as notifications', () => {
    const r = rig()
    r.from({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: 640, height: 381 } })
    r.from({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: -1, height: 'tall' } })
    r.from({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'warning', data: 'low ink' } })
    r.from({ jsonrpc: '2.0', method: 'ui/notifications/request-teardown' })
    expect(r.host.size.mock.calls).toEqual([[640, 381], [undefined, undefined]])
    expect(r.host.log).toHaveBeenCalledWith('warning', 'low ink')
    expect(r.host.requestTeardown).toHaveBeenCalledOnce()
    expect(r.sent).toEqual([])
  })

  it('names a downloaded file by its last path segment and nothing that could leave the folder', () => {
    expect(fileName('file:///a/b/report.pdf')).toBe('report.pdf')
    expect(fileName('../../etc/passwd')).toBe('passwd')
    expect(fileName('C:\\Users\\x\\notes.txt')).toBe('notes.txt')
    expect(fileName('.hidden')).toBe('hidden')
    expect(fileName('a<b>:c|d?.txt')).toBe('abcd.txt')
    expect(fileName('')).toBe('download')
    expect(fileName('file:///')).toBe('download')
    expect(fileName(`x/${'n'.repeat(300)}`).length).toBe(120)
  })
})

describe('what the page decides before it asks the hive', () => {
  it('tells an HTML document from text by the same cases as the server', async () => {
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: string) => string }
    const cases = JSON.parse(fs.readFileSync(new URL('../../../../tests/fixtures/html_document_cases.json', import.meta.url), 'utf8')) as { document: string[]; text: string[] }
    expect(cases.document.length).toBeGreaterThan(3)
    for (const doc of cases.document) expect(isHtmlDocument(doc), doc).toBe(true)
    for (const text of cases.text) expect(isHtmlDocument(text), text).toBe(false)
  })

  it('reads light or dark from the look\'s own background', () => {
    expect(themeOf('rgb(8, 8, 34)')).toBe('dark')
    expect(themeOf('rgb(250, 248, 240)')).toBe('light')
    expect(themeOf('color(srgb 0.95 0.95 0.9)')).toBe('light')
    expect(themeOf('rgba(16, 16, 44, 0.62)')).toBe('dark')
    expect(luminance('nonsense')).toBeNull()
    expect(themeOf('')).toBe('dark')
  })

  it('draws each view a mind names under the last of its messages that names it', () => {
    const a = `ar_${'a'.repeat(32)}`, b = `ar_${'b'.repeat(32)}`
    expect(namedArtifacts(`Here: ${a}, and again \`${a}\`; also ${b}. Not ar_123 or xar_${'c'.repeat(32)}`)).toEqual([a, b])
    const views = lastMentions([
      { id: 'm1', direction: 'out', text: `I made ${a}` },
      { id: 'm2', direction: 'in', text: `What is ${b}?` },
      { id: 'm3', direction: 'out', text: `Updated ${a} and made ${b}` },
      { id: 'm4', direction: 'out', text: 'Done.' },
    ])
    expect([...views]).toEqual([['m3', [a, b]]])
  })

  it('finds an artifact id alone or as a whole code span, and nothing that only looks like one', () => {
    const a = `ar_${'a'.repeat(32)}`, b = `ar_${'0123456789abcdef'.repeat(2)}`
    expect(refPieces(`Here is ${a}. Kept as \`${b}\` and \`\`${a}\`\`.`)).toEqual([
      { text: 'Here is ' }, { ref: a }, { text: '. Kept as ' }, { ref: b }, { text: ' and ' }, { ref: a }, { text: '.' }])
    // an id inside a longer code span is still one: the span keeps its other words and backticks
    expect(refPieces(`\`open ${a} now\``)).toEqual([{ text: '`open ' }, { ref: a }, { text: ' now`' }])
    for (const t of [`ar_${'A'.repeat(32)}`, `ar_${'a'.repeat(31)}`, `ar_${'a'.repeat(33)}`, `xar_${'a'.repeat(32)}`, `${a}_v2`, ''])
      expect(refPieces(t)).toEqual(t ? [{ text: t }] : [])
    // where a string has no room for a chip (a preview, a line of activity), the id is said as words
    expect(withoutIds(`Here is \`${a}\`, and ${b}.`)).toBe('Here is an artifact, and an artifact.')
    expect(plainText(`Saved ${a} for you.`)).toBe('Saved an artifact for you.')
  })

  it('a saved view opens as a view on Artifacts, ahead of Design and the reader', () => {
    const digest = `sha256:${'d'.repeat(64)}`
    const creations: CreationRow[] = [
      { artifact_id: 'ar7', kind: 'view', title: 'Tip calculator', swarm_id: 's1', mind_id: 'm1', revision: 1, digest, created_at: '2026-11-12T08:00:00Z', revised_at: '2026-11-12T08:00:00Z' },
      { artifact_id: 'ar8', kind: 'view', title: 'Unsaved', swarm_id: 's1', mind_id: 'm1', revision: null, digest: null, created_at: '2026-11-12T07:00:00Z', revised_at: null },
    ]
    const names: Names = { minds: { m1: { name: 'Wren', swarm_id: 's1' } }, swarms: { s1: { name: 'Sums' } }, apps: { omegadesign: 'Design' } }
    const rows = artifactsScreen({ status: 'ready', list: { items: composeArtifacts({ creations }), missing: [] } }, NO_FILTER, names, Date.parse('2026-11-12T08:05:00Z')).data['artifacts.shown'] as ArtifactRow[]
    expect(rows[0]).toMatchObject({ title: 'Tip calculator', detail: 'View', action: 'Open it', route: null, read: { artifact_id: 'ar7', revision: 1, view: true } })
    expect(rows[1]).toMatchObject({ title: 'Unsaved', state: 'Empty', action: 'Ask Wren', read: null })   // nothing saved: nothing to open
  })
})
