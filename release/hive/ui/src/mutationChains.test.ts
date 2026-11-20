// Purpose: check that every chain of UI writes retains its bound-operation or explicit identity guard.
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
  /**
   * writes that are deliberate releases, not acts (closing what this same code opened, through the client it opened it
   * with): exempt from the guard, each pinned by name and the function holding the call (its scan name, the testkit's
   * nameOf), with its reason, and checked to still be there
   */
  release?: { name: string; fn: string; why: string }[]
  why: string
}
const ALLOW: Allow[] = [
  { at: 'features/mind/inbox.ts:collectInbox', writes: ['myMindInboxAck*'], path: 4,
    guard: { re: /if \(!binding\.current\(\)\) return/, before: ['myMindInboxAck'] },
    why: 'its own identity binding: `if (!binding.current()) return stale` is the statement right before each ack in the loop' },
  // release baseline r1: the act is sent through personStartedProgramAct (P12/P13 R6), with the same alive() guard
  { at: 'lib/hostConfirm.ts:runConfirmed', writes: ['confirmAct', 'personStartedProgramAct', 'recheckRunning', 'checkOnce', 'recheckRunning'], path: 4,
    guard: { re: /if \(!alive\(\)\) return/, before: ['confirmAct', 'personStartedProgramAct', 'checkOnce'] },
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
  // Code mount a018643c: the same retained operation is recorded and submitted; Dot150958 accepted this guard.
  { at: 'features/code/testIntent.ts:resumeCodeTest', writes: ['askRecordCodeTestIntent', 'askSubmitIntent'], path: 2,
    guard: { re: /if \(!current\(\)\) return/, before: ['askSubmitIntent'] },
    why: '`current()` (the original person, candidate/draft and capability binding) is checked after the record await and synchronously before submitting that same retained intent, including explicit recovery' },
  { at: 'features/code/canvas/vibeSession.ts:ask', writes: ['codeProxy', 'codeSuggestionScope', 'recordAndSubmit'], path: 2,
    guard: { re: /if \(!put\(\{ phase: \{ kind: 'working', step: '\w+' \} \}\)\) return/, before: ['recordAndSubmit'] },
    why: 'found by the helper-effect scan: the scope (one of two exclusive writes) then recordAndSubmit; `put` commits through binding.commit for this request only and the run returns when it is refused, right before the hand-off' },
  // release baseline r1: the embedded app Ask (lib/appAsk.ts, its lease generation)
  // the first write is the card: AppAsk's port reads an app-link entry's card with appLinkEntryCard (a POST)
  { at: 'lib/appAsk.ts:create', writes: ['programAskCard', 'programAskConsent', 'programAskFrame'], path: 3,
    guard: { re: /if \(!valid\(\)/, before: ['programAskConsent', 'programAskFrame'] },
    why: '`valid()` (same open serial, not disposed, the same person, the app visible) is checked synchronously right before the consent write and again right before the frame request' },
  { at: 'lib/appAsk.ts:tick', writes: ['programAskPresence', 'programAskOp', 'op'], path: 2,
    guard: { re: /if \(!this\.holds\(t\)/, before: ['op'] },
    why: 'presence and poll are exclusive branches, each under a fresh ticket(); after a poll the unsubscribe is sent only if `this.holds(t)` (same serial and generation, still active), and op() takes its own ticket' },
  // release baseline r1: the app frame (found once appLink* were classified; the binding checks added this round)
  { at: 'features/programs/AppFrame.tsx:receive', writes: ['appLinkCheck', 'appLinkCheckFrame', 'attachFrame', 'programView', 'programAct'], path: 2,
    guard: { re: /if \(disposed \|\| !releaseCurrent \|\| !docBinding\.current\(\)\) return/, before: ['attachFrame', 'programView', 'programAct'] },
    why: 'the entry or frame consent check (two exclusive POSTs that read) is followed, before any app write, by `disposed || !releaseCurrent || !docBinding.current()` (the same sign-in, document and release); on the app-ready path the same check stands right before attachFrame' },
  { at: 'features/programs/AppLinks.tsx:useAppLinks>useEffect', writes: [], path: 0,
    guard: { re: /if \(!alive \|\| !binding\.current\(\)\)/, before: ['appLinkClose'] },
    why: 'registering the frame: when the answer comes back after the binding was lost (or the mount ended), the frame just created is closed at once (appLinkClose of its own id, through the client it was opened with), so no frame outlives the sign-in that opened it; nothing is done for anyone else',
    release: [{ name: 'appLinkClose', fn: 'useAppLinks>useEffect>return>then', why: 'the effect\'s unmount: this mount\'s own frame (the id its registration returned) is closed through the client that opened it, whatever the sign-in is now; a release, never an act for anyone' }] },
  // store/ask.ts: Ask's thread binding (snapshot().ok(): bound thread, epoch, session, inits, client and sign-in)
  { at: 'store/ask.ts:check', writes: ['ask', 'admitted'], path: 2,
    guard: { re: /if \(!snap\.ok\(\)\) return/, before: ['ask', 'admitted'] },
    why: 'store/ask.ts thread binding: the same request is sent again (same operation_id, never a second admission) only after `snap.ok()`; its admission is applied only after it again' },
  // release baseline r1: store/ask.ts:send is a single write now (deliver, one path), no longer a chain: its allowance went.
  // The held-words loop is named by where it sits (release's queueMicrotask callback, called in place), not by its
  // line, so the lines added above it in store/ask.ts no longer move it; the loop is the same
  { at: 'store/ask.ts:release>queueMicrotask>iife', writes: ['steerTo*'], path: 2,
    guard: { re: /if \(!holds\(\)\) return/, before: ['steerTo'] },
    why: 'store/ask.ts thread binding: held words are steered one at a time, each only while `holds()` (snap.ok() and the turn still there)' },
  // the Ask's act runner: an act's result is posted only once the page the act left has settled (features/ask/conductor)
  { at: 'features/ask/conductor.ts:step', writes: ['answer', 'answer', 'answer', 'perform', 'answer'], path: 2,
    guard: { re: /if \(!origin\.ok\(\)\) return/, before: ['post'], in: 'features/ask/conductor.ts:answer' },
    why: 'the Ask origin binding (store/ask.ts askOrigin: the same client, session, sign-in, Ask epoch and bound thread, and the page still presenting the Ask): answer waits for the page to settle (settledPage), then checks `origin.ok()` synchronously right before it posts the result, and post checks run.origin.ok() again itself' },
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
    // release baseline r1 (on 1ee2bb15 + Create 7abe7aab): 188 = 158 plus 20 new writes, and the 10 appLink* members,
    // which go through the private appLinkRequest(path, body, method = 'POST'): the scanner now reads a transport's verb
    // at its `method` parameter, or that parameter's default (they were unclassified before). The 20: askActClaim,
    // askClaim, askHandover, configureGoogleConnector, consentAppSwarm, disconnectGoogleConnector, hostProgramAct,
    // installProgram, openPersonApp, programAskClose, programAskConsent, programAskFrame, programAskOp,
    // programAskPresence, programAskRevoke, releaseNotices, resetPersonApp, setGoogleConnectorMind, setNoticeSettings,
    // startGoogleConnector. None moved out of `writes`.
    // browser Ask route 7948bb49: 189 = 188 plus askBrowserDone (the browser turn's done, /api/ask/{op}/done)
    // Code mount a018643c: 190 = 189 plus askRecordCodeTestIntent (POST to the original retained-intent route).
    // base 5a8abdf1 (already 194, the pin had drifted): 194 = 190 plus reportMissingBlocks, addMember,
    // resetMemberPassword and removeMemberPassword (each a POST/DELETE write added after e6a59fea)
    // create-code r1 (host 826b23a0): 197 = 194 plus requestApply, requestChanges and requestDiscard (the engine's person
    // routes: POST /api/requests/{id}/controller/apply | changes | discard)
    // create-code r3.12 (host 12f4292f): 198 = 197 plus setCodeControllerPrefs (PUT /api/me/code-controller: the person's
    // own review setting for new Code requests; written through bindOperation().write in canvas/work/reviewPolicy)
    // create-plan r1 (provisional routes, features/createPlan/contract.ts): 202 = 198 plus createPlanStart (POST
    // /api/create/plans {sentence}: starts a plan), createPlanAnswer (POST …/{id}/answers: the person answers a question),
    // createPlanDeploy (POST …/{id}/deploy: the person's deploy go) and createPlanStop (POST …/{id}/stop: the person stops it)
    // linked folders (host files r1): 206 = 202 plus linkFolder (POST /api/folders), unlinkFolder (DELETE …/{id}),
    // setFolderWritable and setFolderWriters (POST …/{id}/write: the admin's per-folder write switch and who may write)
    // messages between minds (omega-flagship #75): 207 = 206 plus setHiveThroughput (PATCH /api/hive/throughput: the
    // admin's hive-wide message limits); hiveThroughput, its GET, is a read
    // settle all: 208 = 207 plus resolveReservations (POST /api/budgets/reservations/resolve: every held call a person
    // listed, settled at its held amount or released, all or none)
    // estimates: 209 = 208 plus correctReservation (POST /api/budgets/reservations/{id}/correct: a person corrects the
    // hive's worst-case estimate of a call with the billed cost, or with nothing billed, within 30 days)
    // held calls settle themselves: 208 = 209 less resolveReservation and resolveReservations (nobody settles a held call
    // by hand) plus correctReservations (POST /api/budgets/reservations/correct: a person corrects several estimates at
    // once, all or none)
    // a view runs only on its person's word: 209 = 208 plus consentView (POST /api/artifacts/{id}/view/grants: the person's
    // Run it, or Allow for this version of the domains an HTML view declares)
    // Check now on Updates: 210 = 209 plus checkUpdates (POST /api/updates/check: an installed Mac hive's updater checks
    // at once and keeps what it found in its state)
    // who sees a mind's beliefs (Jon on #334 and #354): 211 = 210 plus setBeliefLink (PUT /api/agents/{id}/belief-link:
    // its owner or an admin links every belief, some subjects, none, or its default); beliefLink, its GET, is a read
    // feedback area: 212 = 211 plus sendFeedback (POST /api/feedback/send: the report the person saw, sent on their
    // press); feedback, its GET, is a read
    // feedback drafts: 213 = 212 plus dismissFeedbackDraft (DELETE /api/feedback/drafts/{id}: the person dismisses a
    // mind's draft, or its report left); feedbackDrafts, its GET, is a read
    // the Ask above the UI (Jon, 17 Nov: "stop shouldn't happen"): 212 = 213 less askTakeover (POST
    // /api/ask/{op}/takeover), since the person's use of the page no longer asks the host to end the turn
    // a mind's offer to build in Create: 214 = 212 plus createOfferStart (POST /api/create/offers/{id}/start: the
    // person's Start in Create) and createOfferDismiss (POST …/{id}/dismiss: their Not now); createOffers, its GET, is a read
    // a stopped task told to its person: 215 = 214 plus acknowledgeTaskStop (POST /api/me/task-stops/{id}/acknowledge:
    // the person's Got it); listTaskStops, its GET, is a read
    // files: 216 = 215 plus deleteAsset (DELETE /api/assets/{sha}: an admin permanently removes a file no other swarm
    // shares)
    // a made app changed in place: 218 = 216 plus createPlanRevise (POST /api/create/plans/{id}/revise: the person's
    // change) and createPlanRevert (POST …/{id}/revert: their Undo, or Put back on a version)
    expect(client.writes.size).toBe(218)
    for (const m of ['createPlanRevise', 'createPlanRevert']) expect(client.writes.has(m), m).toBe(true)
    expect(client.writes.has('askTakeover')).toBe(false)
    for (const m of ['createOfferStart', 'createOfferDismiss']) expect(client.writes.has(m), m).toBe(true)
    expect(client.writes.has('createOffers')).toBe(false)
    expect(client.writes.has('acknowledgeTaskStop')).toBe(true)
    expect(client.writes.has('listTaskStops')).toBe(false)
    expect(client.writes.has('deleteAsset')).toBe(true)
    expect(client.writes.has('consentView')).toBe(true)
    expect(client.writes.has('checkUpdates')).toBe(true)
    expect(client.writes.has('dismissFeedbackDraft')).toBe(true)
    expect(client.writes.has('setHiveThroughput')).toBe(true)
    expect(client.writes.has('hiveThroughput')).toBe(false)
    expect(client.writes.has('correctReservations')).toBe(true)
    expect(client.writes.has('resolveReservation') || client.writes.has('resolveReservations')).toBe(false)
    expect(client.writes.has('correctReservation')).toBe(true)
    expect(client.writes.has('setBeliefLink')).toBe(true)
    expect(client.writes.has('beliefLink')).toBe(false)
    expect(client.writes.has('sendFeedback')).toBe(true)
    expect(client.writes.has('feedback')).toBe(false)
    for (const m of ['linkFolder', 'unlinkFolder', 'setFolderWritable', 'setFolderWriters']) expect(client.writes.has(m), m).toBe(true)
    for (const r of ['listFolders', 'browseFolder']) expect(client.writes.has(r), r).toBe(false)
    for (const m of ['createPlanStart', 'createPlanAnswer', 'createPlanDeploy', 'createPlanStop']) expect(client.writes.has(m), m).toBe(true)
    for (const m of ['requestApply', 'requestChanges', 'requestDiscard', 'setCodeControllerPrefs']) expect(client.writes.has(m), m).toBe(true)
    expect(client.writes.has('askRecordCodeTestIntent')).toBe(true)
    for (const m of ['appLinkFrame', 'appLinkRedeem', 'programAskFrame', 'configureGoogleConnector']) expect(client.writes.has(m), m).toBe(true)
    expect(client.writes.has('studioSetupProposal')).toBe(true)
    expect(client.writes.has('studioMaker')).toBe(true)
    // live-pins r1: 124 = followups-r8's 122, plus budgetLimitsView (j0-fixes r1: GET /api/budgets/limits) and connect
    // (localowner-ui r1/r1.1: open() first asks GET /api/auth/methods, with no credential, for the hive's kind; so
    // connect is a read now, and leaves `none`). No member moved into or out of `writes`.
    // j3r43-o3 r1.3: 126 = 124 plus studioSession (the ledger GET) and studioMountReadback (GET …/mount?attempt_id=)
    // r1.14b: 127 = 126 plus myKeyLimits (GET /api/me/key-limits: the Me page's own-key monthly total)
    // release baseline r1: 135 = 127 plus appSwarmCard, askPresentation, googleConnector, myApps, myNotices, mySpendDays,
    // programAskCard and programInstall (each a GET)
    // browser Ask route 7948bb49: 136 = 135 plus browserMindGateway (GET, the gateway's configuration)
    // create-code r1: 137 = 136 plus requestController (GET /api/requests/{id}/controller, the engine's view)
    // create-code r3.12 (host 12f4292f): 138 = 137 plus codeControllerPrefs (GET /api/me/code-controller)
    // create-plan r1: 140 = 138 plus createPlan (GET /api/create/plans/{id}, the plan view) and createPlanFile (GET
    // …/{id}/files?path=&ckpt=, a file as of a checkpoint)
    // create-plan wire (host engine 7331307a, create_plan_engine.py): 142 = 140 plus createPlans (GET /api/create/plans:
    // the person's plans, so the bench resumes a running one) and createPlanPreview (GET …/{id}/preview: the current
    // preview's verified files for the app frame). Both GETs; no member moved into or out of `writes`.
    // linked folders (host files r1): 146 = 142 plus listFolders (GET /api/folders), browseFolder (GET …/{id}/list),
    // folderFileBlob (GET …/{id}/file, ranged) and folderReceipts (GET …/{id}/receipts). All GETs.
    // subscription usage (b67fd567): 147 = 146 plus subscriptionStatus (GET /api/subscriptions/status, what is left of
    // each attached plan; owner only). A GET; no member moved into or out of `writes`.
    // refused outside-agent connections (PhysixSNET/omegahive#40): 148 = 147 plus harnessRefusals
    // (GET /api/harness-invites/refused, admin only). A GET.
    // the limit that stops a mind: 149 = 148 plus agentLimits (GET /api/agents/{id}/limits, every limit the mind's next
    // paid call is admitted against, holds counted; operator only). A GET; no member moved into or out of `writes`.
    // messages between minds (omega-flagship #75): 150 = 149 plus hiveThroughput (GET /api/hive/throughput, the hive's
    // message limits). A GET; its PATCH, setHiveThroughput, is a write.
    // Evolve out of main until it launches (Jon on omega-flagship/omegahive#106, 12 Nov 2026): 149 = 150 less
    // figureBlob (GET of a recorded Evolve report's figure), which went with Evolve. No member moved into or out of
    // `writes`.
    // estimates: 150 = 149 plus listEstimated (GET /api/budgets/reservations/estimated, the estimates a person may still
    // correct; admins only). A GET; no member moved into or out of `writes`.
    // a saved creation read in place (PhysixSNET/omegahive#106): 151 = 150 plus creationText (GET
    // /api/artifacts/{id}/revisions/{n}, one saved revision with its text, for a person shown that artifact). A GET.
    // artifact views: 153 = 151 plus artifactView (GET /api/artifacts/{id}/view, one revision as an MCP Apps view) and
    // artifact (GET /api/artifacts/{id}, the Artifacts list's row for one artifact, the title an id in a mind's words
    // reads as). Both GETs; no member moved into or out of `writes`.
    // the stage: 154 = 153 plus myStage (GET /api/me/stage?after=n, what minds said to this person's stage that a
    // dropped socket missed). A GET.
    // a research report back at its Ask turn: 155 = 154 plus research (GET /api/research/{request_id}, the report a
    // personal turn's stored frame keeps none of). A GET.
    // who sees a mind's beliefs: 156 = 155 plus beliefLink (GET /api/agents/{id}/belief-link). A GET; its PUT,
    // setBeliefLink, is a write.
    // feedback area: 157 = 156 plus feedback (GET /api/feedback: what the hive adds to a person's report). A GET; its
    // send, sendFeedback, is a write.
    // feedback drafts: 158 = 157 plus feedbackDrafts (GET /api/feedback/drafts: the reports minds drafted for the
    // person). A GET; dismissFeedbackDraft is a write.
    // a mind's offer to build in Create: 159 = 158 plus createOffers (GET /api/me/create-offers?mind=, the person's open
    // offers from that mind). A GET; its presses, createOfferStart and createOfferDismiss, are writes.
    // a stopped task told to its person: 160 = 159 plus listTaskStops (GET /api/me/task-stops, the person's own
    // unacknowledged stops). A GET; its Got it, acknowledgeTaskStop, is a write.
    // feedback logs: 161 = 160 plus feedbackLogs (GET /api/feedback/logs: what the hive puts in the logs file a person
    // saves). A GET; saving or copying the file sends nothing.
    // Studio's recent creations: 162 = 161 plus listCreations (GET of the person's newest designs, pictures and apps, for
    // the empty canvas's recent list). A GET; opening one sends nothing.
    // and 163 = 162 plus studioRecent (GET of the three newest creations the empty canvas reopens)
    expect(client.reads.size).toBe(163)
    for (const r of ['listCreations', 'studioRecent']) expect(client.reads.has(r), r).toBe(true)
    for (const r of ['artifactView', 'artifact', 'myStage', 'research']) expect(client.reads.has(r), r).toBe(true)
    expect(client.reads.has('feedbackLogs')).toBe(true)
    expect(client.reads.has('feedbackDrafts')).toBe(true)
    expect(client.reads.has('createOffers')).toBe(true)
    expect(client.reads.has('feedback')).toBe(true)
    expect(client.reads.has('listTaskStops')).toBe(true)
    expect(client.reads.has('hiveThroughput')).toBe(true)
    expect(client.reads.has('listEstimated')).toBe(true)
    expect(client.reads.has('creationText')).toBe(true)
    expect(client.reads.has('beliefLink')).toBe(true)
    expect(client.reads.has('subscriptionStatus')).toBe(true)
    expect(client.reads.has('harnessRefusals')).toBe(true)
    expect(client.reads.has('agentLimits')).toBe(true)
    for (const m of ['createPlan', 'createPlanFile', 'createPlans', 'createPlanPreview']) expect(client.reads.has(m), m).toBe(true)
    expect(client.reads.has('requestController')).toBe(true)
    expect(client.reads.has('codeControllerPrefs')).toBe(true)
    expect(client.reads.has('budgetLimitsView')).toBe(true)
    expect(client.reads.has('myKeyLimits')).toBe(true)
    // scanner r1 (Kimi live-pins r1): read certifies verbs only, not side effects. open() also re-asks the methods on
    // a timer after a failure (api/live.ts, the authMethods retry; bounded since scanner r1), and that stays a GET:
    // see api/identityChanged.test.ts's pre-kind pin, which turns this into a write the moment open() sends anything else first.
    expect(client.reads.has('connect')).toBe(true)
    expect(client.unknown).toEqual(new Set())
    // retainedMutationScope: reads the client's own fields (host, principal), sends nothing; onResync: a listener (#111)
    expect([...client.none].sort()).toEqual(['authContext', 'disconnect', 'dispose', 'flowStudioUrl', 'needsAuth', 'onAuthChange', 'onConnection', 'onResync', 'retainedMutationScope', 'subscribe'])
    expect([...client.transports].sort()).toEqual(['codeProxy', 'repoMapRequest'])
    for (const m of ['logout', 'saveExploreView', 'personalMindHello', 'codeProxy', 'repoMapRequest', 'patchOnboarding', 'setOwnKeyLimit', 'askForLimit']) expect(client.writes.has(m), m).toBe(true)
  })
  it('the store: 40 actions; the helper-derived members: exactly these', () => {
    expect(store.size).toBe(40)
    expect([...effects.members].filter((m) => !mutations.has(m)).sort()).toEqual([
      'accept', 'applyCompletion', 'applyRename', 'burn', 'consume', 'deleteThread', 'demoAddKey', 'handback', 'heartbeat', 'helloGet', 'helloWake', 'mount', 'navigate', 'newThread',
      'op', 'programAskCard', 'reinit', 'restorePersonal', 'revoke', 'setDefaultSwarm', 'setOwnLimit', 'setThreadLimit', 'steerTo', 'turnOff', 'unmount', 'useModel', 'wakeAll', 'wakeMind', 'writeLimit', 'writeProgress',
      // First Light always finishable (Peter, 11-10): restorePersonal is the store action that sends an admin's
      // POST /api/swarms/{id}/restore of their archived personal mind's swarm, and wakeMind is First Light's host call for
      // POST /api/agents/{id}/wake of another of the person's minds; each is one write, sent only through the store
      // action's bound operation (op.write in firstlight/store.ts restorePersonal and wakeOther)
      // create-code r1: useModel is First Light's "Think with your … plan" (firstlight/host.ts): one patchAgent of the
      // owner's own mind's model, sent only through store.thinkWith's bound operation (op.write)
      // MeTTa screens R6: `rename` left: the Me page's key rename was a helper named rename around updateKey; the
      // composed page calls the same store action, updateKey, from its press handler (features/keys/ProfilePage.tsx)
      // own-key one-step (Jon 11-05): writeLimit is the add-your-key sheet's PUT /api/me/key-limits/self, sent only
      // through keys/ownLimit.saveOwnLimit's bound operation (features/ownKey/addOwnKey.ts)
      // j3r43-o3 r1.3: mount / heartbeat / unmount are the Studio mount lease's deps (features/studioLive/store.ts → mount.ts),
      // each one host write through the session's bound frame operation
      // release baseline r1: accept, handback, revoke (the Ask's claim and handover helpers), op (lib/appAsk.ts's ticketed
      // programAskOp), navigate (app links, through appLink* now that they are classified) and programAskCard (AppAsk's
      // port, which reads an app-link entry's card with appLinkEntryCard, a POST); consume and burn (lib/appLinkRestore's
      // steps: the entry's presentation spend, AppFrame's restore after consent, re-checked and tested in its own test)
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
      const all = guardedWrites(a.guard.in ?? a.at, a.guard.re, a.guard.before)
      const released = (g: { name: string; fn: string }) => a.release?.some((r) => r.name === g.name && r.fn === g.fn)
      for (const r of a.release ?? []) {
        expect(all.some((g) => g.name === r.name && g.fn === r.fn), `release moved or gone: ${a.at} ${r.name} in ${r.fn}`).toBe(true)
        expect(r.why.length, `${a.at} release`).toBeGreaterThan(40)
      }
      const checks = all.filter((g) => !released(g))
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
      const checks = guardedWrites(at, a.guard.re, a.guard.before, removed).filter((g) => !a.release?.some((r) => r.name === g.name && r.fn === g.fn))
      expect(checks.length, a.at).toBeGreaterThan(0)
      expect(checks.some((g) => !g.guarded), `${a.at}: still passes with its guard removed`).toBe(true)
    }
  })

  it('an anonymous function is named by where it sits, so a line added above it renames nothing', () => {
    const src = (pad: string) => `${pad}function Outer(c, ok) {\n  useEffect(() => {\n    void c.p().then(() => { if (!ok()) return; void c.w(1) })\n` +
      `    return () => { void c.w(2) }\n  })\n  useEffect(() => { void (async () => { if (!ok()) return; await c.w(3) })() })\n` +
      `  return <b onClick={() => { void c.w(4) }} />\n}\n`
    const holders = (pad: string, at: string) => guardedWrites(`lib/x.tsx:${at}`, /if \(!ok\(\)\) return/, ['w'], src(pad)).map((g) => g.fn)
    for (const pad of ['', '// one line added above\n\n\n']) {
      expect(holders(pad, 'Outer>useEffect'), pad).toEqual(['Outer>useEffect>then', 'Outer>useEffect>return'])
      expect(holders(pad, 'Outer>useEffect.2'), pad).toEqual(['Outer>useEffect.2>iife'])
      expect(holders(pad, 'Outer>onClick'), pad).toEqual(['Outer>onClick'])
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
    const at = 'store/ask.ts:release>queueMicrotask>iife'
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

  it('scanner (release baseline r1): an await in the other branch of an if/else or ?: does not precede the write', () => {
    const g = (body: string) => guardedWrites('f.ts:f', /if \(!ok\(\)\) return/, ['w'], `async function f() {\n${body}\n}`).map((x) => x.guarded)
    // exclusive branches: neither write follows the other's await; each is guarded by the check before the if
    expect(g('await c.r()\nif (!ok()) return\nif (a) await c.w(1)\nelse if (b) await c.w(2)')).toEqual([true, true])
    expect(g('await c.r()\nif (!ok()) return\nconst v = a ? await c.w(1) : await c.w(2)')).toEqual([true, true])
    // the same calls in sequence: the second follows the first's await, unguarded
    expect(g('await c.r()\nif (!ok()) return\nawait c.w(1)\nawait c.w(2)')).toEqual([true, false])
    // an await earlier in the same branch still counts
    expect(g('if (!ok()) return\nif (a) { await c.r(); await c.w(1) } else await c.w(2)')).toEqual([false, true])
    // a guard in the opposite branch protects only its own branch (stand-in on 4733c4aa)
    expect(g('await c.r()\nif (a) { if (!ok()) return; await c.w(1) } else if (b) { await c.w(2) }')).toEqual([true, false])
    // nor does a guard inside a branch that doesn't hold the write, before it
    expect(g('await c.r()\nif (a) { if (!ok()) return }\nawait c.w(1)')).toEqual([false])
    // a guard in a catch counts only when the try always leaves (the catch is then the only way on)
    expect(g('try { await c.r(); return 1 } catch (e) { if (!ok()) return }\nawait c.w(1)')).toEqual([true])
    expect(g('try { await c.r() } catch (e) { if (!ok()) return }\nawait c.w(1)')).toEqual([false])
    // a guard after the await inside the same branch counts on that path (appAsk create's consent branch)
    expect(g('if (!ok()) return\nif (a) { await c.r(); if (!ok()) return }\nawait c.w(1)')).toEqual([true])
    // but not when the guard is in a sibling branch of that await
    expect(g('if (a) { if (b) { await c.r() } else { if (!ok()) return } }\nawait c.w(1)')).toEqual([false])
    // a guard in a plain block that holds the write still counts
    expect(g('await c.r()\n{ if (!ok()) return }\nawait c.w(1)')).toEqual([true])
  })

  // Known limits of the structural dominance check (stand-in R2 on 89c65400; Dot: documented, not fixed now; the
  // testkit's KNOWN LIMITS comment). Each of these is still reported guarded though a path skips the guard.
  it.todo('known limit: `do { await c.r(); if (b) break; if (!ok()) return } while (false); await c.w()` (break out of the loop before the guard)')
  it.todo('known limit: `switch (a) { case 1: await c.r(); if (b) break; if (!ok()) return; break; default: break } await c.w()` (break out of the case)')
  it.todo('known limit: `const f = async () => { await c.r(); if (!ok()) return }; await c.w()` (a guard in a nested function)')
  it.todo('known limit: `for (;;) { await c.w(); await c.r(); if (a) { if (!ok()) return } }` (loop-back: the next iteration skips the guard)')
  it.todo('known limit: `await c.r(); try { if (!ok()) return } catch (e) {} await c.w()` (a throwing check falls through the catch)')

  it('the chains these rounds bind are bound: every write through op.write or a helper that binds its own', () => {
    for (const at of ['features/launch/LaunchSwarm.tsx:launch']) {
      const c = chains.find((x) => x.at === at)!
      expect(sig(c)).toEqual(['createSwarm', 'setBudget', 'createAgent*', 'agentAction*', 'createGoal'])
      expect(c.writes.every((w) => w.bound), at).toBe(true)
    }
    const life = chains.filter((c) => c.at.startsWith('features/lifecycle/LifecyclePage.tsx:') && isChain(c))
    // MeTTa screens R6: each Lifecycle press is a named action wrapping an anonymous bound operation, and the scan reports
    // both, so each write is listed twice; the distinct writes are the same three, and every one is still bound
    expect([...new Set(life.flatMap((c) => c.writes.map((w) => w.name)))].sort()).toEqual(['createPolicy', 'issueLease', 'sendMessage'])
    expect(life.every((c) => c.writes.every((w) => w.bound))).toBe(true)
    expect(chains.filter((c) => c.at.startsWith('features/explore/ExplorePage.tsx:') && c.thens.length)).toEqual([])
    // followups-r8 (Kimi FL-R2 #1): First Light's limit → progress, and its other two-write acts
    const fl = (name: string) => chains.find((c) => c.at === `features/firstlight/store.ts:${name}`)!
    // release baseline r1: setMonthly sends more steps now, every one through op.write or a bound helper
    expect(sig(fl('setMonthly'))).toEqual(['write', 'write', 'dispatchOwnLimit', 'write', 'save'])
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
    const inner = found.filter((c) => c.at.includes('>') && unbound(c))   // an anonymous function's scan name: where it sits
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
