import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimClient } from '../../api/sim/SimClient'
import type { Program } from '../../api/types'
import { sessionKey } from '../../store/programSession'

// server rendering reads a zustand store's initial snapshot; read the live state instead (as programFormRefused.test.ts does)
vi.mock('../../store/store', async () => {
  const actual = await vi.importActual<typeof import('../../store/store')>('../../store/store')
  return { ...actual, useHive: Object.assign((sel?: (s: ReturnType<typeof actual.useHive.getState>) => unknown) => sel ? sel(actual.useHive.getState()) : actual.useHive.getState(), actual.useHive) }
})
const { useHive } = await import('../../store/store')
const { default: ProgramPage } = await import('./ProgramPage')
const { formFor } = await import('../../forms/contract')

/**
 * Town follow-up (stand-in r3; Platform's classification 2026-10-09): a direct #/program/<id> for an app the host does
 * not list for this person is a generic page. No app name, no id, no heading, Ω entry or control of that app; the same
 * before the list arrives and after an identity change. Invented apps and swarms only; private ids appear here only
 * as the route a person might type, never as data.
 */
const app = (id: string, name: string): Program => ({ id, name, version: '1', description: '', icon: '', capabilities: [], source: 'built-in', enabled: true, error: null }) as unknown as Program
const LISTED = app('invented-listed', 'Invented Listed')
const SHARED = app('invented-shared', 'Invented Shared')
const UNAVAILABLE = /This app isn(&#x27;|')t available to you here/
const render = (id: string, swarm?: string) => renderToStaticMarkup(createElement(ProgramPage, { id, swarm }))
const stripped = (html: string) => html.replace(/<[^>]+>/g, ' ')   // what a person reads (text), plus attributes below

const saved = useHive.getState()
beforeEach(() => vi.stubGlobal('window', { location: { search: '', hash: '' }, addEventListener: () => undefined, removeEventListener: () => undefined }))
afterEach(() => {
  useHive.setState({ programs: saved.programs, programsError: saved.programsError, loadPrograms: saved.loadPrograms, programSessions: saved.programSessions, programDetails: saved.programDetails, swarms: saved.swarms, openProgram: saved.openProgram, loadProgram: saved.loadProgram })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const quiet = () => useHive.setState({ loadPrograms: (async () => undefined) as never, loadProgram: (async () => null) as never, openProgram: (async () => undefined) as never })

describe('a direct URL to an app the host does not list for this person', () => {
  for (const id of ['atlas', 'omegatruth', 'truth', 'invented-unlisted-app']) {
    it(`#/program/${id}: the generic page, naming nothing of it`, () => {
      quiet()
      useHive.setState({ programs: [LISTED], programsError: null })
      const html = render(id)
      expect(html).toMatch(UNAVAILABLE)
      expect(html).toContain('data-app-unavailable="unlisted"')
      expect(html).toContain('Back to Apps')
      // no name, id or app-specific control: not in the text, not in an attribute (aria-label, heading, data-app)
      expect(html.toLowerCase()).not.toContain(id.replace(/-.*/, ''))
      expect(html).not.toMatch(/Leave |Where it runs|Works in|data-app="/)
      expect(stripped(html)).not.toContain('Invented Listed')
    })
  }
  it('with a swarm in the route too: nothing of the app, and no app form or host mounts', () => {
    quiet()
    useHive.setState({ programs: [LISTED], programsError: null, swarms: { s_inv: { id: 's_inv', name: 'Invented Swarm' } } as never })
    const html = render('atlas', 's_inv')
    expect(html).toMatch(UNAVAILABLE)
    expect(html).not.toContain('data-app-form')
    expect(html.toLowerCase()).not.toContain('atlas')
  })
  it('before the list arrives: a nameless opening line, not the id', () => {
    quiet()
    useHive.setState({ programs: null, programsError: null })
    const html = render('atlas')
    expect(html).toContain('Opening the app…')
    expect(html.toLowerCase()).not.toContain('atlas')
  })
  it('a list that could not be read: nameless, with a retry and a way back', () => {
    quiet()
    useHive.setState({ programs: null, programsError: 'invented failure' })
    const html = render('omegatruth')
    expect(html).toContain('Try again')
    expect(html).toContain('Back to Apps')
    expect(html.toLowerCase()).not.toContain('truth')
  })
  it('a listed app keeps its name (the control case)', () => {
    quiet()
    useHive.setState({ programs: [LISTED], programsError: null })
    const html = render(LISTED.id)
    expect(html).not.toMatch(UNAVAILABLE)
    expect(html).toContain('Invented Listed app')   // its aria-label
    expect(html).toContain('Opening Invented Listed…')
  })
})

describe('after an identity change (real init, two SimClients)', () => {
  const sims: SimClient[] = []
  afterEach(() => { for (const c of sims.splice(0)) c.disconnect() })
  it('A lists the app and sees its name; B does not and sees the generic page, before and after its list arrives', async () => {
    const a = new SimClient({ seed: 21, latency: false, autoStart: false, historyDays: 1 })
    const b = new SimClient({ seed: 22, latency: false, autoStart: false, historyDays: 1 })
    sims.push(a, b)
    vi.spyOn(a, 'programs').mockResolvedValue([LISTED, SHARED])
    vi.spyOn(b, 'programs').mockResolvedValue([LISTED])
    await useHive.getState().init(a)
    await useHive.getState().loadPrograms()
    expect(render(SHARED.id)).toContain('Invented Shared app')

    await useHive.getState().init(b)
    // the moment after the switch: A's list is gone with A, and nothing of the app shows while B's is asked
    const between = render(SHARED.id)
    expect(between).not.toContain('Invented Shared')
    expect(between).not.toContain('invented-shared')
    await useHive.getState().loadPrograms()
    const after = render(SHARED.id)
    expect(after).toMatch(UNAVAILABLE)
    expect(after).not.toContain('Invented Shared')
    expect(after).not.toContain('invented-shared')
  }, 45000)   // followups-r6: measured worst 14145 ms (caps lifted; 1 and 3 workers, load to 9.3), about 3x
})

/**
 * Kimi town-r3 #3: Atlas's own form (forms/lifeMap) is reached only through Atlas's own program page. Routing only,
 * with invented props: no Atlas data or content is read, and the form's module is never rendered beyond its Suspense
 * fallback (server rendering does not resolve lazy components).
 */
describe("Atlas's form renders only on Atlas's own program page", () => {
  it('the contract routes the life-map form to the atlas id and to no other', () => {
    expect(formFor('atlas', null)).toBe('life-map')
    for (const id of ['omegatruth', 'omegadesign', 'commons-explorer', 'invented-listed', 'atlas-invented', 'Atlas', 'life-map', ''])
      expect(formFor(id, null), id).not.toBe('life-map')
    // whatever a program describes, it never earns the life-map form
    expect(formFor('invented-listed', { kinds: [{ role: 'subject' }, { role: 'reading' }] } as never)).not.toBe('life-map')
  })
  const atlasSession = () => {
    useHive.setState({
      swarms: { s_inv: { id: 's_inv', name: 'Invented Swarm' } } as never,
      programSessions: { [sessionKey('atlas', 's_inv')]: { graph: { title: 'Invented', items: [], revision: 'r1' } } as never },
      programDetails: {},
    })
  }
  it('when the host lists atlas for this person: its page mounts the life-map form', () => {
    quiet()
    atlasSession()
    useHive.setState({ programs: [app('atlas', 'Invented Name')], programsError: null })
    expect(render('atlas', 's_inv')).toContain('data-app-form="life-map"')
  })
  it('when the host does not list it: the generic page, with no form at all', () => {
    quiet()
    atlasSession()
    useHive.setState({ programs: [LISTED], programsError: null })
    const html = render('atlas', 's_inv')
    expect(html).toMatch(UNAVAILABLE)
    expect(html).not.toContain('data-app-form')
  })
  it("another app's page never mounts it", () => {
    quiet()
    useHive.setState({
      swarms: { s_inv: { id: 's_inv', name: 'Invented Swarm' } } as never,
      programSessions: { [sessionKey(LISTED.id, 's_inv')]: { graph: { title: 'Invented', items: [], revision: 'r1' } } as never },
      programs: [LISTED, app('atlas', 'Invented Name')], programsError: null,
    })
    expect(render(LISTED.id, 's_inv')).not.toContain('life-map')
  })
})

describe("Atlas's form component is reached only through the form contract", () => {
  it('no hive source imports forms/lifeMap/LifeMap except forms/contract (the developer harness never mounts it)', async () => {
    const fsName = 'node:fs'
    const { readdirSync, readFileSync, statSync } = (await import(/* @vite-ignore */ fsName)) as {
      readdirSync: (p: string) => string[]; readFileSync: (p: string, e: 'utf8') => string; statSync: (p: string) => { isDirectory: () => boolean }
    }
    const root = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(`${d}/${n}`).isDirectory() ? walk(`${d}/${n}`) : /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [`${d}/${n}`] : []))
    const importers = walk(root)
      .filter((f) => !f.startsWith(`${root}/forms/lifeMap/`))
      .filter((f) => /from\s+['"][^'"]*lifeMap\/LifeMap['"]|import\(\s*['"][^'"]*lifeMap\/LifeMap['"]\s*\)/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(root.length + 1))
    expect(importers).toEqual(['forms/contract.ts'])
  })
})
