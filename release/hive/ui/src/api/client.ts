import type { Board, Matches, Scope } from '../features/boards/types'
import type {
  PersonAsk,
  ActionResult,
  Agent,
  AgentAction,
  Approval,
  ApprovalStatus,
  Belief,
  BeliefDetail,
  Catalog,
  CreateAgentBody,
  KeyInfo,
  CreatedAgent,
  CreateGoalBody,
  CreatePolicyBody,
  CreateSwarmBody,
  CreateWakeupBody,
  Goal,
  HiveEvent,
  HiveInfo,
  LabHistory,
  LabRun,
  LabRunSummary,
  LabScorecardEntry,
  LabSuite,
  MemoryAtom,
  MemorySpace,
  Message,
  ModelEndpoint,
  ModelOption,
  PatchAgentBody,
  PatchGoalBody,
  PatchWakeupBody,
  PolicyRule,
  Program,
  ProgramActBody,
  ProgramDetail,
  ProgramViewBody,
  ProviderStatus,
  Swarm,
  Trace,
  Usage,
  Wakeup,
  WorkGraph,
} from './types'

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'unauthorized'

export type EventListener = (event: HiveEvent) => void
export type ConnectionListener = (state: ConnectionState) => void

/**
 * The single data-access surface for the whole UI. Every component talks to the hive
 * through this interface only, so the in-browser simulator and the real server are
 * interchangeable.
 */
