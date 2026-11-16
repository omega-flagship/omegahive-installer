// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { press } from '../../ui/miniDom.testkit'
import { useHive } from '../../store/store'
import type { HtmlArtifactView, MettaArtifactView } from '../../api/moneyWork'
import { ViewFrame } from './ViewFrame'
import { ReachPrompt, RunCard } from './ViewConsent'
import { localPorts, mountPage, settle, type MountedPage } from './mountedView.testkit'
import tipSource from '../../../../tests/fixtures/views-tip.metta?raw'

vi.setConfig({ testTimeout: 20_000 })

/**
 * No view runs until its person asks (Jon's second review on omegahive#299, item 7): a card stands in its place until
 * Run it, the view's worker starts only then, and an HTML view asks before it reaches the domains it declares, for that
 * revision. The hive here is a stand-in that records each answer and hands out the text only after Run it, as
 * hive/core/app.py does. INVENTED mind, ids and domains.
 */
const ID = `ar_${'6'.repeat(32)}`
const common = { artifact_id: ID, kind: 'view', title: 'Tip calculator', swarm_id: 's1', mind_id: 'a1', revision: 1,
  digest: `sha256:${'1'.repeat(64)}`, created_at: '2026-11-13T00:00:00Z' }
let page: MountedPage
const answers: [string, number, boolean][] = []
let ran = false
const client = {
  artifactView: async (): Promise<MettaArtifactView> => ({ ...common, carrier: 'metta', grant: { ran, reach: false }, source: ran ? tipSource : null }),
  consentView: async (id: string, revision: number, reach: boolean) => { answers.push([id, revision, reach]); ran = true; return { ran, reach } },
  subscribe: () => () => undefined,
}
const html = (asks: HtmlArtifactView['asks']): HtmlArtifactView => ({ ...common, carrier: 'view', grant: { ran: false, reach: false },
  resource: { uri: `ui://hive/artifacts/${ID}/r1`, mimeType: 'text/html;profile=mcp-app', _meta: { ui: { csp: {}, permissions: {} } } },
  asks, allow: '', refused: [], document: null })
const buttons = (name: string) => page.container.findAll((n) => n.tagName === 'BUTTON' && n.textContent === name)

beforeEach(async () => {
  page = await mountPage()
  answers.length = 0
  ran = false
  useHive.setState({ client: client as never, agents: { a1: { id: 'a1', name: 'Wren' } } as never })
})
afterEach(async () => {
  await page.restore()
  useHive.setState({ client: null as never, agents: {} as never })
})

describe('a view runs only when its person asks', () => {
  it('stands as a card until Run it, and its worker starts only after that answer', async () => {
    const workers = localPorts()
    await act(async () => page.root.render(<ViewFrame artifactId={ID} place="chat" port={workers.port} />))
    await settle()
    expect(page.container.textContent).toContain('Tip calculator, a view made by Wren. It runs only when you ask it to.')
    expect(workers.made).toBe(0)
    expect(page.container.findAll((n) => n.tagName === 'INPUT')).toHaveLength(0)

    await act(async () => { press(buttons('Run it')[0]) })
    await settle()
    expect(answers).toEqual([[ID, 1, false]])
    expect(workers.made).toBe(1)
    expect(page.container.textContent).toContain('Type the bill to see the split.')
    expect(buttons('Run it')).toHaveLength(0)
  })

  it('names the domains an HTML view would reach before it runs', async () => {
    await act(async () => page.root.render(<RunCard view={html({ connectDomains: ['https://api.example.com'], resourceDomains: ['https://cdn.example.org', 'https://api.example.com'] })} maker="Wren" onRun={async () => undefined} />))
    await settle()
    expect(page.container.textContent).toContain('It asks to reach https://api.example.com, https://cdn.example.org. Until you allow that for this version, it runs with no network.')
  })

  it('asks before an HTML view reaches its domains, for this version, and says when the answer could not be recorded', async () => {
    const view = html({ connectDomains: ['https://api.example.com'] })
    let allowed = 0
    await act(async () => page.root.render(<ReachPrompt view={view} onAllow={async () => { allowed++; throw new Error('the hive is restarting') }} />))
    await settle()
    expect(page.container.textContent).toContain('This view asks to reach https://api.example.com. It runs with no network until you allow that for this version.')
    await act(async () => { press(buttons('Allow for this version')[0]) })
    await settle()
    expect(allowed).toBe(1)
    expect(page.container.textContent).toContain('Could not allow it: the hive is restarting')
    // nothing to ask once nothing waits
    await act(async () => page.root.render(<ReachPrompt view={html({})} onAllow={async () => undefined} />))
    await settle()
    expect(page.container.textContent).toBe('')
  })
})
