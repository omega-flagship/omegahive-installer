import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AskSettings } from '../../api/ask'
import type { StudioHostClient } from './api'
import { DrawingEntry, DrawingIdentity, DrawingModeChoice, drawingAvailability } from './drawingUi'

/** Synthetic clients/data only. These Source cases are authored UNRUN; no authority or live drawing is claimed. */
const noCall = async () => { throw new Error('No host call belongs in a UI projection') }
const client: StudioHostClient = {
  mode: 'live', studioSession: noCall, studioPiece: noCall, studioOutcome: noCall, studioControl: noCall,
  studioMount: noCall, studioMountHeartbeat: noCall, studioUnmount: noCall, studioMountReadback: noCall,
  studioRecordIntent: noCall, askSubmitIntent: noCall, askSteer: noCall, studioSetupProposal: noCall,
}
const settings = (on: unknown): AskSettings => ({ swarm_id: null, thread_budget_usd: 5, capabilities: { conductor: false, memory: false, studio_sessions: on } } as AskSettings)
const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element)

describe('Create drawing entry explains its actual availability', () => {
  it('keeps the entry visible and disabled when the host has not offered drawing, without inventing a cause', () => {
    for (const on of [false, undefined, 'true', 1]) {
      const availability = drawingAvailability(client, settings(on), true, true, true)
      expect(availability.code).toBe('host_not_offered')
      const html = render(createElement(DrawingEntry, { availability, start: () => { throw new Error('Must not start') } }))
      expect(html).toContain('Draw live in Create')
      expect(html).toContain('disabled')
      expect(html).toContain('It has not said why.')
      expect(html).not.toMatch(/Mac|template|HIVE_STUDIO_SESSIONS/)
    }
  })

  it('says the reason the host gave for not offering drawing, and offers the person no step they cannot take (show run f4)', () => {
    const off = (why: unknown): AskSettings => ({ swarm_id: null, thread_budget_usd: 5, capabilities: { conductor: false, memory: false, studio_off: why } } as AskSettings)
    const words = (why: unknown) => {
      const availability = drawingAvailability(client, off(why), true, true, true)
      expect(availability.code).toBe('host_not_offered')
      return render(createElement(DrawingEntry, { availability, start: () => { throw new Error('Must not start') } }))
    }
    const notSetUp = words('not_set_up')
    expect(notSetUp).toContain('Live drawing isn’t set up on this hive yet, so nothing can be drawn here.')
    expect(notSetUp).toContain('That is for whoever runs this hive; there is nothing for you to do here.')
    const turnedOff = words('off')
    expect(turnedOff).toContain('Live drawing is turned off on this hive, so nothing can be drawn here.')
    expect(turnedOff).toContain('That is for whoever runs this hive; there is nothing for you to do here.')
    for (const html of [notSetUp, turnedOff]) {
      expect(html).not.toContain('It has not said why.')
      expect(html).not.toMatch(/key|Keys|template|HIVE_STUDIO|Mac/)      // a key does not turn it on: no key step
      expect(html.match(/<button/g)).toHaveLength(1)                       // only the disabled Draw live
    }
    for (const why of [undefined, 'something_new', 1]) expect(words(why)).toContain('It has not said why.')   // never a guessed reason
  })

  it('names the parts the startup check found missing when the switch is on but the check keeps drawing off', () => {
    // the hive sends the parts, in plain words, only to whoever runs it; a member's answer has none and says the check keeps it off
    const checked = (missing: unknown): string => {
      const caps = { conductor: false, memory: false, studio_off: 'self_check', studio_missing: missing }
      const availability = drawingAvailability(client, { swarm_id: null, thread_budget_usd: 5, capabilities: caps } as AskSettings, true, true, true)
      expect(availability.code).toBe('host_not_offered')
      return availability.reason ?? ''
    }
    const step = 'That is for whoever runs this hive; there is nothing for you to do here.'
    expect(checked(['the reviewed safe restart for Macs'])).toBe('Live drawing is switched on, but this hive’s startup check found parts missing (the reviewed safe restart for Macs), so nothing can be drawn here until a build of the hive has them.')
    expect(checked(['a', 'b'])).toContain('(a and b)')
    expect(checked(['a', 'b', 'c'])).toContain('(a, b and c)')
    // a list that is absent, empty or not names never invents a part, and still says the check keeps drawing off
    for (const missing of [undefined, [], [3, ' '], 'one part']) {
      expect(checked(missing)).toBe(`Live drawing is switched on, but this hive’s startup check keeps it off, so nothing can be drawn here. ${step}`)
    }
  })

  it('distinguishes unknown host data, missing client, space, interface and setup method', () => {
    expect(drawingAvailability(client, null, true, true, true).code).toBe('checking')
    expect(drawingAvailability(null, settings(true), true, true, true).code).toBe('client_unavailable')
    expect(drawingAvailability(client, settings(true), false, true, true).code).toBe('space_unavailable')
    expect(drawingAvailability(client, settings(true), true, false, true).code).toBe('canvas_unavailable')
    expect(drawingAvailability({ ...client, studioSetupProposal: undefined }, settings(true), true, true, true).code).toBe('setup_unavailable')
    const withoutTurn = drawingAvailability(client, settings(true), true, true, false)
    expect(withoutTurn.code).toBe('ask_turn_required')
    const html = render(createElement(DrawingEntry, { availability: withoutTurn, start: () => undefined, ask: () => undefined }))
    expect(html).toContain('disabled')
    expect(html).toContain('Ask what to draw')
    expect(html).toContain('Type what you want drawn in the Ask, then press Draw live.')
  })

  it('words still in the Ask are enough: Draw live asks them first (Jon, 4 Nov), so the button is on', () => {
    const fromWords = drawingAvailability(client, settings(true), true, true, false, true)
    expect(fromWords).toEqual({ available: true, code: 'available', reason: null })
    expect(render(createElement(DrawingEntry, { availability: fromWords, start: () => undefined }))).not.toContain('disabled')
    // the host's own limits still decide first: words never switch on drawing a hive has not offered
    expect(drawingAvailability(client, settings(false), true, true, false, true).code).toBe('host_not_offered')
  })

  it('what Draw live could not do is said under its button, and the button waits while the request is being sent', () => {
    const availability = drawingAvailability(client, settings(true), true, true, false, true)
    const html = render(createElement(DrawingEntry, { availability, start: () => undefined, note: 'The Ask did not take that request, so nothing was drawn.', busy: true }))
    expect(html).toContain('data-drawing-note')
    expect(html).toContain('The Ask did not take that request')
    expect(html).toContain('Sending your request…')
    expect(html).toContain('disabled')
  })

  it('requires all existing capability-checked routes; a true host bit alone does not enable drawing', () => {
    expect(drawingAvailability({ ...client, studioControl: undefined }, settings(true), true, true, true).code).toBe('client_unsupported')
    const availability = drawingAvailability(client, settings(true), true, true, true)
    expect(availability).toEqual({ available: true, code: 'available', reason: null })
    const html = render(createElement(DrawingEntry, { availability, start: () => undefined }))
    expect(html).toContain('Draw live in Create')
    expect(html).not.toContain('disabled')
  })
})

