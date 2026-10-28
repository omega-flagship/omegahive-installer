import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Program } from '../../api/types'
import { sessionKey } from '../../store/programSession'

// server rendering reads a zustand store's initial snapshot; read the live state instead (as dualP2.test.ts does)
vi.mock('../../store/store', async () => {
  const actual = await vi.importActual<typeof import('../../store/store')>('../../store/store')
  return { ...actual, useHive: Object.assign((sel?: (s: ReturnType<typeof actual.useHive.getState>) => unknown) => sel ? sel(actual.useHive.getState()) : actual.useHive.getState(), actual.useHive) }
})
// the router's two moves, recorded (Back's fallback); everything else is the real router
const h = vi.hoisted(() => ({ closed: [] as (undefined | (() => void))[], navigated: [] as unknown[] }))
vi.mock('../../lib/router', async (importOriginal) => ({ ...(await importOriginal<object>()), closePage: (f?: () => void) => h.closed.push(f), navigate: (r: unknown) => h.navigated.push(r) }))
const { useHive } = await import('../../store/store')
const { ProgramForm } = await import('./ProgramForm')

/**
 * Town release r1: an app hosted as a form (OmegaDesign's canvas, Truth's case file, Atlas's body map) that the swarm
 * refuses shows the same RefusedHere as the generic stage (ProgramHost), with a way back, in whatever experience the
 * person is in. Before, it showed a bare "Could not open …" line: a dead end. Invented app and swarm only.
 */
const program = { id: 'invented-app', name: 'Invented App', enabled: true } as unknown as Program
const saved = useHive.getState()
afterEach(() => { useHive.setState({ programSessions: saved.programSessions, openProgram: saved.openProgram, loadProgram: saved.loadProgram }); vi.restoreAllMocks() })

function render(error: { code: string; message: string }, onExit?: () => void) {
  const key = sessionKey(program.id, 's_invented')
  useHive.setState({
    programSessions: { ...useHive.getState().programSessions, [key]: { ...(useHive.getState().programSessions[key] ?? {}), graph: null, error } as never },
    openProgram: (async () => undefined) as never, loadProgram: (async () => undefined) as never,
  })
  return renderToStaticMarkup(createElement(ProgramForm, { form: 'design-canvas', program, swarmId: 's_invented', grammar: 'classic', onExit }))
}

describe('a refused form-hosted app', () => {
  it('renders RefusedHere (title and Back), not a bare error line', () => {
    const html = render({ code: 'program_refused', message: 'Invented App is not allowed in this swarm' }, () => undefined)
    expect(html).toContain('Invented App isn')
    expect(html).toContain('t open in')
    expect(html).toContain('>Back<')
    expect(html).not.toContain('Could not open Invented App')
  })
  it('with no onExit from the caller: RefusedHere still, with a Back (Kimi town-r3 #4)', () => {
    const html = render({ code: 'program_refused', message: 'Invented App is not allowed in this swarm' })
    expect(html).toContain('>Back<')
    expect(html).not.toContain('Could not open Invented App')
  })
  it('that Back goes back through history when the page was reached in the hive, otherwise Home', async () => {
    const { refusedBack } = await import('./refusedBack')
    h.closed.length = 0; h.navigated.length = 0
    const exit = vi.fn()
    refusedBack(exit)()
    expect(exit).toHaveBeenCalledTimes(1)   // a caller's exit still wins
    expect(h.closed).toHaveLength(0)
    refusedBack()()
    expect(h.closed).toHaveLength(1)   // back through the hive's own history (closePage) ...
    h.closed[0]!()   // ... and with none to go back through: Home
    expect(h.navigated).toEqual([{ name: 'hive' }])
  })
  it('any other error keeps the existing line', () => {
    const html = render({ code: 'program_error', message: 'invented failure' }, () => undefined)
    expect(html).toContain('Could not open Invented App: invented failure')
  })
})
