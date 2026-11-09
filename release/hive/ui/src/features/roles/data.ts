import type { Agent, Role } from '../../api/types'
import { shown } from '../../lib/displayName'
import { money } from '../../lib/format'
import { plural } from '../../lib/plural'
import type { ResourceStatus } from '../../lib/useResource'
import type { ScreenFacts } from '../../screens/screenSpace'
import { withResource } from '../../screens/resourceFacts'

/**
 * What the Roles screens are told: the values they draw (bound by path) and this moment's facts (counts and flags)
 * from which MeTTa composes them (roles.metta). Pure.
 */
export type RolesState = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported'
export interface RolesLoad { state: RolesState; roles: Role[] | null; error: unknown }

/** A role's prompt as a mind reads it: {name}, {swarm} and {purpose} filled in. */
export const renderRole = (prompt: string, name: string, swarm: string, purpose: string) =>
  prompt.replace(/\{(name|swarm|purpose)\}/g, (_, k: string) => (k === 'name' ? name : k === 'swarm' ? swarm || 'this hive' : purpose))

/** A role's own colour, from its name: the same name always gets the same hue (0–359). */
export const hueOf = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 11)

/** Where the library is: still loading, failed, not offered by this hive, empty, or ready. */
export function rolesStatus(load: RolesLoad): ResourceStatus {
  if (load.state === 'unsupported') return 'unsupported'
  if (load.state === 'error') return 'error'
  if (load.state === 'ready' && load.roles) return load.roles.length ? 'ready' : 'empty'
  return 'loading'
}

export interface RoleRow { id: string; title: string; summary: string; kind: string; minds: string; hue: number }

/** The library: its rows (each with its colour), the open role's id, and the facts that pick its parts. */
export function rolesScreen(load: RolesLoad, canCreate: boolean, open = ''): { data: Record<string, unknown>; facts: ScreenFacts } {
  const status = rolesStatus(load)
  const loaded = status === 'ready' || status === 'empty'
  const all: RoleRow[] = (loaded ? load.roles ?? [] : []).map((r) => ({
    id: r.id,
    title: shown(r.name),
    summary: r.summary || 'No summary',
    kind: r.builtin ? 'built in' : '',
    minds: r.minds.length > 0 ? plural(r.minds.length, 'mind') : '',
    hue: hueOf(r.name),
  }))
  return withResource({ status, error: load.error }, {
    data: { 'roles.all': all, 'roles.open': open },
    facts: { counts: { 'roles.all': all.length }, flags: { 'roles.can-create': canCreate } },
  })
}

export interface MindRow { id: string; name: string; spent: string; hue: number; status: string }

/** The open role (or none): the minds that have it, in the role's own order. */
export function roleScreen(role: Role | null, agents: Record<string, Agent>): { data: Record<string, unknown>; facts: ScreenFacts } {
  const minds: MindRow[] = (role?.minds ?? [])
    .map((id) => agents[id])
    .filter(Boolean)
    .map((a) => ({ id: a.id, name: shown(a.name), spent: money(a.spent_usd), hue: a.hue, status: a.status }))
  return {
    data: { 'role.minds': minds },
    facts: { counts: { 'role.minds': minds.length }, flags: { 'role.picked': role !== null } },
  }
}
