import type { Route } from '../lib/router'

/**
 * Everything a person can do in the hive, in one list (from the classic UI audit, 2026-10-05). Every experience must
 * reach every entry, natively or by opening its classic page (experiences/coverage.test.ts enforces it). An entry with
 * `classic: null` has no classic page yet: it is a known gap that experiences report rather than hide.
 */
export type FeatureGroup = 'minds' | 'swarms' | 'work' | 'decide' | 'talk' | 'apps' | 'build' | 'watch' | 'money' | 'people' | 'hive'
export interface Feature {
  id: string
  label: string
  /** One plain line: what it is for. */
  blurb: string
  group: FeatureGroup
  /** Where the classic UI does it, or null when nothing does yet. */
  classic: Route | null
  /** Needs a person's informed decision (Review R2/R3 inspection rules apply wherever it is built natively). */
  decision?: boolean
  /** Spends money or reserves budget. */
  money?: boolean
  keywords?: string
}

export const FEATURES: Feature[] = [
  // minds
  { id: 'minds.see', label: 'See every mind', blurb: 'Who is awake, thinking or asleep, and where', group: 'minds', classic: { name: 'hive' } },
  { id: 'minds.create', label: 'Create a mind', blurb: 'A new mind with a role, model and budget', group: 'minds', classic: { name: 'new' }, money: true },
  { id: 'minds.talk', label: 'Talk to a mind', blurb: 'Its conversation, live', group: 'talk', classic: { name: 'hive' } },
  { id: 'minds.wake', label: 'Wake or sleep a mind', blurb: 'Start, stop, wake or rest', group: 'minds', classic: { name: 'hive' } },
  { id: 'minds.memory', label: "A mind's memory", blurb: 'Spaces and atoms; retire or reset', group: 'minds', classic: { name: 'hive' } },
  { id: 'minds.schedule', label: 'Wakeups and schedule', blurb: 'When a mind wakes on its own', group: 'minds', classic: { name: 'hive' } },
  { id: 'minds.model', label: "A mind's model and key", blurb: 'Which model it thinks with and who pays', group: 'minds', classic: { name: 'hive' }, money: true },
  { id: 'minds.traces', label: 'What a mind did', blurb: 'Traces, logs and thinking', group: 'minds', classic: { name: 'hive' } },
  { id: 'minds.shares', label: 'Memory shared between minds', blurb: 'Who can read whose memory; revoke', group: 'minds', classic: { name: 'hive' }, decision: true },
  { id: 'minds.inventory', label: "A mind's tools", blurb: 'What it can call, and what it called', group: 'minds', classic: { name: 'hive' } },
  { id: 'minds.move', label: 'Move a mind between hives', blurb: 'Export, import, settle', group: 'minds', classic: { name: 'settings' }, decision: true },
  { id: 'minds.outside', label: 'Add an outside agent', blurb: 'Claude Code, Codex or any MCP client', group: 'minds', classic: { name: 'connect' }, keywords: 'outside agent invitations, open invitations, withdraw an invitation, join codes' },
  // swarms
  { id: 'swarms.see', label: 'Swarms', blurb: 'Groups of minds with one purpose', group: 'swarms', classic: { name: 'swarms' } },
  { id: 'swarms.launch', label: 'Start a swarm', blurb: 'Minds from roles, with a purpose', group: 'swarms', classic: { name: 'launch' }, money: true },
  { id: 'swarms.beliefs', label: 'What a swarm believes', blurb: 'Shared beliefs with their evidence', group: 'swarms', classic: { name: 'swarms' } },
  { id: 'swarms.vocabulary', label: "A swarm's vocabulary", blurb: 'The shared terms a swarm uses, and what they mean', group: 'swarms', classic: { name: 'swarms' }, keywords: 'vocab terms words glossary dictionary language meanings' },
  { id: 'swarms.archived', label: 'Archived swarms', blurb: 'Swarms put away with their history; restore one', group: 'swarms', classic: { name: 'swarms' }, decision: true, keywords: 'archive archived restore retired bring back' },
  { id: 'swarms.edit', label: 'Change a swarm', blurb: 'Rename, purpose, coordinator, archive, nest', group: 'swarms', classic: { name: 'swarms' } },
  { id: 'swarms.nesting', label: 'Swarms inside minds', blurb: 'The holarchy of nested swarms', group: 'swarms', classic: { name: 'explore' } },
  { id: 'swarms.connections', label: 'Connections between swarms', blurb: 'Purpose, scope, duration, budget', group: 'swarms', classic: { name: 'swarms' } },
  { id: 'swarms.requests', label: 'Coding swarm requests', blurb: 'Requests in and out of a swarm: who asked, the receiving task, state and budget', group: 'swarms', classic: { name: 'swarms' }, keywords: 'requests inbox incoming outgoing coding swarm request receiving goal task in review budget root' },
  { id: 'swarms.services', label: 'Services between swarms', blurb: 'What one swarm offers another, and grants', group: 'swarms', classic: { name: 'swarms' }, decision: true, keywords: 'capability catalogue, what other swarms can do' },
  { id: 'swarms.lifecycle', label: 'Lifecycle and leases', blurb: 'Who looks after a swarm, and for how long', group: 'swarms', classic: { name: 'swarms' } },
  // work
  // Motivations above Tasks: the old Goals and Boards pair. `work.goals` keeps its id (the hive's Ask names features by
  // id); it is the Tasks feature now, and Boards is one of its views.
  { id: 'work.motivations', label: 'Motivations', blurb: 'Why the work matters: aims held by people, swarms and minds', group: 'work', classic: { name: 'motivations' }, keywords: 'motivations why aims purpose objectives intentions reasons' },
  { id: 'work.goals', label: 'Tasks', blurb: 'The work itself: in columns or a list, by swarm, mind or motivation', group: 'work', classic: { name: 'tasks' }, keywords: 'tasks goals board boards kanban list work subtasks' },
  { id: 'work.review', label: 'Review submitted work', blurb: 'Accept or return results awaiting review, with their history', group: 'work', classic: { name: 'tasks' }, decision: true, keywords: 'review awaiting accept return submitted reviewed done, result attempts, every attempt on a task, code access to a task, give code access' },
  { id: 'work.flow', label: 'Flows', blurb: 'Connected workflows', group: 'work', classic: { name: 'flow' }, keywords: 'adopted revisions, take back an adoption, unadopt a flow' },
  { id: 'work.sessions', label: 'Sessions', blurb: 'A focused thread with one mind, a task and a cap', group: 'work', classic: { name: 'messages' }, money: true },
  { id: 'work.explore', label: 'Explore', blurb: 'Everything, filtered and grouped your way', group: 'work', classic: { name: 'explore' }, keywords: 'my groups, rename a group, delete a group' },
  { id: 'work.artifacts', label: 'Artifacts and findings', blurb: 'What minds and apps produced', group: 'work', classic: { name: 'artifacts' } },
  { id: 'work.assets', label: 'Files and storage', blurb: 'Assets, stores and transfers', group: 'work', classic: { name: 'assets' }, keywords: 'clean up a file, local only copies, remove cloud copies' },
  // decide
  { id: 'decide.approvals', label: 'Decisions waiting on you', blurb: 'Approve once, for a time, always, no, never', group: 'decide', classic: { name: 'approvals' }, decision: true },
  { id: 'decide.rules', label: 'Policy rules', blurb: 'What minds may do without asking', group: 'decide', classic: { name: 'approvals', tab: 'rules' }, decision: true },
  { id: 'decide.history', label: 'Decision history', blurb: 'What was decided, by whom', group: 'decide', classic: { name: 'approvals', tab: 'history' } },
  { id: 'decide.asks', label: "People's requests", blurb: 'A member asks for a mind or an allowance', group: 'decide', classic: { name: 'approvals' }, decision: true },
  { id: 'decide.reservations', label: 'Settle unknown-cost calls', blurb: 'A person settles calls whose cost is unknown', group: 'decide', classic: { name: 'usage' }, decision: true, money: true },
  { id: 'decide.stopall', label: 'Stop all minds', blurb: 'The kill switch', group: 'decide', classic: { name: 'hive' }, decision: true },
  // talk
  { id: 'talk.rooms', label: 'Messages and rooms', blurb: 'DMs, groups, channels and projects', group: 'talk', classic: { name: 'messages' } },
  { id: 'talk.recent', label: 'Recent conversations', blurb: 'Minds you talked to lately: straight back to their chat', group: 'talk', classic: { name: 'conversations' }, keywords: 'recent chats conversations channels my chats back to the chat where was I talking' },
  { id: 'talk.coffee', label: 'Coffee Room', blurb: 'Where everyone in the hive, people and minds, can meet', group: 'talk', classic: { name: 'messages', room: 'coffee' }, keywords: 'coffee everyone hive chat lounge' },
  // apps
  { id: 'apps.list', label: 'Apps', blurb: 'Every app this hive offers you', group: 'apps', classic: { name: 'programs' } },
  { id: 'apps.open', label: 'Open an app', blurb: 'Its own space, in its own form', group: 'apps', classic: { name: 'programs' } },
  { id: 'apps.activity', label: 'App activations and offers', blurb: 'Where apps run, attachments and offers', group: 'apps', classic: { name: 'programs' }, keywords: 'pause app access, restore app access, app grants' },
  // build
  { id: 'build.code', label: 'Code', blurb: 'Code workspaces with minds', group: 'build', classic: { name: 'code' } },
  { id: 'build.roles', label: 'Roles', blurb: 'Job descriptions for minds', group: 'build', classic: { name: 'roles' } },
  { id: 'build.models', label: 'Models and providers', blurb: 'AI providers and models', group: 'build', classic: { name: 'models' }, money: true },
  { id: 'build.evolve', label: 'Evolve', blurb: 'The evolving research pair', group: 'build', classic: { name: 'programs' } },
  { id: 'build.updates', label: 'Updates and holds', blurb: 'App and platform updates; place or lift a hold', group: 'build', classic: { name: 'updates' }, decision: true, keywords: 'update reload restart hold holds lift release, ask for an update, request an update' },
  // watch
  { id: 'watch.health', label: 'Health', blurb: 'Errors across minds', group: 'watch', classic: { name: 'health' } },
  { id: 'watch.idle', label: 'Idle minds', blurb: 'Awake minds with no input: what Health noticed, asked, and what they answered', group: 'watch', classic: { name: 'health', section: 'idle' }, keywords: 'idle minds which minds are idle idle spend wasting money doing nothing remind owed' },
  { id: 'watch.healthmind', label: 'The health mind', blurb: 'Which mind answers incidents', group: 'watch', classic: { name: 'health' } },
  { id: 'watch.lab', label: 'Lab', blurb: 'Tests and benchmarks', group: 'watch', classic: { name: 'lab' } },
  { id: 'watch.activity', label: 'Live activity', blurb: 'What is happening now', group: 'watch', classic: { name: 'hive' } },
  // money
  { id: 'money.usage', label: 'Usage and spend', blurb: 'Spend, tokens and limits', group: 'money', classic: { name: 'usage' }, money: true },
  { id: 'money.keys', label: 'Your keys', blurb: 'API keys and who pays', group: 'money', classic: { name: 'me' }, money: true },
  // people
  { id: 'people.manage', label: 'People and invitations', blurb: 'Who can use this hive', group: 'people', classic: { name: 'people' } },
  { id: 'people.me', label: 'You', blurb: 'Your profile', group: 'people', classic: { name: 'me' } },
  { id: 'people.mind', label: 'Your personal mind', blurb: 'The mind named after you: what it remembers, its version, its hands', group: 'people', classic: { name: 'me', view: 'mind' }, keywords: 'my mind, personal mind, what it remembers, swarm talk, download my memory, restore memory, adopt version, roll back' },
  // hive
  { id: 'hive.setup', label: 'Getting started', blurb: 'Setup checklist: provider, who pays, limit, a swarm, invites', group: 'hive', classic: { name: 'setup' }, keywords: 'first run setup checklist onboarding start' },
  { id: 'hive.identity', label: 'Name this hive', blurb: 'How other hives know this one', group: 'hive', classic: { name: 'settings' }, decision: true, keywords: 'rename hive name identity home cloud' },
  { id: 'hive.settings', label: 'Settings', blurb: 'Sign-in, password, disk, apps', group: 'hive', classic: { name: 'settings' }, keywords: 'registered services, code service, turn a service off, remove a service, ask audit, every person’s ask turns' },
  { id: 'hive.changeui', label: 'Change UI', blurb: 'Looks, layouts and experiences', group: 'hive', classic: null },
  { id: 'hive.search', label: 'Search everything', blurb: 'Jump to anything', group: 'hive', classic: { name: 'hive' } },
  { id: 'hive.help', label: 'Help and the tour', blurb: 'How the hive works', group: 'hive', classic: { name: 'hive' } },
]

export const featureById = (id: string): Feature | undefined => FEATURES.find((f) => f.id === id)

/** How an experience reaches a feature: built in its own grammar, or by opening the classic page. */
export type Reach = 'native' | 'classic'
/** An experience's coverage: every feature id, with how it is reached. Missing classic pages are reported, not hidden. */
export type Coverage = Record<string, Reach>

export const GROUP_LABEL: Record<FeatureGroup, string> = {
  minds: 'Minds',
  swarms: 'Swarms',
  work: 'Work',
  decide: 'Decide',
  talk: 'Talk',
  apps: 'Apps',
  build: 'Build',
  watch: 'Watch',
  money: 'Money',
  people: 'People',
  hive: 'Hive',
}