export interface HiveClient {
  board?(scope: Scope, entityId?: string): Promise<Board>
  matchServices?(need: string, kind?: 'mind' | 'swarm'): Promise<Matches>
  flowStudioUrl?(): string
  flowRequest?(operation: import('../features/flow/operations').FlowOperation, params: Record<string, unknown>): Promise<unknown>
  tools?(): Promise<import('./types').ToolsCatalogue>
  readonly mode: 'live' | 'sim'
  /** True when the client needs an operator login before it can do anything. */
  needsAuth(): boolean
  login(password: string): Promise<void>
  /** Ends the session; the live client waits briefly for the hive to end it server-side. */
  logout(): void | Promise<void>
  /** How this browser may sign in here: the password only from the hive's own machine; Google from outside. */
  authMethods?(): Promise<AuthMethods>
  /** Exchange a webhost sign-in for a hive session. Resolves false when the person is not signed in or not allowed. */
  trySso?(): Promise<boolean>
  /** Spending limits at every level (hive/core/budgets.py). */
  listBudgets?(): Promise<import('../features/usage/Limits').BudgetRow[]>
  setBudget?(body: { scope: string; period: string; limit_usd: number; note?: string }): Promise<unknown>
  removeBudget?(id: string): Promise<unknown>
  /** Who is signed in, and their role. */
  me?(): Promise<Me>
  /** Local invalidation handle only; never a person session or permission. */
  authContext?(): object
  onAuthChange?(listener: () => void): () => void
  /** Your look and layout (Surface v1, /api/me/ui). Without these the Change UI entry stays hidden. */
  uiPrefs?(): Promise<import('../shell/uiVariant').UiPrefsResponse>
  /** `opts.baseRev`: compare-and-set against the host's `rev`, sent as X-UI-Base-Rev (409 stale_ui_prefs when it moved on) */
  setUiPrefs?(prefs: import('../shell/uiVariant').UiPrefs, opts?: import('../shell/uiVariant').UiPrefsWriteOptions): Promise<import('../shell/uiVariant').UiPrefsResponse>
  resetUiPrefs?(opts?: import('../shell/uiVariant').UiPrefsWriteOptions): Promise<import('../shell/uiVariant').UiPrefsResponse>
  invitePreview?(token: string): Promise<{ email_hint: string; name: string; role: string; expires_at: number }>
  /** Error checking across minds: issues per mind, worst first. */
  health?(swarmId?: string): Promise<import('./types').HealthOverview>
  /** Idle minds (Platform idle-minds r2): what Health noticed and asked. `includePersonal`: admin audit, opt-in, read-only. */
  idleMinds?(opts?: { includePersonal?: boolean }): Promise<import('./idleMinds').IdleOverview>
  idleMind?(agentId: string, opts?: { includePersonal?: boolean }): Promise<import('./idleMinds').IdleDetail | null>
  /** Health asks the mind its question now (409 not_awake, 403 personal_mind, 404 not_found); two within 60 s are one. */
  remindIdle?(agentId: string): Promise<import('./idleMinds').IdleDetail | null>
  /** R19: filter, group and page every node on the server; saved personal views. */
  explore?(spec: import('./types').ExploreSpec): Promise<import('./types').ExploreResult>
  exploreViews?(): Promise<import('./types').ExploreView[]>
  saveExploreView?(body: { name: string; spec: import('./types').ExploreSpec; arrangement: import('./types').ExploreArrangement }, id?: string): Promise<import('./types').ExploreView>
  deleteExploreView?(id: string): Promise<{ id: string }>
  setNodeMeta?(id: string, body: { purpose?: string; tags?: string[] }): Promise<{ node_id: string; purpose: string; tags: string[] }>
  exploreGroups?(): Promise<import('./types').ExploreGroupDef[]>
  createExploreGroup?(name: string): Promise<import('./types').ExploreGroupDef>
  exploreGroupMembers?(id: string, body: { add?: string[]; remove?: string[] }): Promise<import('./types').ExploreGroupDef>
  /** R18: detected app and platform updates, owners' requests, holds and history. */
  updates?(): Promise<import('./types').UpdatesOverview>
  applyUpdate?(body: { target: string; override?: boolean; confirm?: string }): Promise<{ target: string; ok: boolean; restarting?: boolean; error?: string | null }>
  releaseHold?(id: string): Promise<{ id: string }>
  /** Admins: refuse a platform restart, every update, or one app's reload until released (or `until`, an ISO time). */
  placeHold?(body: import('./types').PlaceHoldBody): Promise<import('./types').UpdateHold>
  listPeople?(): Promise<{ people: Person[]; invites: Invite[]; google_ready: boolean }>
  // R15 rooms
  rooms?(): Promise<import('./types').Room[]>
  /** One room by id or alias (GET /api/rooms/coffee loads the Coffee Room). */
  room?(id: string): Promise<import('./types').Room>
  createRoom?(body: { kind: import('./types').RoomKind; name?: string; topic?: string; members: string[]; visibility?: string; origin?: import('./types').RoomOrigin }): Promise<import('./types').Room>
  updateRoom?(id: string, body: Record<string, unknown>): Promise<import('./types').Room>
  roomMessages?(id: string, after?: number): Promise<import('./types').RoomMessage[]>
  postRoomMessage?(id: string, text: string): Promise<import('./types').RoomMessage>
  addRoomMembers?(id: string, members: string[]): Promise<import('./types').Room>
  removeRoomMember?(id: string, member: string): Promise<import('./types').Room>
  roomBecomeSwarm?(id: string, moveMinds: string[]): Promise<{ room: import('./types').Room; swarm: Swarm }>
  swarmRoom?(swarmId: string): Promise<import('./types').Room>
  usageMe?(): Promise<import('./types').MySpendSummary>
  /** G2: the signed-in person's own notices (held ones are counted, not shown) and their budget settings. */
  myNotices?(): Promise<unknown>
  setNoticeSettings?(body: Partial<Pick<import('./notices').NoticePrefs, 'cap' | 'quiet_start' | 'quiet_end' | 'tz'>>): Promise<unknown>
  releaseNotices?(): Promise<unknown>
  /** G4: the signed-in person's own spend per day. */
  mySpendDays?(days: number): Promise<unknown>
  // settings
  settings?(): Promise<import('./types').HiveSettings>
  /** Current principal's Calendar-only connection; safe metadata, never OAuth tokens. */
  googleConnector?(): Promise<unknown>
  startGoogleConnector?(): Promise<unknown>
  disconnectGoogleConnector?(): Promise<unknown>
  setGoogleConnectorMind?(mind: string, allowed: boolean): Promise<unknown>
  /** Host admins only; the secret is write-only and never part of a status. */
  configureGoogleConnector?(clientId: string, clientSecret: string): Promise<unknown>
  rotatePassword?(): Promise<{ password: string; ended_password_sessions: number; note: string }>
  // sessions
  sessions?(): Promise<import('./types').WorkSession[]>
  createSession?(body: { mind: string; title: string; detail?: string; budget_usd: number }): Promise<import('./types').WorkSession>
  sessionTimeline?(id: string): Promise<{ session: import('./types').WorkSession; items: import('./types').SessionItem[] }>
  endSession?(id: string): Promise<import('./types').WorkSession>
  /** GET /api/budgets/limits (admins only): the Limits page's read model; ask-limits r1 adds minds[].ask_threads. Read
   *  as untrusted (features/ask/openThreads askThreadFigures). */
  budgetLimitsView?(): Promise<unknown>
  sessionWorkspaces?(id: string): Promise<{ workspaces: { id: string; repository_id: string; status?: string; base_commit?: string }[] }>
  invite?(body: { email: string; name?: string; role?: string; days?: number }): Promise<Invite & { link: string }>
  revokeInvite?(id: string): Promise<Invite>
  updatePerson?(id: string, body: { role?: string; disabled?: boolean }): Promise<Person>
  /** Unlinks the person's Google identity and signs them out everywhere (admins): PATCH {"clear_google_identity": true}. */
  clearGoogleIdentity?(id: string): Promise<Person>
  /** R2: everything running in the hive and its code (admins). */
  /** Harness invitations (hive/core/mcp.py). */
  createHarnessInvite?(body: { harness: string; name: string; swarm_id: string; role_id?: string | null; ttl_minutes?: number }): Promise<import('../features/harness/ConnectHarness').HarnessInvite>
  harnessInvite?(id: string): Promise<import('../features/harness/ConnectHarness').HarnessInvite>
  revokeHarnessInvite?(id: string): Promise<import('../features/harness/ConnectHarness').HarnessInvite>
  /** Roles (hive/core/roles.py). */
  listRoles?(): Promise<import('./types').Role[]>
  createRole?(body: Partial<import('./types').Role>): Promise<import('./types').Role>
  updateRole?(id: string, body: Partial<import('./types').Role>): Promise<import('./types').Role>
  duplicateRole?(id: string): Promise<import('./types').Role>
  removeRole?(id: string): Promise<{ ok: true; unassigned: number }>
  /** The boundary a mind's running process actually has (not what is configured). */
  agentIsolation?(agentId: string): Promise<import('./types').AgentIsolation>
  /** People's access to a goal's coding work; a grant names the workspace it joined, when known. */
  goalGrants?(goalId: string): Promise<import('./types').GoalGrant[]>
  /**
   * Revoke one collaborator grant on a goal (DELETE /api/goals/{goal}/grants/{grant}; hive/core/app.py:431 → services.py:199
   * at 60fa650). Admin session only (401 unauthorized, 403 admin_only); 404 not_found "no grant <id>" unless the grant is on
   * that goal; idempotent (an already revoked grant comes back unchanged). The hive also withdraws every capability issued
   * under the grant. Returns the grant as it now stands.
   */
  revokeGoalGrant?(goalId: string, grantId: string): Promise<import('./types').GoalGrant>
  /** Cross-swarm requests, newest first (hive/core/collab.py). */
  listConnections?(swarmId: string): Promise<import('./types').ConnectionAgreement[]>
  createConnection?(body: import('./types').CreateRequestConnection): Promise<import('./types').ConnectionAgreement>
  /** `reason` is sent on revoke only: the host records it in the connection's history (app.py:2615, connections.py revoke). */
  connectionAction?(id: string, action: import('./types').ConnectionAction, days?: number, reason?: string): Promise<import('./types').ConnectionAgreement>
  listRequests?(): Promise<import('./types').CollabRequest[]>
  /** The request's new state arrives as request.updated. */
  cancelRequest?(id: string): Promise<{ cancelled: unknown; by: string }>
  codeTargets?(): Promise<import('../features/code/CodePage').Target[]>
  codeAttach?(task: string, workspace: string, repository: string): Promise<import('../features/code/CodePage').Opened>
  codeTree?(target: string): Promise<{ target: string; commit: string; subdir: string; files: string[]; truncated: boolean }>
  codeSelect?(task: string, repository: string): Promise<import('../features/code/CodePage').Opened>
  codeOpen?(target: string): Promise<{ target: import('../features/code/CodePage').Target; task_id: string; swarm_id: string; grant_id: string; repository_id: string; base_commit: string }>
  /** Relayed by the hive to OmegaCode with a short-lived capability; the browser never talks to the service. */
  codeProxy?<T>(method: 'GET' | 'POST', path: string, ctx: Record<string, string>, body?: unknown): Promise<T>
  /**
   * Retained scoped suggestions (WorkbenchSuggestionPanel), relayed through the same authenticated codeProxy path.
   * Contract: coordination/omegacode/SCOPED_SUGGESTIONS_IMPLEMENTATION.md + SUGGESTION_HISTORY_IMPLEMENTATION.md.
   * Relayed live since next7 (60fa650): hive/core/code.py PROXY_ROUTES lists the nine Workbench routes (the four
   * run-result routes are held). The panel decides availability from the real answer: a hive that does not relay a
   * route answers 404 not_relayed and the panel says so. Responses are parsed strictly by the panel.
   */
  codeSuggestionScope?(ctx: CodeContext, workspaceId: string, body: import('../features/code/suggestions/contract').SuggestionScopeRequest): Promise<unknown>
  codeSuggestionCreate?(ctx: CodeContext, workspaceId: string, body: import('../features/code/suggestions/contract').SuggestionCreateRequest): Promise<unknown>
  codeSuggestionHistory?(ctx: CodeContext, workspaceId: string, page?: { limit?: number; cursor?: string }): Promise<unknown>
  codeSuggestionRead?(ctx: CodeContext, workspaceId: string, suggestionId: string): Promise<unknown>
  codeSuggestionDecide?(ctx: CodeContext, workspaceId: string, body: import('../features/code/suggestions/contract').SuggestionDecisionRequest): Promise<unknown>
  /**
   * SIM ONLY. No hive or service route carries a person's instruction to a mind yet; in the sim an invented mind turns
   * the instruction into hunks and files them with the agent `suggestion-create` action. Absent on the live client.
   */
  codeSuggestionAsk?(ctx: CodeContext, workspaceId: string, body: { scope_id: string; instruction: string }): Promise<unknown>
  /**
   * The Ask's linkage intents (spec r3.6 §(a); host release main 39c0731, app.py:1495-1532). The Code canvas's vibe
   * requests go ONLY through these: record one intent on the person's Ask turn, then submit it (team controller →
   * suggest-only child → retained proposal). Answers are untrusted here and read strictly by api/askIntents.
   */
  askRecordIntent?(operationId: string, body: import('./askIntents').IntentRecordBody): Promise<unknown>
  askSubmitIntent?(intentId: string): Promise<unknown>
  // ---- J3 r4.3 O3: Platform's PROPOSED live Studio session routes (host plan §3.2–§3.3). NOT ON LIVE YET; the page uses
  // them only when the host says `capabilities.studio_sessions` (features/studioLive/api.ts studioCapable).
  /** POST /api/ask/{op}/intents {kind:"studio.session", request} (G1 record; creates nothing else). Submit: askSubmitIntent. */
  studioRecordIntent?(operationId: string, body: { kind: 'studio.session'; request: import('../features/studioLive/api').StudioSessionRequest }): Promise<unknown>
  /** GET /api/studio-sessions/{sid}: the person's ledger. */
  studioSession?(sessionId: string): Promise<unknown>
  /** PUT /api/studio-sessions/{sid}/piece {seq, body, scene_ref}: the frame's opaque current piece (seq CAS). */
  studioPiece?(sessionId: string, body: import('../features/studioLive/api').PieceBody): Promise<unknown>
  /** POST /api/studio-sessions/{sid}/steps/{n}/outcome: the frame-reported terminal outcome, bound to its acknowledged upload. */
  studioOutcome?(sessionId: string, n: number, body: import('../features/studioLive/api').OutcomeBody): Promise<unknown>
  /** POST /api/studio-sessions/{sid}/controls {control_id, action}: pause | resume | stop, idempotent per control_id. */
  studioControl?(sessionId: string, body: import('../features/studioLive/api').ControlBody): Promise<unknown>
  /** host plan r1.2 E3: POST/heartbeat/DELETE /api/studio-sessions/{sid}/mount (compare-and-swap on expected_epoch). */
  studioMount?(sessionId: string, body: import('../features/studioLive/api').MountBody): Promise<unknown>
  studioMountHeartbeat?(sessionId: string, body: import('../features/studioLive/api').MountWire): Promise<unknown>
  studioUnmount?(sessionId: string, body: { mount_token: string }): Promise<unknown>
  /** host R3: GET …/mount?attempt_id= reads a lost mount answer back (the token only if that attempt won and is current). */
  studioMountReadback?(sessionId: string, attemptId: string): Promise<unknown>
  /** SIM ONLY: what an Ask turn would have prepared for the Studio setup card (the live source is not pinned yet). */
  studioSetupProposal?(programId: string, swarmId: string, prep?: import('../features/studioLive/api').SetupPrep): Promise<unknown>
  /** r1.13 (host R7): POST /api/studio/setup {}: the person's own maker and its Studio space */
  studioMaker?(): Promise<unknown>
  askIntent?(intentId: string): Promise<unknown>
  askIntents?(q?: { state?: import('./askIntents').IntentState; limit?: number }): Promise<unknown>
  /**
   * The Code team that would take a person's code request here: the one visible swarm offering `code` with a
   * coordinator, and its registered mind templates (live: GET /api/teams/{swarm_id}/templates, release 37e606f).
   * SIM: an invented team.
   */
  codeTeamOffer?(ctx: CodeContext): Promise<import('./askIntents').CodeTeamOffer>
  /**
   * GET /api/teams/{swarm_id}/children (minds.py team_children): the team's children, a page at a time, each with its
   * request_id and state. The vibe canvas reads it to see whether a mind was started for its request.
   */
  teamChildren?(swarmId: string, cursor?: string): Promise<unknown>
  /**
   * Copy-apply consent (Platform 66312cd): the request's own named person accepts or declines one exact proposal digest.
   * POST /api/requests/{request_id}/proposals/{suggestion_id}/{accept|decline} {suggestion_digest}. Read strictly by
   * features/code/canvas/vibeConsent.
   */
  proposalConsent?(requestId: string, suggestionId: string, decision: 'accept' | 'decline', suggestionDigest: string): Promise<unknown>
  /** SIM ONLY fixture controls for qualification cases (another actor edits, issuer revoked, answer lost). */
  codeSimFixture?(action: SimCodeFixture): Promise<string>

