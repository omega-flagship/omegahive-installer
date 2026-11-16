/**
 * What the memory folder is, in words (Lisbon testers, 10 Nov, took "keep a copy in a folder" for sharing a folder's
 * files with their minds): wherever the folder is offered or kept, the page says only the memory file goes there and
 * no mind reads the folder, and it points to Files and storage for files minds should read. Rendered, both states.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MEMORY_FOLDER_ONLY } from './durability'

// server rendering reads a store's initial state; here the section draws for a signed-in person whose memory is ready
vi.mock('../../lib/askMemory', async () => {
  const actual = await vi.importActual<typeof import('../../lib/askMemory')>('../../lib/askMemory')
  const view = { owner: { principal: 'user:u_test', hive: 'sim' }, ready: true, beliefs: [], trace: [], talks: [], forgets: '0|', talkRecall: false }
  return { ...actual, useAskMemory: () => view }
})
import { folderLink, type FolderState } from './folder'
import { MemoryDurability } from './MemoryDurability'

const was = folderLink.state
const draw = (state: Partial<FolderState>) => {
  ;(folderLink as unknown as { state: FolderState }).state = { ...was, ...state }
  return renderToStaticMarkup(createElement(MemoryDurability, {}))
}
afterEach(() => {
  ;(folderLink as unknown as { state: FolderState }).state = was
})

describe('the memory folder says what it is', () => {
  it('offered: only the memory file, no mind reads the folder, and Files and storage for files minds read', () => {
    expect(MEMORY_FOLDER_ONLY).toBe('Only the memory file goes there: your mind doesn’t read the folder’s other files.')
    const html = draw({ supported: true, linked: null })
    expect(html).toContain('Or keep a copy in a folder on this computer, written again after each change. Only the memory file goes there: your mind doesn’t read the folder’s other files. To give your minds files to read, use')
    expect(html).toMatch(/<a [^>]*href="#\/assets"[^>]*>Files and storage<\/a>/)
  })

  it('kept: the same sentence beside the folder it is kept in', () => {
    const html = draw({ supported: true, linked: 'Notes', permission: 'granted', wroteAt: null, guarded: null })
    expect(html).toContain('Kept in your folder “Notes”. It is written again after each change. Only the memory file goes there: your mind doesn’t read the folder’s other files.')
  })
})
