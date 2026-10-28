import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERSON_APP_REASONS, type PersonAppReason } from '../../api/personApps'
import type { Program } from '../../api/types'

vi.mock('../../store/store', async () => {
  const actual = await vi.importActual<typeof import('../../store/store')>('../../store/store')
  return { ...actual, useHive: Object.assign((sel?: (s: ReturnType<typeof actual.useHive.getState>) => unknown) => sel ? sel(actual.useHive.getState()) : actual.useHive.getState(), actual.useHive) }
})
const { useHive } = await import('../../store/store')
const { default: ProgramPage, PersonAppFailure, PersonAppHostState, PersonAppReadyNotes } = await import('./ProgramPage')

/** P14: a person app's page. Invented apps and swarms only. */
const app = (id: string, placement: 'person' | 'swarm'): Program =>
  ({ id, name: 'Invented Assist', version: '1', description: '', icon: '', capabilities: [], source: 'built-in', enabled: true, error: null, placement }) as unknown as Program
const PERSON = app('invented-person', 'person')
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'")
const saved = useHive.getState()
beforeEach(() => vi.stubGlobal('window', { location: { search: '', hash: '' }, addEventListener: () => undefined, removeEventListener: () => undefined }))
afterEach(() => {
  useHive.setState({ programs: saved.programs, programsError: saved.programsError, loadPrograms: saved.loadPrograms, programDetails: saved.programDetails, swarms: saved.swarms, loadProgram: saved.loadProgram, client: saved.client })
  vi.unstubAllGlobals()
})

describe('a person app page', () => {
  it('opens without a swarm pick or the old empty state while the host makes its context', () => {
    useHive.setState({
      programs: [PERSON], programsError: null, loadPrograms: (async () => undefined) as never, loadProgram: (async () => null) as never,
      swarms: { s_a: { id: 's_a', name: 'Invented A' }, s_b: { id: 's_b', name: 'Invented B' } } as never,
      client: { openPersonApp: async () => new Promise(() => undefined) } as never,
    })
    const html = renderToStaticMarkup(createElement(ProgramPage, { id: PERSON.id }))
    expect(text(html)).toContain('Opening Invented Assist…')
    expect(html).not.toMatch(/Not set up on any swarm|Choose where to open|Works in/)
  })
  it('a route naming some other swarm is never opened for a person app', () => {
    useHive.setState({
      programs: [PERSON], programsError: null, loadPrograms: (async () => undefined) as never, loadProgram: (async () => null) as never,
      swarms: { s_other: { id: 's_other', name: 'Invented Other' } } as never,
      client: { openPersonApp: async () => new Promise(() => undefined) } as never,
    })
    const html = renderToStaticMarkup(createElement(ProgramPage, { id: PERSON.id, swarm: 's_other' }))
    expect(html).not.toContain('s_other')
    expect(text(html)).toContain('Opening Invented Assist…')
  })
})

describe('the host states', () => {
  const leave = () => undefined
  for (const [reason, { text: words }] of Object.entries(PERSON_APP_REASONS)) {
    it(`${reason}: fixed words and one action`, () => {
      const html = renderToStaticMarkup(createElement(PersonAppFailure, { reason: reason as PersonAppReason, opener: null, leave }))
      expect(text(html)).toContain(words)
      expect(html.match(/<button/g)).toHaveLength(1)
      expect(html).toContain(`data-person-app-failure="${reason}"`)
    })
  }
  const ready = (extra: object) => ({ kind: 'ready' as const, swarmId: 's_own', needs: [], helpers: 'none' as const, spaceLine: null, ...extra })
  it('no key: the host key card is a banner over the open app, opening is free', () => {
    const html = renderToStaticMarkup(createElement(PersonAppReadyNotes, { name: 'Invented Assist', state: ready({ helpers: 'key', needs: ['ai_key'] }), opener: null }))
    expect(html).toContain('data-host-key-card')
    expect(text(html)).toContain('Add your AI key')
    expect(text(html)).toContain('Opening it costs nothing')
    expect(text(html)).toContain('Private to you; hive admins can audit.')
  })
  it('declined: a banner over the open app, nothing set up, one way back to the card', () => {
    const html = renderToStaticMarkup(createElement(PersonAppReadyNotes, { name: 'Invented Assist', state: ready({ helpers: 'declined' }), opener: null }))
    expect(text(html)).toContain('Nothing was set up')
    expect(html.match(/<button/g)).toHaveLength(1)
  })
  it('a deployed or template-less app shows only the privacy line', () => {
    for (const helpers of ['none', 'ready'] as const) {
      const html = renderToStaticMarkup(createElement(PersonAppReadyNotes, { name: 'Invented Assist', state: ready({ helpers }), opener: null }))
      expect(html).not.toContain('<button')
    }
  })
  it('until the context is open: an opening line, never an empty state', () => {
    const html = renderToStaticMarkup(createElement(PersonAppHostState, { name: 'Invented Assist', state: { kind: 'opening' }, opener: null, leave }))
    expect(text(html)).toContain('Opening Invented Assist…')
  })
})
