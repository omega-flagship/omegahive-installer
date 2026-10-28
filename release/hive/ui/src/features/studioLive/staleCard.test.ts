import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * r1.9 (stand-in r1.8 blocking): a setup card the host refused for drift or own key renders NO confirm while its fresh
 * card loads or after the load failed: only an honest line and "Try loading again". react-dom/server. INVENTED values.
 */
// SSR reads zustand's initial state; read the live store instead (the closeHome render tests' approach)
vi.mock('zustand', async (orig) => {
  const real = await orig<typeof import('zustand')>()
  type Init = (...a: never[]) => unknown
  const make = (init: Init) => {
    const api = real.createStore(init as never) as { getState: () => unknown }
    const hook = (sel: (s: unknown) => unknown = (s) => s) => sel(api.getState())
    return Object.assign(hook, api)
  }
  return { ...real, create: (init?: Init) => (init ? make(init) : make) }
})
vi.stubGlobal('window', { location: { search: '', hash: '#/program/omegadesign/s_forge' }, addEventListener: () => undefined, removeEventListener: () => undefined, matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }), localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } })

const { DirectingStudio } = await import('./DirectingStudio')
const { useStudioLive } = await import('./store')
const { bindOperation } = await import('../../lib/boundOperation')
import type { SetupProposal } from './store'

const proposal: SetupProposal = {
  operation_id: 'op_inv1',
  request: { swarm_id: 's_x', program_id: 'omegadesign', app_pin: { id: 'omegadesign' }, maker_id: 'a_m', title: 'Invented poster', detail: 'invented', piece: { scene_id: 'sim-poster', source_ref: null }, key_id: 'k1', model: 'invented-model', role_id: null, tools: [], cap_usd: 2, step_cap_usd: 0.25, coordinator_exclusive: false, max_steps: 12, window_minutes: 60 },
  consent: { schema: 'omega-studio-consent-1', swarm_id: 's_x', program_id: 'omegadesign', app_pin: { id: 'omegadesign' }, maker_id: 'a_m', model: 'invented-model', key_id: 'k1', role_id: null, tools: [], payer: 'own_key', monthly: { kind: 'own_key_limit', limit_micros: 10_000_000 }, cap_micros: 2_000_000, step_cap_micros: 250_000, step_window_s: 180, max_steps: 12, window_minutes: 60, piece: { scene_id: 'sim-poster', source_ref: null }, coordinator_exclusive: false, title: 'Invented poster', detail: 'invented', disclosures: ['maker_restarts_between_steps', 'maker_reads_unsaved_piece_while_live'] },
  consent_digest: `sha256:${'c'.repeat(64)}`,
  maker_name: 'Invented maker', key_label: 'invented key', audience: 'only you', month_left_micros: 6_000_000,
}

const card = (over: Record<string, unknown>) => ({ proposal, state: 'open', refusal: null, op: bindOperation(), ...over })
const html = () => renderToStaticMarkup(createElement(DirectingStudio))

describe('r1.9: a stale card can never be confirmed from the page', () => {
  it('refreshing: the only primary button is a disabled "Loading the updated card…"; no Start or Confirm', () => {
    useStudioLive.setState({ setup: card({ state: 'refreshing', stale: true, notice: 'Your key changed since this card was shown, so nothing was started.' }) as never })
    const h = html()
    expect(h).toContain('Loading the updated card…')
    expect(h).not.toMatch(/Start drawing|Confirm again and start/)
  })
  it('refresh-failed: says it plainly and offers "Try loading again" only', () => {
    useStudioLive.setState({ setup: card({ state: 'refresh-failed', stale: true, refusal: { code: 'card_unavailable', words: 'Couldn’t load the updated card. Nothing was started.', keepWords: true } }) as never })
    const h = html()
    expect(h).toContain('Couldn’t load the updated card. Nothing was started.')
    expect(h).toContain('Try loading again')
    expect(h).not.toMatch(/Start drawing|Confirm again and start/)
  })
  it('own_key_needed: Keys and Try again; no Start for the old values', () => {
    useStudioLive.setState({ setup: card({ state: 'refused', stale: true, refusal: { code: 'own_key_needed', words: 'x', remedy: { label: 'Add your own key', go: 'keys' }, keepWords: true } }) as never })
    const h = html()
    expect(h).toContain('Add your own key')
    expect(h).toContain('Try again')
    expect(h).not.toMatch(/Start drawing|Confirm again and start/)
  })
  it('r1.12: any refused card shows no Start: busy → Try again; too old → Ask what to draw only; unavailable → both', () => {
    for (const [code, words, want, not] of [
      ['maker_busy', 'busy', ['Try again'], ['Ask what to draw']],
      ['turn_too_old', 'This Studio request came from an Ask message that’s now too old. Ask what to draw again.', ['Ask what to draw'], ['Try again', 'Set up again']],
      ['admit_unavailable', 'Studio can’t start this right now', ['Ask what to draw', 'Set up again'], []],
      ['maker_kind_unsupported', 'x', [], ['Try again', 'Ask what to draw']],
    ] as const) {
      useStudioLive.setState({ setup: card({ state: 'refused', stale: true, refusal: { code, words, keepWords: true } }) as never })
      const h = html()
      expect(h).not.toMatch(/Start drawing|Confirm again and start/)
      for (const w of want) expect([code, h.includes(`>${w}<`)]).toEqual([code, true])
      for (const w of not) expect([code, h.includes(`>${w}<`)]).toEqual([code, false])
    }
  })
  it('control: a fresh, unrefused card offers Start', () => {
    useStudioLive.setState({ setup: card({}) as never })
    expect(html()).toContain('Start drawing')
  })
})
