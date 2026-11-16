import { describe, expect, it } from 'vitest'
import { assigneeLanes, checkWords, codeTarget, currentFile, deployGo, fileKey, fileWant, frameFiles, openQuestions, parsePlanList, parsePlanView, parsePreviewFiles, pieceRows, planStages, reviewName, runningPlan, STATUS_WORDS, statusLine } from './planModel'
import type { PlanView } from './contract'

const STUDIO = { selector: ['team', 'studio'], kind: 'team', ref: 'studio', resolved: true, display: 'Studio', detail: null, taken_by: null }
const CODE = { selector: ['team', 'code'], kind: 'team', ref: 'code', resolved: true, display: 'Code', detail: null, taken_by: null }
const piece = (id: string, o: Record<string, unknown> = {}) => ({
  id, title: `Piece ${id}`, team: 'Code', assignee: CODE, kind: 'code', deps: [], files: [`${id}.js`], state: 'waiting', builder: null,
  editing: null, draft: null, repairs: 0, review: null, tests: false, ...o,
})
const base = (o: Record<string, unknown> = {}) => ({
  plan_id: 'plan_1', sentence: 'make a page', phase: 'building', status_line: null, pieces: [], questions: [], checks: [], checkpoint: null,
  preview: null, summary: null, unreviewed: false, actions: [], installed: null, updated_at: '2026-11-08T00:00:00.000Z', ...o,
})
const view = (o: Record<string, unknown> = {}) => parsePlanView(base(o))!
const stage = (v: PlanView, key: string) => planStages(v).find((s) => s.key === key)!
const actives = (v: PlanView) => planStages(v).filter((s) => s.state === 'active').map((s) => s.key)

describe('parsePlanView: strict and tolerant', () => {
  it('refuses only what is not a plan view', () => {
    expect(parsePlanView(null)).toBeNull()
    expect(parsePlanView({ phase: 'building' })).toBeNull()
    expect(parsePlanView([])).toBeNull()
  })
  it('keeps unknown phases and states, ignores unknown fields, drops malformed sub-items alone', () => {
    const v = parsePlanView({
      ...base({ phase: 'meditating', extra: 1 }),
      pieces: [piece('a', { state: 'pondering', surprise: true }), { title: 'no id' }, 7, piece('b', { builder: { id: 'x' }, draft: { path: 1 }, review: { state: 'odd' } })],
      questions: [{ q: 'q1', text: 'Which?', about: { kind: 'piece', piece: 'a' } }, { q: 'q2' }],
      checks: [{ run: 'r1', state: 'failed', base: true, line: 'x' }, { run: 'r2' }],
      actions: [{ name: 'deploy', available: false, why_not: 'Not yet' }, { name: 'launch', available: true }, { name: 'stop' }],
      checkpoint: { ckpt: 'c1', files: { 'a.js': 'x', bad: 3 }, at: 't', piece: 'a' },
    })!
    expect(v.phase).toBe('meditating')
    expect(v.pieces.map((p) => p.id)).toEqual(['a', 'b'])
    expect(v.pieces[0].state).toBe('pondering')
    expect(v.pieces[1]).toMatchObject({ builder: null, draft: null, review: { state: 'pending' } })
    expect(v.questions.map((q) => q.q)).toEqual(['q1'])
    expect(v.questions[0]).toMatchObject({ choices: [], answered: null, about: { kind: 'piece', piece: 'a' } })
    expect(v.checks.map((c) => c.run)).toEqual(['r1'])
    expect(v.actions).toEqual([{ name: 'deploy', available: false, why_not: 'Not yet' }])
    expect(v.checkpoint).toEqual({ ckpt: 'c1', workspace: null, files: { 'a.js': 'x' }, at: 't', piece: 'a' })
  })
  it('reads older views: team only → a team assignee; review kinds review/design-review → code/design', () => {
    const v = parsePlanView({ ...base(), pieces: [{ id: 'a', team: 'Studio', state: 'built', review: { kind: 'design-review', state: 'pending' } }] })!
    expect(v.pieces[0]).toMatchObject({ assignee: { kind: 'team', ref: 'studio', resolved: true, display: 'Studio' }, kind: 'design', review: { kind: 'design', state: 'pending' } })
    // the provisional shape's assignee.name still reads as the display
    const old = parsePlanView({ ...base(), pieces: [{ id: 'a', assignee: { kind: 'mind', ref: 'a_x', resolved: true, name: 'Iris' } }] })!
    expect(old.pieces[0].assignee.display).toBe('Iris')
  })
})

