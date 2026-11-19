// Purpose: verify removal composition in every look, inspected-record binding, and identity-safe action results.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type HiveClient } from '../../api/client'
import type { Asset, LinkedFolder } from '../../api/moneyWork'
import { STALE } from '../../lib/identityEpoch'
import { Screen } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { useHive } from '../../store/store'
import { removalBound, removalRun, type RemovalSubject } from './Removal'

const space = ScreensSpace.open()
const looks = ['classic', 'cosmos', 'flux', 'canvas', 'still', 'construct', 'professional']
const asset: Asset = { sha256: 'a'.repeat(64), name: 'notes.txt', mime: 'text/plain', bytes: 12, owner_swarm: 's_one', owners: ['s_one'], created_by: 'user:operator', created_at: '2026-11-17T00:00:00Z', local_only: false, placements: ['cloud', 'local'], history: [] }
const folder: LinkedFolder = { id: 'f_one', label: 'Work', root: '/invented/work', owner_swarm: 's_one', writable: false, writers: 'admins', created_by: 'user:operator', created_at: asset.created_at, scope: 'this_machine_only', available: true, history: [] }
const subjects: RemovalSubject[] = [{ kind: 'asset', value: asset }, { kind: 'folder', value: folder }]
const data = { 'file.name': 'notes.txt', 'file.sha256': asset.sha256, 'file.size': '12 B', 'file.stores': 'cloud, local', 'folder.root': folder.root, 'folder.swarm': 'Studio' }
const before = useHive.getState()
afterEach(() => { useHive.setState(before, true); vi.unstubAllGlobals() })

describe('removal is composed by MeTTa', () => {
  it.each(looks)('%s draws only the action or its confirmation and names what is lost', (look) => {
    for (const [screen, action] of [['assets-delete', 'Delete'], ['assets-unlink', 'Unlink']]) {
      const draw = (allowed: boolean, open: boolean) => space.compose(screen, look, { flags: { 'removal.allowed': allowed, 'removal.open': open } })
      const ready = draw(true, false)
      expect(ready.parts.map((p) => p.block)).toEqual(['buttons'])
      const html = renderToStaticMarkup(createElement(Screen, { plan: ready, host: { data } }))
      expect(html).toContain(`aria-label="${action} notes.txt"`)
      expect(html).toContain(`${action}…`)
      expect(draw(false, false).parts).toEqual([])
      expect(draw(false, true).parts).toEqual([])
      const opened = draw(true, true)
      expect(opened.parts.map((p) => p.block)).toEqual(['island'])
      expect(renderToStaticMarkup(createElement(Screen, { plan: opened, host: { data, islands: { confirmation: 'the existing decision dialog' } } }))).toContain('the existing decision dialog')
      expect(ready.missing).toEqual([])
      expect(opened.missing).toEqual([])
      const plan = space.compose(`${screen}-confirm`, look, {})
      const confirmation = renderToStaticMarkup(createElement(Screen, { plan, host: { data } }))
      expect(plan.missing).toEqual([])
      if (screen === 'assets-delete') {
        expect(confirmation).toContain(asset.sha256)
        expect(confirmation).toContain('cloud, local')
        expect(confirmation).toContain('ownership registrations and its storage history will be permanently deleted')
        expect(confirmation).toContain('Minds, saved messages, artifact revisions and programs')
        expect(confirmation).toContain('file links will stop opening')
        expect(confirmation).toContain('more than one swarm, or needed for coding-tools setup, cannot be deleted')
      } else {
        expect(confirmation).toContain('/invented/work')
        expect(confirmation).toContain('Its files stay on disk and its saved write receipts stay')
        expect(confirmation).toContain('Other links to the same folder stay')
      }
    }
  })
  it('the screen guards remain clean', () => expect(Object.values(space.guards()).flat()).toEqual([]))
})

describe('the confirmation binds everything the person inspected', () => {
  it('refuses disappeared, moved, newly shared and renamed files, and changed folder links', () => {
    const a: RemovalSubject = subjects[0]
    expect(removalBound(a, a)).toEqual({ kind: 'ready' })
    expect(removalBound(a, undefined)).toEqual({ kind: 'gone' })
    for (const change of [{ placements: ['local'] }, { owners: ['s_one', 's_two'] }, { name: 'changed.txt' }, { history: [{ at: 'later', by: 'user:operator', event: 'copied' }] }]) {
      expect(removalBound(a, { kind: 'asset', value: { ...asset, ...change } }).kind).toBe('changed')
    }
    for (const change of [{ root: '/elsewhere' }, { writable: true }, { writers: 'swarm_members' as const }, { label: 'Changed' }, { owner_swarm: 's_two' }]) {
      expect(removalBound(subjects[1], { kind: 'folder', value: { ...folder, ...change } }).kind).toBe('changed')
    }
  })
})

describe.each(subjects)('$kind removal results', (seen) => {
  const reply = seen.kind === 'asset' ? { sha256: asset.sha256, deleted: true } : { id: folder.id, unlinked: true }
  const clientFor = (work: () => Promise<unknown>) => ({ deleteAsset: work, unlinkFolder: work }) as unknown as HiveClient
  it('removes the row and shows success only after the hive answers', async () => {
    const onGone = vi.fn(), toast = vi.fn(), work = vi.fn(async () => reply)
    expect(await removalRun({ client: clientFor(work), seen, onGone, toast })()).toBe(true)
    expect(work).toHaveBeenCalledWith(seen.kind === 'asset' ? asset.sha256 : folder.id)
    expect(onGone).toHaveBeenCalledWith(seen.kind === 'asset' ? asset.sha256 : folder.id)
    expect(toast).toHaveBeenCalledOnce()
  })
  it('surfaces a store or route failure without removing the row or claiming success', async () => {
    const onGone = vi.fn(), toast = vi.fn()
    const result = await removalRun({ client: clientFor(async () => { throw new ApiError(503, 'asset_delete_failed', 'cloud refused deletion') }), seen, onGone, toast })()
    expect(result).toMatchObject({ unsettled: expect.stringContaining('cloud refused deletion') })
    expect(onGone).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
  })
  it('a row callback that changes identity cannot publish a success toast to the next person', async () => {
    vi.stubGlobal('window', { location: { search: '' } })
    const toast = vi.fn()
    const onGone = () => useHive.setState({ inits: useHive.getState().inits + 1 })
    expect(await removalRun({ client: clientFor(async () => reply), seen, onGone, toast })()).toBe(STALE)
    expect(toast).not.toHaveBeenCalled()
  })
  it.each([false, true])('a late answer, rejected=%s, cannot update the next identity', async (reject) => {
    vi.stubGlobal('window', { location: { search: '' } })
    let resolve!: (value: unknown) => void, fail!: (reason: Error) => void
    const answer = new Promise((yes, no) => { resolve = yes; fail = no })
    const onGone = vi.fn(), toast = vi.fn()
    const running = removalRun({ client: clientFor(() => answer), seen, onGone, toast })()
    useHive.setState({ inits: useHive.getState().inits + 1 })
    if (reject) fail(new Error('old identity failure')); else resolve(reply)
    expect(await running).toBe(STALE)
    expect(onGone).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
  })
})
