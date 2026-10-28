import { describe, expect, it } from 'vitest'
import { classifyClient, deriveEffects, guardedWrites, isChain, scan, storeMutations, unbound, type Chain } from './lib/mutationChains.testkit'

/**
 * professional-release r1.2 (stand-in r1.1 P1, the class): no chain of hive writes in src may send a write after the
 * first without checking, immediately before it, that the sign-in it began under (and its caller) is still current.
 * The way to do that is lib/boundOperation (`op.write`). A chain that already checks its own binding right before each
 * write is listed here with its EXACT writes, its path count, and its GUARD: the check that must stand between the last
 * await and each listed write (lib/mutationChains.testkit guardedWrites). Remove the guard, put an await between it and
 * the write, or turn exclusive writes into sequential ones, and the allowance fails, so it is read again.
 *
 * followups-r8 (stand-in r1.2 P2/P3, Kimi r1.2 #4/#5, Kimi FL-R2 #1): writes are followed through helpers (a function
 * that awaits a helper that writes is writing: hostConfirm's checkOnce, First Light's save), callbacks, aliases and
 * Promise groups; the derived sets are pinned exactly; a write routed through a client wrapper is classified, not
 * dropped. store/ask.ts is no longer outside the scan: its chains are held by Ask's own thread binding (snapshot().ok()
 * and liveBound(), store/ask.ts:674-690, finer than the identity epoch), and each one is listed below with that guard.
 * The in-memory stand-ins (api/sim, First Light's demo host) reach no hive and are not scanned.
 */