describe('planStages: the plan-level timeline, one active at a time', () => {
  it('planning → planned', () => {
    expect(stage(view({ phase: 'planning' }), 'plan')).toMatchObject({ state: 'active', words: 'Planning it…' })
    const v = view({ phase: 'planned', pieces: [piece('a'), piece('b'), piece('c'), piece('d')] })
    expect(stage(v, 'plan')).toMatchObject({ state: 'done', words: 'A plan of 4 pieces' })
  })
  it('tests first: writing, base red, base green is wrong', () => {
    const w = view({ phase: 'planned', pieces: [piece('t', { tests: true, state: 'started' })] })
    expect(stage(w, 'tests')).toMatchObject({ state: 'active', words: 'Writing the acceptance test…' })
    expect(actives(w)).toEqual(['tests'])
    const red = view({ pieces: [piece('t', { tests: true, state: 'integrated' }), piece('a', { state: 'started' })], checks: [{ run: 'r1', ckpt: 'c1', base: true, state: 'failed', failing: [], line: '1 failed: shows the temperature' }] })
    expect(stage(red, 'tests')).toMatchObject({ state: 'done', words: 'The test fails first, as it should', line: '1 failed: shows the temperature' })
    const green = view({ phase: 'blocked', pieces: [piece('t', { tests: true, state: 'integrated' })], checks: [{ run: 'r1', ckpt: 'c1', base: true, state: 'passed', failing: [], line: '1 passed' }] })
    expect(stage(green, 'tests').state).toBe('failed')
  })
  it('build: "2 of 4 pieces in", with a held count', () => {
    const v = view({
      pieces: [piece('t', { tests: true, state: 'integrated' }), piece('a', { state: 'integrated' }), piece('b', { state: 'started' }), piece('c', { state: 'held' })],
      checks: [{ run: 'r1', ckpt: 'c1', base: true, state: 'failed', failing: [], line: null }],
      questions: [{ q: 'q1', about: { kind: 'piece', piece: 'c' }, text: 'Which?', choices: [], answered: null }],
    })
    expect(stage(v, 'build')).toMatchObject({ state: 'active', words: '2 of 4 pieces in', detail: '1 piece waiting for your answer' })
    expect(actives(v)).toEqual(['build'])
  })
  const all = [piece('t', { tests: true, state: 'integrated', review: { kind: 'test', state: 'passed', reviewer: 'Sable', notes: null, evidence: null } }), piece('a', { state: 'integrated', review: { kind: 'code', state: 'passed', reviewer: 'Sable', notes: null, evidence: null } })]
  const baseRed = { run: 'r1', ckpt: 'c1', base: true, state: 'failed', failing: [], line: null }
  it('check: running, red, fixing, green', () => {
    const running = view({ phase: 'checking', pieces: all, checks: [baseRed, { run: 'r2', ckpt: 'c2', base: false, state: 'running', failing: [], line: null }] })
    expect(stage(running, 'check')).toMatchObject({ state: 'active', words: 'Checking the whole app…' })
    expect(stage(running, 'build')).toMatchObject({ state: 'done', words: 'All 2 pieces in' })
    expect(actives(running)).toEqual(['check'])
    const red = { run: 'r2', ckpt: 'c2', base: false, state: 'failed', failing: ['a.js'], line: '1 failed: units' }
    expect(stage(view({ phase: 'checking', pieces: all, checks: [baseRed, red] }), 'check')).toMatchObject({ state: 'failed', words: '1 check failed', line: '1 failed: units' })
    const fixing = view({ phase: 'fixing', pieces: [all[0], piece('a', { state: 'fixing', repairs: 1 })], checks: [baseRed, red] })
    expect(stage(fixing, 'check')).toMatchObject({ state: 'active', words: 'Fixing what the check found', line: '1 failed: units' })
    expect(actives(fixing)).toEqual(['check'])
    const green = view({ phase: 'previewing', pieces: all, checks: [baseRed, red, { ...red, run: 'r3', state: 'passed', failing: [], line: '2 passed' }] })
    expect(stage(green, 'check')).toMatchObject({ state: 'done', words: 'All checks pass', line: '2 passed' })
  })
  it('review: reviewed (by whom) or waived; ready; deployed', () => {
    const checks = [baseRed, { run: 'r2', ckpt: 'c2', base: false, state: 'passed', failing: [], line: '2 passed' }]
    const pv = view({ phase: 'previewing', pieces: all, checks })
    expect(stage(pv, 'review')).toMatchObject({ state: 'done', words: 'Reviewed', detail: 'by Sable' })
    expect(stage(pv, 'ready')).toMatchObject({ state: 'active', words: 'Getting the preview ready…' })
    const rd = view({ phase: 'ready-to-deploy', pieces: all, checks, unreviewed: true })
    expect(stage(rd, 'review')).toMatchObject({ state: 'skipped', words: 'Not reviewed: your setting allowed it' })
    expect(stage(rd, 'ready')).toMatchObject({ state: 'active', words: 'Ready to deploy' })
    expect(actives(rd)).toEqual(['ready'])
    const dep = view({ phase: 'deployed', pieces: all, checks, installed: { app_id: 'app_x', name: 'London weather' } })
    expect(stage(dep, 'deployed')).toMatchObject({ state: 'done', words: 'Installed as London weather' })
    expect(actives(dep)).toEqual([])
  })
  it('stopped: the stage it was on fails, saying so; an unknown phase is drawn plainly', () => {
    const st = view({ phase: 'stopped', pieces: [piece('t', { tests: true, state: 'started' })] })
    expect(stage(st, 'tests')).toMatchObject({ state: 'failed', detail: 'Stopped' })
    const odd = view({ phase: 'meditating', pieces: [piece('a')] })
    expect(planStages(odd).some((s) => s.detail === 'Meditating')).toBe(true)
  })
})

