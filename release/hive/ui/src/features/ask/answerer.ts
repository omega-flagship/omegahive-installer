/**
 * Who answers an Ask when nothing on the page decides it (pure; tested). The host routes in Jon's order: the addressed
 * mind's swarm, the page's swarm, the person's default swarm (GET /api/me/ask), then (Platform P2) the person's own
 * mind (GET /api/me/mind). When none of these holds the host refuses with `no_mind`, so the bar says so before the
 * first send and offers the same picker the refusal does. Never about models: a swarm's coordinator answers.
 */
import type { AskContext, AskSettings, AskSwarmChoice, MyMind, RefusalReason } from '../../api/ask'

/** The host's own words for these refusals (core/ask.py SAY), mirrored here: the page never echoes a host string. */
export const HOST_SAY: Partial<Record<RefusalReason, string>> = {
  no_mind: 'Choose a swarm to ask first.',
  no_orchestrator: 'That swarm has no coordinator to answer. An admin can choose one.',
}
export const ADMIN_CHOOSES = 'An admin can choose one in the swarm’s settings.'
export const MIND_RESTING = 'Your mind is resting — Ask from a swarm, or wake it.'
export const MIND_RESTING_NO_WAKE = 'Your mind is resting — Ask from a swarm.'
export const CHOOSE_WHO = 'Choose who answers'
export const CHANGE_WHO = 'Change who answers'

/** The refusals the picker answers: choosing a swarm (and re-sending once) is the fix. */
export const PICKER_REASONS: readonly RefusalReason[] = ['no_mind', 'no_orchestrator']

export type AnswererChip =
  | { kind: 'loading' }
  /** the person's own mind answers (Platform P2; inert until the host has it) */
  | { kind: 'personal'; name: string; resting: boolean; status?: string }
  /** exactly one swarm can answer: it is preselected, and shown */
  | { kind: 'one'; swarm: AskSwarmChoice }
  /** nobody would answer yet: choose before the first send */
  | { kind: 'choose' }
  /** j0-fixes r1: the open thread's mind answers a plain follow-up (continuity); Change still beats it */
  | { kind: 'thread'; name: string }
  /** A resolved plan is named before admission; it is not yet a thread. */
  | { kind: 'planned'; name: string }

/**
 * The bar's chip, or null when something else decides who answers (an addressed mind, the page's swarm, a saved
 * default; an open thread does not: the host routes each request afresh), or when the host has not said yet (the
 * settings are not read: nothing is guessed).
 */
export function answererChip(o: { settings: AskSettings | null; personal: MyMind | null | undefined; pageSwarm?: string; to?: string }): AnswererChip | null {
  if (!o.settings || o.to || o.pageSwarm) return null
  if (o.settings.swarm_id) return null // an explicit default still wins over the person's own mind (Platform P2)
  if (o.personal === undefined) return { kind: 'loading' }
  if (o.personal) return { kind: 'personal', name: o.personal.name, resting: o.personal.status === 'asleep', status: o.personal.status }
  const eligible = o.settings.eligible ?? []
  return eligible.length === 1 ? { kind: 'one', swarm: eligible[0] } : { kind: 'choose' }
}

/** The chip's words. */
export function chipWords(c: AnswererChip): string {
  if (c.kind === 'loading') return 'Finding who answers…'
  if (c.kind === 'personal') return `Answering: you (${c.name.slice(0, 60)})`
  if (c.kind === 'one') return `Answering: ${c.swarm.name.slice(0, 60)} · change`
  if (c.kind === 'thread') return `Answering: ${c.name.slice(0, 60)} (this thread) · change`
  if (c.kind === 'planned') return `Answering: ${c.name.slice(0, 60)}`
  return CHOOSE_WHO
}

/** Native grammar changes the presentation, never the routing scope or identity. */
export type NativeAnswererLook = 'construct' | 'professional' | 'still'
export function nativeAnswererWords(chip: AnswererChip, look: NativeAnswererLook): string {
  if (chip.kind === 'loading' || chip.kind === 'choose') return look === 'construct' ? chipWords(chip).toLowerCase() : chipWords(chip)
  const name = (chip.kind === 'one' ? chip.swarm.name : chip.name).slice(0, 60)
  return look === 'construct' ? `answering: ${name.toLowerCase()}` : look === 'still' ? `Asking ${name} · change` : `Answering: ${name}`
}

