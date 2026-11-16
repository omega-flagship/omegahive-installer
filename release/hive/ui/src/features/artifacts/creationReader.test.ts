import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// The reader as the component returns it, its read answered by a stand-in (no DOM library here). INVENTED text.
const read = vi.hoisted(() => ({ state: { status: 'loading', data: undefined, error: undefined, refreshing: false } as Record<string, unknown> }))
vi.mock('../../lib/useResource', () => ({ need: () => async () => undefined, useResource: () => ({ ...read.state, reload: () => undefined, mutate: () => undefined }) }))
vi.mock('../../store/store', () => ({ useHive: (sel: (s: { client: null }) => unknown) => sel({ client: null }) }))
const { CreationReader } = await import('./CreationReader')

const draw = () => renderToStaticMarkup(createElement(CreationReader, { artifactId: 'ar7', revision: 1, title: 'Agenda for two days', onBack: () => undefined }))

describe('a saved creation read in place on the Artifacts page', () => {
  it('shows the text exactly as saved and never renders it, with its revision, a way back and a way to copy it', () => {
    const body = '<!DOCTYPE html><h1>Day 1</h1>\n09:00 Welcome & goals'
    read.state = { status: 'ready', data: { artifact_id: 'ar7', kind: 'plan', title: 'Agenda for two days', swarm_id: 's1', revision: 1, digest: `sha256:${'b'.repeat(64)}`, body, created_at: new Date(Date.now() - 5 * 60_000).toISOString() }, error: undefined, refreshing: false }
    const html = draw()
    expect(html).toContain('&lt;!DOCTYPE html&gt;&lt;h1&gt;Day 1&lt;/h1&gt;\n09:00 Welcome &amp; goals</pre>')
    expect(html).not.toContain('<h1>Day 1</h1>')
    expect(html).toContain('aria-label="Agenda for two days, revision 1"')
    expect(html).toContain('Revision 1, saved 5m ago')
    expect(html).toContain('>Back to artifacts</button>')
    expect(html).toContain('>Copy the text</button>')
  })

  it('says so when the text could not be read, with a retry, and offers no copy', () => {
    read.state = { status: 'error', data: undefined, error: new Error('The hive is asleep.'), refreshing: false }
    const html = draw()
    expect(html).toContain('Could not read it')
    expect(html).toContain('The hive is asleep.')
    expect(html).not.toContain('Copy the text')
  })
})