  // --- Surface: minds-side (shares, inventory, portable, health mind)
  /** Memory shares between minds, newest first (every status; the record stays after a share closes). */
  listShares?(opts?: { agent_id?: string; status?: string }): Promise<import('../features/minds/types').Share[]>
  /** Every read of one share, newest first. */
  shareReads?(shareId: string): Promise<import('../features/minds/types').ShareRead[]>
  /** Ends an open share or withdraws a request at once; the reader is told. */
  revokeShare?(shareId: string): Promise<import('../features/minds/types').Share>
  /** S4: what the mind's last boot receipt says it can call (its owner or an admin). */
  agentInventory?(agentId: string): Promise<import('../features/minds/types').MindInventory>
  agentInventoryActivity?(agentId: string, cycles?: number): Promise<import('../features/minds/types').MindActivity>
  agentHealth?(agentId: string): Promise<import('../features/minds/types').MindHealthDetail>
  /** R8: the mind told of every health alert (admins change it). */
  healthMind?(): Promise<import('../features/minds/types').HealthMindSetting>
  setHealthMind?(agentId: string | null): Promise<import('../features/minds/types').HealthMindSetting>
  /** Portable minds (hive/core/placement.py). */
  hiveIdentity?(): Promise<import('../features/minds/types').HiveIdentity>
  /** Admins: rename this hive as other hives see it, or mark it home or cloud. */
  setHiveIdentity?(body: { name?: string; home?: boolean }): Promise<import('../features/minds/types').HiveIdentity>
  exportMind?(agentId: string): Promise<import('../features/minds/types').MindExport>
  importMind?(bundle: Blob, swarmId?: string): Promise<import('../features/minds/types').MindImportResult>
  settleMind?(agentId: string, body: { to_hive: string; to_name: string; manifest_sha256: string }): Promise<Agent>
  mindMoves?(agentId: string): Promise<import('../features/minds/types').MindMove[]>
  convertNative?(agentId: string): Promise<Agent>

  // --- Surface: money/work/apps (reservations, artifacts, assets, services, app activity)
  /** Calls whose cost is held (admins). A person settles an unknown-outcome call; nothing else does. */
  listReservations?(): Promise<import('./moneyWork').CostReservation[]>
  listOverruns?(): Promise<import('./moneyWork').CostOverrun[]>
  resolveReservation?(id: string, body: import('./moneyWork').ResolveBody): Promise<import('./moneyWork').ResolvedReservation>
  /** What minds and apps produced, across the hive (composed from requests, flows, exhibits and app actions). */
  hiveArtifacts?(): Promise<import('./moneyWork').ArtifactList>
  /** Candidate (Studio picker): this swarm's artifacts at their latest exact revision, metadata only, for a viewer who sees it. */
  swarmArtifacts?(swarmId: string, opts?: { kind?: string; limit?: number }): Promise<import('./moneyWork').SwarmArtifact[]>
  assetStores?(): Promise<import('./moneyWork').AssetStore[]>
  listAssets?(swarmId?: string): Promise<import('./moneyWork').Asset[]>
  uploadAsset?(file: Blob, opts: import('./moneyWork').UploadAssetOptions): Promise<import('./moneyWork').Asset>
  /** The file's bytes, checked against its hash by the hive. */
  assetBlob?(sha: string): Promise<Blob>
  /** lab-figures r1: a recorded report's figure bytes, from its host-relative `read_url`, with the session in the
   *  Authorization header only (never in a URL). 401/404 and network failures reject with ApiError. */
  figureBlob?(readUrl: string): Promise<Blob>
  transferAsset?(sha: string, to: string, move: boolean): Promise<import('./moneyWork').Asset>
  swarmServices?(swarmId: string): Promise<import('./moneyWork').SwarmServices>
  setSwarmServices?(swarmId: string, body: { kinds: string[]; connection_only_kinds: string[] }): Promise<import('./moneyWork').SwarmServices>
  registeredServices?(): Promise<import('./moneyWork').RegisteredService[]>
  setServiceEnabled?(id: string, enabled: boolean): Promise<import('./moneyWork').RegisteredService>
  removeService?(id: string): Promise<{ ok: true }>
  programActivations?(programId: string): Promise<import('./moneyWork').AppActivation[]>
  activateProgram?(programId: string, swarmId: string): Promise<import('./moneyWork').AppActivation>
  deactivateProgram?(programId: string, swarmId: string): Promise<import('./moneyWork').AppActivation>
  programAttachments?(programId: string): Promise<import('./moneyWork').AppAttachment[]>
  offerProgram?(programId: string, mindId: string): Promise<import('./moneyWork').AppOffer>
  attachProgram?(programId: string, body: import('./moneyWork').AttachBody): Promise<import('./moneyWork').AppAttachment>
  detachProgram?(programId: string, attachmentId: string): Promise<import('./moneyWork').AppAttachment>
  programActivity?(opts?: { swarm_id?: string; program?: string; limit?: number }): Promise<import('./moneyWork').AppActivityRow[]>

