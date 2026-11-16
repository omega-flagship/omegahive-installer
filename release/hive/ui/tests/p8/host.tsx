/** Invented browser fixture; actual AppFrame, AppMemory, identity epoch and IndexedDB backend. Not a product entry. */
import '../../src/index.css'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { AppFrame } from '../../src/features/programs/AppFrame'
import { AppMemoryHost, type AppMemoryHostState } from '../../src/features/programs/AppMemory'
import { useHive } from '../../src/store/store'
import type { HiveClient, Me } from '../../src/api/client'
import type { HiveEvent, Program, ProgramUiBundle } from '../../src/api/types'
import { askMemory, dbName, hiveKey } from '../../src/lib/askMemory/store'
import { idbBackend, type MemoryBackend } from '../../src/lib/askMemory/backend'
import { bindEpoch, onIdentityChange } from '../../src/lib/identityEpoch'
import { memoryOpenBudget, nextMemoryOpeningKey } from '../../src/lib/appMemory'
import { personHash } from '../../src/lib/askMemory/file'
import { chromeFor, experienceById } from '../../src/experiences/registry'
import { WIRE } from '../../src/features/studioLive/wire'

const app = 'p8-fixture', digest = 'sha256:' + 'a'.repeat(64)
const principal = 'user:u_p8_browser', owner = { principal, hive: hiveKey('sim') }
const sentinel = `Invented local note ${crypto.randomUUID()}`
const listeners = new Set<(e: HiveEvent) => void>()
const calls: string[] = []
let memoryReviewCalls = 0
const openReview = askMemory.openReview.bind(askMemory)
askMemory.openReview = (...args) => { memoryReviewCalls++; return openReview(...args) }
const onward: unknown[] = []
const privateWords = new Set([sentinel, 'Invented corrected note', 'Invented concurrent note', 'Invented blocked late write'])
function safeWire(value: unknown, depth = 0): boolean {
  if (depth > 12) return false
  if (typeof value === 'string') return ![...privateWords].some((words) => value.includes(words))
  if (value === null || typeof value !== 'object') return true
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
  return Object.entries(value).every(([key, item]) => !/(image|pixels|bitmap|canvas|snapshot|blob|bytes|buffer|data_url)/i.test(key) && safeWire(item, depth + 1))
}
let expires = Date.now() / 1000 + 3600
const program: Program = { id: app, name: 'Fixture app', version: '1', description: '', icon: 'spark', capabilities: [], source: 'fixture', enabled: true, error: null, digest, ui: true }
const script = `
const channel = document.documentElement.dataset.appChannel;
const origin = document.documentElement.dataset.appHostOrigin;
const received = [];
addEventListener('message', (e) => { if(e.source === parent && e.data?.channel === channel) { received.push(e.data); parent.postMessage({type:'p8-forwarded',channel,payload:e.data},origin); } });
const safe = (value, depth=0) => {
 if(depth > 12) return false;
 if(value === null || typeof value !== 'object') return true;
 if(value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof Blob || value instanceof HTMLCanvasElement || typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap || typeof ImageData !== 'undefined' && value instanceof ImageData) return false;
 if(!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
 return Object.entries(value).every(([key,item]) => !/(image|pixels|bitmap|canvas|snapshot|blob|bytes|buffer|data_url)/i.test(key) && safe(item,depth+1));
};
globalThis.p8Frame = {
 received,
 safePayloads() { return received.every(safe); },
 open(id, topic='review this note', theme) { parent.postMessage({type:'memory-open',id,channel,topic,...(theme?{theme}:{})},origin); },
 send(value) { parent.postMessage({...value,channel},origin); },
 parentRead() { try { return parent.document.body.innerText; } catch(e) { return e.name; } },
 parentPixels() { try { return parent.document.querySelector('[data-app-memory-host]').getBoundingClientRect().width; } catch(e) { return e.name; } },
 navigate() { location.href='about:blank'; }
};
parent.postMessage({type:'app-ready',channel},origin);
`
const bundle: ProgramUiBundle = { program: app,
  files: { 'index.html': '<html lang="en"><head><link rel="stylesheet" href="./style.css"></head><body><button>Invented app</button><script type="module" src="./app.js"></script></body></html>', 'style.css': 'body{background:#eaeaea;color:#111}', 'app.js': script },
  release: { digest, memory_theme: { accent: '#123456', font: 'serif', radius: 12,
    calm: { accent: '#234567', dark: { surface: '#111111', panel: '#161616', accent: '#345678' } },
    focus: { accent: '#456789' }, warm: { accent: '#563412' }, simple: { accent: '#123456' } },
    memory_theme_dark: { surface: '#020202', panel: '#101010', accent: '#678901' } } }