describe('pieceRows', () => {
  const v = view({
    pieces: [
      piece('layout', { title: 'Index page', assignee: STUDIO, team: 'Studio', kind: 'design', state: 'started', editing: 'index.html', draft: { path: 'index.html', content: '<!doctype html>' }, builder: { id: 'm1', name: 'Wren', hue: 200 } }),
      piece('look', { title: 'Colours', assignee: STUDIO, kind: 'design', deps: ['layout'], state: 'waiting' }),
      piece('grid', { title: 'Grid', assignee: STUDIO, kind: 'design', deps: ['layout'], state: 'waiting' }),
      piece('logic', { state: 'built', review: { kind: 'code', state: 'pending', reviewer: 'Sable', notes: null, evidence: null } }),
      piece('art', { kind: 'media', state: 'reviewed', assignee: { kind: 'mind', ref: 'a_iris', resolved: true, display: 'Iris (illustrator)' }, review: { kind: 'media', state: 'passed', reviewer: 'Sable', notes: null, evidence: 'render:1' } }),
      piece('doc', { kind: 'doc', state: 'integrated', review: { kind: 'doc', state: 'passed', reviewer: 'Sable', notes: null, evidence: null } }),
      piece('fix', { state: 'fixing', repairs: 1, editing: 'fix.js' }),
      piece('self', { state: 'started', draft: { path: 'self.js', content: 'x' } }),
      piece('stuck', { state: 'blocked' }),
      piece('hive', { assignee: { kind: 'hive', ref: null, resolved: false, display: 'the whole hive' } }),
      piece('weird', { state: 'pondering-hard' }),
    ],
    questions: [{ q: 'q1', about: { kind: 'piece', piece: 'grid' }, text: 'Which grid?', choices: ['A', 'B'], answered: null }],
    checks: [{ run: 'r2', ckpt: 'c2', base: false, state: 'failed', failing: ['fix.js'], line: '1 failed: units' }],
  })
  const rows = Object.fromEntries(pieceRows(v).map((r) => [r.id, r]))
  it('words each phase plainly, by assignee and review kind', () => {
    expect(rows.layout).toMatchObject({ phase: 'building', words: 'Index page · Studio · writing index.html', team: 'Studio', builder: { name: 'Wren' } })
    expect(rows.look).toMatchObject({ phase: 'waiting', words: 'Waiting for index page' })
    expect(rows.grid).toMatchObject({ phase: 'held', words: 'Held by your question' })
    expect(rows.logic).toMatchObject({ phase: 'review', words: 'Code review with Sable', reviewName: 'Code review' })
    expect(rows.art).toMatchObject({ phase: 'review', words: 'Media review passed', team: 'Iris (illustrator)' })
    expect(rows.doc).toMatchObject({ phase: 'integrated', words: 'In the app · Doc review passed' })
    expect(rows.fix).toMatchObject({ phase: 'fixing', words: 'Fixing: 1 failed: units · writing fix.js', repairs: 1 })
    expect(rows.self).toMatchObject({ phase: 'testing' })
    expect(rows.stuck).toMatchObject({ phase: 'blocked' })
    expect(rows.hive.words).toBe('Waiting for the whole hive (finding who takes it)')
    expect(rows.weird).toMatchObject({ phase: 'waiting', words: 'Pondering hard' })
    expect(reviewName('design')).toBe('Design review')
  })
  it('openQuestions; assigneeLanes: one lane per assignee, open last, ordered by depth, with edges', () => {
    expect(openQuestions(v).map((q) => q.q)).toEqual(['q1'])
    const { lanes, edges } = assigneeLanes(v)
    expect(lanes.map((l) => l.assignee.display)).toEqual(['Studio', 'Code', 'Iris (illustrator)', 'the whole hive'])
    expect(lanes[0].pieces.map((p) => p.id)).toEqual(['layout', 'look', 'grid'])
    expect(edges).toEqual([{ from: 'layout', to: 'look' }, { from: 'layout', to: 'grid' }])
  })
  it('a dependency cycle never loops', () => {
    const c = view({ pieces: [piece('a', { deps: ['b'] }), piece('b', { deps: ['a'] })] })
    expect(assigneeLanes(c).lanes[0].pieces).toHaveLength(2)
  })
})

