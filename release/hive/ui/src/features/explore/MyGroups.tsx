import { ApiError, type HiveClient } from '../../api/client'
import type { ExploreGroupDef } from '../../api/types'
import { errorMessage } from '../../lib/useResource'
import { askConfirmBound, bindEpoch } from '../../lib/identityEpoch'
import type { ToastFn } from '../../lib/epochBound'

/**
 * My Explore groups: rename or delete one (PUT / DELETE /api/explore/groups/{id}). Groups are private to the person who
 * made them; deleting one removes only the group, never its members. The screen that shows them is explore.metta's
 * explore-group, composed per group (data.ts groupItem); these are the name rule and the two writes it presses.
 */

/** The host's group name rule (explore.py save_group): trimmed, 1..60 characters. Null when fine. Pure. */
export function groupNameProblem(name: string, others: ExploreGroupDef[], self?: string): string | null {
  const n = name.trim()
  if (!n) return 'A group needs a name.'
  if (n.length > 60) return 'At most 60 characters.'
  if (others.some((g) => g.id !== self && g.name.toLowerCase() === n.toLowerCase())) return 'You already have a group with that name.'
  return null
}

export interface GroupDeps {
  client: HiveClient | null
  setGroups: (fn: (g: ExploreGroupDef[]) => ExploreGroupDef[]) => void
  setEditing: (id: string | null) => void
  onChanged: () => void
  setBusy: (on: boolean) => void
  toast: ToastFn
}

const failWords = (e: unknown) => (e instanceof ApiError && e.status === 404 ? 'That group is no longer yours or no longer exists. Nothing changed.' : errorMessage(e))

/** Rename one of my groups (PUT); the answer is written only for the person who renamed it (r5). */
export async function renameGroup(d: GroupDeps, g: ExploreGroupDef, name: string): Promise<void> {
  if (!d.client?.renameExploreGroup) return
  const binding = bindEpoch()
  d.setBusy(true)
  try {
    const out = await d.client.renameExploreGroup(g.id, name.trim())
    binding.commit(() => {
      d.setGroups((gs) => gs.map((x) => (x.id === out.id ? { id: out.id, name: out.name, members: out.members } : x)).sort((a, b) => a.name.localeCompare(b.name)))
      d.setEditing(null)
      d.onChanged()
    })
  } catch (e) {
    binding.commit(() => d.toast({ tone: 'error', title: 'Could not rename the group', body: failWords(e) }))
  } finally {
    // back to idle: a reset, never the earlier person's data, so it runs for whoever is here now
    d.setBusy(false)
  }
}

/** Delete one of my groups (DELETE) after a confirm bound to the same identity; written only for that person (r5). */
export async function removeGroup(d: GroupDeps, g: ExploreGroupDef): Promise<void> {
  if (!d.client?.deleteExploreGroup) return
  const binding = bindEpoch()
  if (!(await askConfirmBound(`Delete your group “${g.name}”? Its ${g.members.length} member${g.members.length === 1 ? '' : 's'} stay as they are; only the group goes.`, 'Delete group', { danger: true, binding }))) return
  if (!binding.current()) return
  d.setBusy(true)
  try {
    await d.client.deleteExploreGroup(g.id)
    binding.commit(() => {
      d.setGroups((gs) => gs.filter((x) => x.id !== g.id))
      d.onChanged()
      d.toast({ tone: 'success', title: `Deleted “${g.name}”` })
    })
  } catch (e) {
    binding.commit(() => d.toast({ tone: 'error', title: 'Could not delete the group', body: failWords(e) }))
  } finally {
    d.setBusy(false)
  }
}