/**
 * The context a request is sent with: when exactly one swarm can answer and nothing else decides it, that swarm is
 * named, so the first send works without a saved default. A private app's page is never changed (exactly {private}).
 */
export function withPreselected(ctx: AskContext, chip: AnswererChip | null, settings?: AskSettings | null): AskContext {
  if ('private' in ctx || ctx.swarm_id || ctx.mind) return ctx
  if (chip?.kind === 'one') return { ...ctx, swarm_id: chip.swarm.id }
  // j0-fixes r1: the person's saved default (their explicit choice) is named in the context, so the request sent says
  // the same swarm the row names; only one the Ask may use (the host's `eligible`), never guessed
  const chosen = settings?.swarm_id && settings.eligible?.some((e) => e.id === settings.swarm_id) ? settings.swarm_id : null
  return chosen && !chip ? { ...ctx, swarm_id: chosen } : ctx
}

/**
 * The context after an explicit saved choice: a root refusal can use the new
 * host default; an old recipient/program scope is replaced so it cannot win
 * over that choice. Private requests retain their exact contract.
 */
export function resendContext(ctx: AskContext, reason: RefusalReason, swarmId: string): AskContext {
  if ('private' in ctx) return ctx
  // A root refusal can use the newly saved host default unchanged. Explicit
  // previous recipient/program scope must instead be replaced by the choice.
  if (reason !== 'no_orchestrator' && !ctx.swarm_id && !ctx.mind && !ctx.program && !ctx.selection?.length) return ctx
  const { mind: _mind, program, selection, view, ...rest } = ctx
  void _mind
  const sel = program ? undefined : selection?.filter((r) => r.kind !== 'mind')
  return { ...rest, ...(!program && view ? { view } : {}), ...(sel?.length ? { selection: sel } : {}), swarm_id: swarmId }
}

/** What routeAround knows of a swarm: its name, and its coordinator when the swarm list said (absent: unknown). */
export interface SwarmFacts {
  name: string
  coordinator_id?: string | null
}

/** A request to make or draw something: when it falls back to the person's own mind, an admin is offered the fix. */
export const MAKES = /\b(make|draw|design|create|sketch|paint|poster|illustrat\w*)\b/i

/**
 * Why the page's swarm cannot answer, in plain words (ask-fix r2, stand-in note): "has no coordinator" only when the
 * swarm list says its coordinator is empty; otherwise the cause may be permission, so "can't answer here".
 */
export function cannotAnswer(swarm: SwarmFacts | undefined): string {
  const name = (swarm?.name ?? 'This swarm').slice(0, 60)
  return swarm && 'coordinator_id' in swarm && !swarm.coordinator_id ? `${name} has no coordinator` : `${name} can't answer here`
}

/**
 * The mind an Ask answers through in a swarm that has no coordinator (ask-fix r2; Jon: "any hive I have permission
 * for should answer through some way"). Platform's host route (ask-answer-through-mind r1): in a swarm with NO
 * coordinator an addressed mind (`context.mind`) answers itself, under the same participates/sees/addressable checks
 * and wake and budget rules as a coordinator; a swarm with a coordinator still answers through it. A host without that
 * route refuses it (hive/core/ask.py _route 330-333 -> orchestrator 297-300, no_orchestrator); store/ask.ts then sends
 * the turn once more with the r1 fallback (`compat`).
 * TODO(Platform program_homes.mind_id via GET /homes): prefer the app's declared mind, falling back to the coordinator.
 * Until then: a mind in the swarm whose name names the app ("Design" in "Design deck maker" for omegadesign), else the
 * first mind the person may address, awake ones first. Never a personal or module mind, never a stopped or failed one.
 * `prefer`: the mind this swarm's thread already answers through (kept for every follow-up, Platform 80d066e).
 */
