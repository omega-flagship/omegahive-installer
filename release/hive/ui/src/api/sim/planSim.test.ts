// Purpose: test that the sim's plan engine serves the host's plan view, its timeline, its acts and their refusals,
// later rounds (a change, its versions, undo and put back) included; invented data only.
import { describe, expect, it } from 'vitest'
import { SimPlans, SIM_PLAN_MINDS, type PlanSimEvent, type PlanSimMode } from './planSim'
import { codeTarget, currentFile, deployGo, fileKey, fileWant, frameFiles, parsePlanList, parsePlanView, parsePreviewFiles, pieceRows, planStages, assigneeLanes, runningPlan, type FileTexts } from '../../features/createPlan/planModel'
import type { PlanView } from '../../features/createPlan/contract'

const SENTENCE = 'make me a small web page that shows the weather in London'
const minds = (id: string) => SIM_PLAN_MINDS[id] ?? null
const make = (mode: PlanSimMode = 'normal') => {
  let t = 0
  const events: PlanSimEvent[] = []
  const s = new SimPlans({ now: () => t, mode: () => mode, emit: (e) => events.push(e) })
  const id = (s.start(SENTENCE) as { plan_id: string }).plan_id
  const view = (): PlanView => parsePlanView(s.get(id), minds)!
  /** step the clock in 250 ms ticks up to `ms`, or until `until` holds */
  const run = (ms: number, until?: (v: PlanView) => boolean): PlanView => {
    while (t < ms) { t += 250; const v = view(); if (until?.(v)) return v }
    return view()
  }
  /** the code pane's file, read through the files route exactly as the page does (usePlan's loop) */
  const code = (v: PlanView) => {
    const texts: Record<string, string | null> = {}
    for (let w = fileWant(v, texts); w; w = fileWant(v, texts as FileTexts)) {
      try { texts[fileKey(w.ckpt, w.path)] = (s.file(id, w.path, w.ckpt) as { content: string }).content } catch { texts[fileKey(w.ckpt, w.path)] = null }
    }
    return currentFile(v, texts)
  }
  return { s, id, view, run, events, code, at: () => t }
}
const piece = (v: PlanView, id: string) => v.pieces.find((p) => p.id === id)!
const raw = (m: ReturnType<typeof make>) => m.s.get(m.id) as Record<string, unknown>

