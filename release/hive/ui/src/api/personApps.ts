import { ApiError } from './client'

/**
 * P14: a person app (manifest `placement: "person"`) always opens in the person's own private context. `helpers` says
 * what its one template still needs: nothing (`none`, `ready`), the host key card (`key_required`) or P2's card
 * (`consent_required`, with a display-only `space_line`). Anything else is a failure, shown only as a fixed reason.
 */
export interface PersonAppOpen {
  state: 'ready'
  program: string
  swarm_id: string
  needs: PersonAppNeed[]
  helpers: PersonAppHelpers
  space_line?: string
  private: string
}

export type PersonAppHelpers = 'none' | 'ready' | 'consent_required' | 'key_required'
const HELPERS: readonly PersonAppHelpers[] = ['none', 'ready', 'consent_required', 'key_required']

export type PersonAppNeed = 'ai_key' | 'monthly_total'

/** The install screen's view of one app (admins also see the release and the recorded review). */
export interface AppInstallStatus {
  program: string
  placement: 'person' | 'swarm'
  installed: boolean
  release_digest?: string | null
  person_allow?: 'all' | string[] | null
  templates?: number | null
  review?: { release_digest: string; placement: string; by: string; at: string; person_allow: 'all' | string[]; revoked: boolean } | null
}

export interface AppInstallBody {
  release_digest: string
  placement: 'person' | 'swarm'
  person_allow?: 'all' | string[]
  use_in?: string[]
}

export type PersonAppAction = 'back' | 'ask_admin' | 'set_up_again' | 'try_again'

/** The approved reasons, with this page's own fixed words: nothing the host (or a fault) sends is ever shown. */
export const PERSON_APP_REASONS = {
  not_available_to_you: { text: "This app isn't available to you.", action: 'back' },
  app_turned_off: { text: 'This app was turned off by an admin.', action: 'ask_admin' },
  not_reviewed: { text: "An admin hasn't finished installing this app yet.", action: 'ask_admin' },
  release_changed: { text: 'This app was updated and needs an admin to review it again.', action: 'ask_admin' },
  space_needs_setup: { text: "Your space for this app can't be used any more.", action: 'set_up_again' },
  space_failed: { text: "Your hive couldn't create your space.", action: 'try_again' },
  busy: { text: 'Your hive is busy. Try again in a moment.', action: 'try_again' },
} as const satisfies Record<string, { text: string; action: PersonAppAction }>

export type PersonAppReason = keyof typeof PERSON_APP_REASONS

export const ACTION_LABEL: Record<PersonAppAction, string> = {
  back: 'Back to Apps', ask_admin: 'Back to Apps', set_up_again: 'Set up again', try_again: 'Try again',
}

const NEEDS: readonly PersonAppNeed[] = ['ai_key', 'monthly_total']
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const needs = (v: unknown): v is PersonAppNeed[] => Array.isArray(v) && v.every((n) => NEEDS.includes(n as PersonAppNeed))

/** A strict reader: the wrong app, a state this page does not know or a malformed field is not an answer. */
export function readPersonAppOpen(raw: unknown, program: string): PersonAppOpen | null {
  if (!record(raw) || raw.program !== program || raw.state !== 'ready' || typeof raw.swarm_id !== 'string' || !raw.swarm_id ||
      !needs(raw.needs) || typeof raw.private !== 'string' || !HELPERS.includes(raw.helpers as PersonAppHelpers)) return null
  const helpers = raw.helpers as PersonAppHelpers
  if (helpers === 'consent_required' && typeof raw.space_line !== 'string') return null
  return { state: 'ready', program, swarm_id: raw.swarm_id, needs: [...raw.needs], helpers, private: raw.private,
    ...(helpers === 'consent_required' ? { space_line: (raw.space_line as string).slice(0, 400) } : {}) }
}

/** Which approved reason a failure is; an unknown code, a lost answer or a fault is "couldn't create your space". */
export function personAppReason(error: unknown): PersonAppReason {
  if (error instanceof ApiError && error.code === 'app_unavailable') {
    const reason = error.envelope?.reason
    if (typeof reason === 'string' && Object.prototype.hasOwnProperty.call(PERSON_APP_REASONS, reason)) return reason as PersonAppReason
  }
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return 'not_available_to_you'
  return 'space_failed'
}

/** What installing sends: exactly the release and placement shown, the audience chosen, the swarms picked ("Use in"). */
export function installBody(status: AppInstallStatus, choice: { everyone: boolean; people: string[]; useIn: string[] }): AppInstallBody | null {
  if (!status.release_digest) return null
  const body: AppInstallBody = { release_digest: status.release_digest, placement: status.placement }
  if (status.placement === 'person') {
    if (!choice.everyone) {
      if (!choice.people.length) return null
      body.person_allow = [...new Set(choice.people)].sort()
    }
  } else if (choice.useIn.length) {
    body.use_in = [...new Set(choice.useIn)]
  }
  return body
}