  // --- Surface: studio slice 2 (drafts, asset bytes)
  /** Candidate (platform/next8): the signed-in person's private drafts for an app in a swarm (see api/appDrafts.ts).
   *  A 409 is a DraftConflictError carrying `current_revision`. Asset bytes for app frames use assetBlob. */
  putAppDraft?(programId: string, draftKey: string, body: import('./appDrafts').AppDraftPut): Promise<import('./appDrafts').AppDraftSaved>
  listAppDrafts?(programId: string, swarmId: string): Promise<{ drafts: import('./appDrafts').AppDraftSummary[] }>
  getAppDraft?(programId: string, draftKey: string, swarmId: string): Promise<import('./appDrafts').AppDraft>
  deleteAppDraft?(programId: string, draftKey: string, swarmId: string): Promise<unknown>

  getHive(): Promise<HiveInfo>
  getModels(): Promise<ModelOption[]>

  /** Archived swarms are left out unless `archived` (admins only: a member is refused). */
  listSwarms(opts?: { archived?: boolean }): Promise<Swarm[]>
  createSwarm(body: CreateSwarmBody): Promise<Swarm>
  /** Who can see a mind or swarm: its owner or an admin changes it. */
  setAgentVisibility?(id: string, body: { visibility?: import('./types').Visibility; shared_with?: string[] }): Promise<Agent>
  setSwarmVisibility?(id: string, body: { visibility?: import('./types').Visibility; shared_with?: string[] }): Promise<Swarm>
  getSwarm(id: string): Promise<Swarm>
  /** Admins: name, description, coordinator (a member), parent mind (a mind in another swarm; no cycles, at most four deep). */
  updateSwarm?(id: string, body: import('./types').UpdateSwarmBody): Promise<Swarm>
  /** Admins: only an empty swarm (no minds, goals, artifacts or child swarms); 409 swarm_not_empty otherwise. */
  deleteSwarm?(id: string): Promise<{ deleted: string }>
  /**
   * Admins (host swarm-delete r3): delete a swarm together with its minds, behind its exact name. DELETE /api/swarms/{id}
   * with {with_minds: true, confirm}. Refusals: 400 confirm_mismatch (`expected`), 409 swarm_busy, 409 minds_unstoppable.
   */
  deleteSwarmWithMinds?(id: string, confirm: string): Promise<SwarmDeleteResult>
  /** Admins: GET /api/swarms/{id}/delete-preview, what that delete would do now; writes nothing (advisory only). */
  deleteSwarmPreview?(id: string): Promise<SwarmDeletePreview>
  /** Admins: put a swarm away and bring it back (404 on hives that do not archive yet). */
  archiveSwarm?(id: string): Promise<Swarm>
  restoreSwarm?(id: string): Promise<Swarm>
  listBeliefs(swarmId: string): Promise<Belief[]>
  getBeliefDetail(swarmId: string, statement: string): Promise<BeliefDetail>
  getVocab(swarmId: string): Promise<string[]>
  addVocab(swarmId: string, terms: string[]): Promise<string[]>

  listAgents(): Promise<Agent[]>
  createAgent(body: CreateAgentBody): Promise<CreatedAgent>
  getAgent(id: string): Promise<Agent>
  patchAgent(id: string, body: PatchAgentBody): Promise<Agent>
  deleteAgent(id: string): Promise<{ ok: true }>
  agentAction(id: string, action: AgentAction): Promise<Agent>
  listMessages(id: string, opts?: { conversation_id?: string; limit?: number }): Promise<Message[]>
  sendMessage(id: string, body: { text: string; conversation_id?: string }): Promise<Message>
  getLogs(id: string, tail?: number): Promise<{ lines: string[] }>

  listUsage(opts?: { agent_id?: string; since?: string }): Promise<Usage[]>

  // ---- Phase 2 ----
  listPolicy(): Promise<PolicyRule[]>
  createPolicy(body: CreatePolicyBody): Promise<PolicyRule>
  /** Coordinator-run lifecycle (hive/core/delegation.py): a signed-in admin person delegates and issues leases. */
  listDelegations?(): Promise<{ coordinator_id: string; specialist_id: string; created_by: string; created_at: string }[]>
  setDelegation?(coordinatorId: string, specialistIds: string[]): Promise<unknown>
  issueLease?(body: { coordinator: string; specialist: string; task: string; seconds: number; budget_usd: number }): Promise<{ lease: string; coordinator: string; specialist: string; task: string }>
  deletePolicy(id: string): Promise<{ ok: true }>
  /** Newest first. */
  listApprovals(status?: ApprovalStatus): Promise<Approval[]>
  /** `remember` also adds an `allow` rule for this agent and skill. */
  approve(id: string, remember?: boolean): Promise<Approval>
  deny(id: string): Promise<Approval>
  /** Once, For a time (minutes), Always, No or Never. */
  answerApproval?(id: string, decision: 'once' | 'for' | 'always' | 'no' | 'never', minutes?: number): Promise<Approval>
  /** How people answered this mind and skill before: a count and the NAL-revised belief (hive/core/governance_evidence.py). */
  approvalTrackRecord?(id: string): Promise<{ answers: number; positive: number; tv: { f: number; c: number } | null }>
  listAsks?(): Promise<PersonAsk[]>
  createAsk?(body: { kind: PersonAsk['kind']; payload: Record<string, unknown>; note?: string }): Promise<PersonAsk>
  answerAsk?(id: string, decision: 'once' | 'for' | 'always' | 'no' | 'never', minutes?: number): Promise<PersonAsk>
  listGoals(swarmId: string): Promise<Goal[]>
  createGoal(swarmId: string, body: CreateGoalBody): Promise<Goal>
  patchGoal(id: string, body: PatchGoalBody): Promise<Goal>
  /** R17: a named person accepts submitted work (done) or returns it with notes. */
  reviewGoal?(id: string, decision: 'accept' | 'return', notes?: string): Promise<Goal>
  /** One goal in full: the list row plus `review_by` (who must accept its result) and its validator. */
  getGoal?(id: string): Promise<Goal>
  /** R17 review history of one goal, oldest first: each submit, accept and return, with notes. */
  goalReviews?(id: string): Promise<import('./types').GoalReview[]>
  // ---- Motivations above Tasks (host phase 1: hive/API.md "Motivations and the Tasks query")
  /** GET /api/motivations: the motivations this viewer can read, newest first, keyset-paged. */
  listMotivations?(q?: { owner?: string; swarm?: string; status?: string; cursor?: string; limit?: number }): Promise<import('./types').MotivationList>
  /** GET /api/motivations/{id}; a hidden id answers exactly as a missing one (404). */
  getMotivation?(id: string): Promise<import('./types').Motivation>
  createMotivation?(body: import('./types').CreateMotivationBody): Promise<import('./types').Motivation>
  /** PATCH /api/motivations/{id} {title?, why?, status?, expected_rev}; 409 motivation_changed on a stale rev. */
  patchMotivation?(id: string, body: import('./types').PatchMotivationBody): Promise<import('./types').Motivation>
  setMotivationVisibility?(id: string, body: { visibility?: import('./types').Visibility; shared_with?: string[]; expected_rev: number }): Promise<import('./types').Motivation>
  /** POST /api/motivations/{id}/links: link, unlink or move tasks in one transaction, idempotent on operation_id. */
  linkMotivation?(id: string, body: import('./types').MotivationLinkBody): Promise<import('./types').MotivationLinkResult>
  /** GET /api/tasks: one filter for items and counts; cursors are opaque and bound to the filter. */
  listTasks?(q?: import('./types').TaskQuery): Promise<import('./types').TaskList>
  /** Newest first. */
  listTraces(agentId: string, limit?: number): Promise<Trace[]>
  traceArchive?(agentId: string): Promise<import('./types').TraceArchiveIndex>
  archivedTraces?(agentId: string, day: string, limit: number, offset: number): Promise<Trace[]>
  listWakeups(agentId: string): Promise<Wakeup[]>
  createWakeup(agentId: string, body: CreateWakeupBody): Promise<Wakeup>
  patchWakeup(id: string, body: PatchWakeupBody): Promise<Wakeup>
  deleteWakeup(id: string): Promise<{ ok: true }>
  listMemory(agentId: string): Promise<MemorySpace[]>
  listAtoms(agentId: string, space: string, opts?: { q?: string; limit?: number }): Promise<MemoryAtom[]>
  /** Queued: the agent removes the atom on its next loop. */
  retireAtom(agentId: string, space: string, atom: string): Promise<{ queued: true }>
  resetMemory(agentId: string): Promise<{ queued: true }>
  /** Global kill switch. */
  stopAll(): Promise<{ stopped: number }>
  /** Hive power (Off, Quiet and Wake all; features/power/api.ts owns the shapes): GET /api/hive/power. Open while off. */
  getPower?(): Promise<unknown>
  /** POST /api/hive/power {state, operation_id}: admin only, idempotent on operation_id. Open while off. */
  setPower?(body: import('../features/power/api').PowerBody): Promise<unknown>

