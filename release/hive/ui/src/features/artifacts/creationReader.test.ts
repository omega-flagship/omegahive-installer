// Purpose: a saved creation read in place on the Artifacts page, composed by artifacts.metta's artifact-reader: its text
// exactly as saved and never rendered, its title naming the reader, its revision, Back, View it for an HTML page and Copy,
// a creation made as a view shown as that view with Read the source, and a read that failed, with Try again.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// The reader as the component returns it, its read answered by a stand-in (no DOM library here). INVENTED text.
const read = vi.hoisted(() => ({ state: { status: 'loading', data: undefined, error: undefined, refreshing: false } as Record<string, unknown> }))
// only the read is a stand-in: the resource facts the screen states (isForbidden, errorMessage) stay the real ones
vi.mock('../../lib/useResource', async (actual) => ({ ...(await actual<typeof import('../../lib/useResource')>()), need: () => async () => undefined, useResource: () => ({ ...read.state, reload: () => undefined, mutate: () => undefined }) }))
vi.mock('../../store/store', () => ({ useHive: (sel: (s: { client: null }) => unknown) => sel({ client: null }) }))
// the view itself is ViewFrame's (its own tests); here it stands in, so the reader around it can be read
vi.mock('../views/ViewFrame', async () => {
  const { createElement: h } = await import('react')
  return { ViewFrame: ({ artifactId }: { artifactId: string }) => h('div', { 'data-view-stand-in': artifactId }) }
})
const { CreationReader } = await import('./CreationReader')

// the reader composes its screen with the hive's MeTTa: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

const draw = (view = false) => renderToStaticMarkup(createElement(CreationReader, { artifactId: 'ar7', revision: 1, title: 'Agenda for two days', view, onBack: () => undefined }))

describe('a saved creation read in place on the Artifacts page', () => {
  it('shows the text exactly as saved and never renders it, with its revision, a way back and a way to copy it', () => {
    const body = '<!DOCTYPE html><h1>Day 1</h1>\n09:00 Welcome & goals'
    read.state = { status: 'ready', data: { artifact_id: 'ar7', kind: 'plan', title: 'Agenda for two days', swarm_id: 's1', revision: 1, digest: `sha256:${'b'.repeat(64)}`, body, created_at: new Date(Date.now() - 5 * 60_000).toISOString() }, error: undefined, refreshing: false }
    const html = draw()
    expect(html).toContain('&lt;!DOCTYPE html&gt;&lt;h1&gt;Day 1&lt;/h1&gt;\n09:00 Welcome &amp; goals</pre>')
    expect(html).not.toContain('<h1>Day 1</h1>')
    const named = /<section aria-labelledby="([^"]+)"/.exec(html)
    expect(named).not.toBeNull()
    expect(html).toContain(`<h2 id="${named![1]}" class="text-xl font-semibold text-balance text-ink">Agenda for two days</h2>`)
    expect(html).toContain('Revision 1, saved 5m ago')
    expect(html).toContain('>Back to artifacts</button>')
    expect(html).toContain('>Copy the text</button>')
    // its text is an HTML page: the person may view it, sandboxed, on their own press
    expect(html).toContain('View it</button>')
    expect(html).not.toContain('Read the source')
  })

  it('says so when the text could not be read, with a retry, and offers no copy', () => {
    read.state = { status: 'error', data: undefined, error: new Error('The hive is asleep.'), refreshing: false }
    const html = draw()
    expect(html).toContain('Could not read it: The hive is asleep.')
    expect(html).toContain('>Try again</button>')
    expect(html).not.toContain('Copy the text')
  })

  it('opens a creation made as a view as that view, with Read the source and nothing to copy', () => {
    read.state = { status: 'ready', data: { artifact_id: 'ar7', kind: 'view', title: 'Agenda for two days', swarm_id: 's1', revision: 1, digest: `sha256:${'c'.repeat(64)}`, body: '(Screen agenda "Agenda")', created_at: new Date(Date.now() - 60_000).toISOString() }, error: undefined, refreshing: false }
    const html = draw(true)
    expect(html).toContain('<div data-view-stand-in="ar7"></div>')
    expect(html).not.toContain('</pre>')
    expect(html).toContain('>Back to artifacts</button>')
    expect(html).toContain('Read the source</button>')
    expect(html).not.toContain('View it</button>')
    expect(html).not.toContain('Copy the text')
  })
})