export function answerMindFor<M extends { id: string; name: string; swarm_id?: string | null; status?: string; personal_of?: string | null; kind?: string }>(swarmId: string, minds: M[], app?: { id: string; name?: string } | null, prefer?: string | null): M | null {
  // a module mind is refused by the host (not_allowed), so it is never chosen
  const here = minds.filter((m) => m.swarm_id === swarmId && !m.personal_of && m.kind !== 'module' && m.status !== 'stopped' && m.status !== 'error')
  // the mind this thread already answers through stays, so every follow-up reaches the same mind
  const kept = prefer ? here.find((m) => m.id === prefer) : undefined
  if (kept) return kept
  if (!here.length) return null
  // awake first, then asleep (it can be woken), then one only created or starting
  const rank = (m: M) => (m.status === 'awake' ? 0 : m.status === 'asleep' ? 1 : 2)
  const words = app ? [app.name ?? '', app.id].map((w) => w.toLowerCase().replace(/^omega/, '').trim()).filter((w) => w.length >= 3) : []
  const named = here.filter((m) => words.some((w) => m.name.toLowerCase().includes(w))).sort((a, b) => rank(a) - rank(b))
  return named[0] ?? [...here].sort((a, b) => rank(a) - rank(b))[0]
}

/** `note`: the plain visible line ("Answering: Product Design"); `why`: its explanation, kept for a tooltip (j0-fixes r1). */
type Routed = { context: AskContext; note: string | null; why?: string; fixSwarm?: string }

/**
 * ask-fix r1/r2 (Jon, live): standing near a swarm the Ask cannot use (not in the host's `eligible`) made every plain
 * question a "no coordinator" refusal, because the page's swarm is sent as `context.swarm_id`, which the host routes
 * to (core/ask.py _route). Such a swarm is never targeted. Instead, in the host's own order (an explicit default wins
 * over the person's own mind, Platform P2): the person's default swarm when the Ask may use it; else their own mind;
 * else the one swarm the Ask may use; else the host decides. An addressed mind, a private app's page, and anything
 * while the host has not said which swarms the Ask may use are never changed. `note`: a quiet line, or null.
 * `fixSwarm`: a make/draw request that fell back to the person's own mind names the page's swarm, so an admin is
 * offered "Set a coordinator for <swarm>" (non-admins see the note only).
 */
export function routeAround(ctx: AskContext, settings: AskSettings | null, personal: MyMind | null | undefined, swarmOf: (id: string) => SwarmFacts | undefined, words = '',
  through?: { minds: { id: string; name: string; swarm_id?: string | null; status?: string; personal_of?: string | null; kind?: string }[]; app?: { id: string; name?: string } | null; prefer?: (swarmId: string) => string | null | undefined },
): Routed & { through?: { mind: string; why: string }; compat?: Routed } {
  if ('private' in ctx || ctx.mind || !ctx.swarm_id || !settings?.eligible) return { context: ctx, note: null }
  const eligible = settings.eligible
  if (eligible.some((e) => e.id === ctx.swarm_id)) return { context: ctx, note: null }
  const facts = swarmOf(ctx.swarm_id)
  const why = cannotAnswer(facts)
  const fallback = aroundTo(ctx, settings, personal, why, words)
  // no coordinator (known): a mind there answers itself, on a host with the route; else the turn is sent again as `compat`
  const noCoordinator = !!facts && 'coordinator_id' in facts && !facts.coordinator_id
  const mind = noCoordinator && through ? answerMindFor(ctx.swarm_id, through.minds, through.app, through.prefer?.(ctx.swarm_id)) : null
  if (mind) return { context: { ...ctx, mind: mind.id }, note: `Answering: ${mind.name.slice(0, 60)}`, why: `${why}, so ${mind.name.slice(0, 60)} answers directly`, through: { mind: mind.id, why }, compat: fallback }
  return fallback
}

