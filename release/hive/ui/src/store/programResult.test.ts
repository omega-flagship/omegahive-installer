import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { WorkGraph } from '../api/types'
import { ResultPanel } from '../features/programs/ResultPanel'
import { applyResult, goTo, newSession, pushStep, reconcile, type ProgramSession } from './programSession'
import { TOOLS_063_RESULTS as R, TOOLS_063_REVISION as REV } from './programResult.fixture'

/**
 * Root 2026-10-08 (live Tools 0.6.3): the reducer kept an action's sources and DISCARDED everything else it returned
 * (tools, input_contract, execution_binding, wire_examples), and an examples-only result produced no detail, notice
 * or refresh. These run the reducer on the app's own frozen read-only outputs.
 */
const graph = (revision = REV): WorkGraph => ({
  revision,
  focus: 'atom-recall',
  title: 'Tools',
  suggested_stage: 'detail',
  items: [
    { id: 'atom-recall', kind: 'tool', label: 'Exact AtomSpace recall' },
    { id: 'set:pln', kind: 'set', label: 'PLN' },
  ],
  links: [],
  groups: [],
  notes: [],
})
const open = (): ProgramSession => ({ ...newSession('omega-tools', 'sw_tools', [{ stage: 'detail', focus: 'atom-recall' }]), graph: graph() })
const act = (s: ProgramSession, action: keyof typeof R | string, items: string[], r = R[action as keyof typeof R]) => applyResult(s, r, { action, items, params: {}, now: 1000, baseRevision: REV })
const keys = (s: ProgramSession) => (s.result?.fields ?? []).map(([k]) => k)

describe('program results: what an action returned is kept, bound and labelled (Tools 0.6.3 outputs)', () => {
  it('the fixtures are the app’s returned shapes (keys as observed live)', () => {
    expect(Object.keys(R['inspect-tool'].detail!)).toEqual(['tools', 'authority', 'executed_now', 'input_contract', 'execution_binding', 'sources', 'wire_examples'])
    expect(Object.keys(R['show-examples'].detail!)).toEqual(['scope', 'recorded_at', 'executed_now', 'examples', 'authority', 'installation'])
    expect(R['compose-set'].detail).toMatchObject({ schema: 'omega-tools-composition-preview/v1', executed: false, status: 'incomplete' })
  })

  it('Inspect skill keeps tools, contract, binding and examples, and still keeps its two sources', () => {
    const { session, refresh } = act(open(), 'inspect-tool', ['atom-recall'])
    expect(refresh).toBe(false)
    expect(session.sourceDetail?.sources).toHaveLength(2)
    expect(keys(session)).toEqual(['tools', 'authority', 'executed_now', 'input_contract', 'execution_binding', 'wire_examples'])
    const f = Object.fromEntries(session.result!.fields)
    expect(f.input_contract).toEqual(R['inspect-tool'].detail!.input_contract)
    expect(f.execution_binding).toEqual(R['inspect-tool'].detail!.execution_binding)
    expect(f.wire_examples).toEqual(R['inspect-tool'].detail!.wire_examples)
    expect(session.result).toMatchObject({ action: 'inspect-tool', items: ['atom-recall'], programId: 'omega-tools', swarmId: 'sw_tools', sessionKey: open().key, revision: REV, basis: 'banked', stale: false, at: 1000 })
  })

  it('See tested examples (examples only, no sources, no message) shows its examples, labelled banked', () => {
    const { session } = act(open(), 'show-examples', ['atom-recall'])
    expect(session.sourceDetail).toBeNull()
    expect(keys(session)).toEqual(['scope', 'recorded_at', 'executed_now', 'examples', 'authority', 'installation'])
    expect((Object.fromEntries(session.result!.fields).examples as unknown[]).length).toBe(5)
    expect(session.result!.basis).toBe('banked')
  })

  it('a composition preview is kept with its unresolved slots, and executed:false reads as banked, not a run', () => {
    const { session } = act({ ...open(), trail: [{ stage: 'detail', focus: 'set:pln' }] }, 'compose-set', ['set:pln'])
    const f = Object.fromEntries(session.result!.fields)
    expect(f.unresolved_required_slots).toEqual(['pln-inference', 'reasoning-continuation'])
    expect(f.components).toHaveLength(2)
    expect(f.status).toBe('incomplete')
    expect(session.result!.basis).toBe('banked')
  })

  it('a result that says nothing either way is "unstated", one that says it ran is "current"', () => {
    expect(act(open(), 'x', ['atom-recall'], { status: 'done', detail: { kind: 'ToolResult' } }).session.result!.basis).toBe('unstated')
    expect(act(open(), 'x', ['atom-recall'], { status: 'done', detail: { kind: 'ToolResult', executed_now: true } }).session.result!.basis).toBe('current')
  })

  it('nothing showable: a plain "Nothing to show for this result" notice instead of silence', () => {
    for (const r of [{ status: 'done' as const }, { status: 'done' as const, detail: {} }, { status: 'done' as const, detail: { sources: [], note: '', list: [] } }]) {
      const { session } = act(open(), 'show-examples', ['atom-recall'], r)
      expect(session.result).toBeNull()
      expect(session.notice?.title).toBe('Nothing to show for this result')
    }
  })

  it('a declined, stale or failed action clears earlier data instead of leaving it looking current', () => {
    const shown = act(open(), 'inspect-tool', ['atom-recall']).session
    expect(shown.result).not.toBeNull()
    expect(act(shown, 'show-examples', ['atom-recall'], { status: 'refused', message: 'Banked checks are not passing.' }).session.result).toBeNull()
    expect(act(shown, 'inspect-tool', ['atom-recall'], { status: 'stale', message: 'Refresh the catalogue before inspecting.' }).session.result).toBeNull()
    expect(act(shown, 'inspect-tool', ['atom-recall'], { status: 'error', message: 'boom' }).session.result).toBeNull()
    // a new done action replaces it with its own
    expect(act(shown, 'show-examples', ['atom-recall']).session.result!.action).toBe('show-examples')
  })

  it('navigation resets it; a changed revision marks it out of date; items gone from view drop it', () => {
    const shown = act(open(), 'inspect-tool', ['atom-recall']).session
    expect(goTo(shown, pushStep(shown.trail, { stage: 'map', focus: 'atom-recall' })).result).toBeNull()
    const moved = reconcile(shown, graph('r-next'))
    expect(moved.result).toMatchObject({ stale: true, revision: REV })
    expect(reconcile(shown, { ...graph(), items: [graph().items[1]] }).result).toBeNull()
    // answered against a revision the view has already left: out of date from the start
    const late = applyResult({ ...open(), graph: graph('r-next') }, R['inspect-tool'], { action: 'inspect-tool', items: ['atom-recall'], params: {}, baseRevision: REV })
    expect(late.session.result!.stale).toBe(true)
  })

  it('a new session starts with none', () => {
    expect(newSession('omega-tools', 'sw_tools').result).toBeNull()
  })
})