describe('deployGo and currentFile', () => {
  it('deployGo follows the action, and says when a review was waived', () => {
    expect(deployGo(view({ actions: [{ name: 'deploy', available: true, why_not: null }], unreviewed: true }))).toEqual({ available: true, why_not: null, unreviewed: true })
    expect(deployGo(view({ actions: [{ name: 'deploy', available: false, why_not: 'Installing it now.' }] }))).toEqual({ available: false, why_not: 'Installing it now.', unreviewed: false })
    expect(deployGo(view())).toEqual({ available: false, why_not: 'It isn’t ready yet.', unreviewed: false })
  })
  it('currentFile: the latest draft being written; else the file the latest integration brought in', () => {
    const w = view({
      pieces: [
        piece('a', { state: 'started', editing: 'a.js', draft: { path: 'a.js', content: 'A', at: '2026-11-08T00:00:02Z' }, builder: { id: 'm1', name: 'Wren', hue: 1 } }),
        piece('b', { state: 'started', editing: 'b.js', draft: { path: 'b.js', content: 'B', at: '2026-11-08T00:00:01Z' } }),
      ],
    })
    expect(currentFile(w)).toEqual({ path: 'a.js', content: 'A', piece: 'a', builder: { id: 'm1', name: 'Wren', hue: 1 }, writing: true })
    const i = view({ pieces: [piece('a', { state: 'integrated' }), piece('b', { state: 'integrated' })], checkpoint: { ckpt: 'c2', files: { 'a.js': 'A1', 'b.js': 'B1' }, at: 't', piece: 'a' } })
    expect(currentFile(i)).toMatchObject({ path: 'a.js', content: 'A1', piece: 'a' })
    const noPiece = view({ pieces: [piece('a', { state: 'integrated' }), piece('b', { state: 'integrated' })], checkpoint: { ckpt: 'c2', files: { 'a.js': 'A1', 'b.js': 'B1' }, at: 't' } })
    expect(currentFile(noPiece)).toMatchObject({ path: 'b.js', piece: 'b' })
    expect(currentFile(view())).toBeNull()
  })
  it('frameFiles passes the bundle on (never checks/), and needs the three frame files', () => {
    const f = frameFiles({ 'index.html': '<img src="./i.svg">', 'style.css': '', 'app.js': '', 'i.svg': '<svg/>', 'checks/test.mjs': 'x' })!
    expect(Object.keys(f).sort()).toEqual(['app.js', 'i.svg', 'index.html', 'style.css'])
    expect(f['index.html']).toBe('<img src="./i.svg">')
    expect(frameFiles({ 'index.html': '' })).toBeNull()
  })
})