describe('plan sim: the engine’s own shape', () => {
  it('the view carries the engine’s fields; checkpoint is {ckpt, workspace} with no files', () => {
    const m = make()
    const r0 = raw(m)
    expect(r0).toMatchObject({ phase: 'planning', status: 'planning', sentence: SENTENCE, pieces: [], checkpoint: { ckpt: null, workspace: null }, preview: null, last_error: null })
    for (const k of ['engine', 'reducer_sha256', 'title', 'summary', 'acceptance', 'review_policy', 'unreviewed', 'next_action', 'journal', 'effects', 'actions', 'installed', 'updated_at']) expect(r0, k).toHaveProperty(k)
    m.run(12000, (v) => piece(v, 'layout')?.state === 'started')
    const r = raw(m)
    expect(Object.keys(r.checkpoint as object).sort()).toEqual(['ckpt', 'workspace'])
    const p = (r.pieces as Record<string, unknown>[])[0]
    expect(Object.keys(p).sort()).toEqual(['assignee', 'builder', 'candidate', 'deps', 'draft', 'editing', 'files', 'id', 'kinds', 'passed_reviews', 'repairs', 'review', 'state', 'status', 'team', 'tests', 'title', 'unreviewed'].sort())
    expect(Object.keys(p.assignee as object).sort()).toEqual(['detail', 'display', 'kind', 'ref', 'resolved', 'selector', 'taken_by'])
    expect(typeof p.editing).toBe('boolean')
    expect(p.builder === null || typeof p.builder === 'string').toBe(true)
    expect((r.actions as { name: string; method: string; path: string }[]).map((a) => [a.name, a.method, a.path])).toEqual([
      ['answer', 'POST', `/api/create/plans/${m.id}/answers`], ['deploy', 'POST', `/api/create/plans/${m.id}/deploy`], ['stop', 'POST', `/api/create/plans/${m.id}/stop`],
      ['revise', 'POST', `/api/create/plans/${m.id}/revise`], ['undo', 'POST', `/api/create/plans/${m.id}/revert`], ['revert', 'POST', `/api/create/plans/${m.id}/revert`],
    ])
    expect(r0).toMatchObject({ round: 1, round_words: SENTENCE, revisions: [] })
  })

  it('plans for ~4 s, then 4 pieces with assignees and one question holding only look; tests are written first', () => {
    const m = make()
    const v = m.run(4000)
    expect(v).toMatchObject({ phase: 'planned', status: 'writing_tests', title: 'London weather', checkpoint: null })
    expect(v.pieces.map((p) => [p.id, p.assignee.display, p.kind, p.files[0]])).toEqual([
      ['layout', 'Studio', 'design', 'index.html'], ['look', 'Studio', 'design', 'style.css'], ['logic', 'Code', 'code', 'app.js'], ['icon', 'Iris (illustrator)', 'media', 'icon.svg'],
    ])
    expect(piece(v, 'icon').assignee).toMatchObject({ selector: ['mind', 'a_sim_iris'], kind: 'mind', ref: 'a_sim_iris', resolved: true, display: 'Iris (illustrator)' })
    expect(v.questions).toEqual([{ q: 'q_look', about: { kind: 'piece', piece: 'look' }, text: 'Should it look calm and minimal, or bright and playful?', choices: ['Calm and minimal', 'Bright and playful'], answered: null }])
    expect(piece(v, 'look').state).toBe('held')
    expect(planStages(v).find((s) => s.state === 'active')).toMatchObject({ key: 'tests', words: 'Writing the acceptance test…' })
    const authored = m.run(8000, (x) => x.status === 'checking_tests_are_red')
    expect(authored.checkpoint).toEqual({ ckpt: 'ckpt_0', workspace: `ws_sim_${m.id}` })
    expect(m.s.files(m.id, 'checks/acceptance_check.py', 'ckpt_0')).toMatchObject({ ckpt: 'ckpt_0', path: 'checks/acceptance_check.py' })
    expect(authored.status_line).toBe('Checking the test fails before anything is built…')
    const red = m.run(20000, (x) => x.checks.some((c) => c.base && c.state === 'failed'))
    expect(red.checks[0]).toMatchObject({ base: true, state: 'failed', line: '1 failed: shows the temperature for London', failing: ['app.js'] })
    expect(String((raw(m).checks as { line: string }[])[0].line)).toMatch(/^CREATE-CHECK \{/)
    expect(red.status).toBe('building')
    expect(planStages(red).find((s) => s.key === 'tests')).toMatchObject({ state: 'done', words: 'The test fails first, as it should' })
    expect(['layout', 'logic', 'icon', 'look'].map((id) => piece(red, id).state)).toEqual(['started', 'started', 'waiting', 'held'])
  })

  it('a piece’s work streams in as candidates the files route reads; the code pane follows the newest', () => {
    const m = make()
    const writing = m.run(20000, (v) => !!piece(v, 'layout')?.candidate && piece(v, 'layout').state === 'started')
    const t = codeTarget(writing)!
    expect(t.inline).toBeNull()
    expect(t.ckpt).toMatch(/^cand_/)
    const file = m.code(writing)!
    expect(file).toMatchObject({ writing: true })
    expect(['index.html', 'app.js']).toContain(file.path)
    const grew = m.run(m.at() + 500)
    const later = m.code(grew)
    expect(later!.content.length).toBeGreaterThanOrEqual(1)
    expect(() => m.s.files(m.id, 'nope.js', 'ckpt_0')).toThrow(/no such file/)
    expect(() => m.s.files(m.id, 'app.js', 'ckpt_99')).toThrow(/not a checkpoint/)
    expect(m.s.files(m.id)).toMatchObject({ ckpt: writing.checkpoint!.ckpt })
  })

  it('the question holds only look: unanswered, the rest is built and integrated; it never auto-answers', () => {
    const m = make()
    const v = m.run(120000)
    expect(v.questions[0].answered).toBeNull()
    expect(piece(v, 'look').state).toBe('held')
    expect(['layout', 'logic', 'icon'].map((id) => piece(v, id).state)).toEqual(['integrated', 'integrated', 'integrated'])
    expect(v.status).toBe('asking_you')
    expect(v.status_line).toBe('Waiting for your answer')
    expect(pieceRows(v).find((r) => r.id === 'look')!.words).toBe('Held by your question')
    expect(deployGo(v).available).toBe(false)
    expect(() => m.s.preview(m.id)).toThrow(/no preview yet/)
  })

  it('the whole timeline: answer → check red → fix → green → a verified preview → deploy → installed', () => {
    const m = make()
    m.run(6000)
    m.s.answer(m.id, 'q_look', 'Calm and minimal')
    expect(() => m.s.answer(m.id, 'q_look', 'again')).toThrow(/not taken/)
    const red = m.run(60000, (v) => v.checks.filter((c) => !c.base).some((c) => c.state === 'failed'))
    expect(red.checks.filter((c) => !c.base)[0]).toMatchObject({ state: 'failed', failing: ['app.js'], line: '1 failed: shows "°C" after the temperature' })
    expect(red.checkpoint!.ckpt).toBe('ckpt_4')
    const files = m.s.files(m.id, null, 'ckpt_4').files as Record<string, string>
    expect(files['style.css']).toContain('Calm and minimal')
    expect(files['app.js']).not.toContain('°C')
    const fixing = m.run(m.at() + 250)
    expect(fixing.status).toBe('fixing')
    expect(piece(fixing, 'logic')).toMatchObject({ state: 'fixing', repairs: 1 })
    expect(planStages(fixing).find((s) => s.state === 'active')).toMatchObject({ key: 'check', words: 'Fixing what the check found' })
    const ready = m.run(80000, (v) => v.status === 'ready_to_deploy')
    expect(ready.checks.at(-1)).toMatchObject({ state: 'passed', line: '2 passed' })
    expect(ready.preview).toMatchObject({ ckpt: ready.checkpoint!.ckpt })
    expect(ready.preview!.ref).toMatch(/^preview-[0-9a-f]{32}$/)
    const pv = parsePreviewFiles(m.s.preview(m.id))!
    expect(pv).toMatchObject({ ref: ready.preview!.ref, ckpt: ready.preview!.ckpt })
    expect(Object.keys(pv.files).sort()).toEqual(['app.js', 'icon.svg', 'index.html', 'style.css'])
    expect(pv.files['app.js']).toContain('°C')
    expect(frameFiles(pv.files)!['icon.svg']).toContain('<svg')
    expect(ready.acceptance).toHaveLength(3)
    expect(deployGo(ready)).toEqual({ available: true, why_not: null, unreviewed: false })
    expect(planStages(ready).find((s) => s.key === 'review')).toMatchObject({ state: 'done', words: 'Reviewed', detail: 'by Sable' })
    expect(piece(ready, 'icon').review).toMatchObject({ kind: 'media', state: 'passed', reviewer: 'Sable', evidence: 'render-icon-1' })
    expect(m.at()).toBeGreaterThanOrEqual(40000)
    expect(m.at()).toBeLessThanOrEqual(60000)
    m.s.deploy(m.id)
    expect(m.view().status).toBe('deploying')
    expect(() => m.s.deploy(m.id)).toThrow(/not ready/)
    const done = m.run(m.at() + 2000, (v) => v.status === 'deployed')
    expect(done).toMatchObject({ phase: 'deployed', installed: { app_id: 'london-weather', name: 'London weather' }, status_line: 'Installed as London weather' })
    expect(planStages(done).at(-1)).toMatchObject({ state: 'done', words: 'Installed as London weather' })
    // events: the engine's four, each in its own shape
    const kinds = new Set(m.events.map((e) => e.type))
    expect([...kinds].sort()).toEqual(['create.plan.piece', 'create.plan.preview', 'create.plan.question', 'create.plan.status'])
    expect(m.events.every((e) => e.plan_id === m.id)).toBe(true)
    const status = m.events.find((e) => e.type === 'create.plan.status')!
    expect(Object.keys(status).sort()).toEqual(['next_action', 'phase', 'plan_id', 'status', 'type'])
    const pieceEv = m.events.find((e) => e.type === 'create.plan.piece')!
    expect(Object.keys(pieceEv).sort()).toEqual(['candidate', 'piece', 'plan_id', 'repairs', 'state', 'type'])
    const asked = m.events.find((e) => e.type === 'create.plan.question' && e.answered === false)!
    expect(asked).toMatchObject({ q: 'q_look', about: { piece: 'look' }, choices: ['Calm and minimal', 'Bright and playful'] })
    expect(m.events.find((e) => e.type === 'create.plan.question' && e.answered === true)).toEqual({ type: 'create.plan.question', plan_id: m.id, q: 'q_look', answered: true })
    expect(m.events.find((e) => e.type === 'create.plan.preview')).toEqual({ type: 'create.plan.preview', plan_id: m.id, ckpt: ready.preview!.ckpt, preview: ready.preview!.ref })
  })

  it('a bright answer gives the bright palette in the preview', () => {
    const m = make()
    m.run(5000); m.s.answer(m.id, 'q_look', 'Bright and playful')
    m.run(80000, (x) => x.status === 'ready_to_deploy')
    expect(m.s.preview(m.id).files['style.css']).toContain('Bright and playful')
  })

  it('?simplan=unreviewed: every review unavailable, pieces unreviewed, and the deploy go says so', () => {
    const m = make('unreviewed')
    m.run(5000); m.s.answer(m.id, 'q_look', 'Calm and minimal')
    const v = m.run(80000, (x) => x.status === 'ready_to_deploy')
    expect(v.unreviewed).toBe(true)
    expect(v.review_policy).toBe('review-waivable')
    expect(v.pieces.every((p) => p.unreviewed && p.review?.state === 'waived')).toBe(true)
    expect(deployGo(v)).toEqual({ available: true, why_not: null, unreviewed: true })
    expect(planStages(v).find((s) => s.key === 'review')).toMatchObject({ state: 'skipped', words: 'Not reviewed: your setting allowed it' })
  })

  it('?simplan=fail: the fix fails twice → needs you, with a hold question; "Try again" fixes it', () => {
    const m = make('fail')
    m.run(5000); m.s.answer(m.id, 'q_look', 'Calm and minimal')
    const b = m.run(90000, (x) => x.status === 'needs_you')
    expect(b.phase).toBe('blocked')
    expect(piece(b, 'logic').repairs).toBe(2)
    const q = b.questions.find((x) => !x.answered)!
    expect(q).toMatchObject({ about: { kind: 'blocked' }, choices: ['Try again', 'Stop'] })
    expect(planStages(b).find((s) => s.state === 'failed')).toMatchObject({ key: 'check', detail: 'Stuck: it needs your answer' })
    expect(m.run(m.at() + 10000).status).toBe('needs_you')
    m.s.answer(m.id, q.q, 'Try again')
    const v = m.run(m.at() + 30000, (x) => x.status === 'ready_to_deploy')
    expect(v.status).toBe('ready_to_deploy')
    expect(piece(v, 'logic').repairs).toBe(3)
  })

  it('?simplan=fail: answering "Stop" stops the plan', () => {
    const m = make('fail')
    m.run(5000); m.s.answer(m.id, 'q_look', 'Calm and minimal')
    const b = m.run(90000, (x) => x.status === 'needs_you')
    m.s.answer(m.id, b.questions.find((x) => !x.answered)!.q, 'Stop')
    expect(m.view().status).toBe('stopped')
  })

  it('?simplan=hive: logic goes to the whole hive (an open lane, last), then resolves to a mind after ~3 s', () => {
    const m = make('hive')
    const v = m.run(4000)
    expect(piece(v, 'logic').assignee).toMatchObject({ kind: 'hive', ref: null, resolved: false, display: 'the whole hive', detail: 'finding a mind across the hive' })
    expect(assigneeLanes(v).lanes.map((l) => l.assignee.display)).toEqual(['Studio', 'Iris (illustrator)', 'the whole hive'])
    const r = m.run(7250)
    expect(piece(r, 'logic').assignee).toMatchObject({ kind: 'mind', resolved: true, display: 'Quill (from the hive)' })
    const built = m.run(20000, (x) => piece(x, 'logic').builder !== null)
    expect(piece(built, 'logic').builder!.name).toBe('Quill')
  })

  it('stop: the plan becomes stopped; stopping again just answers the view; a stopped plan refuses deploy', () => {
    const m = make()
    m.run(12000)
    expect(m.s.stop(m.id)).toMatchObject({ phase: 'stopped', status: 'stopped' })
    const v = m.run(60000)
    expect(v.status).toBe('stopped')
    expect(v.pieces.every((p) => p.builder === null)).toBe(true)
    expect(m.s.stop(m.id)).toMatchObject({ status: 'stopped' })
    expect(() => m.s.deploy(m.id)).toThrow(/not ready/)
  })

  it('GET /api/create/plans: the person’s plans newest first; the running one is picked up again', () => {
    let t = 0
    const s = new SimPlans({ now: () => t })
    const a = (s.start('one') as { plan_id: string }).plan_id
    const b = (s.start('two') as { plan_id: string }).plan_id
    t = 12000
    s.stop(b)
    const rows = parsePlanList(s.list())
    expect(rows.map((r) => [r.plan_id, r.status])).toEqual([[b, 'stopped'], [a, 'building']])
    expect(runningPlan(rows)?.plan_id).toBe(a)
  })

  it('refuses bad input and unknown plans', () => {
    const m = make()
    expect(() => m.s.start('  ')).toThrow(/1-2000/)
    expect(() => m.s.get('plan_nope')).toThrow(/no plan/)
    expect(() => m.s.answer(m.id, 'q_look', '')).toThrow(/1-4000/)
    expect(() => m.s.answer(m.id, 'q_nope', 'x')).toThrow(/not taken/)
    expect(() => m.s.deploy(m.id)).toThrow(/not ready/)
    expect(() => m.s.files(m.id, 'app.js')).toThrow(/nothing is built/)
  })

  it('scale 0 (vitest SimClient): every due step runs at once, up to the held question', () => {
    const s = new SimPlans({ scale: 0, now: () => 0 })
    const id = (s.start('anything at all') as { plan_id: string }).plan_id
    const v = parsePlanView(s.get(id))!
    expect(v.sentence).toBe('anything at all')
    expect(piece(v, 'look').state).toBe('held')
    expect(piece(v, 'logic').state).toBe('integrated')
    s.answer(id, 'q_look', 'Calm and minimal')
    expect(parsePlanView(s.get(id))!.status).toBe('ready_to_deploy')
    expect(parsePreviewFiles(s.preview(id))).not.toBeNull()
  })
})

describe('plan sim: changing the deployed app in place', () => {
  /** a plan deployed once, and a change asked, built to its go and deployed */
  const deployed = () => {
    const m = make()
    m.run(5000)
    m.s.answer(m.id, 'q_look', 'Calm and minimal')
    m.run(200000, (v) => v.status === 'ready_to_deploy')
    m.s.deploy(m.id)
    m.run(400000, (v) => v.status === 'deployed')
    const change = (words: string) => {
      m.s.revise(m.id, words)
      m.run(m.at() + 200000, (v) => v.status === 'ready_to_deploy')
      m.s.deploy(m.id)
      return m.run(m.at() + 200000, (v) => v.status === 'deployed')
    }
    const action = (name: string) => (raw(m).actions as { name: string; available: boolean; why_not: string | null; body: Record<string, unknown> }[]).find((a) => a.name === name)!
    return { ...m, change, action }
  }

  it('deployed once: one version, the current one; a change can be asked; nothing to undo or put back', () => {
    const m = deployed()
    const v = m.view()
    expect(v.revisions).toEqual([{ round: 1, words: SENTENCE, deployed_at: expect.any(String), current: true, from: null }])
    expect(m.action('revise')).toMatchObject({ available: true, why_not: null, body: { words: 'string, 1-2000 characters' } })
    expect(m.action('undo')).toMatchObject({ available: false, body: { round: null } })
    expect(m.action('revert')).toMatchObject({ available: false, why_not: 'there is only one version' })
  })

  it('a change is a later round on the same plan: from the app as it is, red first, then the go, deployed over the same app', () => {
    const m = deployed()
    const first = m.view()
    const started = parsePlanView(m.s.revise(m.id, '  make it blue '), minds)!
    expect(started).toMatchObject({ round: 2, round_words: 'make it blue', phase: 'planning', status: 'planning', pieces: [], checks: [], checkpoint: null, preview: null })
    expect(started.installed).toEqual(first.installed)
    expect(m.events.some((e) => e.type === 'create.plan.status' && e.status === 'planning')).toBe(true)
    // while it runs it takes no other change and puts nothing back
    expect(() => m.s.revise(m.id, 'and bigger')).toThrow(/still being made/)
    expect(() => m.s.revert(m.id, 1)).toThrow(/still being made/)
    const planned = m.run(m.at() + 3000)
    expect(planned.pieces.map((p) => [p.id, p.assignee.display, p.files[0]])).toEqual([['change', 'Code', 'style.css']])
    const red = m.run(m.at() + 60000, (v) => v.checks.some((c) => c.base && c.state === 'failed'))
    expect(red.checks[0].line).toBe('1 failed: make it blue')
    // the round's scaffold is the deployed version's files, so the change is made from what the app is
    const scaffold = m.s.files(m.id, null, red.checks[0].ckpt) as { files: Record<string, string> }
    expect(scaffold.files['app.js']).toBe((m.s.files(m.id, null, first.preview!.ckpt) as { files: Record<string, string> }).files['app.js'])
    const ready = m.run(m.at() + 200000, (v) => v.status === 'ready_to_deploy')
    expect(ready.checks[ready.checks.length - 1].state).toBe('passed')
    const css = parsePreviewFiles(m.s.preview(m.id))!.files['style.css']
    expect(css).toContain('/* Version 2: make it blue */')
    expect(css.startsWith('/* Calm and minimal */')).toBe(true)
    m.s.deploy(m.id)
    const done = m.run(m.at() + 10000, (v) => v.status === 'deployed')
    expect(done.revisions.map((r) => [r.round, r.words, r.current, r.from])).toEqual([[1, SENTENCE, false, null], [2, 'make it blue', true, 1]])
    expect(done.installed!.app_id).toBe(first.installed!.app_id)
    expect(m.action('undo')).toMatchObject({ available: true, body: { round: 1 } })
    expect(m.action('revert').available).toBe(true)
  })

  it('undo puts back the version the current one was made from; put back any version; the running page follows', () => {
    const m = deployed()
    const v1 = m.view()
    const v2 = m.change('make it blue')
    const back = parsePlanView(m.s.revert(m.id, 1), minds)!
    expect(back.revisions.map((r) => [r.round, r.current])).toEqual([[1, true], [2, false]])
    // nothing is appended, and the running page is version 1's again
    expect(back.round).toBe(2)
    expect(back.preview).toEqual(v1.preview)
    expect(m.action('undo')).toMatchObject({ available: false, body: { round: null } })
    // a change made after the undo is made from version 1, so Undo puts back version 1, not the undone version 2
    const v3 = m.change('make the cells bigger')
    expect(v3.revisions.map((r) => [r.round, r.current, r.from])).toEqual([[1, false, null], [2, false, 1], [3, true, 1]])
    expect(m.action('undo')).toMatchObject({ available: true, body: { round: 1 } })
    const css3 = parsePreviewFiles(m.s.preview(m.id))!.files['style.css']
    expect(css3).toContain('/* Version 3: make the cells bigger */')
    expect(css3).not.toContain('Version 2')
    // version 2 put back explicitly
    const two = parsePlanView(m.s.revert(m.id, 2), minds)!
    expect(two.revisions.find((r) => r.current)!.round).toBe(2)
    expect(two.preview).toEqual(v2.preview)
    expect(two.installed).toMatchObject({ app_id: 'london-weather' })
  })

  it('a change stopped: the app stays at its version, the running page is that version, and another change can be asked', () => {
    const m = deployed()
    const v1 = m.view()
    m.s.revise(m.id, 'make it blue')
    m.run(m.at() + 200000, (v) => v.status === 'ready_to_deploy')
    const stopped = parsePlanView(m.s.stop(m.id), minds)!
    expect(stopped).toMatchObject({ status: 'stopped', round: 2, round_words: 'make it blue' })
    expect(stopped.revisions.map((r) => [r.round, r.current])).toEqual([[1, true]])
    expect(stopped.preview).toEqual(v1.preview)
    expect(stopped.installed).toEqual(v1.installed)
    expect(m.action('revise').available).toBe(true)
    expect(parsePlanView(m.s.revise(m.id, 'make it green'), minds)).toMatchObject({ round: 3, status: 'planning' })
  })

  it('refuses a change or a put-back before anything is deployed, bad words, a bad round, and unknown versions', () => {
    const running = make()
    running.run(4000)
    expect(() => running.s.revise(running.id, 'make it blue')).toThrow(/still being made/)
    running.s.stop(running.id)
    expect(() => running.s.revise(running.id, 'make it blue')).toThrow(/nothing is deployed yet/)
    expect(() => running.s.revert(running.id, 1)).toThrow(/nothing is deployed yet/)
    const m = deployed()
    expect(() => m.s.revise(m.id, '   ')).toThrow(/1-2000/)
    expect(() => m.s.revise(m.id, 'x'.repeat(2001))).toThrow(/1-2000/)
    expect(() => m.s.revise('plan_nope', 'make it blue')).toThrow(/no plan/)
    expect(() => m.s.revert(m.id, '1' as unknown as number)).toThrow(/which version/)
    expect(() => m.s.revert(m.id, 7)).toThrow(/no such version/)
  })
})