const client = {
  mode: 'sim',
  async programUi() { calls.push('programUi'); return bundle },
  async me(): Promise<Me> { calls.push('me'); return { principal, kind: 'password', role: 'member', expires_at: expires, person: { id: 'u_p8_browser', email: null, name: 'Invented person' }, person_kind: 'person', local_operator: false } },
  subscribe(fn: (e: HiveEvent) => void) { listeners.add(fn); return () => listeners.delete(fn) },
} as unknown as HiveClient
useHive.setState({ client, session: 'p8-browser-fixture', programs: [program], programDetails: {} })
askMemory.connectIdentity({ bind: bindEpoch, onIdentityChange })
const backend = idbBackend(dbName(owner))
await backend.commit({ op: 'put', gen: 0, base: null, trace: [], belief: { id: 'p8_note', kind: 'preference', statement: sentinel, truth: { frequency: 1, confidence: .7 }, uses: 0, last_used_at: null, source_turn: null, created_at: 1, updated_at: 1 } })
askMemory.use(owner); await askMemory.whenReady()
// Load the same host chrome before measurement; a memory op must not be confused with a late initial chunk load.
await chromeFor(experienceById(undefined).id)
const root = createRoot(document.getElementById('root')!)
const render = (key = 0) => flushSync(() => root.render(<div style={{ height: '100vh' }}><AppFrame key={key} programId={app} swarmId="s_fixture" /></div>))
let mount = 0
render()
let releaseHeld: (() => void) | null = null
let held = false
let settled = 0
type LifecycleOpening = { state: AppMemoryHostState; controller: AbortController }
let lifecycle: LifecycleOpening | null = null
let lifecycleNext: LifecycleOpening | null = null
const lifecycleWords = 'Invented fresh lifecycle snapshot'
privateWords.add(lifecycleWords)
privateWords.add('Invented old unsaved lifecycle fix')
async function lifecycleOpening(topic: string): Promise<LifecycleOpening> {
  const controller = new AbortController()
  const guard = { signal: controller.signal, current: () => !controller.signal.aborted }
  const snapshot = await askMemory.openReview(guard)
  if (!snapshot) throw new Error('Current invented lifecycle snapshot unavailable')
  return { controller, state: { hostKey: nextMemoryOpeningKey(), opening: { id: 'same-caller-id', appName: 'Lifecycle fixture app',
    topic, themes: bundle.release!, snapshot, guard } } }
}
const lifecycleElement = (value: LifecycleOpening) => <AppMemoryHost state={value.state} mode="light" onClose={() => {
  if (lifecycle !== value) return
  lifecycle = null; value.controller.abort(); root.render(null)
}} />
const emit = (e: HiveEvent) => { for (const fn of [...listeners]) fn(e) }
window.addEventListener('message', (event) => {
  if (event.origin === 'null' && event.source === document.querySelector('iframe')?.contentWindow && event.data?.type === 'p8-forwarded'
    && event.data.channel === event.data.payload?.channel) onward.push(event.data.payload)
})
const controls = {
  sentinel, calls, onward,
  memoryReviewCalls: () => memoryReviewCalls,
  // Component lifecycle only: the original18 controls keep using the actual opaque AppFrame.
  async lifecycleBegin() {
    lifecycle = await lifecycleOpening('first lifecycle topic')
    const opening = lifecycle
    flushSync(() => root.render(lifecycleElement(opening)))
  },
  async lifecyclePrepareNext() {
    if (!lifecycle || lifecycleNext) throw new Error('Unexpected lifecycle preparation state')
    const old = (await backend.load()).beliefs.find((b) => b.id === 'p8_note')!
    await backend.commit({ op: 'put', gen: 0, base: old.updated_at, trace: [], belief: { ...old, statement: lifecycleWords, updated_at: old.updated_at + 1 } })
    // Prepare before the old confirmation is intentionally held in the write queue.
    lifecycleNext = await lifecycleOpening('replacement lifecycle topic')
    return { words: lifecycleWords }
  },
  lifecycleReplaceBatched() {
    if (!lifecycle || !lifecycleNext) throw new Error('Prepared lifecycle replacement required')
    const old = lifecycle, next = lifecycleNext
    lifecycle = next; lifecycleNext = null
    // Both updates share one commit: an intermediate null cannot accidentally make this test pass.
    flushSync(() => { root.render(null); root.render(lifecycleElement(next)) })
    old.controller.abort()
    return { sameCallerId: old.state.opening.id === next.state.opening.id, changedHostKey: old.state.hostKey !== next.state.hostKey }
  },
  wireSafe() {
    return onward.length > 0 && onward.every((value) => {
      if (!safeWire(value) || !value || typeof value !== 'object') return false
      const row = value as Record<string, unknown>
      if (row.type === 'memory-opened' || row.type === 'memory-closed') return Object.keys(row).sort().join(',') === 'channel,id,type'
      if (row.type === 'memory-refused') return Object.keys(row).sort().join(',') === 'channel,id,reason,type' && ['invalid', 'unsupported', 'busy', 'unavailable', 'rate-limited'].includes(String(row.reason))
      return ['app-context', 'context', 'layout-set', WIRE.close].includes(String(row.type))
    })
  },
  exportOwnerMatches(value: { salt?: unknown; hive?: unknown; person_hash?: unknown }) {
    return typeof value.salt === 'string' && value.hive === owner.hive && value.person_hash === personHash(value.salt, owner.hive, owner.principal)
  },
  held: () => held,
  settled: () => settled,
  holdNext(kind: 'commit' | 'export') {
    const barrier = new Promise<void>((resolve) => { releaseHeld = resolve })
    if (kind === 'commit') {
      const actual = (askMemory as unknown as { backend: MemoryBackend }).backend
      const original = actual.commit.bind(actual)
      actual.commit = async (change, guard) => { actual.commit = original; held = true; try { await barrier; return await original(change, guard) } finally { held = false; settled++ } }
    } else {
      const original = askMemory.exportReview.bind(askMemory)
      askMemory.exportReview = async (...args) => { askMemory.exportReview = original; const out = await original(...args); held = true; try { await barrier; return out } finally { held = false; settled++ } }
    }
  },
  releaseHeld() { releaseHeld?.(); releaseHeld = null },
  async current() { return (await backend.load()).beliefs },
  async concurrent(statement: string, sameTimestamp = false) {
    privateWords.add(statement)
    const old = (await backend.load()).beliefs.find((b) => b.id === 'p8_note')!
    await backend.commit({ op: 'put', gen: 0, base: old.updated_at, trace: [], belief: { ...old, statement, updated_at: old.updated_at + (sameTimestamp ? 0 : 1) } })
  },
  invalidate(kind: string) {
    if (kind === 'identity') useHive.setState({ session: 'p8-other-session' })
    else if (kind === 'owner') askMemory.use({ principal: 'user:u_other', hive: owner.hive })
    else if (kind === 'missing-program') useHive.setState({ programs: [] })
    else if (kind === 'missing-digest') useHive.setState({ programs: [{ ...program, digest: undefined }] })
    else if (kind === 'disabled') useHive.setState({ programs: [{ ...program, enabled: false }] })
    else if (kind === 'release') emit({ type: 'program.release_changed', at: new Date().toISOString(), program: app, digest: 'sha256:' + 'b'.repeat(64) })
    else if (kind === 'pagehide') window.dispatchEvent(new Event('pagehide'))
    else if (kind === 'unmount') root.unmount()
  },
  remount() { memoryOpenBudget.clear(); render(++mount) },
  expireNextDocument() { expires = Date.now() / 1000 + 2; memoryOpenBudget.clear(); render(++mount) },
}
;(window as unknown as { p8Host: typeof controls }).p8Host = controls