// ------------------------------------------------------------------ the host engine's shape (create_plan_engine.py)

const ENGINE_PIECE = (id: string, o: Record<string, unknown> = {}) => ({
  id, title: `Piece ${id}`, kinds: ['code'], team: 'Code',
  assignee: { selector: ['team', 'code'], kind: 'team', ref: 'code', resolved: true, display: 'Code', detail: null, taken_by: null },
  deps: [], files: [`${id}.js`], state: 'waiting', status: 'waiting', passed_reviews: [], builder: null, editing: false, draft: null,
  candidate: null, repairs: 0, unreviewed: false, review: null, tests: ['checks/acceptance_check.py'], ...o,
})
const engineView = (o: Record<string, unknown> = {}) => parsePlanView({
  plan_id: 'plan_x', engine: 'metta-plan-controller/R4.1', reducer_sha256: 'b4', sentence: 'make a page', title: 'A page', summary: 'A page',
  acceptance: ['It shows the page'], phase: 'building', status: 'building', review_policy: 'review-required', unreviewed: false,
  next_action: '(rest awaiting-results)', last_error: null, pieces: [], questions: [], checks: [], checkpoint: { ckpt: null, workspace: null },
  preview: null, installed: null, actions: [], journal: [{ seq: 1, id: 'planned:plan-1', kind: 'planned', fields: '()', verdict: 'accepted', at: 't', evidence: null }],
  effects: [{ kind: 'plan', op: 'plan-1', state: 'done', goal_id: null }], updated_at: 't', ...o,
})!