interface Allow {
  at: string
  /** the writes in source order (`*`: inside a loop) */
  writes: string[]
  /** the most writes on one path (a loop of one counts two) */
  path: number
  /** the check that stands between the last await and each of `before` (in `in`, when it is another function) */
  guard: { re: RegExp; before: string[]; in?: string }
  why: string
}
const ALLOW: Allow[] = [
  { at: 'features/mind/inbox.ts:collectInbox', writes: ['myMindInboxAck*'], path: 4,
    guard: { re: /if \(!binding\.current\(\)\) return/, before: ['myMindInboxAck'] },
    why: 'its own identity binding: `if (!binding.current()) return stale` is the statement right before each ack in the loop' },
  { at: 'lib/hostConfirm.ts:runConfirmed', writes: ['confirmAct', 'programAct', 'recheckRunning', 'checkOnce', 'recheckRunning'], path: 4,
    guard: { re: /if \(!alive\(\)\) return/, before: ['confirmAct', 'programAct', 'checkOnce'] },
    why: '`alive()` (client, session, app, swarm, dialog) is checked synchronously right before the mint, the act and the recovery check; a token minted across a change is discarded unsent; recheckRunning checks it itself (its own allowance)' },
  { at: 'lib/hostConfirm.ts:recheckRunning', writes: ['checkOnce*'], path: 2,
    guard: { re: /if \(!alive\(\)\) return/, before: ['checkOnce'] },
    why: 'found by the helper-effect scan (stand-in r1.2 P2): each bounded re-check presents the SAME token (nothing minted or confirmed), and `alive()` is checked right after each pause, before the check is sent' },
  { at: 'lib/motivations.ts:changeLinks', writes: ['linkMotivation*'], path: 2,
    guard: { re: /if \(!live\.ok\(\)\) return/, before: ['linkMotivation'] },
    why: 'one write, retried once with the SAME operation_id after a lost answer; `live.ok()` is checked synchronously right before the retry' },
  { at: 'features/code/canvas/vibeRoute.ts:recordAndSubmit', writes: ['askRecordIntent', 'askSubmitIntent'], path: 2,
    guard: { re: /if \(!stillWanted\(\)\) return/, before: ['askSubmitIntent'] },
    why: '`stillWanted()` (vibeSession `live`: same request AND binding.current()) is checked synchronously right before the submit' },
  { at: 'features/code/canvas/vibeSession.ts:ask', writes: ['codeProxy', 'codeSuggestionScope', 'recordAndSubmit'], path: 2,
    guard: { re: /if \(!put\(\{ phase: \{ kind: 'working', step: '\w+' \} \}\)\) return/, before: ['recordAndSubmit'] },
    why: 'found by the helper-effect scan: the scope (one of two exclusive writes) then recordAndSubmit; `put` commits through binding.commit for this request only and the run returns when it is refused, right before the hand-off' },
  // store/ask.ts: Ask's thread binding (snapshot().ok(): bound thread, epoch, session, inits, client and sign-in)
  { at: 'store/ask.ts:check', writes: ['ask', 'admitted'], path: 2,
    guard: { re: /if \(!snap\.ok\(\)\) return/, before: ['ask', 'admitted'] },
    why: 'store/ask.ts thread binding: the same request is sent again (same operation_id, never a second admission) only after `snap.ok()`; its admission is applied only after it again' },
  { at: 'store/ask.ts:send', writes: ['ask', 'check'], path: 2,
    guard: { re: /if \(!snap\.ok\(\)\) return/, before: ['check'] },
    why: 'store/ask.ts thread binding: an answer that is not known is checked by its own id only after `snap.ok()`' },
  // live-pins r1: was @873; j0-fixes r1 (db7133ec) added 17 lines above it in store/ask.ts. `release` (its doc and body)
  // is byte-identical to followups-r8's: same writes, same path, same guard.
  // ask-send-r1: was @890; AskRow.spentUsd (2 lines, the refused row's reported turn spend) was added above it
  { at: 'store/ask.ts:<anonymous@892>', writes: ['steerTo*'], path: 2,
    guard: { re: /if \(!holds\(\)\) return/, before: ['steerTo'] },
    why: 'store/ask.ts thread binding: held words are steered one at a time, each only while `holds()` (snap.ok() and the turn still there)' },
  { at: 'store/ask.ts:apply', writes: ['revertSeq*'], path: 2,
    guard: { re: /if \(!t \|\| !t\.tookOver \|\| t\.takeover \|\| t\.state !== 'open' \|\| !client\?\.askTakeover\) return/, before: ['askTakeover'], in: 'store/ask.ts:sendTakeover' },
    why: 'revertSeq writes only through patchTurn → sendTakeover, which sends the takeover at most once per turn (marked sending before it is sent) and only for an open turn of the current thread' },
  { at: 'store/ask.ts:sendTakeover', writes: [], path: 0,
    guard: { re: /if \(!snap\.ok\(\)\) return/, before: ['askStop'] },
    why: 'found by the helper-effect scan: a takeover the host did not take is stopped instead, only after `snap.ok()` (added in this round: before it, a stop could follow a sign-in change)' },
]

const client = classifyClient()
const store = storeMutations(client.writes)
const mutations = new Set([...client.writes, ...store])
const effects = deriveEffects(mutations, undefined, { transports: client.transports })
const chains = scan(mutations, undefined, effects)
const sig = (c: Chain) => c.writes.map((w) => w.name + (w.loop ? '*' : ''))