  // ---- Lab ----
  listLabSuites(): Promise<LabSuite[]>
  /** Newest first. */
  listLabRuns(opts?: { suite?: string; limit?: number }): Promise<LabRunSummary[]>
  /** 409 already_running, 400 missing_requirements. */
  startLabRun(suite: string): Promise<LabRun>
  getLabRun(id: string): Promise<LabRun>
  cancelLabRun(id: string): Promise<{ cancelling: true }>
  getLabHistory(suite: string, limit?: number): Promise<LabHistory>
  /** Health per dimension from the latest finished run of every suite. */
  getLabScorecard(): Promise<LabScorecardEntry[]>

  // ---- Hive programs (PROGRAMS.md) ----
  programs(): Promise<Program[]>
  program(id: string): Promise<ProgramDetail>
  /** Swarms where this app works, best first (configured, activated, opened before). */
  /** An app's own pinned interface files (index.html, app.js, style.css). */
  programUi?(id: string): Promise<import('./types').ProgramUiBundle>
  /** P1: authenticated parent-only routes. The opaque app frame receives no credential or consent-card reference. */
  /** P12/P13 parent-only; no bearer/card/pass crosses into a frame. */
  appLinkFrame?(app: string, body: { swarm_id: string; frame_slot_id: string; entry_id?: string }): Promise<unknown>
  appLinkClose?(app: string, frame: string, body: { handoff?: string }): Promise<unknown>
  appLinkPrepare?(app: string, frame: string, body: { type: 'app-setup' | 'app-open'; app: string }): Promise<unknown>
  appLinkInspect?(app: string, frame: string, review: string): Promise<unknown>
  appLinkDecide?(app: string, frame: string, review: string, body: { approve: boolean; open_now: boolean }): Promise<unknown>
  appLinkEntryCard?(entry: string): Promise<unknown>
  appLinkCheck?(entry: string, body: { frame_id: string }): Promise<unknown>
  appLinkPresentation?(entry: string, consume?: boolean): Promise<unknown>
  appLinkCheckFrame?(app: string, frame: string): Promise<unknown>
  appLinkRedeem?(entry: string, body: { release_digest: string; frame_slot_id: string }): Promise<unknown>
  programAskCard?(app: string): Promise<unknown>
  programAskConsent?(app: string, body: { card_id: string }): Promise<unknown>
  programAskRevoke?(app: string): Promise<unknown>
  programAskFrame?(app: string, body: { release_digest: string; frame_slot_id: string; initial_operation_id?: string }): Promise<unknown>
  programAskPresence?(app: string, generation: string): Promise<unknown>
  programAskClose?(app: string, generation: string): Promise<unknown>
  programAskOp?(app: string, generation: string, body: import('./appAsk').AppAskOp): Promise<unknown>
  askPresentation?(operation: string): Promise<unknown>
  askClaim?(operation: string, body: { expected_epoch: number }): Promise<unknown>
  askHandover?(operation: string, body: { generation_id: string; expected_epoch: number }): Promise<unknown>
  /** P1 stamped host acts: claim once before any screen effect. Unknown/refused claims never execute or retry. */
  askActClaim?(operation: string, act: string, body: { owner_epoch: number }): Promise<unknown>
  /** r2.8: may this viewer subscribe an app frame to this artifact? Resolves for an artifact of that swarm they can see. */
  artifactSubscription?(swarmId: string, artifactId: string): Promise<{ artifact_id: string; swarm_id: string }>
  programHomes?(id: string): Promise<{ program: string; homes: { swarm_id: string; why: string }[] }>
  /** Always a full snapshot, validated by the hive. */
  programView(id: string, body: ProgramViewBody): Promise<WorkGraph>
  programAct(id: string, body: ProgramActBody): Promise<ActionResult>
  /** Host person-act transport only; advisory header stays out of the JSON result and the frame. */
  hostProgramAct?(id: string, body: ProgramActBody): Promise<{ result: ActionResult; personSwarmConsentRequired: boolean }>
  /** P14: open a person app in the person's own context (POST /api/programs/{id}/person-context); read by api/personApps. */
  openPersonApp?(program: string): Promise<unknown>
  /** P14: "Set up again", the host's one action out of an unusable space. */
  resetPersonApp?(program: string): Promise<unknown>
  /** P14: install is the review (named admins); members see only the placement and whether it is installed. */
  programInstall?(program: string): Promise<import('./personApps').AppInstallStatus>
  installProgram?(program: string, body: import('./personApps').AppInstallBody): Promise<import('./personApps').AppInstallStatus>
  appSwarmCard?(program: string, template: string): Promise<import('./personSwarms').PersonSwarmCard>
  consentAppSwarm?(program: string, template: string, shown: import('./personSwarms').PersonSwarmShown): Promise<import('./personSwarms').PersonSwarmCard>
  /** §9d: POST /api/programs/{id}/confirm {swarm_id, action, payload, payload_digest} → a confirm token, for a person
   *  session only. Called by the host only after the person confirmed the act in its own DecisionDialog
   *  (lib/hostConfirm.ts). The hive recomputes the digest from `payload` (400 confirm_digest_mismatch otherwise). */
  confirmAct?(id: string, swarmId: string, action: string, payload: import('../lib/confirmDigest').ConfirmPayload, payloadDigest: string): Promise<import('./types').ConfirmToken>
  /** Candidate (G1, PROGRAMS.md §9c): POST /api/programs/{id}/read {swarm_id, query, params?} → {program, query, result}.
   *  404 unknown_read, 403 program_refused, 413 read_too_large, 400 bad_request. The wire shape lives in lib/frameOps.ts. */
  programRead?(id: string, swarmId: string, query: string, params: Record<string, unknown> | null): Promise<import('./types').ProgramReadResult>
  programEnable(id: string): Promise<Program>
  programDisable(id: string): Promise<Program>
  programsReload(): Promise<Program[]>

  // ---- Providers: keys, the OpenRouter catalogue, routing (hive/core/providers.py) ----
  listProviders(): Promise<ProviderStatus[]>
  /** Also refreshes the account details (credits) for that provider. */
  getProvider(name: string): Promise<ProviderStatus>
  /** The key is verified upstream and stored in the hive; 401 bad_key, 502 provider_unreachable. */
  setProviderKey(name: string, key: string): Promise<ProviderStatus>
  removeProviderKey(name: string): Promise<ProviderStatus>
  openrouterCatalog(refresh?: boolean): Promise<Catalog>
  openrouterEndpoints(modelId: string): Promise<ModelEndpoint[]>
  /** The keyring: many keys per provider, each paying for the minds assigned to it. */
  listKeys(): Promise<KeyInfo[]>
  addKey(body: { provider: string; key: string; label?: string; default?: boolean }): Promise<KeyInfo>
  updateKey(id: string, body: { label?: string; default?: boolean }): Promise<KeyInfo>
  refreshKey(id: string): Promise<KeyInfo>
  /** Minds assigned to it fall back to the provider default. */
  removeKey(id: string): Promise<{ ok: true; unassigned: number }>