describe('the engine view (create_plan_engine.view)', () => {
  it('reads every field the engine adds; checkpoint without a ckpt is none; the preview carries its ref', () => {
    const v = engineView({
      pieces: [ENGINE_PIECE('a', {
        kinds: ['design', 'code'], state: 'built', builder: 'a_wren', candidate: 'cand-7', draft: 'cand-7', passed_reviews: ['design-review'],
        assignee: { selector: ['mind', 'a_wren'], kind: 'mind', ref: 'a_wren', resolved: true, display: 'Wren (designer)', detail: 'free', taken_by: 'plan_other' },
        review: { kind: 'design-review', state: 'journaled', decision: null, reviewer: null, notes: null, evidence: null, candidate: 'cand-7' },
      })],
      questions: [{ q: 'q1', about: { piece: 'a' }, text: 'Which?', choices: ['A'], answered: true, answer: 'A' }, { q: 'hold-2', about: 'blocked', text: 'Try again?', choices: [], answered: false, answer: null }],
      checks: [{ run: 'run-checks-1', ckpt: 'c0', base: true, state: 'fail', failing: ['a.js'], line: 'CREATE-CHECK {"passed": false, "failing": ["a.js"], "notes": ["1 failed: it shows"]}', output: 'out' },
        { run: 'run-checks-2', ckpt: 'c1', base: false, state: 'journaled', failing: [], line: null, output: null }],
      preview: { ref: 'preview-abc', digest: 'sha256:abc', app_id: 'a-page', source_digest: 'sha256:x', ckpt: 'c1' },
      installed: { program_id: 'a-page', digest: 'sha256:abc', installed_at: 't' },
    })
    expect(v).toMatchObject({ title: 'A page', acceptance: ['It shows the page'], status: 'building', next_action: '(rest awaiting-results)', review_policy: 'review-required', checkpoint: null })
    expect(v.journal).toEqual([{ seq: 1, id: 'planned:plan-1', kind: 'planned', verdict: 'accepted', at: 't' }])
    expect(v.effects).toEqual([{ kind: 'plan', op: 'plan-1', state: 'done' }])
    expect(v.pieces[0]).toMatchObject({
      kind: 'design', kinds: ['design', 'code'], candidate: 'cand-7', draft: null, passed_reviews: ['design-review'], editing: null,
      assignee: { display: 'Wren (designer)', detail: 'free', taken_by: 'plan_other', selector: ['mind', 'a_wren'] },
      builder: { id: 'a_wren', name: 'Wren (designer)' }, review: { kind: 'design', state: 'pending', candidate: 'cand-7' }, tests: false,
    })
    expect(v.questions.map((q) => [q.q, q.about.kind, q.answered?.text ?? null])).toEqual([['q1', 'piece', 'A'], ['hold-2', 'blocked', null]])
    expect(v.checks.map((c) => [c.state, c.line, c.output])).toEqual([['failed', '1 failed: it shows', 'out'], ['running', null, null]])
    expect(v.preview).toEqual({ ckpt: 'c1', ref: 'preview-abc', digest: 'sha256:abc' })
    expect(v.installed).toEqual({ app_id: 'a-page', name: 'A page' })
  })
  it('a builder is named from the hive’s minds when known, never by its id', () => {
    const raw = { ...ENGINE_PIECE('a', { state: 'started', builder: 'a_anvil', editing: true }) }
    const named = parsePlanView({ plan_id: 'p', pieces: [raw] }, (id) => (id === 'a_anvil' ? { name: 'Anvil', hue: 28 } : null))!
    expect(named.pieces[0]).toMatchObject({ builder: { id: 'a_anvil', name: 'Anvil', hue: 28 }, editing: 'a.js' })
    const plain = parsePlanView({ plan_id: 'p', pieces: [raw] })!
    expect(plain.pieces[0].builder!.name).toBe('Code')
  })
  it('reviews: pass / fail decisions, an unavailable review on an unreviewed piece is waived', () => {
    const v = engineView({ pieces: [
      ENGINE_PIECE('p', { review: { kind: 'code-review', state: 'done', decision: 'pass', reviewer: 'Sable', notes: 'ok', evidence: { ref: 'r1' }, candidate: 'c' } }),
      ENGINE_PIECE('f', { review: { kind: 'code-review', state: 'done', decision: 'fail', reviewer: 'Sable', notes: 'no', evidence: null, candidate: 'c' } }),
      ENGINE_PIECE('u', { unreviewed: true, review: { kind: 'code-review', state: 'unavailable', decision: null, reviewer: null, notes: null, evidence: null, candidate: 'c' } }),
      ENGINE_PIECE('n', { unreviewed: true }),
    ] })
    expect(v.pieces.map((p) => [p.review?.state, p.review?.kind])).toEqual([['passed', 'code'], ['failed', 'code'], ['waived', 'code'], ['waived', 'code']])
    expect(v.pieces[0].review!.evidence).toBe('r1')
    expect(reviewName('media-review')).toBe('Media review')
  })
  it('checkWords: the CREATE-CHECK line in plain words', () => {
    expect(checkWords('CREATE-CHECK {"passed": true, "failing": [], "notes": []}')).toBe('All passed')
    expect(checkWords('CREATE-CHECK {"passed": false, "failing": ["app.js"], "notes": []}')).toBe('Failing in app.js')
    expect(checkWords('CREATE-CHECK {broken')).toBeNull()
    expect(checkWords('4 passed')).toBe('4 passed')
  })
})