/** The r1 fallback: the person's usable default, else their own mind, else the one usable swarm, else the host. */
function aroundTo(ctx: AskContext & { swarm_id?: string }, settings: AskSettings, personal: MyMind | null | undefined, why: string, words: string): Routed {
  const eligible = settings.eligible ?? []
  const { swarm_id: page, ...rest } = ctx
  const chosen = eligible.find((e) => e.id === settings.swarm_id)
  if (chosen) return { context: { ...rest, swarm_id: chosen.id }, note: `Answering: ${chosen.name.slice(0, 60)}`, why }
  if (personal === undefined) return { context: rest, note: null, why }
  if (personal) {
    // a saved default the Ask cannot use would be routed to first: name the person's own swarm instead
    const own = settings.swarm_id && personal.swarm_id ? { swarm_id: personal.swarm_id } : {}
    return { context: { ...rest, ...own }, note: 'Answering: you', why, ...(MAKES.test(words) ? { fixSwarm: page } : {}) }
  }
  if (eligible.length === 1) return { context: { ...rest, swarm_id: eligible[0].id }, note: `Answering: ${eligible[0].name.slice(0, 60)}`, why }
  return { context: rest, note: null }
}

/**
 * A thread's info line. A personal-mind thread (the person's own mind answers) is private to them: admins cannot read
 * it, so it never says they can (ask-fix r1). Every other thread keeps the audit sentence. Only the swarm's coordinator
 * is called its orchestrator: in a swarm with no coordinator the mind answers directly (the answer-through route), and
 * the line says so; when the swarm list has not said who coordinates, nothing is claimed (followups r4).
 * `swarmOf`: what the page knows of the thread's swarm (hive.swarms), absent when unknown.
 */
export function threadInfo(t: { mind: { id: string; name: string }; swarm?: { id: string; name: string } | null }, personal: MyMind | null | undefined, mindName: (n: string) => string, swarmOf: (id: string) => SwarmFacts | undefined = () => undefined): string {
  // the person's own mind answers: matched by the mind, never by a swarm it may share with others
  const own = !!personal && t.mind.id === personal.id
  const who = mindName(t.mind.name)
  const facts = t.swarm ? swarmOf(t.swarm.id) : undefined
  const known = !!facts && 'coordinator_id' in facts
  const role = own || !t.swarm ? '' : known && facts.coordinator_id === t.mind.id ? `, as ${t.swarm.name}’s orchestrator` : known && !facts.coordinator_id ? `. ${who} answers directly, because ${t.swarm.name} has no coordinator` : `, in ${t.swarm.name}`
  const base = `Answers come from ${who}’s own knowledge${role}.`
  return own ? base : `${base} Admins can review this in the audit log.`
}

/**
 * j0-fixes r1 (J0 live, Design's source repro): who receives a plain request was decided in three places that could
 * disagree: the chip, the paid row (which kept an old thread's mind) and the send (which re-injected that mind while the
 * chip named someone else, ignoring a since-chosen default). It is now one decision, `planAsk`, read by the chip, the
 * paid row and the outgoing context alike:
 *  - an explicit choice (Change, saved as the default) beats continuity: the store clears the carry when it is saved;
 *  - a closed or new thread does not carry its mind into a plain new request (`continuing` needs the thread showing);
 *  - the row names exactly the mind the context sends to (`planName` reads the planned context, nothing else).
 * A turn in flight keeps its deliberate steering (the hook names the thread's mind while `open`; never retargeted).
 */
export interface Carry {
  /** the mind the thread answers through (a swarm with no coordinator) */
  mind: string
  /** that mind's swarm */
  swarm: string
}

/** What the decision reads. `carry`: the store's continuity binding; `threadOpen`: the thread is showing. */
export interface PlanInputs {
  settings: AskSettings | null
  personal: MyMind | null | undefined
  swarmOf: (id: string) => SwarmFacts | undefined
  words?: string
  /** Explicit local choice: do not replace it with an inferred page fallback. */
  explicitChoice?: boolean
  through?: Parameters<typeof routeAround>[5]
  thread: { mind: { id: string; name: string } } | null
  carry: Carry | null
  threadOpen: boolean
}

