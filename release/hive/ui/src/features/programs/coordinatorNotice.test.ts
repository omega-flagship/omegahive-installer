import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Agent, Swarm } from '../../api/types'
import { href, parse } from '../../lib/router'
import { CoordinatorNotice } from './CoordinatorNotice'

/**
 * followups-r9 item 1 (Studio walk, OI-5 interim; Design's next-action r1): the stopped-coordinator notice on an app
 * page offers the way to that mind: a link to the existing mind page in a new tab, for that coordinator's id. Only while
 * the coordinator is set and not awake. INVENTED minds and swarms only.
 */
const mind = (id: string, name: string, status: string) => ({ id, name, status }) as unknown as Agent
const swarm = (id: string, coordinator_id: string | null) => ({ id, name: `Invented ${id}`, coordinator_id }) as unknown as Swarm
const agents: Record<string, Agent> = {
  m_stopped: mind('m_stopped', 'Invented Director', 'stopped'),
  m_asleep: mind('m_asleep', 'Invented Sleeper', 'asleep'),
  m_awake: mind('m_awake', 'Invented Waker', 'awake'),
  m_other: mind('m_other', 'Invented Bystander', 'stopped'),
}
const render = (s: Swarm | null | undefined) => renderToStaticMarkup(createElement(CoordinatorNotice, { swarm: s, agents }))
const links = (html: string) => [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0])
const attr = (tag: string, name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1]

describe('the stopped-coordinator notice on an app page', () => {
  it('a stopped coordinator: the notice, with one link to that mind, in a new tab', () => {
    const html = render(swarm('s_design', 'm_stopped'))
    expect(html).toContain('Invented Director, who coordinates Invented s_design, is stopped.')
    const [a, ...rest] = links(html)
    expect(rest).toEqual([])
    expect(attr(a, 'href')).toBe(href({ name: 'dot', id: 'm_stopped', tab: 'mind' }))
    expect(parse(attr(a, 'href')!)).toEqual({ name: 'dot', id: 'm_stopped', tab: 'mind' })
    expect(attr(a, 'target')).toBe('_blank')
    expect(attr(a, 'rel')).toBe('noopener noreferrer')
    expect(html).toContain('View this mind in a new tab')
    expect(html).not.toContain('m_other')
  })

  it('an asleep coordinator links to its own id', () => {
    const [a] = links(render(swarm('s_b', 'm_asleep')))
    expect(attr(a, 'href')).toBe(href({ name: 'dot', id: 'm_asleep', tab: 'mind' }))
  })

  it('an awake coordinator, no coordinator, an unknown one, or no swarm: nothing at all', () => {
    expect(render(swarm('s_c', 'm_awake'))).toBe('')
    expect(render(swarm('s_d', null))).toBe('')
    expect(render(swarm('s_e', 'm_unknown'))).toBe('')
    expect(render(null)).toBe('')
    expect(render(undefined)).toBe('')
  })

  it('the link is an ordinary focusable anchor with a visible focus ring, nothing that wakes or asks', () => {
    const html = render(swarm('s_design', 'm_stopped'))
    const [a] = links(html)
    expect(attr(a, 'class')).toContain('focus-visible:outline')
    expect(a).not.toMatch(/tabindex="-1"|aria-hidden|onclick/i)
    expect(html).not.toMatch(/<button/)
  })
})
