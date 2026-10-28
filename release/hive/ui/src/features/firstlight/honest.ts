/**
 * First Light's honest copy, as pure functions (review-blocking rules, Surface brief for R2):
 *  - a limit is named as enforced only when the host's `enforced` says so, with what enforces it; the model company's
 *    own limit is said to be separate;
 *  - every key, limit and guest screen says whose key pays;
 *  - no greeting while the mind can't answer; the greeting is only ever the mind's own words from the host;
 *  - "Try again" only when the host says the hello is `retryable`;
 *  - a guest's band says whose hive, whose key and their limit, through beats 1, 3 and 8.
 * Owner words throughout: minds, swarms, Motivations and Tasks.
 */
import type { FlPath } from './script'
import type { Hello, MonthlyLimit } from './host'

/** Dollars as the storyboard writes them: whole amounts plain ($20), the rest to the cent ($0.02, $5.50). */
export function usd(n: number): string {
  if (!Number.isFinite(n)) return '$0'
  const r = Math.round(n * 100) / 100
  return Number.isInteger(r) ? `$${r.toLocaleString('en-US')}` : `$${r.toFixed(2)}`
}
/** A guest's limit is written to the cent, as on their invite ($5.00). */
export const cents = (n: number): string => `$${(Math.round(n * 100) / 100).toFixed(2)}`

export interface Who {
  path: FlPath
  /** the hive's owner, or a guest's host (their name, as the host gave it) */
  host: string
  /** keys of the person's own (provider_key own_keys) */
  ownKeys: number
}

/** Whose key pays, in one line. Said on every key, limit and guest screen. */
export function payerLine(w: Who): string {
  if (w.path === 'guest') return `${w.host}’s key pays, not yours. You never see ${w.host}’s key.`
  if (w.path === 'owner') return w.ownKeys > 0 ? 'Your own key pays: you pay the model company directly.' : 'Your own key will pay, once you add one: you pay the model company directly.'
  return w.ownKeys > 0 ? 'Your own key pays for your minds: you pay the model company directly.' : `${w.host}’s keys pay for your minds here.`
}

/** What enforces a limit, in owner words. */
const BY: Record<NonNullable<MonthlyLimit['enforced_by']>, (host: string) => string> = {
  own: () => 'your own limit on your keys',
  invite: (host) => `the limit ${host} set on your invite`,
  grant: (host) => `the limit ${host} gave you`,
  rule: () => 'a limit set for you in this hive',
  'member-default': () => 'this hive’s usual limit for its people',
}

/** A limit is named as one the hive stops minds at only when the host says `enforced`, with an amount and with what
 *  enforces it (`enforced_by`). One test for the limit line, the guest band and the script's fill-ins. */
export const isEnforced = (l: MonthlyLimit | null): l is MonthlyLimit & { limit_usd: number; enforced_by: NonNullable<MonthlyLimit['enforced_by']> } =>
  !!l && l.enforced === true && l.limit_usd !== null && !!l.enforced_by

/** The model company's own limit is separate; said wherever a limit is named. */
export const COMPANY_SEPARATE = 'Your model company may have its own limits too; those are separate.'

/**
 * The limit, honestly. Named as a limit the hive stops minds at ONLY when the host says it is enforced, and then with
 * what enforces it. Otherwise it says plainly that nothing is enforcing one (and what was chosen, if anything).
 */
export function limitLine(l: MonthlyLimit | null, w: Who): string {
  if (isEnforced(l)) {
    const amount = w.path === 'guest' ? cents(l.limit_usd) : usd(l.limit_usd)
    return `Your limit: ${amount} a month (${BY[l.enforced_by](w.host)}); the hive stops your minds there.`
  }
  const chosen = l?.chosen_usd ?? null
  if (w.path === 'guest') return `${w.host} hasn’t set a limit for you yet, so your minds can’t think here yet.`
  if (chosen !== null) return `You chose ${usd(chosen)} a month, but it isn’t a limit yet: nothing holds your minds to it.`
  return 'No monthly limit is in force for you yet.'
}

/** Used so far this month, when the host says. */
export const usedLine = (l: MonthlyLimit | null): string | null => (l && l.spent_usd !== null ? `used ${cents(l.spent_usd)}` : null)

/** The guest's amber band: whose hive, whose key, their limit (and what they used). Always on screen for a guest. */
export function guestBand(l: MonthlyLimit | null, host: string): string {
  const head = `Guest in ${host}’s hive. Runs on ${host}’s key, not yours.`
  if (isEnforced(l)) return `${head} Your limit: ${cents(l.limit_usd)} a month (${usedLine(l) ?? 'used $0.00'}); the hive stops your minds there.`
  return `${head} ${host} hasn’t set a limit for you yet, so your minds can’t think here yet.`
}

/** Fill a script line from what the host said. Unknown fields read as plain words, never as a made-up value. */
export function fillLine(text: string, f: { name: string | null; host: string; limit: MonthlyLimit | null; look: string | null; monthly: number | null; mind: string | null; app?: string | null }): string {
  const guestLimit = isEnforced(f.limit) ? cents(f.limit.limit_usd) : 'the limit your host set'
  return text
    .replace(/\{name\}/g, f.name ?? 'there')
    .replace(/\{host\}/g, f.host)
    .replace(/\{guest_limit\}/g, guestLimit)
    .replace(/\{look\}/g, f.look ?? 'This look')
    .replace(/\{monthly\}/g, f.monthly !== null ? usd(f.monthly) : 'that')
    .replace(/\{mind\}/g, f.mind ?? 'your mind')
    .replace(/\{app\}/g, f.app ?? 'your app')
}

