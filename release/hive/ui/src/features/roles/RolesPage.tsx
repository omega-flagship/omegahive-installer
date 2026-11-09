import { useEffect, useMemo } from 'react'
import type { Role } from '../../api/types'
import { navigate, useRoute } from '../../lib/router'
import { actionFailure, has, need } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { useLook } from '../../shell/uiVariant'
import { experienceById } from '../../experiences/registry'
import { Page } from '../../ui/Page'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { roleScreen, rolesScreen } from './data'
import { RoleCommandsIsland, RoleFormIsland } from './RoleEditor'
import { useRoleDraft } from './useRoleDraft'

/**
 * #/roles and #/roles/<id>: the role library, and one role open beside it. A role sets a mind's prompt, defaults and
 * approval rules; edits reach every mind that has it. Both screens are atoms (roles.metta) that MeTTa composes for the
 * look being worn (loading, New role and the open row included); this page loads the data, states the facts, places
 * the editor island, and carries out a press.
 */
export default function RolesPage() {
  const route = useRoute()
  const roles = useHive((s) => s.roles)
  const rolesState = useHive((s) => s.rolesState)
  const rolesError = useHive((s) => s.rolesError)
  const loadRoles = useHive((s) => s.loadRoles)
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const look = experienceById(useLook().current?.experience).id
  const selected = route.name === 'roles' ? route.id : undefined
  useEffect(() => {
    void loadRoles().catch(() => undefined)
  }, [loadRoles, client])
  const current = roles?.find((r) => r.id === selected) ?? null
  const canCreate = has(client, 'createRole')
  const openId = current?.id ?? ''
  const compose = useCompose(look)
  const { plan, data } = useMemo(() => {
    const { data, facts } = rolesScreen({ state: rolesState, roles, error: rolesError }, canCreate, openId)
    return { plan: compose('roles', facts), data }
  }, [rolesState, roles, rolesError, canCreate, openId, compose])

  const create = async () => {
    try {
      const r = await need(client, 'createRole', 'Creating roles')({ name: `New role ${(roles?.length ?? 0) + 1}`, summary: '', prompt: 'You are {name}, a member of {swarm}. ' })
      await loadRoles()
      navigate({ name: 'roles', id: r.id })
    } catch (e) {
      toast(actionFailure(e, 'Could not create the role'))
    }
  }

  return (
    <Page
      title="Roles"
      eyebrow="What shapes a mind"
      label="Roles"
      onClose={() => navigate({ name: 'hive' })}
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 pt-2 pb-12 md:flex-row md:px-6">
        <aside className="md:w-72 md:shrink-0">
          <Screen plan={plan} host={{
            data,
            framed: true,
            onOpen: (target, item) => { if (target === 'role') navigate({ name: 'roles', id: String(item.id) }) },
            onAction: (action) => {
              if (action === 'retry') void loadRoles().catch(() => undefined)
              if (action === 'create-role') void create()
            },
          }} />
        </aside>
        <section className="min-w-0 flex-1">
          <RoleScreen key={current?.id ?? ''} role={current} look={look} />
        </section>
      </div>
    </Page>
  )
}

/** The open role's screen (or "Pick a role"). Keyed by the role, so opening another one starts a fresh draft. */
function RoleScreen({ role, look }: { role: Role | null; look: string }) {
  const agents = useHive((s) => s.agents)
  const draft = useRoleDraft(role)
  const compose = useCompose(look)
  const { plan, data, mindCount } = useMemo(() => {
    const { data, facts } = roleScreen(role, agents)
    return { plan: compose('role', facts), data, mindCount: facts.counts?.['role.minds'] ?? 0 }
  }, [role, agents, compose])
  return (
    <Screen plan={plan} host={{
      data,
      islands: role ? {
        'role-form': <RoleFormIsland role={role} draft={draft} />,
        'role-commands': <RoleCommandsIsland role={role} draft={draft} mindCount={mindCount} />,
      } : undefined,
      framed: true,
      onOpen: (target, item) => { if (target === 'mind') navigate({ name: 'dot', id: String(item.id), tab: 'model' }) },
    }} />
  )
}