describe('the mutation sets are derived, and pinned', () => {
  it('include the writes this class is about; reads are not writes', () => {
    for (const m of ['createSwarm', 'createAgent', 'agentAction', 'createGoal', 'issueLease', 'createPolicy', 'setDelegation', 'approve', 'sendMessage', 'createExploreGroup', 'exploreGroupMembers']) expect(mutations.has(m), m).toBe(true)
    for (const r of ['listGoals', 'getHive', 'listPolicy', 'listDelegations']) expect(mutations.has(r), r).toBe(false)
    expect(store.has('sendMessage')).toBe(true) // through its delivery helper
  })
  it('the client: every member classified; the sizes exact (a change is read, not absorbed)', () => {
    // 149 = the 144 the r1.2 regex found on this base, plus 5 it could not see: logout (fetch POST), saveExploreView and
    // personalMindHello (a verb chosen by a ternary), codeProxy and repoMapRequest (public transports: the caller's verb)
    // j3r43-o3 r1.3: 156 = 149 plus the seven live Studio session writes (studioRecordIntent, studioPiece, studioOutcome,
    // studioControl, studioMount, studioMountHeartbeat, studioUnmount; host R3 routes, used only behind the capability)
    // j3r43-o3 r1.10: 157 = 156 plus studioSetupProposal (host R7 POST /api/studio/setup: provisions the person's own
    // Studio maker and returns the card; used only behind the capability, from the app page's "Draw live")
    // j3r43-o3 r1.13: 158 = 157 plus studioMaker (POST /api/studio/setup with body {}: the person's own maker and its
    // Studio space, before their saved canvases are listed; behind the capability)
    expect(client.writes.size).toBe(158)
    expect(client.writes.has('studioSetupProposal')).toBe(true)
    expect(client.writes.has('studioMaker')).toBe(true)
    // live-pins r1: 124 = followups-r8's 122, plus budgetLimitsView (j0-fixes r1: GET /api/budgets/limits) and connect
    // (localowner-ui r1/r1.1: open() first asks GET /api/auth/methods, with no credential, for the hive's kind; so
    // connect is a read now, and leaves `none`). No member moved into or out of `writes`.
    // j3r43-o3 r1.3: 126 = 124 plus studioSession (the ledger GET) and studioMountReadback (GET …/mount?attempt_id=)
    // r1.14b: 127 = 126 plus myKeyLimits (GET /api/me/key-limits: the Me page's own-key monthly total)
    expect(client.reads.size).toBe(127)
    expect(client.reads.has('budgetLimitsView')).toBe(true)
    expect(client.reads.has('myKeyLimits')).toBe(true)
    // scanner r1 (Kimi live-pins r1): read certifies verbs only, not side effects. open() also re-asks the methods on
    // a timer after a failure (api/live.ts, the authMethods retry; bounded since scanner r1), and that stays a GET:
    // see api/identityChanged.test.ts's pre-kind pin, which turns this into a write the moment open() sends anything else first.
    expect(client.reads.has('connect')).toBe(true)
    expect(client.unknown).toEqual(new Set())
    expect([...client.none].sort()).toEqual(['authContext', 'disconnect', 'dispose', 'flowStudioUrl', 'needsAuth', 'onAuthChange', 'onConnection', 'subscribe'])
    expect([...client.transports].sort()).toEqual(['codeProxy', 'repoMapRequest'])
    for (const m of ['logout', 'saveExploreView', 'personalMindHello', 'codeProxy', 'repoMapRequest', 'patchOnboarding', 'setOwnKeyLimit', 'askForLimit']) expect(client.writes.has(m), m).toBe(true)
  })
  it('the store: 40 actions; the helper-derived members: exactly these', () => {
    expect(store.size).toBe(40)
    expect([...effects.members].filter((m) => !mutations.has(m)).sort()).toEqual([
      'applyCompletion', 'applyRename', 'deleteThread', 'demoAddKey', 'heartbeat', 'helloGet', 'helloWake', 'mount', 'newThread', 'reinit', 'rename',
      'setDefaultSwarm', 'setOwnLimit', 'setThreadLimit', 'steerTo', 'turnOff', 'unmount', 'wakeAll', 'writeProgress',
      // j3r43-o3 r1.3: mount / heartbeat / unmount are the Studio mount lease's deps (features/studioLive/store.ts → mount.ts),
      // each one host write through the session's bound frame operation
    ])
  })
})