describe('program results: rendered as inert text', () => {
  const render = (s: ProgramSession) => renderToStaticMarkup(createElement(ResultPanel, { result: s.result!, currentRevision: s.graph?.revision ?? null, itemLabel: (x: string) => x, onClose: () => undefined }))

  it('Inspect skill shows the contract, the binding and the example, labelled banked', () => {
    const html = render(act(open(), 'inspect-tool', ['atom-recall']).session)
    for (const k of ['tools', 'input_contract', 'execution_binding', 'wire_examples']) expect(html).toContain(`data-result-field="${k}"`)
    expect(html).toContain('Banked · not run now')
    expect(html).toContain('Banked example · expected result only')
    expect(html).toContain('omega-tools-inert-input-v2')
    expect(html).toContain('(AtomMemoryRecallDecisionV1 r1 (lamp) authority-none)')
  })

  it('See tested examples (real 0.6.3: executed_now false, five passed:true) reports recorded outcomes, never a test made now', () => {
    expect(R['show-examples'].detail!.executed_now).toBe(false)
    const html = render(act(open(), 'show-examples', ['atom-recall']).session)
    expect(html.match(/Banked example · recorded as passed/g)).toHaveLength(5)
    expect(html).not.toContain('Tested example')
    expect(html).toContain('Banked · not run now')
    expect(html).toContain('data-result-basis="banked"')
  })

  it('"Tested example" only when the result or the example itself says it ran now', () => {
    const ex = (flags: Record<string, unknown>, entry: Record<string, unknown>) => render(act(open(), 'show-examples', ['atom-recall'], { status: 'done', detail: { ...flags, examples: [{ call: '(f a)', ...entry }] } }).session)
    expect(ex({ executed_now: true }, { passed: true })).toContain('Tested example · passed')
    expect(ex({ executed_now: true }, { passed: false })).toContain('Tested example · did not pass')
    // the example's own flag wins over the result's
    expect(ex({ executed_now: true }, { passed: true, executed_now: false })).toContain('Banked example · recorded as passed')
    expect(ex({ executed_now: false }, { passed: true, executed_now: true })).toContain('Tested example · passed')
    expect(ex({ executed_now: false }, { passed: false })).toContain('Banked example · recorded as not passing')
    expect(ex({ executed_now: false }, {})).toContain('Banked example · expected result only')
    // neither says: an app-reported outcome, uncertain whether run now
    const unstated = ex({}, { passed: true })
    expect(unstated).toContain('Example · reported as passed; not stated whether run now')
    expect(unstated).not.toContain('Tested example')
  })

  it('returned strings are never markup: tags and scripts come out as escaped text', () => {
    const hostile = { status: 'done' as const, detail: { executed_now: false, note: '<img src=x onerror="alert(1)">', examples: [{ call: '<script>alert(2)</script>', passed: false }] } }
    const html = render(act(open(), 'show-examples', ['atom-recall'], hostile).session)
    expect(html).not.toMatch(/<img|<script/)
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;')
    expect(html).toContain('Banked example · recorded as not passing')
  })

  it('an out-of-date result says so', () => {
    const s = reconcile(act(open(), 'inspect-tool', ['atom-recall']).session, graph('r-next'))
    const html = render(s)
    expect(html).toContain('Out of date')
    expect(html).toContain('data-result-stale="true"')
  })
})