  // ---- Surface universal Ask (UNIVERSAL_ASK_HOST_CONTRACT_DRAFT_20261005 and the built host, platform/ask-p1 6100794).
  // askConfirm is ahead of the live client (phase 2): only the sim implements it.
  /** POST /api/ask: one turn to the swarm's orchestrator. The answer arrives as `ask` events on /api/events. */
  ask?(body: import('./ask').AskBody): Promise<import('./ask').AskAccepted>
  /** GET /api/ask/{operation_id}?after=&limit=: the turn view and its frames after `after` (gap recovery; paged by `more`). */
  askTurn?(operationId: string, after?: number): Promise<import('./ask').AskTurnState>
  /** POST /api/ask/{operation_id}/stop: close the turn (the mind's later reply stays in the room). */
  askStop?(operationId: string): Promise<unknown>
  /** POST /api/ask/{operation_id}/proposals/{proposal_id}/confirm {digest}: the person confirmed exactly what was shown. */
  askConfirm?(operationId: string, proposalId: string, digest: string): Promise<{ ok: boolean; outcome?: string }>
  /** GET/PUT /api/me/ask: the default swarm (its coordinator answers), a new thread's limit and the eligible swarms. */
  askSettings?(): Promise<import('./ask').AskSettings>
  setAskSettings?(body: import('./ask').AskSettingsPut): Promise<import('./ask').AskSettings>
  /** GET /api/me/mind (Platform P1/P2): {mind} or {mind: null}; 404 on a host without it. Read with api/personalMind readPersonalMind (the #/me/mind page) or api/ask readMyMind (who answers the Ask). */
  myMind?(): Promise<unknown>
  // ---- First Light R2 (Platform R1a + own hive H1, live 81c8b9d): features/firstlight/host.ts reads every answer
  /** GET /api/me/onboarding: the person's progress record (versioned). */
  onboarding?(): Promise<unknown>
  /** PATCH /api/me/onboarding: only the fields given; `version` refuses a stale write (409 stale_onboarding + current). */
  patchOnboarding?(body: Record<string, unknown>): Promise<unknown>
  /** GET /api/me/setup: the person's setup list (monthly_limit carries `enforced`). */
  mySetup?(): Promise<unknown>
  /** GET /api/hive/own: whose hive, and how the person is in it. */
  hiveOwn?(): Promise<unknown>
  /** GET /api/me/key-limits: the caller's own keys, their own limits (`own`, grantee self) and grants. r1.14b */
  myKeyLimits?(): Promise<unknown>
  /** PUT /api/me/key-limits/self: the person's own monthly limit on their own keys. */
  setOwnKeyLimit?(body: Record<string, unknown>): Promise<unknown>
  /** POST /api/me/limit-requests: ask a key owner (a guest: their host) for a monthly limit. */
  askForLimit?(body: Record<string, unknown>): Promise<unknown>
  /** GET (wake false: never wakes) or POST (wake true: the person pressed Wake) /api/me/personal-mind/hello. */
  personalMindHello?(wake: boolean): Promise<unknown>
  /** "New thread": the Ask thread is a Session, so it ends like one (POST /api/sessions/{id}/end). */
  askEndThread?(threadId: string): Promise<unknown>
  /** "Delete this thread" (the owner, 2026-10-05: kept like rooms, with a person-visible delete): DELETE /api/ask/threads/{id},
   *  owner only (built in platform/ask-p1 6100794; the text is stripped, the turn rows stay for the audit). */
  askDeleteThread?(threadId: string): Promise<unknown>
  /** The person took over the page mid-turn (the owner, 2026-10-05): POST /api/ask/{operation_id}/takeover
   *  {reason: "user_took_over"}; the host ends the conductor turn at once, so no further act or spend follows. */
  askTakeover?(operationId: string): Promise<import('./ask').AskTakeover>
  /** POST /api/ask/{operation_id}/steer {steer_id, text, at_seq} (Platform phase 1.1): words mid-turn. A closed turn
   *  answers with a NEW operation_id: the words became a fresh request. */
  askSteer?(operationId: string, body: import('./ask').AskSteerBody): Promise<import('./ask').AskSteerResult>
  /** POST /api/ask/{operation_id}/acts/{act_id}/result (conductor vocabulary v1 §2, confirmed by Platform): what a
   *  conductor act did and the page view after it. Turn owner only (404 otherwise); once per act (409 on a repeat). */
  askActResult?(operationId: string, actId: string, body: import('./ask').ActResult): Promise<unknown>

