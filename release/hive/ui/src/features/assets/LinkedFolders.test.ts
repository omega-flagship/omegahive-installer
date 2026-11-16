import { describe, expect, it, vi } from 'vitest'
import { storeLimit } from '../../api/moneyWork'
import { SimClient } from '../../api/sim/SimClient'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useHive } from '../../store/store'
import type { HiveClient } from '../../api/client'
import { crumbs, LinkedFolders, LINKED_FOLDER_READERS, linkRefusal, parentPath, writersLabel } from './LinkedFolders'

// server rendering reads a store's initial state (no client); the section below draws with the client set here
vi.mock('../../store/store', async () => {
  const actual = await vi.importActual<typeof import('../../store/store')>('../../store/store')
  return { ...actual, useHive: Object.assign((pick: (s: ReturnType<typeof actual.useHive.getState>) => unknown) => pick(actual.useHive.getState()), actual.useHive) }
})

describe('file limits and linked folders', () => {
  it('the local store has no cap unless the hive says so; cloud keeps its own; an older hive keeps 100 MB', () => {
    const stores = [{ name: 'local', kind: 'local', max_bytes: null }, { name: 'cloud', kind: 's3', max_bytes: 100 * 1024 * 1024 }, { name: 'old', kind: 'local' }]
    expect(storeLimit(stores, 'local')).toBeNull()
    expect(storeLimit(stores, 'cloud')).toBe(100 * 1024 * 1024)
    expect(storeLimit(stores, 'old')).toBe(100 * 1024 * 1024)
    expect(storeLimit(stores, 'missing')).toBeNull()
  })

  it('the demo stores a file over 100 MB locally and refuses it in the cloud', async () => {
    const c = new SimClient({ seed: 3, latency: false, autoStart: false, historyDays: 1 })
    const big = { size: 150 * 1024 * 1024, type: 'application/octet-stream' } as Blob
    expect((await c.uploadAsset(big, { name: 'big.bin', store: 'local' })).bytes).toBe(big.size)
    await expect(c.uploadAsset(big, { name: 'big.bin', store: 'cloud' })).rejects.toMatchObject({ code: 'too_large' })
  })

  it('paths inside a linked folder walk up and break into crumbs', () => {
    expect(parentPath('a/b/c.txt')).toBe('a/b')
    expect(parentPath('a')).toBe('')
    expect(parentPath('')).toBe('')
    expect(crumbs('Site', 'src/app')).toEqual([['Site', ''], ['src', 'src'], ['app', 'src/app']])
    expect(crumbs('Site', '')).toEqual([['Site', '']])
  })

  it('link refusals read plainly; unknown codes fall back to the toast', () => {
    expect(linkRefusal('folder_denied')).toMatch(/protected/)
    expect(linkRefusal('local_hive_only')).toMatch(/own machine/)
    expect(linkRefusal('folder_not_allowed')).toMatch(/operator allows/)
    expect(linkRefusal('boom')).toBeNull()
  })

  it('who can write defaults to admins', () => {
    expect(writersLabel(undefined)).toBe('admins write')
    expect(writersLabel('admins')).toBe('admins write')
    expect(writersLabel('swarm_members')).toBe('swarm members write')
  })

  it('says under its heading who reads a linked folder: the swarm it belongs to, its minds read only, nothing copied', () => {
    expect(LINKED_FOLDER_READERS).toBe('Each folder belongs to a swarm: that swarm’s minds can read its files and never change them. Nothing is copied.')
    useHive.setState({ client: { listFolders: () => new Promise(() => undefined), me: () => new Promise(() => undefined) } as unknown as HiveClient })
    const html = renderToStaticMarkup(createElement(LinkedFolders, {}))
    expect(html).toMatch(/<h2[^>]*>Linked folders<\/h2>[\s\S]*<p[^>]*data-linked-folder-readers="">Each folder belongs to a swarm: that swarm’s minds can read its files and never change them\. Nothing is copied\.<\/p>/)
  })
})