describe('every multi-write chain goes through the bound operation (lib/boundOperation)', () => {
  it('no unbound chain outside the allowlist', () => {
    const allowed = new Set(ALLOW.map((a) => a.at))
    const bad = chains.filter((c) => unbound(c) && !allowed.has(c.at)).map((c) => `${c.at} ${JSON.stringify(c.writes)} thens=${c.thens}`)
    expect(bad, 'send each write after the first through bindOperation().write, or allow it here with a reason').toEqual([])
  })

  it('every allowance is current: still a chain, with exactly the recorded writes and path, and its guard in place', () => {
    for (const a of ALLOW) {
      const c = chains.find((x) => x.at === a.at)
      expect(c, `stale: ${a.at}`).toBeDefined()
      expect(isChain(c!), a.at).toBe(true)
      expect(sig(c!), `changed: ${a.at}`).toEqual(a.writes)
      expect(c!.path, `path changed: ${a.at}`).toBe(a.path)
      expect(a.why.length, a.at).toBeGreaterThan(40)
      const checks = guardedWrites(a.guard.in ?? a.at, a.guard.re, a.guard.before)
      expect(new Set(checks.map((g) => g.name)), a.at).toEqual(new Set(a.guard.before))
      for (const g of checks) expect(g.guarded, `${a.at}: ${g.name} at line ${g.line} has no guard right before it`).toBe(true)
    }
  })

  it('guard removal: each allowance fails once its guard is gone (the pin is the safety argument, not the names)', async () => {
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync(p: string, e: 'utf8'): string }
    const SRC = new URL('.', import.meta.url).pathname
    for (const a of ALLOW) {
      const at = a.guard.in ?? a.at
      const src = fs.readFileSync(`${SRC}${at.slice(0, at.lastIndexOf(':'))}`, 'utf8')
      const removed = src.replace(new RegExp(a.guard.re.source, 'g'), 'if (false) return')
      expect(removed, a.at).not.toBe(src)
      const checks = guardedWrites(at, a.guard.re, a.guard.before, removed)
      expect(checks.length, a.at).toBeGreaterThan(0)
      expect(checks.some((g) => !g.guarded), `${a.at}: still passes with its guard removed`).toBe(true)
    }
  })

  it('an await between the guard and the write fails it too', () => {
    const src = `async function f(c, alive) {\n  if (!alive()) return\n  await c.pause()\n  await c.programAct(1)\n}\n`
    const ok = `async function f(c, alive) {\n  await c.pause()\n  if (!alive()) return\n  await c.programAct(1)\n}\n`
    expect(guardedWrites('lib/hostConfirm.ts:f', /if \(!alive\(\)\) return/, ['programAct'], src).map((g) => g.guarded)).toEqual([false])
    expect(guardedWrites('lib/hostConfirm.ts:f', /if \(!alive\(\)\) return/, ['programAct'], ok).map((g) => g.guarded)).toEqual([true])
  })

  it('scanner r1 (stand-in + Kimi live-pins r1): a `continue` goes back to the loop head; removing ONLY the guard before steerTo fails', async () => {
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync(p: string, e: 'utf8'): string }
    const SRC = new URL('.', import.meta.url).pathname
    const at = 'store/ask.ts:<anonymous@892>'
    const re = /if \(!holds\(\)\) return/
    const src = fs.readFileSync(`${SRC}store/ask.ts`, 'utf8')
    // the loop-head guard is the one directly before steerTo (steerTo → continue comes back to it, never to the one after send)
    const first = src.search(re)
    expect(first).toBeGreaterThan(0)
    expect(src.slice(first).search(/await get\(\)\.steerTo\(/), 'the first holds() guard is the one before steerTo').toBeGreaterThan(0)
    expect(src.slice(first, first + src.slice(first).search(/await get\(\)\.steerTo\(/))).not.toMatch(/await /)
    const onlyFirst = src.slice(0, first) + 'if (false) return' + src.slice(first + 'if (!holds()) return'.length)
    expect(onlyFirst.match(new RegExp(re.source, 'g'))?.length, 'the guard after send is still there').toBe(1)
    expect(guardedWrites(at, re, ['steerTo'], src).map((g) => g.guarded)).toEqual([true])
    expect(guardedWrites(at, re, ['steerTo'], onlyFirst).map((g) => g.guarded), 'steerTo → continue → steerTo has no guard').toEqual([false])
    const both = src.replace(new RegExp(re.source, 'g'), 'if (false) return')
    expect(guardedWrites(at, re, ['steerTo'], both).map((g) => g.guarded)).toEqual([false])
  })

  it('scanner r1: the continue edge on synthetic loops (its own loop only, labels followed, nested functions skipped)', () => {
    const g = (body: string) => guardedWrites('lib/x.ts:f', /if \(!ok\(\)\) return/, ['w'], `async function f(c, ok, xs) {\n${body}\n}\n`).map((x) => x.guarded)
    // the guard only after the second await: the continue after w skips it
    expect(g('for (const x of xs) {\n  if (x) { await c.w(x); continue }\n  await c.r()\n  if (!ok()) return\n}')).toEqual([false])
    // the guard between the await and the continue: guarded on both edges
    expect(g('for (const x of xs) {\n  if (x) { await c.w(x); if (!ok()) return; continue }\n  await c.r()\n  if (!ok()) return\n}')).toEqual([true])
    // the guard at the loop head: guarded whatever the edge
    expect(g('for (const x of xs) {\n  if (!ok()) return\n  if (x) { await c.w(x); continue }\n  await c.r()\n}')).toEqual([true])
    // a continue of an inner loop goes back to that loop's head, not this one's
    expect(g('for (const x of xs) {\n  await c.w(x)\n  for (const y of xs) { await c.r(y); continue }\n  if (!ok()) return\n}')).toEqual([true])
    // ... unless it names this loop
    expect(g('outer: for (const x of xs) {\n  await c.w(x)\n  for (const y of xs) { await c.r(y); continue outer }\n  if (!ok()) return\n}')).toEqual([false])
    // scanner r1.1 (stand-in P2): every label attached to the loop, not only the innermost
    expect(g('outer: inner: for (const x of xs) {\n  if (x) { await c.w(x); continue outer }\n  await c.r()\n  if (!ok()) return\n}')).toEqual([false])
    expect(g('outer: inner: for (const x of xs) {\n  if (x) { await c.w(x); continue inner }\n  await c.r()\n  if (!ok()) return\n}')).toEqual([false])
    expect(g('outer: inner: for (const x of xs) {\n  if (x) { await c.w(x); if (!ok()) return; continue outer }\n  await c.r()\n  if (!ok()) return\n}')).toEqual([true])
    // a continue inside a nested function is that function's
    expect(g('for (const x of xs) {\n  await c.w(x)\n  xs.forEach(async (y) => { for (const z of xs) { await c.r(z); continue } })\n  if (!ok()) return\n}')).toEqual([true])
    // a continue with no await before it in the body brings nothing new
    expect(g('for (const x of xs) {\n  if (!x) continue\n  await c.w(x)\n  if (!ok()) return\n}')).toEqual([true])
  })

  it('the chains these rounds bind are bound: every write through op.write or a helper that binds its own', () => {
    for (const at of ['features/launch/LaunchSwarm.tsx:launch']) {
      const c = chains.find((x) => x.at === at)!
      expect(sig(c)).toEqual(['createSwarm', 'setBudget', 'createAgent*', 'agentAction*', 'createGoal'])
      expect(c.writes.every((w) => w.bound), at).toBe(true)
    }
    const life = chains.filter((c) => c.at.startsWith('features/lifecycle/LifecyclePage.tsx:') && isChain(c))
    expect(life.flatMap((c) => c.writes.map((w) => w.name)).sort()).toEqual(['createPolicy', 'issueLease', 'sendMessage'])
    expect(life.every((c) => c.writes.every((w) => w.bound))).toBe(true)
    expect(chains.filter((c) => c.at.startsWith('features/explore/ExplorePage.tsx:') && c.thens.length)).toEqual([])
    // followups-r8 (Kimi FL-R2 #1): First Light's limit → progress, and its other two-write acts
    const fl = (name: string) => chains.find((c) => c.at === `features/firstlight/store.ts:${name}`)!
    expect(sig(fl('setMonthly'))).toEqual(['setOwnLimit', 'save', 'refreshSetup'])
    for (const name of ['setMonthly', 'tick', 'wake', 'primeDemo']) {
      expect(isChain(fl(name)), name).toBe(true)
      expect(fl(name).writes.every((w) => w.bound), name).toBe(true)
    }
    expect(effects.bound.has('features/firstlight/store.ts#save')).toBe(true)
  })

  it('Kimi r1.1 #4: Code open/attach/select and roomBecomeSwarm are single writes (one per path)', () => {
    const go = chains.find((c) => c.at === 'features/code/CodePage.tsx:go')!
    expect(sig(go)).toEqual(['codeAttach', 'codeSelect', 'codeOpen'])
    expect(go.path).toBe(1) // one ternary: exactly one of the three is sent
    const become = chains.filter((c) => c.writes.some((w) => w.name === 'roomBecomeSwarm'))
    expect(become.length).toBeGreaterThan(0)
    for (const c of become) expect(isChain(c), c.at).toBe(false)
  })

  it('the two allowances r1.2 kept for early returns are no longer needed: the scan sees the returns (and their removal)', async () => {
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync(p: string, e: 'utf8'): string; writeFileSync(p: string, d: string): void; mkdtempSync(p: string): string; rmSync(p: string, o: { recursive: true }): void }
    const osName = 'node:os'
    const os = (await import(/* @vite-ignore */ osName)) as { tmpdir(): string }
    const SRC = new URL('.', import.meta.url).pathname
    const cases = [
      { at: 'features/messages/MessagesPage.tsx:create', name: 'create', writes: ['createSession', 'createRoom'], guard: /onCreated\(se\.room_id, 'session'\)\n\s*return\n/, keep: "onCreated(se.room_id, 'session')\n" },
      { at: 'lib/studioBridge.ts:studioReply', name: 'studioReply', writes: ['putAppDraft', 'deleteAppDraft'], guard: /return \{ reply: \{ type: 'draft-saved', id: msg\.id, \.\.\.r \} \}\n/, keep: '' },
    ]
    const dir = fs.mkdtempSync(`${os.tmpdir()}/chains-`)
    try {
      for (const k of cases) {
        const c = chains.find((x) => x.at === k.at)!
        expect(sig(c), k.at).toEqual(k.writes)
        expect(c.path, k.at).toBe(1)
        const src = fs.readFileSync(`${SRC}${k.at.slice(0, k.at.lastIndexOf(':'))}`, 'utf8')
        const removed = src.replace(k.guard, k.keep)
        expect(removed, k.at).not.toBe(src)
        const f = `${dir}/${k.name}.tsx`
        fs.writeFileSync(f, removed)
        const m = scan(mutations, [f]).find((x) => x.at.endsWith(`:${k.name}`))!
        expect(m.path, `${k.at} with its return removed`).toBe(2)
        expect(unbound(m), k.at).toBe(true)
      }
    } finally { fs.rmSync(dir, { recursive: true }) }
  })
})