  /**
   * Workbench Map (PLATFORM_REPO_MAP_SLICE_A_CONTRACT_R1 §3): one read-only request to a `/api/repo-maps…` route, as the
   * signed-in member. Only api/repoMap.ts builds the path and reads the answer (untrusted); the admin loader is never
   * called from here. Rejects with ApiError carrying the hive's envelope code (not_found, cursor_expired, …).
   */
  repoMapRequest?(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown>

  // ---- Surface personal mind r1 (Platform P1 308727d/0dbd550; P3/P4 versions to come): api/personalMind.ts readers
  /** POST /api/me/mind {name}: rename the person's own mind (or make it if missing). */
  renameMyMind?(name: string): Promise<unknown>
  /** GET /api/me/mind/inbox?after=&limit= (≤ 50): the person's swarm conversations the hive holds until collected. */
  myMindInbox?(after: string | null, limit: number): Promise<unknown>
  /** POST /api/me/mind/inbox/ack {ids}: the hive deletes them; sent only after this browser durably kept them. */
  myMindInboxAck?(ids: string[]): Promise<unknown>
  /** GET /api/me/mind/versions (P3/P4; 404 until then): the current version, the benchmark's best and candidates. */
  myMindVersions?(): Promise<unknown>
  /** POST /api/me/mind/adopt {version_id}: switch the person's mind to that version (one click, behind a confirm). */
  adoptMyMindVersion?(versionId: string): Promise<unknown>
  /** POST /api/me/mind/rollback: back to the version before. */
  rollbackMyMind?(): Promise<unknown>

  // ---- Surface missing-UI batch 1 (UI_BACKEND_PARITY_AUDIT_20261007): host routes that had no screen; api/missingUi.ts
  /** GET /api/ask?limit= (≤ 200, no cursor): my own Ask turns as the hive keeps them, newest first. */
  askHistory?(limit?: number): Promise<import('./missingUi').AskTurnRecord[]>
  /** GET /api/ask/audit?limit=&principal=&before= (admins): every person's Ask turns, newest first. */
  askAudit?(opts?: { limit?: number; principal?: string; before?: string }): Promise<import('./missingUi').AskAuditRow[]>
  /** GET /api/ask/audit/{turn}?after= (admins): one turn and its frames. */
  askAuditTurn?(turnId: string, after?: number): Promise<import('./missingUi').AskAuditTurn>
  /** GET /api/goals/{id}/attempts: every submitted result on a goal with a result schema, verbatim, valid or not. */
  goalAttempts?(goalId: string): Promise<import('./missingUi').GoalAttempt[]>
  /** POST /api/goals/{id}/grants (admins): give a person code access on a goal. */
  addGoalGrant?(goalId: string, body: import('./missingUi').AddGoalGrantBody): Promise<import('./types').GoalGrant>
  /** POST /api/programs/{id}/grants/revoke: the app's owner (or the hive's own machine) pauses its host-managed access. */
  revokeProgramGrants?(programId: string): Promise<import('./missingUi').ProgramGrantsRevoked>
  /** POST /api/programs/{id}/grants/restore: the app's owner only; takes effect at the next restart. */
  restoreProgramGrants?(programId: string): Promise<import('./missingUi').ProgramGrantsRestored>
  /** POST /api/updates/requests (admins): ask for an update, with a note and receipts. */
  requestUpdate?(body: import('./missingUi').UpdateRequestBody): Promise<import('./missingUi').UpdateRequestRecord>
  /** GET /api/harness-invites (admins): outside-agent invitations, newest first (≤ 200). */
  harnessInvites?(): Promise<import('./missingUi').HarnessInviteRow[]>
  /** GET /api/match/catalogue?scope= : what other swarms (and apps) advertise to my swarm. */
  capabilityCatalogue?(scope: string): Promise<import('./missingUi').CapabilityCatalogue>
  /** GET /api/swarms/{id}/flows: a swarm's flows with their latest revision. */
  flowList?(swarmId: string): Promise<import('./missingUi').FlowListRow[]>
  /** GET /api/flows/{id}/revisions/{n}: one revision, with its adoption (or null). */
  flowRevision?(artifactId: string, n: number): Promise<import('./missingUi').FlowRevisionRead>
  /** DELETE /api/flows/{id}/revisions/{n}/adoption: take an adoption back (a named owner or admin). */
  unadoptFlow?(artifactId: string, n: number): Promise<{ revoked: boolean }>
  /** PUT /api/explore/groups/{id} {name}: rename one of my groups. */
  renameExploreGroup?(id: string, name: string): Promise<import('./types').ExploreGroupDef>
  /** DELETE /api/explore/groups/{id}: delete one of my groups (its members stay as they are). */
  deleteExploreGroup?(id: string): Promise<import('./missingUi').ExploreGroupDeleted>
  /** POST /api/assets/{sha}/cleanup (admins): retry removing a this-machine-only file's copies from other stores. */
  cleanupAsset?(sha: string): Promise<import('./moneyWork').Asset>

  /** Open the live event stream. Safe to call more than once. */
  connect(): void
  disconnect(): void
  subscribe(listener: EventListener): () => void
  onConnection(listener: ConnectionListener): () => void
}

export interface AuthMethods {
  password: boolean
  public: boolean
  sso: { enabled: boolean; provider: string; login_url: string | null; invite_login_url?: string | null; invites?: boolean }
  /** J1b: a local-owner hive (the installer's): its events socket signs in with its first frame, never ?token= */
  local_owner?: boolean
}

export interface Me {
  /** Proposed host attribution reference; absence closes session-bound readers. Not authority. */
  auth_session_ref?: string
  principal: string
  kind: 'password' | 'sso'
  role: 'admin' | 'member' | null
  expires_at: number | null
  person: { id: string; email: string | null; name: string } | null
  /** Candidate (platform/next8; Surface studio slice 2): a named person, or the hive's operator session. */
  person_kind?: 'person' | 'operator'
  /** Candidate (platform/next8): signed in with the operator password on the hive's own machine. */
  local_operator?: boolean
  /** How this session signed in (host, J1b): the installer's local sign-in is not Google, though its kind is 'sso' */
  signin?: 'local_install' | 'google' | 'password'
}
/** What a swarm still holds (409 swarm_not_empty's `counts`; host words: `goals` are tasks). */
export interface SwarmCounts {
  minds: number
  /** external module agents: never deleted with the swarm; they keep it archived */
  members: number
  goals: number
  artifacts: number
  child_swarms: number
}
/** GET /api/swarms/{id}/delete-preview (host r3): an advisory snapshot; the confirmed delete re-checks everything. */
export interface SwarmDeletePreview {
  /** the swarm's exact name: what confirm must be */
  name: string
  counts: SwarmCounts
  /** minds awake or starting now (stopped first by the delete) */
  awake_minds: { id: string; name: string }[]
  /** what happens to the swarm itself once its minds are gone */
  would: 'delete' | 'archive'
  reason: string
  /** unfinished tasks its minds hold or were given, released back to open */
  released_tasks_estimate: number
  /** false, or why a delete would be refused right now */
  busy: false | string
}
/**
 * DELETE /api/swarms/{id} {with_minds: true, confirm}: the swarm deleted, or archived because it has history. A partial
 * answer (a mind's cleanup failed after its delete committed) carries `error`, `remaining_minds`, `hint` and, for minds
 * deleted but not yet cleaned up, `cleanup_pending`; the same request again finishes it.
 */
export interface SwarmDeleteResult {
  deleted_minds: string[]
  swarm: 'deleted' | 'archived'
  reason?: string
  detached_swarms?: string[]
  released_tasks?: number
  skipped_minds?: { id: string; name: string; reason: string }[]
  remaining_minds?: string[]
  error?: { code: string; message: string; mind?: string }
  hint?: string
  cleanup_pending?: string[]
}
export interface Person {
  id: string
  email: string
  name: string
  role: 'admin' | 'member'
  invited_by: string | null
  created_at: string
  last_seen_at: string | null
  disabled: boolean
  /** Platform's sign-in hardening: a Google identity is linked to this person (absent on older hives). */
  google_bound?: boolean
}
export interface Invite {
  id: string
  email: string
  name: string
  role: 'admin' | 'member'
  created_by: string
  created_at: string
  expires_at: number
  accepted_at: string | null
  revoked_at: string | null
  status: 'pending' | 'accepted' | 'expired' | 'revoked'
}

/** SIM ONLY qualification fixtures: another actor saves an edit; the scope issuer's grant is revoked (the person reopens
 *  under a renewed grant); the next decision commits but its answer is lost in transit. */
export type SimCodeFixture = 'external-edit' | 'revoke-issuer' | 'lose-next-answer' | 'revoke-grant'

/** The exact opened task/grant/repository every Code proxy call carries. */
export interface CodeContext {
  task_id: string
  grant_id: string
  repository_id: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  /** For OmegaCode errors relayed by /api/code/proxy: the service's own HTTP status (next8 sends it as upstream_status). */
  readonly upstreamStatus?: number
  readonly source?: 'omegacode'
  /** The host's whole error envelope (it merges an error's details in: stop_incomplete's {stopped, failed}); untrusted. */
  readonly envelope?: Record<string, unknown>
  /** The whole JSON error body, for fields beside the envelope (ui prefs' 409 carries `current`); untrusted. */
  readonly body?: unknown
  constructor(status: number, code: string, message: string, relay?: { source?: 'omegacode'; upstreamStatus?: number; envelope?: Record<string, unknown>; body?: unknown }) {
    super(message)
    this.status = status
    this.code = code
    this.source = relay?.source
    this.upstreamStatus = relay?.upstreamStatus
    this.envelope = relay?.envelope
    this.body = relay?.body
  }
}

/**
 * professional-release r1.1 (stand-in P1): an answer that arrives after this client's sign-in changed belongs to the
 * earlier sign-in. The live client never delivers it, success or failure: it rejects with this typed error, so every
 * multi-step flow (launch a swarm, create a mind, start or wake, create a task) stops at its next await instead of
 * sending its later steps under the new person's credential.
 */
export const IDENTITY_CHANGED = 'identity_changed'
export const IDENTITY_CHANGED_WORDS = 'Stopped: you signed in as someone else while this was being sent.'
export const isIdentityChanged = (e: unknown): boolean => e instanceof ApiError && e.code === IDENTITY_CHANGED

/** Small typed emitter shared by both implementations. */
export class Emitter<T> {
  private listeners = new Set<(v: T) => void>()
  on(fn: (v: T) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  emit(v: T): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(v)
      } catch (err) {
        console.warn('[hive] listener failed', err)
      }
    }
  }
  get size(): number {
    return this.listeners.size
  }
}

