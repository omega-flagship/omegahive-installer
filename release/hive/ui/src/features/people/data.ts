import type { Invite, Person } from '../../api/client'
import { ago } from '../../lib/format'
import type { ResourceState } from '../../lib/useResource'
import { withResource } from '../../screens/resourceFacts'
import type { ScreenFacts, ScreenPlan } from '../../screens/screenSpace'
import type { ShownPassword } from './memberPassword'

/**
 * What the People screens are told (people.metta): the values they draw, bound by path, and this moment's facts
 * (counts, flags and known values) from which MeTTa composes them. Each person is composed as their own small screen,
 * and the people screen stacks them. Pure: composing, times and dates are handed in.
 */
export type PeopleData = { people: Person[]; invites: Invite[]; google_ready: boolean; member_passwords?: boolean }
/** Composes one screen for the look being worn. */
export type Compose = (screen: string, facts: ScreenFacts) => ScreenPlan
export interface Composed { data: Record<string, unknown>; facts: ScreenFacts }
/** One row of a stack: its id, the screen MeTTa composed for it, and the values that screen draws. */
export interface StackItem { id: string; plan: ScreenPlan; data: Record<string, unknown> }

/** What this hive's client offers (each a method it has). */
export interface Can {
  invite: boolean
  addMember: boolean
  revokeInvite: boolean
  updatePerson: boolean
  clearGoogle: boolean
  resetPassword: boolean
  removePassword: boolean
}
/** Who is looking: an admin or not, and their own person id (null when the hive does not say). */
export interface Viewer { admin: boolean; selfId: string | null }
/** An invitation just made, with the link shown only now; copied once the person has copied it. */
export type FreshInvite = Invite & { link: string; copied: boolean }
/** What the page is showing just now: a fresh invitation link, and a member password shown once. */
export interface Moment { invite: FreshInvite | null; password: (ShownPassword & { copied: boolean }) | null }
/** How times read: when someone was last seen, and the day an invitation expires. */
export interface Names { seen?: (iso: string) => string; day?: (unixSeconds: number) => string }

const OPERATOR_ID = 'hive-operator'
/** The operator's orb, and each person's: a steady hue from their email. */
const OPERATOR_HUE = 150
export const hueOf = (s: string): number => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
const ROLES = new Set<string>(['admin', 'member'])

export const pendingOf = (d: Pick<PeopleData, 'invites'>): Invite[] => d.invites.filter((i) => i.status === 'pending')
const who = (p: { name: string; email: string }) => p.name || p.email

/** The page-wide facts each person's screen also reads. */
function sharedFlags(data: PeopleData, viewer: Viewer, can: Can): Record<string, boolean> {
  return {
    'viewer.admin': viewer.admin,
    'passwords.on': data.member_passwords === true,
    'can.update': can.updatePerson,
    'can.clear_google': can.clearGoogle,
    'can.reset_password': can.resetPassword,
    'can.remove_password': can.removePassword,
  }
}

export function personItem(p: Person, shared: Record<string, boolean>, viewer: Viewer, names: Names, compose: Compose): StackItem {
  const seen = names.seen ?? ((iso: string) => ago(iso))
  const self = viewer.selfId !== null && viewer.selfId === p.id
  return {
    id: p.id,
    plan: compose('people-person', {
      flags: {
        ...shared,
        'person.self': self,
        'person.disabled': p.disabled,
        'person.google': p.google_bound === true,
        'person.password': p.password_set === true,
      },
      // a role MeTTa knows, compared as data ((is person.role member)); any other role states none
      values: ROLES.has(p.role) ? { 'person.role': p.role } : {},
    }),
    data: {
      'person.name': who(p),
      'person.you': self ? 'you' : '',
      'person.hue': hueOf(p.email),
      'person.status': p.disabled ? 'stopped' : 'awake',
      'person.disabled': p.disabled,
      'person.sub': `${p.email}${p.last_seen_at ? ` · seen ${seen(p.last_seen_at)}` : ' · not signed in yet'}`,
      'person.role': p.role,
      'person.role_word': p.role.charAt(0).toUpperCase() + p.role.slice(1),
      'person.role_label': `Role of ${who(p)}`,
    },
  }
}

/** The email the person may send with a fresh invitation: a mail link, nothing sent from the hive. */
export function inviteMail(inv: Pick<Invite, 'email' | 'name' | 'expires_at'> & { link: string }, names: Names = {}): string {
  const day = names.day ?? ((s: number) => new Date(s * 1000).toLocaleDateString())
  const first = (inv.name || '').split(' ')[0]
  const subject = 'An invitation to OmegaHive'
  const body = `${first ? `Hi ${first},\n\n` : ''}I'd like you to join my OmegaHive, a living hive of AI minds.\n\nAccept here with your Google account (${inv.email}):\n${inv.link}\n\nThe link works once and expires ${day(inv.expires_at)}.\n`
  return `mailto:${encodeURIComponent(inv.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

export function inviteItem(i: Invite, names: Names): Record<string, unknown> {
  const day = names.day ?? ((s: number) => new Date(s * 1000).toLocaleDateString())
  return { id: i.id, icon: 'send', title: who(i), meta: `${i.email} · ${i.role} · expires ${day(i.expires_at)}`, withdraw: 'Withdraw' }
}

/** The people screen: how the list stands, the forms and what they just made, invitations, and everyone in the hive. */
export function peopleScreen(res: ResourceState<PeopleData>, viewer: Viewer, can: Can, moment: Moment, names: Names, compose: Compose): Composed {
  const d = (res.status === 'ready' || res.status === 'empty') && res.data ? res.data : null
  const pw = moment.password
  const flags: Record<string, boolean> = {
    'people.loaded': d !== null,
    'invite.fresh': moment.invite !== null,
    'invite.copied': moment.invite?.copied === true,
    'password.shown': pw !== null,
    'password.copied': pw?.copied === true,
    'password.ended': pw?.reason === 'reset' && (pw.endedSessions ?? 0) > 0,
    'can.invite': can.invite,
    'can.add_member': can.addMember,
    'can.withdraw': can.revokeInvite,
  }
  const data: Record<string, unknown> = {}
  if (pw) {
    const whom = who(pw)
    const signIn = `They sign in with ${pw.email} and this password.`
    Object.assign(data, {
      'password.value': pw.password,
      'password.added_title': `${whom} is a member. Their password:`,
      'password.reset_title': `New password for ${whom}:`,
      'password.note': signIn,
      'password.note_ended': `${signIn} Their earlier password sign-ins ended (${pw.endedSessions ?? 0}).`,
    })
  }
  if (moment.invite) {
    Object.assign(data, {
      'invite.title': `Invitation ready for ${moment.invite.email}`,
      'invite.link': moment.invite.link,
      'invite.mail': inviteMail(moment.invite, names),
    })
  }
  const values: Record<string, string> = pw ? { 'password.reason': pw.reason } : {}
  if (!d) return withResource(res, { data, facts: { flags, values } })

  const shared = sharedFlags(d, viewer, can)
  Object.assign(flags, shared, { 'google.ready': d.google_ready })
  const pending = pendingOf(d).map((i) => inviteItem(i, names))
  const operator: StackItem = { id: OPERATOR_ID, plan: compose('people-operator', {}), data: { 'operator.hue': OPERATOR_HUE } }
  const rows = [operator, ...d.people.map((p) => personItem(p, shared, viewer, names, compose))]
  Object.assign(data, { 'invites.pending': pending, 'people.rows': rows })
  return withResource(res, { data, facts: { flags, values, counts: { 'invites.pending': pending.length } } })
}