// ---------------------------------------------------------------- refusals

/** One plain sentence for every refusal the journey can meet. `host` is a guest's host or the hive's owner. */
export function refusalSentence(code: string, ctx: { path: FlPath; host: string; limit?: MonthlyLimit | null; fallback?: string }): string {
  const { host } = ctx
  switch (code) {
    case 'no_key_grant':
      return 'This mind runs on someone else’s key, and they haven’t given you a limit on it. Ask them for one.'
    case 'own_key_required':
      return 'Here you use your own key. Add a key of your own for this model’s company first.'
    case 'owner_only':
      return 'Only this hive’s owner can do that.'
    case 'owner_present':
      return 'This hive already has an owner, so it can’t be claimed.'
    case 'invite_unavailable':
      return 'That invitation can’t be used any more. Ask whoever sent it for a new one.'
    case 'no_model':
      return 'Your mind has no model it can think with yet. Choose one for it on its page.'
    case 'no_key':
      return ctx.path === 'guest' ? `Your mind can’t wake yet: there’s no key for its model in ${host}’s hive. Ask ${host}.` : 'Your mind can’t wake yet: it has nothing to think with. Add a key of your own, then wake it here.'
    case 'no_budget':
      return ctx.path === 'guest' ? `Your mind can’t wake yet: ${host} hasn’t set a limit for you. Ask ${host} for one.` : 'Your mind can’t wake yet: no monthly limit is in force for you, so there is nothing for it to spend from.'
    case 'spend_limit':
      return ctx.path === 'guest' && ctx.limit?.limit_usd != null
        ? `You’ve reached your ${cents(ctx.limit.limit_usd)} limit in ${host}’s hive this month, so your mind can’t wake. Ask ${host} for more, or start your own hive later.`
        : 'You’ve reached your spending limit for now, so your mind can’t think until it resets or is raised.'
    case 'hive_limit':
      return 'The hive has reached its own spending cap, so minds can’t think until it is raised.'
    case 'cannot_wake':
      return 'Your mind couldn’t wake just now. Nothing was sent.'
    case 'egress_refused':
      return 'Your mind’s swarm keeps its thinking on this machine, and its model isn’t a local one. Choose a local model for it.'
    case 'stale_onboarding':
      return 'Your setup changed in another window. Here is where it stands now.'
    case 'already_asked':
      return `You’ve already asked ${host}; ${host} decides.`
    case 'key_owner_only':
      return 'Only the person who owns a key sets its limits.'
    case 'bad_limit':
      return 'A monthly limit is an amount from $0 to $1,000,000.'
    case 'not_on_this_hive':
      return 'This hive doesn’t offer that yet, so this part can’t be done here.'
    case 'network':
      return 'I can’t reach your hive just now. Nothing is lost.'
    default:
      return ctx.fallback && ctx.fallback.trim() ? ctx.fallback : 'That didn’t work, and nothing was changed.'
  }
}

/** Refusal codes the journey gives a plain sentence of its own (the rest show the host's message). */
export const REFUSAL_CODES = ['no_key_grant', 'own_key_required', 'owner_only', 'owner_present', 'invite_unavailable', 'no_model', 'no_key', 'no_budget', 'spend_limit', 'hive_limit', 'cannot_wake'] as const

// ---------------------------------------------------------------- the hello

/** How long after our own Wake a GET that finds no hello is read as "still waking", not as lost. */
export const TRANSIENT_MS = 15000

export type HelloPhase = 'idle' | 'waking' | 'still-waking' | 'waiting' | 'greeted' | 'lost'

export interface HelloView {
  phase: HelloPhase
  /** the mind's own words, only once the host says it greeted */
  greeting: string | null
  /** "Try again": only when the host says the hello is retryable */
  tryAgain: boolean
  line: string
}

/**
 * What the hello shows. `hello`: the host's latest answer (null: none read, or a GET found none). `postedAt`: when our
 * own Wake was pressed (null: not pressed here). A null GET within TRANSIENT_MS after our Wake is "Still waking…".
 */
export function helloView(hello: Hello | null, postedAt: number | null, now: number, mindName: string | null): HelloView {
  const mind = mindName ?? 'Your mind'
  if (hello && hello.state === 'greeted' && hello.greeting && hello.greeting.text.trim())
    return { phase: 'greeted', greeting: hello.greeting.text, tryAgain: false, line: `${hello.mind.name || mind}, in its own words.` }
  if (hello) return { phase: 'waiting', greeting: null, tryAgain: hello.retryable === true, line: hello.retryable === true ? `${mind} hasn’t answered, and its hello can be sent again.` : `${mind} is waking. Its first words will show here as soon as it says them.` }
  if (postedAt !== null && now - postedAt <= TRANSIENT_MS) return { phase: 'still-waking', greeting: null, tryAgain: false, line: 'Still waking…' }
  if (postedAt !== null) return { phase: 'lost', greeting: null, tryAgain: false, line: `I can’t find ${mind === 'Your mind' ? 'your mind' : mind}’s hello on the hive. Press Wake to ask again.` }
  return { phase: 'idle', greeting: null, tryAgain: false, line: '' }
}

/** A greeting may show only when the mind can answer and has: the host says greeted, with its own words. */
export const canShowGreeting = (hello: Hello | null): boolean => !!hello && hello.state === 'greeted' && !!hello.greeting?.text.trim()