describe('the engine’s status, worded plainly', () => {
  const ALL = ['planning', 'designing', 'writing_tests', 'checking_tests_are_red', 'building', 'fixing', 'integrating', 'checking', 'previewing',
    'asking_you', 'ready_to_deploy', 'deploying', 'deployed', 'needs_you', 'stopped', 'checking_back', 'engine_error', 'assignee_unavailable']
  it('every status has its own plain words, with no codes in them', () => {
    expect(Object.keys(STATUS_WORDS).sort()).toEqual([...ALL].sort())
    const words = ALL.map((st) => statusLine(engineView({ status: st, pieces: [] })))
    expect(new Set(words).size).toBe(ALL.length)
    for (const w of words) expect(w).not.toMatch(/_|\(|plan_|ckpt/)
    expect(statusLine(engineView({ status: 'checking_tests_are_red' }))).toBe('Checking the test fails before anything is built…')
    expect(statusLine(engineView({ status: 'engine_error', last_error: 'reducer timeout' }))).toBe('The hive hit a problem with this plan')
  })
  it('building counts the pieces in; deployed names the app; an unknown status is said plainly', () => {
    const v = engineView({ pieces: [ENGINE_PIECE('a', { state: 'integrated' }), ENGINE_PIECE('b', { state: 'held' })] })
    expect(v.status_line).toBe('Building: 1 of 2 pieces in · one piece waits for your answer')
    expect(engineView({ status: 'deployed', phase: 'deployed', installed: { program_id: 'a-page' } }).status_line).toBe('Installed as A page')
    expect(engineView({ status: 'daydreaming' }).status_line).toBe('Daydreaming')
  })
  it('the status, not the phase, drives the timeline: held statuses fail the stage they were on, saying why', () => {
    const base = [{ run: 'r1', ckpt: 'c0', base: true, state: 'fail', failing: ['a.js'], line: null }]
    const pieces = [ENGINE_PIECE('a', { state: 'started' })]
    const at = (status: string) => planStages(engineView({ status, pieces, checks: base })).find((s) => s.state === 'failed')
    expect(at('needs_you')).toMatchObject({ key: 'build', detail: 'Stuck: it needs your answer' })
    expect(at('engine_error')).toMatchObject({ key: 'build', detail: 'The hive hit a problem here' })
    expect(at('assignee_unavailable')).toMatchObject({ key: 'build', detail: 'Nobody can take a piece right now' })
    expect(at('stopped')).toMatchObject({ key: 'build', detail: 'Stopped' })
    const red = planStages(engineView({ status: 'checking_tests_are_red', phase: 'testing-authored', pieces }))
    expect(red.find((s) => s.state === 'active')).toMatchObject({ key: 'tests', words: 'Running the test on the empty app…' })
    const writing = planStages(engineView({ status: 'writing_tests', phase: 'planned', pieces }))
    expect(writing.find((s) => s.state === 'active')).toMatchObject({ key: 'tests', words: 'Writing the acceptance test…' })
    const deploying = planStages(engineView({ status: 'deploying', phase: 'ready-to-deploy', pieces: [ENGINE_PIECE('a', { state: 'integrated' })] }))
    expect(deploying.find((s) => s.state === 'active')).toMatchObject({ key: 'ready', detail: 'Installing it…' })
  })
  it('an unassignable piece says nobody can take it, with the hive’s reason', () => {
    const v = engineView({ pieces: [ENGINE_PIECE('a', { state: 'unassignable', assignee: { kind: 'capability', ref: null, resolved: false, display: 'Any mapmaker', detail: 'no mind has the skill' } })] })
    expect(pieceRows(v)[0]).toMatchObject({ phase: 'blocked', words: 'Nobody can take it right now (no mind has the skill)' })
  })
})

describe('the code pane: which file, read through the files route', () => {
  const two = (recent?: Record<string, number>) => {
    const v = engineView({
      checkpoint: { ckpt: 'c3', workspace: 'ws' },
      pieces: [
        ENGINE_PIECE('a', { state: 'started', editing: true, builder: 'a_wren' }),
        ENGINE_PIECE('b', { state: 'built', candidate: 'cand-b', files: ['b.js', 'b.css'] }),
        ENGINE_PIECE('c', { state: 'integrated' }),
      ],
    })
    return { v, t: codeTarget(v, recent) }
  }
  it('a piece being written is read at the latest checkpoint; a built one at its candidate', () => {
    const { v, t } = two()
    expect(t).toMatchObject({ piece: { id: 'a' }, writing: true, ckpt: 'c3', paths: ['a.js'], inline: null })
    expect(fileWant(v)).toEqual({ ckpt: 'c3', path: 'a.js' })
    expect(currentFile(v)).toBeNull()
    expect(currentFile(v, { [fileKey('c3', 'a.js')]: 'const a = 1\n' })).toMatchObject({ path: 'a.js', content: 'const a = 1\n', piece: 'a', writing: true, builder: { id: 'a_wren' } })
  })
  it('prefers the piece changed most recently (the latest create.plan.piece event heard), then a missing file falls through', () => {
    const { v, t } = two({ b: 2000, a: 1000 })
    expect(t).toMatchObject({ piece: { id: 'b' }, writing: false, ckpt: 'cand-b', paths: ['b.js', 'b.css'] })
    const recent = { b: 2000, a: 1000 }
    expect(fileWant(v, {}, recent)).toEqual({ ckpt: 'cand-b', path: 'b.js' })
    const missing = { [fileKey('cand-b', 'b.js')]: null }
    expect(fileWant(v, missing, recent)).toEqual({ ckpt: 'cand-b', path: 'b.css' })
    expect(currentFile(v, { ...missing, [fileKey('cand-b', 'b.css')]: 'body{}' }, recent)).toMatchObject({ path: 'b.css', content: 'body{}', piece: 'b' })
  })
  it('prefers the newest draft.at over plan order and over typing (older inline views)', () => {
    const v = parsePlanView({ plan_id: 'p', status: 'building', pieces: [
      ENGINE_PIECE('late', { state: 'started', editing: 'late.js', draft: { path: 'late.js', content: 'L', at: '2026-11-08T00:00:01Z' } }),
      ENGINE_PIECE('new', { state: 'fixing', draft: { path: 'new.js', content: 'N', at: '2026-11-08T00:00:09Z' } }),
      ENGINE_PIECE('none', { state: 'started', editing: 'none.js' }),
    ] })!
    expect(currentFile(v)).toMatchObject({ path: 'new.js', content: 'N', piece: 'new' })
  })
  it('while a new checkpoint’s text is on its way, the last text read for that file stays', () => {
    const { v } = two()
    expect(currentFile(v, { [fileKey('c2', 'a.js')]: 'older' })).toMatchObject({ path: 'a.js', content: 'older' })
  })
  it('with nothing at work: the latest integrated piece’s file at the checkpoint', () => {
    const v = engineView({ checkpoint: { ckpt: 'c4', workspace: 'ws' }, pieces: [ENGINE_PIECE('a', { state: 'integrated' }), ENGINE_PIECE('b', { state: 'integrated' })] })
    expect(codeTarget(v)).toMatchObject({ piece: { id: 'b' }, ckpt: 'c4', paths: ['b.js'], writing: false })
    expect(codeTarget(v, { a: 5 })).toMatchObject({ piece: { id: 'a' } })
    expect(codeTarget(engineView({ pieces: [ENGINE_PIECE('a', { state: 'started' })] }))).toMatchObject({ ckpt: null })
    expect(fileWant(engineView({ pieces: [ENGINE_PIECE('a', { state: 'started' })] }))).toBeNull()
  })
})

describe('the list and the preview route', () => {
  it('parsePlanList / runningPlan: the newest plan still going', () => {
    const rows = parsePlanList([
      { plan_id: 'p3', sentence: 'c', phase: 'stopped', status: 'stopped', updated_at: 't3' },
      { plan_id: 'p2', sentence: 'b', phase: 'blocked', status: 'needs_you', updated_at: 't2' },
      { plan_id: 'p1', sentence: 'a', phase: 'building', status: 'building', updated_at: 't1' },
      { nope: true },
    ])
    expect(rows.map((r) => r.plan_id)).toEqual(['p3', 'p2', 'p1'])
    expect(runningPlan(rows)?.plan_id).toBe('p2')
    expect(runningPlan(parsePlanList([{ plan_id: 'd', phase: 'deployed', status: 'deployed' }]))).toBeNull()
    expect(parsePlanList({})).toEqual([])
  })
  it('parsePreviewFiles: {ref, ckpt, files} or nothing', () => {
    expect(parsePreviewFiles({ ref: 'preview-a', ckpt: 'c1', files: { 'index.html': 'x', bad: 1 } })).toEqual({ ref: 'preview-a', ckpt: 'c1', files: { 'index.html': 'x' } })
    expect(parsePreviewFiles({ ckpt: 'c1', files: {} })).toBeNull()
  })
})
