import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * Witness for Quinn's 2026-10-08 report (the cloud Ask answered 409 no_mind; nothing on the page showed how to fix it).
 * Written against modules that already exist at 8739049, so it fails there and passes with the fix. INVENTED data.
 */
vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900 })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })

const { REFUSAL_WORDS } = await import('./words')
const { ThreadLog } = await import('./Thread')

describe('a 409 about who answers is said plainly, with the fix right there', () => {
  it('no_mind: the host’s exact words and "Choose who answers"', () => {
    expect(REFUSAL_WORDS.no_mind.say).toBe('Choose a swarm to ask first.')
    const html = renderToStaticMarkup(createElement(ThreadLog, { variant: 'glass', rows: [{ id: 'o#refused', op: 'o', kind: 'refused', text: '', reason: 'no_mind' }] }))
    expect(html).toContain('Choose a swarm to ask first.')
    expect(html).toContain('Choose who answers')
  })
  it('no_orchestrator: the host’s exact words and where an admin chooses one', () => {
    expect(REFUSAL_WORDS.no_orchestrator.say).toBe('That swarm has no coordinator to answer. An admin can choose one.')
    const html = renderToStaticMarkup(createElement(ThreadLog, { variant: 'glass', rows: [{ id: 'o#refused', op: 'o', kind: 'refused', text: '', reason: 'no_orchestrator' }] }))
    expect(html).toContain('An admin can choose one in the swarm’s settings.')
    expect(html).not.toMatch(/\bmodels?\b/i)
  })
})
