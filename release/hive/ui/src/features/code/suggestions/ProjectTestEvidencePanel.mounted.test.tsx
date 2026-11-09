// Actual ReactDOM on the existing qualified MiniDOM kit; no new dependency.
// Limited DOM semantics: no browser/layout/focus/event-dispatch acceptance claim.
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, press, type MiniNode } from '../../../ui/miniDom.testkit'
const cryptoModule = 'node:crypto'
const { webcrypto } = await import(/* @vite-ignore */ cryptoModule) as { webcrypto: Crypto }
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectTestEvidencePanel } from './ProjectTestEvidencePanel'
import { deferred, emptyEvidencePage, evidencePage, evidenceSubject } from './projectTestEvidence.testkit'

let node: MiniNode, root: Root | null
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('crypto', webcrypto)
  const doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener() {}, removeEventListener() {} }
  doc.defaultView = win
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
  vi.stubGlobal('HTMLIFrameElement', win.HTMLIFrameElement)
  node = doc.createElement('div'); doc.body.appendChild(node)
  // First actual react-dom/client import follows the original MiniDOM globals.
  const { createRoot } = await import('react-dom/client')
  root = createRoot(node as unknown as Element)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  node.parentNode?.removeChild(node)
  vi.unstubAllGlobals()
})
async function observed(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 20)) })
  }
  expect(check()).toBe(true)
}
describe('mounted read-only project-test evidence', () => {
  it('shows verified captures and the retained locator without a Test/Run action', async () => {
    const page = await evidencePage(), call = vi.fn(async () => page)
    await act(async () => root!.render(<ProjectTestEvidencePanel call={call} subject={evidenceSubject} />))
    await observed(() => !!node.textContent?.includes('Tested on the current proposal and runtime'))
    expect(node.textContent).toContain('Tested on the current proposal and runtime')
    expect(node.textContent).toContain('original assertion output')
    expect(node.textContent).toContain('sha256:' + 'a'.repeat(64))
    expect(node.findAll(x => x.tagName === 'BUTTON').map(x => x.textContent)).toEqual(['Refresh evidence'])
    expect(call).toHaveBeenCalledExactlyOnceWith('GET', '/v1/workspaces/ws_a/suggestions/suggestion_a/project-tests', undefined, { limit: '4', cursor: '0' })
  })
  it('does not display a deferred old attachment response after the subject changes', async () => {
    const old = deferred<unknown>(), next = deferred<unknown>()
    const call = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise)
    await act(async () => root!.render(<ProjectTestEvidencePanel call={call} subject={evidenceSubject} />))
    await act(async () => root!.render(<ProjectTestEvidencePanel call={call} subject={{ ...evidenceSubject, proposal_id: 'suggestion_b' }} />))
    await act(async () => { next.resolve(emptyEvidencePage()) })
    await act(async () => { old.resolve(await evidencePage()) })
    await observed(() => !!node.textContent?.includes('No retained test evidence'))
    expect(node.textContent).toContain('No retained test evidence')
    expect(node.textContent).not.toContain('Tested on the current')
    expect(call.mock.calls[1][1]).toContain('/suggestions/suggestion_b/project-tests')
  })
  it('revokes the request on actual unmount before its deferred result resolves', async () => {
    const delayed = deferred<unknown>(), call = vi.fn(() => delayed.promise)
    await act(async () => root!.render(<ProjectTestEvidencePanel call={call} subject={evidenceSubject} />))
    await act(async () => root!.unmount())
    root = null  // afterEach must not attempt a second unmount
    await act(async () => { delayed.resolve(await evidencePage()) })
    expect(node.textContent).toBe(''); expect(call).toHaveBeenCalledTimes(1)
  })
  it('clears prior current credit during refresh and shows unavailable on a failed read', async () => {
    const page = await evidencePage(), later = deferred<unknown>()
    const call = vi.fn().mockResolvedValueOnce(page).mockImplementationOnce(() => later.promise)
    await act(async () => root!.render(<ProjectTestEvidencePanel call={call} subject={evidenceSubject} />))
    await observed(() => !!node.textContent?.includes('Tested on the current proposal and runtime'))
    await act(async () => press(node.findAll(x => x.tagName === 'BUTTON')[0]))
    expect(node.textContent).not.toContain('Tested on the current')
    await act(async () => { later.resolve({ private_unexpected: 'not evidence' }) })
    await observed(() => node.findAll(x => x.getAttribute('role') === 'alert').length > 0)
    expect(node.findAll(x => x.getAttribute('role') === 'alert')).toHaveLength(1)
    expect(node.textContent).not.toContain('original assertion output')
  })
})