describe('the scanner itself (synthetic sources)', () => {
  const probe = async (source: string, names: string[], ext = 'ts') => {
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { writeFileSync(p: string, d: string): void; mkdtempSync(p: string): string; rmSync(p: string, o: { recursive: true }): void }
    const osName = 'node:os'
    const os = (await import(/* @vite-ignore */ osName)) as { tmpdir(): string }
    const dir = fs.mkdtempSync(`${os.tmpdir()}/chains-`)
    const f = `${dir}/probe.${ext}`
    fs.writeFileSync(f, source)
    try {
      const found = scan(new Set(names), [f])
      return { found, got: Object.fromEntries(found.map((c) => [c.at.split(':').pop(), { chain: isChain(c), unbound: unbound(c) }])) as Record<string, { chain: boolean; unbound: boolean }> }
    } finally { fs.rmSync(dir, { recursive: true }) }
  }
  const W = ['createSwarm', 'createAgent', 'createPolicy', 'approve', 'deny', 'programAct']

  it('counts a loop as two, exclusive branches once, a .then of writes as a chain, and op.write as bound', async () => {
    const { got } = await probe(`
      async function twoDirect(c) { await c.createSwarm(1); await c.createAgent(2) }
      async function loopOne(c, xs) { for (const x of xs) await c.createPolicy(x) }
      async function either(c, a) { a ? await c.approve(1) : await c.deny(1) }
      async function bound(c, op) { await op.write(() => c.createSwarm(1)); await op.write(() => c.createAgent(2)) }
      function thenChain(c) { void c.createSwarm(1).then((s) => c.createAgent(s)) }
      function boundThenDirect(c, op) { void op.write(() => c.createSwarm(1)).then((s) => c.createAgent(s)) }
      function boundThenBound(c, op) { void op.write(() => c.createSwarm(1)).then((s) => op.write(() => c.createAgent(s))) }
      async function single(c) { await c.createSwarm(1); await c.listGoals(1) }
    `, W)
    expect(got.twoDirect).toEqual({ chain: true, unbound: true })
    expect(got.loopOne).toEqual({ chain: true, unbound: true })
    expect(got.either).toEqual({ chain: false, unbound: false })
    expect(got.bound).toEqual({ chain: true, unbound: false })
    expect(got.thenChain).toEqual({ chain: true, unbound: true })
    expect(got.boundThenDirect).toEqual({ chain: true, unbound: true }) // a bound first write does not excuse a direct second
    expect(got.boundThenBound).toBeUndefined() // nothing direct, no awaits: not even listed
    expect(got.single).toEqual({ chain: false, unbound: false })
  })

  it('followups-r8: a helper that writes is a write (hostConfirm checkOnce shape), to any depth; a bound helper is bound', async () => {
    const { got } = await probe(`
      async function checkOnce(c) { try { return { r: await c.programAct(1) } } catch { return null } }
      async function recheck(c, alive) { for (const ms of [1, 2]) { await pause(ms); if (!alive()) return; const x = await checkOnce(c); if (x) return x } }
      async function deeper(c) { return checkOnce(c) }
      async function viaDeeper(c) { await c.createSwarm(1); await deeper(c) }
      async function boundHelper(c, op) { await op.write(() => c.createAgent(1)) }
      async function viaBound(c, op) { await op.write(() => c.createSwarm(1)); await boundHelper(c, op) }
      async function viaBoundDirectFirst(c, op) { await c.createSwarm(1); await boundHelper(c, op) }
    `, W)
    expect(got.recheck).toEqual({ chain: true, unbound: true }) // the loop on the helper: checkOnce sends programAct
    expect(got.viaDeeper).toEqual({ chain: true, unbound: true })
    expect(got.viaBound).toEqual({ chain: true, unbound: false })
    expect(got.viaBoundDirectFirst).toEqual({ chain: true, unbound: true })
  })

  it('followups-r8: callbacks, Promise groups, returned writes and early returns', async () => {
    const { got } = await probe(`
      async function inlineCallback(c, run) { await c.createSwarm(1); await run(async () => { await c.createAgent(2) }) }
      async function allAtOnce(c, xs) { await Promise.all(xs.map((x) => c.createAgent(x))) }
      async function allThenMore(c, xs) { await c.createSwarm(1); await Promise.all(xs.map((x) => c.createAgent(x))) }
      async function groupOfTwo(c) { await Promise.all([c.createSwarm(1), c.createAgent(2)]) }
      async function reduceInTurn(c, xs) { await xs.reduce(async (p, x) => { await p; await c.createAgent(x) }, Promise.resolve()) }
      async function returnsWrite(c) { await c.createSwarm(1); return c.createAgent(2) }
      async function earlyReturn(c, a) { if (a) { await c.createSwarm(1); return } await c.createAgent(2) }
      async function tryThenCatch(c) { try { await c.createSwarm(1) } catch { await c.deny(1) } }
      function rejectThen(c) { void c.createSwarm(1).then(undefined, () => c.deny(1)) }
      function catchThen(c) { void c.createSwarm(1).catch(() => c.deny(1)) }
    `, W)
    expect(got.inlineCallback).toEqual({ chain: true, unbound: true })
    expect(got.allAtOnce).toEqual({ chain: false, unbound: false }) // one synchronous run: one step
    expect(got.allThenMore).toEqual({ chain: true, unbound: true })
    expect(got.groupOfTwo).toEqual({ chain: false, unbound: false })
    expect(got.reduceInTurn).toEqual({ chain: true, unbound: true })
    expect(got.returnsWrite).toEqual({ chain: true, unbound: true })
    expect(got.earlyReturn).toEqual({ chain: false, unbound: false })
    expect(got.tryThenCatch).toEqual({ chain: true, unbound: true }) // the catch may follow a sent write
    expect(got.rejectThen).toEqual({ chain: true, unbound: true })
    expect(got.catchThen).toEqual({ chain: true, unbound: true })
  })

  it('followups-r8: aliases of a write are the write', async () => {
    const { got } = await probe(`
      async function alias(c) { const make1 = c.createAgent; await c.createSwarm(1); await make1(2) }
      async function aliasBound(c) { const make2 = c.createAgent.bind(c); await c.createSwarm(1); await make2(2) }
      async function destructured(c) { const { createAgent: make3 } = c; await c.createSwarm(1); await make3(2) }
      async function reused(c) { const a = c.createAgent; await c.createSwarm(1); await a(2) }
      async function reusedForARead(c) { const a = c.listGoals; await a(1) } // the same name again, later: it must not hide the write above
      async function sameName(c) { const { createAgent } = c; await c.createSwarm(1); await createAgent(2) }
    `, W)
    for (const k of ['alias', 'aliasBound', 'destructured', 'sameName', 'reused']) expect(got[k], k).toEqual({ chain: true, unbound: true })
  })

  it('followups-r8: several writes inside ONE op.write callback are a chain of their own (the check is made once)', async () => {
    const { found, got } = await probe(`
      async function twoInOne(c, op) { await op.write(async () => { await c.createSwarm(1); await c.createAgent(2) }) }
      async function thenInOne(c, op) { await op.write(() => c.createSwarm(1).then((s) => c.createAgent(s))) }
      async function groupInOne(c, op) { await op.write(() => Promise.all([c.createSwarm(1), c.createAgent(2)])) }
    `, W)
    expect(got.twoInOne).toEqual({ chain: false, unbound: false }) // the operation itself: one bound step
    const inner = found.filter((c) => c.at.includes('<anonymous@') && unbound(c))
    expect(inner.map((c) => sig(c))).toEqual([['createSwarm', 'createAgent'], []]) // twoInOne's callback; thenInOne's .then
    expect(inner[1].thens.length).toBe(1)
  })

  it('followups-r8: a client write routed through a wrapper is classified a write, and an unreadable verb is reported', async () => {
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { writeFileSync(p: string, d: string): void; mkdtempSync(p: string): string; rmSync(p: string, o: { recursive: true }): void }
    const osName = 'node:os'
    const os = (await import(/* @vite-ignore */ osName)) as { tmpdir(): string }
    const dir = fs.mkdtempSync(`${os.tmpdir()}/client-`)
    const f = `${dir}/live.ts`
    fs.writeFileSync(f, `
      export class LiveClient {
        private async request(method: string, path: string, body?: unknown) { return fetch(path, { method, body: JSON.stringify(body) }) }
        private post(path: string, body: unknown) { return this.request('POST', path, body) }
        createThing = (b: unknown) => this.post('/api/things', b)
        readThing = () => this.request('GET', '/api/things')
        either = (w: boolean) => this.request(w ? 'PUT' : 'GET', '/api/things')
        guessed = (m: string) => this.request(m.toUpperCase(), '/api/things')
        bye = () => fetch('/api/auth/logout', { method: 'POST' })
        connect() { return null }
      }
    `)
    try {
      const k = classifyClient(f)
      expect([...k.writes].sort()).toEqual(['bye', 'createThing', 'either'])
      expect([...k.reads]).toEqual(['readThing'])
      expect([...k.unknown]).toEqual(['guessed']) // the standing test fails on any unknown
      expect([...k.none]).toEqual(['connect'])
      // the r1.2 classifier read only the member's own text for a literal write verb: the wrapper's write was dropped
      expect(/\(\s*['"`](POST|PUT|PATCH|DELETE)['"`]/.test("(b: unknown) => this.post('/api/things', b)")).toBe(false)
    } finally { fs.rmSync(dir, { recursive: true }) }
  })
})
