import { describe, expect, it } from 'vitest'
import { SimCodeService } from '../../../api/sim/codeService'
import { apply, choreograph, EMPTY, finalState, MAX_OPS, plain, validate, type DocShape, type PlacedChange } from './codePresence'
import { inkPath } from './layers'
import { wholeLines } from './useVibe'
import { describeChange, enclosingName, runMarks, runTally, summarize, wholeFile } from './vibe'

const doc = (text: string): DocShape => {
  const rows = text.split('\n')
  return { lines: rows.length, lineText: (n) => rows[n - 1] ?? '' }
}
const D = doc('def add(a, b):\n    return a - b\n')

describe('code presence: the draw protocol on code', () => {
  it('accepts only the closed vocabulary and clamps positions to the document', () => {
    expect(validate(D, { op: 'caret', line: 99, col16: 99 })).toEqual({ op: 'caret', line: 3, col16: 0 })
    expect(validate(D, { op: 'caret', line: 2, col16: 4, caption: 'here' })).toEqual({ op: 'caret', line: 2, col16: 4, caption: 'here' })
    expect(validate(D, { op: 'sketch', ink: 'circle', from_line: 5, to_line: -2 })).toEqual({ op: 'sketch', ink: 'circle', from_line: 1, to_line: 3 })
    expect(validate(D, { op: 'sketch', ink: 'spiral', from_line: 1, to_line: 1 })).toBeNull()
    expect(validate(D, { op: 'run', argv: ['rm'] })).toBeNull()
    expect(validate(D, { op: 'type', hunk: '../x', chars: 3 })).toBeNull()
    expect(validate(D, { op: 'type', hunk: 'h1', chars: -1 })).toBeNull()
    expect(validate(D, { op: 'select', from: { line: 2, col16: 9 }, to: { line: 1, col16: 0 } })).toEqual({ op: 'select', from: { line: 1, col16: 0 }, to: { line: 2, col16: 9 } })
  })
  it('keeps captions and notes plain and short', () => {
    expect(plain('a\nb')).toBe('a b')
    expect(plain('x\u0007y')).toBeNull()
    expect(plain('y'.repeat(300))?.length).toBe(120)
    expect(validate(D, { op: 'note', line: 1, text: '<b>hi</b>' })).toEqual({ op: 'note', line: 1, text: '<b>hi</b>' }) // rendered as text, never HTML
    expect(validate(D, { op: 'note', line: 1, text: 'ok', tone: 'loud' })).toBeNull()
  })
  it('folds ops into what is drawn, caps the count and fades the oldest ink', () => {
    let p = EMPTY
    for (let i = 0; i < 20; i++) p = apply(p, { op: 'sketch', ink: 'underline', from_line: 1, to_line: 1 })
    expect(p.inks).toHaveLength(12)
    p = apply(p, { op: 'type', hunk: 'h', chars: 5 })
    p = apply(p, { op: 'type', hunk: 'h', chars: 2 })
    expect(p.typed.h).toBe(5) // writing never goes backwards
    p = apply(p, { op: 'clear' })
    expect(p.inks).toEqual([])
    expect(p.typed.h).toBe(5)
    let q = { ...EMPTY, count: MAX_OPS }
    q = apply(q, { op: 'caret', line: 1, col16: 0 })
    expect(q.caret).toBeNull()
  })
  const changes: PlacedChange[] = [
    { id: 'a', line: 2, lastLine: 2, col16: 4, after: 'return a + b', words: 'now adds instead of subtracting' },
    { id: 'b', line: 5, lastLine: 7, col16: 0, after: 'x', words: 'rewrites 3 lines' },
  ]
  it('choreographs a proposal: caret, select, mark, write, note, in order and within the time budget', () => {
    const steps = choreograph(changes, 'Anvil', 6000)
    expect(steps[0].op).toMatchObject({ op: 'caret', line: 2, caption: 'Anvil: now adds instead of subtracting' })
    expect(steps.map((s) => s.op.op)).toContain('sketch')
    expect(steps.find((s) => s.op.op === 'sketch' && s.op.from_line === 5)?.op).toMatchObject({ ink: 'bracket', to_line: 7 })
    const typed = steps.filter((s) => s.op.op === 'type' && s.op.hunk === 'a').map((s) => (s.op as { chars: number }).chars)
    expect(typed[typed.length - 1]).toBe(12)
    expect(steps.every((s, i) => i === 0 || s.at >= steps[i - 1].at || s.op.op === 'caret')).toBe(true)
    expect(steps[steps.length - 1]).toMatchObject({ op: { op: 'clear' } })
    expect(steps[steps.length - 1].at).toBeLessThanOrEqual(6000)
  })
  it('draws the finished state at once for reduced motion', () => {
    const p = finalState(changes)
    expect(p.typed).toEqual({ a: 12, b: 1 })
    expect(p.notes.map((n) => n.text)).toEqual(['1. now adds instead of subtracting', '2. rewrites 3 lines'])
    expect(p.caret).toBeNull()
  })
  it('makes hand-drawn ink paths for every shape', () => {
    for (const ink of ['underline', 'circle', 'bracket', 'arrow', 'tick', 'cross'] as const) expect(inkPath(ink, 200, 40, 3)).toMatch(/^M-?\d/)
    expect(inkPath('underline', 100, 20, 1)).toBe(inkPath('underline', 100, 20, 1)) // deterministic
  })
})