/** True when the app should run against the in-browser simulator. */
export function wantsSim(): boolean {
  // the static demo build has no backend at all
  if (import.meta.env.MODE === 'demo') return true
  const params = new URLSearchParams(window.location.search)
  if (params.get('sim') === '1') return true
  if (params.get('sim') === '0') return false
  // The dev server plays the simulator unless a hive is named; a production build is served by a
  // hive (hive/core hosts dist/), so it talks to the origin that served it.
  return !import.meta.env.VITE_HIVE_URL && import.meta.env.MODE !== 'production' && import.meta.env.MODE !== 'surface-preview'
}

/**
 * Where the hive's API lives. VITE_HIVE_URL names it outright; otherwise it is the path the UI was
 * served from, so one build works at the root and under a prefix such as /omegadot/ (HIVE_BASE_PATH).
 */
export function hiveBase(): string {
  if (import.meta.env.VITE_HIVE_URL) return import.meta.env.VITE_HIVE_URL
  return window.location.pathname.replace(/\/index\.html$/, '').replace(/\/+$/, '')
}

/** SIM: ?askflags= read as the host's Ask switches (unknown words ignored). */
function simAskFlags(v: string): import('./ask').AskCapabilities {
  const on = new Set(v.split(',').map((w) => w.trim()))
  return { conductor: on.has('conductor'), memory: on.has('memory') }
}

/**
 * The invented reasoning-module fixture (api/sim/reasoningFixture) is opt-in by the URL alone: BOTH `sim=1` and
 * `reasoning=invented`, explicitly (stand-in r1 P2). Never through demo mode, the dev server's default simulator or
 * any other default; `sim=0` or a missing `sim=1` keeps it off.
 */
export function inventedReasoningRequested(search: string): boolean {
  const q = new URLSearchParams(search)
  return q.get('sim') === '1' && q.get('reasoning') === 'invented'
}

/**
 * Code's prepared PC contribution payloads as OmegaEvolve's view (api/sim/evolvePc) are opt-in by the URL alone: BOTH
 * `sim=1` and `pcreports=fixture` (or `fail`, a view that fails). The fixture module loads only then.
 */
export function pcReportsRequested(search: string): 'fixture' | 'fail' | null {
  const q = new URLSearchParams(search)
  if (q.get('sim') !== '1') return null
  const v = q.get('pcreports')
  return v === 'fixture' || v === 'fail' ? v : null
}

/** SIM: the personal-mind fixture from ?mind= and ?mindversions= (unknown words: the default demo). */
function simMind(mind: string | null, versions: string | null): { mind: 'on' | 'null' | 'absent' | 'person'; versions: boolean } {
  return { mind: mind === 'null' || mind === 'absent' || mind === 'person' ? mind : 'on', versions: versions === '1' }
}

/** SIM: ?askanswer= read as the who-answers fixture (unknown words ignored). */
function simAskAnswer(v: string): { nodefault?: boolean; one?: boolean; mind?: 'awake' | 'asleep'; next?: string } {
  const on = v.split(',').map((w) => w.trim())
  const next = on.find((w) => /^next-(no_mind|no_orchestrator|mind_asleep)$/.test(w))?.slice(5)
  return { nodefault: on.includes('nodefault'), one: on.includes('one'), mind: on.includes('mindasleep') ? 'asleep' : on.includes('mind') ? 'awake' : undefined, ...(next ? { next } : {}) }
}

async function pcExtraApps(search: string): Promise<{ extraApps?: (() => import('./sim/programs').SimProgram)[]; figureSource?: (readUrl: string) => Uint8Array | null }> {
  const want = pcReportsRequested(search)
  if (!want) return {}
  const m = await import('./sim/evolvePc')
  return { extraApps: [want === 'fail' ? m.evolvePcFailing : m.evolvePcFixture], figureSource: m.simFigureBytes }
}

/** Lazily constructs the right client so the unused implementation is never downloaded. */
export async function createClient(): Promise<HiveClient> {
  if (wantsSim()) {
    const [{ SimClient }, { DEMO_REFUSE, isDemoMode }] = await Promise.all([import('./sim/SimClient'), import('./sim/demo')])
    const q = new URLSearchParams(window.location.search)
    // plain demo mode (the demo build, ?sim=1): Ada (INVENTED) visits, one app is refused in one swarm, team rooms talk
    const demo = isDemoMode(window.location.search, import.meta.env.MODE)
    return new SimClient({
      ...(demo ? { demo: true, persona: q.get('simrole') === 'operator' ? ('operator' as const) : ('person' as const), refuse: DEMO_REFUSE } : {}),
      extraDots: Math.min(200, Number(q.get('dots')) || 0),
      // sim-only: ?simscale=cloud|big|150x500 plays a hive at that scale (INVENTED; api/sim/scale.ts)
      ...(q.get('simscale') ? { scale: (await import('./sim/scale')).scaleFromQuery(q) ?? undefined } : {}),
      speed: Math.min(10, Number(q.get('speed')) || 1),
      // sim-only: ?code=person plays the live client (no mind route); ?code=unrelayed plays a hive without the routes
      codeMode: q.get('code') === 'person' ? 'person' : q.get('code') === 'unrelayed' ? 'unrelayed' : 'mind',
      // sim-only: ?askflags=conductor,memory or none plays a hive with those Ask switches; ?refuse=app@swarm
      ...(q.has('askflags') ? { askFlags: simAskFlags(q.get('askflags') ?? '') } : {}),
      ...(q.get('refuse') ? { refuse: (q.get('refuse') ?? '').split(',').slice(0, 8) } : {}),
      // sim-only: ?slowapp=app plays an app whose read settles only after 6 s; askflags …,strayframes plays late frames
      ...(q.get('slowapp') ? { slowApps: (q.get('slowapp') ?? '').split(',').slice(0, 8) } : {}),
      ...((q.get('askflags') ?? '').split(',').includes('strayframes') ? { strayMemoryFrames: true } : {}),
      // the invented reasoning-module read (not evidence of real state): only with BOTH ?sim=1 and ?reasoning=invented
      ...(inventedReasoningRequested(window.location.search) ? { reasoning: 'invented' as const } : {}),
      // Code's PC payloads as OmegaEvolve's view: only with BOTH ?sim=1 and ?pcreports=fixture|fail (a lazily loaded chunk)
      ...(await pcExtraApps(window.location.search)),
      // sim-only: the demo person's personal mind (on by default); ?mind=null|absent|person, ?mindversions=1
      personalMind: { ...simMind(q.get('mind'), q.get('mindversions')), lost: q.get('mindlost') === '1' },
      // sim-only: ?askanswer=nodefault,one,mind|mindasleep,next-no_mind plays who answers when nothing decides it
      ...(q.get('askanswer') ? { askAnswer: simAskAnswer(q.get('askanswer') ?? '') } : {}),
      // sim-only (J3 r4.3 O3): ?studiomonthly=missing plays a missing monthly total; ?studiomonth=rollover a month change;
      // r1.6 (host R5): ?studiostopfail=1|2 parks Stop once / twice; ?studioconsent=changed refuses resume; ?studiofenced=1;
      // r1.7: ?studiokey=none (OI-13 own_key_needed); ?studiomaker=iter (R6 maker_kind_unsupported);
      // r1.13: ?studiopieces=none (no saved canvas in the Studio space); ?studiosource=unbindable (409 source_not_bindable)
      studio: { monthlyMissing: q.get('studiomonthly') === 'missing', rollover: q.get('studiomonth') === 'rollover', hold: q.get('studiohold') === '1', role: q.get('studiorole') === '1', stopFail: Number(q.get('studiostopfail')) || 0, consentDrift: q.get('studioconsent') === 'changed', fenced: q.get('studiofenced') === '1', keyNone: q.get('studiokey') === 'none', makerKind: q.get('studiomaker') || undefined, piecesNone: q.get('studiopieces') === 'none', unbindable: q.get('studiosource') === 'unbindable' },
    })
  }
  const { LiveClient } = await import('./live')
  return new LiveClient(hiveBase())
}
