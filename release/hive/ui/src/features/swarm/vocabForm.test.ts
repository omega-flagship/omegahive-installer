// Purpose: pins that a swarm's vocabulary offers its add form only to people the hive lets add terms (may_control).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { hostRefusesControl } from '../../api/idleMinds'
import { Vocab } from './SwarmView'

/** Review #299: adding a term acts on the swarm, so GET /api/swarms says may_control and the page follows it. */
describe("a swarm's vocabulary form", () => {
  const html = (refused: boolean) => renderToStaticMarkup(createElement(Vocab, { swarmId: 's_1', refused }))

  it('is offered to whoever the hive lets add terms, and to a view without the flag (the route decides)', () => {
    expect(html(false)).toContain('Add vocabulary terms')
    expect(hostRefusesControl({})).toBe(false)
    expect(hostRefusesControl({ may_control: true })).toBe(false)
  })

  it('says who adds terms, with no form, when the hive says no', () => {
    expect(hostRefusesControl({ may_control: false })).toBe(true)
    expect(html(true)).not.toContain('Add vocabulary terms')
    expect(html(true)).toContain('Only this swarm’s owner or a hive admin adds terms.')
  })
})