describe('plain words for code', () => {
  it('says what a change does without code', () => {
    expect(describeChange('    return a - b', '    return a + b')).toBe('now adds instead of subtracting')
    expect(describeChange('def greet(name):', 'def greet(name: str) -> str:')).toBe('says what it returns, labels its inputs')
    expect(describeChange('    message = "Hello, " + name + "!"', '    text = f"Hello, {name}!"')).toBe('builds the text in one piece')
    expect(describeChange('    print(message)', '    print(text)')).toBe('renames message to text')
    expect(describeChange('', ' # check this')).toBe('adds a note')
    expect(describeChange('x = 1\ny = 2', '')).toBe('removes 2 lines')
  })
  it('summarises a proposal and says plainly when there is no reason of its own', () => {
    const s = summarize({ instruction: 'make it add', mind: 'Anvil', path: 'src/calculator.py', changes: [{ line: 2, lastLine: 2, words: 'now adds' }, { line: 4, lastLine: 6, words: 'x' }], together: [[0, 1]] })
    expect(s.headline).toBe('Anvil proposes 2 changes to calculator.py (lines 2–6).')
    expect(s.lines).toContain('Changes 1, 2 only work together: keep all of them or none.')
    expect(s.why).toContain('You asked: “make it add”')
    expect(s.why).toContain('gave no reason of its own')
  })
  it('turns test output into results beside lines, refusing odd paths', () => {
    const out = 'F.\ncalculator.py:2: in add\n    return a - b\nE   AssertionError: add(2, 3) gave -1\n/etc/passwd:1: x\n../up.py:3: y\n1 failed, 1 passed in 0.03s\n'
    expect(runMarks(out)).toEqual([{ path: 'calculator.py', line: 2, text: 'AssertionError: add(2, 3) gave -1', ok: false }])
    expect(runTally(out)).toEqual({ passed: 1, failed: 1, text: '1 failed, 1 passed' })
    expect(runTally('nothing here')).toBeNull()
  })
  it('scopes whole lines and whole files', () => {
    const t = 'one\ntwo three\nfour\n'
    expect(wholeLines(t, 5, 7)).toEqual({ from: 4, to: 13 })
    expect(wholeLines(t, 0, 2)).toEqual({ from: 0, to: 3 })
    expect(wholeLines(t, 4, 14)).toEqual({ from: 4, to: 13 }) // a selection ending at a line break stays on its line
    expect(wholeFile('a.py', 10)).toEqual({ 'a.py': [[0, 10]] })
    expect(enclosingName('def greet(n):\n    x = 1\n    return x\n', 3)).toBe('greet')
  })
})

describe('the simulator: invented runs and the invented mind', () => {
  const ws = 'ws_cc01'
  const svc = () => new SimCodeService({ workspace_id: ws, task_id: 'g_cc01' })
  it('runs on exactly the asked generation and reports results in the pytest shape', async () => {
    const s = svc()
    const head = (await s.proxy('GET', `/v1/workspaces/${ws}`, {}, null)) as { generation: number; tree_digest: string }
    await expect(s.proxy('POST', '/v1/runs', {}, { workspace_id: ws, expected_generation: head.generation + 1, expected_tree_digest: head.tree_digest, argv: ['pytest'] })).rejects.toMatchObject({ code: 'stale_workspace' })
    const run = (await s.proxy('POST', '/v1/runs', {}, { workspace_id: ws, expected_generation: head.generation, expected_tree_digest: head.tree_digest, argv: ['python3', '-m', 'pytest', '-q'] })) as { id: string; status: string; exit_code: number }
    expect(run).toMatchObject({ status: 'failed', exit_code: 1 })
    const page = (await s.proxy('GET', `/v1/runs/${run.id}/output`, { after: '0' }, null)) as { data: string; complete: boolean }
    const text = new TextDecoder().decode(Uint8Array.from(atob(page.data), (c) => c.charCodeAt(0)))
    expect(page.complete).toBe(true)
    expect(runMarks(text)[0]).toMatchObject({ path: 'calculator.py', line: 2 })
    expect(runTally(text)).toMatchObject({ failed: 1, passed: 1 })
  })
  it('the invented mind fixes the operator only when asked to, and adds types only when asked to', async () => {
    const s = svc()
    const head = (await s.proxy('GET', `/v1/workspaces/${ws}`, {}, null)) as { generation: number; tree_digest: string }
    const scope = (await s.proxy('POST', `/v1/workspaces/${ws}/suggestion-scopes`, {}, { operation_id: 'sc1', expected_generation: head.generation, expected_tree_digest: head.tree_digest, ranges: { 'calculator.py': [[0, 31]] } })) as { id: string }
    const rec = (await s.ask(ws, scope.id, 'make add actually add')) as { id: string }
    const read = (await s.proxy('GET', `/v1/workspaces/${ws}/suggestions/${rec.id}`, {}, null)) as { content: { hunks: { replacement: string }[] } }
    expect(read.content.hunks.map((h) => h.replacement)).toEqual(['    return a + b'])
  })
})