/** A plain request continues the retained thread's mind only while that thread is showing and still bound to it. */
export function continuing(ctx: AskContext, o: Pick<PlanInputs, 'thread' | 'carry' | 'threadOpen'>): (Carry & { name: string }) | null {
  if ('private' in ctx || ctx.swarm_id || ctx.mind) return null
  const c = o.carry
  if (!c || !o.threadOpen || !o.thread || o.thread.mind.id !== c.mind) return null
  return { ...c, name: o.thread.mind.name }
}

export type Plan = Routed & { through?: { mind: string; why: string }; compat?: Routed; chip: AnswererChip | null }

/** The one decision: the context a request is sent with, and the chip that says who answers it. */
export function planAsk(ctx: AskContext, o: PlanInputs): Plan {
  const around = o.explicitChoice ? { context: ctx, note: null } : routeAround(ctx, o.settings, o.personal, o.swarmOf, o.words ?? '', o.through)
  const pageSwarm = 'private' in ctx ? undefined : ctx.swarm_id
  if (!around.through) {
    const c = continuing(ctx, o)
    if (c) return { ...around, context: { ...ctx, mind: c.mind }, through: { mind: c.mind, why: cannotAnswer(o.swarmOf(c.swarm)) }, compat: { context: ctx, note: null }, chip: { kind: 'thread', name: c.name } }
  }
  const to = 'private' in around.context ? undefined : around.context.mind
  const chip = answererChip({ settings: o.settings, personal: o.personal, pageSwarm, to })
  return { ...around, context: withPreselected(around.context, chip, o.settings), chip }
}

/** What the page knows of minds and swarms, to name who a planned context reaches. */
export interface NameFacts {
  agents: Record<string, { id: string; name: string; swarm_id?: string | null } | undefined>
  swarms: Record<string, { coordinator_id?: string | null; name?: string } | undefined>
  personal: MyMind | null | undefined
  settings: AskSettings | null
}

/**
 * The mind a planned request reaches, as the row names it; null when the host decides and the page cannot know (the
 * row then says "the swarm's orchestrator"). Read from the planned context only, so the row and the send agree.
 */
/**
 * THE planned recipient, by identity AND name, from the one plan (j0-fixes r1.6, Kimi r1.5): the row, the chip, "is it
 * you", the paid line and the send all read this, so they cannot disagree. `id` is null when the page can't know which
 * mind it is (a coordinator it doesn't have): then nothing may claim it is the person's own mind. Names are display.
 */
export function planRecipient(plan: Pick<Plan, 'context' | 'through'>, f: NameFacts): { id: string | null; name: string | null } {
  const ctx = plan.context
  if ('private' in ctx) return { id: null, name: null }
  if (plan.through) return { id: plan.through.mind, name: f.agents[plan.through.mind]?.name ?? null }
  const coordinatorOf = (sw: string | null | undefined): { id: string | null; name: string | null } => {
    if (!sw) return { id: null, name: null }
    const el = f.settings?.eligible?.find((e) => e.id === sw)
    const id = f.swarms[sw]?.coordinator_id ?? el?.orchestrator?.id ?? null
    const known = id ? f.agents[id]?.name : undefined
    // j0-fixes r1.4 (Kimi 1): a coordinator the page doesn't know still has a swarm the send goes to; name that swarm
    // rather than render a row with no recipient (the send would still reach its coordinator)
    return { id, name: known ?? el?.orchestrator?.name ?? f.swarms[sw]?.name ?? el?.name ?? 'this swarm’s coordinator' }
  }
  // an addressed mind: its swarm's orchestrator answers, about it (Jon's ruling)
  if (ctx.mind) {
    if (ctx.mind === f.personal?.id) return { id: f.personal.id, name: f.personal.name }
    return coordinatorOf(f.agents[ctx.mind]?.swarm_id)
  }
  if (ctx.swarm_id) return coordinatorOf(ctx.swarm_id)
  if (f.settings?.swarm_id) return coordinatorOf(f.settings.swarm_id)
  return { id: f.personal?.id ?? null, name: f.personal?.name ?? null }
}

/** The planned recipient's name (display only); see planRecipient. */
export function planName(plan: Pick<Plan, 'context' | 'through'>, f: NameFacts): string | null {
  return planRecipient(plan, f).name
}
