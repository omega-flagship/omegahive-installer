// @vitest-environment node
// Purpose: a research report back at its Ask turn (ResearchRow in features/ask/Thread.tsx) drawn as plain text: its
// words, title, summary and how many claims cite a page the researcher opened, then on request each section's claims
// with their sources as https links that open apart from the hive, and the questions still open. INVENTED words.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import type { AskRow } from '../../store/ask'
import { readResearchView } from '../../api/ask'
import { press } from '../../ui/miniDom.testkit'
import { mountPage, settle, type MountedPage } from '../views/mountedView.testkit'
import { ResearchRow } from './Thread'
import { RESEARCH_WORDS } from './words'

const view = readResearchView({
  request_id: 'rq_res1', title: 'Reputation systems', state: 'done',
  report: {
    summary: 'Reputation rests on staking and peer review.',
    sections: [{ heading: 'Advances', claims: [
      { text: 'Staked reviews <img src=x onerror=alert(1)> make a bad report cost something.', cited: true, citations: [{ url: 'https://example.org/staking', title: 'Staking', verified: true }] },
      { text: 'No network yet measures reputation across hives.', cited: false, citations: [] },
    ] }],
    open_questions: ['How is collusion between reviewers found?'],
    checks: { claims: 2, cited: 1 },
  },
})!
const row: AskRow = { id: 'op1#8', op: 'op1', seq: 8, kind: 'research', text: RESEARCH_WORDS.done, state: 'sent', research: view }

let page: MountedPage
beforeEach(async () => {
  page = await mountPage()
})
afterEach(async () => {
  await page.restore()
})

const all = (tag: string) => page.container.findAll((n) => n.tagName === tag)

describe('a research report back at its turn', () => {
  it('shows its words, title, summary and checks, and its claims and sources only on request', async () => {
    await act(async () => page.root.render(<ResearchRow r={row} />))
    await settle()
    const text = () => page.container.textContent
    for (const said of [RESEARCH_WORDS.done, 'Reputation systems', 'Reputation rests on staking and peer review.', 'The researcher opened a page for 1 of 2 claims.']) expect(text()).toContain(said)
    expect(text()).not.toContain('Staked reviews')
    const toggle = all('BUTTON').find((b) => b.textContent === 'Show the report')!
    await act(async () => press(toggle))
    expect(text()).toContain('Staked reviews <img src=x onerror=alert(1)> make a bad report cost something.')
    expect(all('IMG')).toEqual([])
    const links = all('A').map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')])
    expect(links).toEqual([['Staking', 'https://example.org/staking', '_blank', 'noopener noreferrer']])
    expect(text()).toContain('No network yet measures reputation across hives. · no page the researcher opened')
    expect(text()).toContain('How is collusion between reviewers found?')
    expect(all('BUTTON').map((b) => b.textContent)).toEqual(['Hide the report'])
  })

  it('a report not read here, or a research that ended without one, shows its words alone', async () => {
    await act(async () => page.root.render(<ResearchRow r={{ ...row, text: RESEARCH_WORDS.failed, state: 'failed', research: undefined }} />))
    await settle()
    expect(page.container.textContent).toBe(RESEARCH_WORDS.failed)
    expect(all('BUTTON')).toEqual([])
  })
})