describe('the visible future-message choice', () => {
  it('shows both Steer and Queue, the selected value, and the separate paid-work meaning', () => {
    const html = render(createElement(DrawingModeChoice, { mode: 'queue', available: true, steerAvailable: true, change: () => undefined }))
    expect(html).toContain('>Steer</button>')
    expect(html).toContain('>Queue</button>')
    expect(html).toMatch(/aria-pressed="true"[^>]*>Queue/)
    expect(html).toContain('own consent and spending checks')
  })

  it('keeps both controls visible but unavailable when the session cannot accept messages', () => {
    const html = render(createElement(DrawingModeChoice, { mode: 'steer', available: false, steerAvailable: true, change: () => undefined }))
    expect((html.match(/disabled/g) ?? []).length).toBe(2)
    expect(html).toContain('No message will be sent through this session while it is unavailable.')
  })

  it('does not enable Steer when the directions capability is missing', () => {
    const html = render(createElement(DrawingModeChoice, { mode: 'queue', available: true, steerAvailable: false, change: () => undefined }))
    expect(html).toMatch(/disabled[^>]*>Steer/)
    expect(html).not.toMatch(/disabled[^>]*>Queue/)
    expect(html).toContain('This hive has not offered drawing directions.')
  })
})

describe('omega drawing organ and separate maker identity', () => {
  it('labels only the named omega from the same turn and keeps the actual maker in Raw', () => {
    const html = render(createElement(DrawingIdentity, { omega: { mind_id: 'omega_wren', name: 'Wren' }, maker: { id: 'maker_real', name: 'Host maker' } }))
    expect(html).toContain('Wren · drawing')
    expect(html).toContain('uses a separate maker')
    expect(html).toContain('<summary>Raw</summary>')
    expect(html).toContain('Maker ID (host record)')
    expect(html).toContain('maker_real')
    expect(html).toContain('Host maker')
    expect(html).not.toContain('Design team')
  })

  it('does not invent an omega association when the host turn has none', () => {
    const html = render(createElement(DrawingIdentity, { omega: null, maker: { id: 'maker_real' } }))
    expect(html).toContain('This record does not identify the omega')
    expect(html).not.toContain(' · drawing')
    expect(html).toContain('maker_real')
  })

  it('renders names and IDs as text rather than raw markup', () => {
    const html = render(createElement(DrawingIdentity, { omega: { mind_id: 'omega_<x>', name: '<script>Wren</script>' }, maker: { id: '<maker>', name: '<img>' } }))
    expect(html).toContain('&lt;script&gt;Wren&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img>')
  })
})
