import { useState } from 'react'
import { ApiError, type HiveClient } from '../../api/client'
import type { ExploreGroupDef } from '../../api/types'
import { errorMessage } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { askConfirmBound, bindEpoch } from '../../lib/identityEpoch'
import type { ToastFn } from '../../lib/epochBound'
import { Button } from '../../ui/primitives'

/** The host's group name rule (explore.py save_group): trimmed, 1..60 characters. Null when fine. Pure. */
export function groupNameProblem(name: string, others: ExploreGroupDef[], self?: string): string | null {
  const n = name.trim()
  if (!n) return 'A group needs a name.'
  if (n.length > 60) return 'At most 60 characters.'
  if (others.some((g) => g.id !== self && g.name.toLowerCase() === n.toLowerCase())) return 'You already have a group with that name.'
  return null
}

interface GroupDeps {
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

/**
 * My Explore groups: rename or delete one (PUT / DELETE /api/explore/groups/{id}; Surface missing-UI batch 1, audit
 * item 14). Groups are private to the person who made them; deleting one removes only the group, never its members.
 */
export function MyGroups({ groups, setGroups, onChanged }: { groups: ExploreGroupDef[]; setGroups: (fn: (g: ExploreGroupDef[]) => ExploreGroupDef[]) => void; onChanged: () => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  // r5: every completion after an await is written through the binding made when the person acted (lib/identityEpoch)
  const deps = { client, setGroups, setEditing, onChanged, setBusy, toast }
  const rename = (g: ExploreGroupDef) => {
    if (groupNameProblem(draft, groups, g.id)) return
    return renameGroup(deps, g, draft)
  }
  const remove = (g: ExploreGroupDef) => removeGroup(deps, g)

  return (
    <section aria-labelledby="my-groups-h" className="rounded-2xl border border-line bg-white/[0.02] p-3" data-my-groups>
      <h2 id="my-groups-h" className="text-[13px] font-medium text-ink">My groups <span className="text-ink-4">(only you see these)</span></h2>
      {groups.length === 0 ? (
        <p className="mt-1 text-[12.5px] text-ink-4">No groups yet. Add one from any row’s “Groups and tags”.</p>
      ) : (
        <ul className="mt-1 divide-y divide-line">
          {groups.map((g) => {
            const problem = editing === g.id ? groupNameProblem(draft, groups, g.id) : null
            return (
              <li key={g.id} className="flex flex-wrap items-center gap-2 py-1.5 text-[13px]">
                {editing === g.id ? (
                  <form className="flex min-w-0 flex-1 flex-wrap items-center gap-2" onSubmit={(e) => (e.preventDefault(), void rename(g))}>
                    <input autoFocus value={draft} maxLength={60} onChange={(e) => setDraft(e.target.value)} aria-label={`New name for ${g.name}`} aria-invalid={!!problem}
                      className="min-h-9 min-w-[160px] flex-1 rounded-lg border border-line bg-black/25 px-2.5 text-[13px] text-ink" />
                    <Button type="submit" variant="primary" className="min-h-9 px-3 text-[12.5px]" disabled={busy || !!problem}>Save</Button>
                    <Button type="button" variant="ghost" className="min-h-9 px-3 text-[12.5px]" onClick={() => setEditing(null)}>Cancel</Button>
                    {problem && <span className="basis-full text-[12px] text-bad">{problem}</span>}
                  </form>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-ink-2">
                      {g.name} <span className="text-ink-4">· {g.members.length}</span>
                    </span>
                    {client?.renameExploreGroup && (
                      <Button variant="ghost" className="min-h-9 px-2.5 text-[12px]" disabled={busy} onClick={() => (setEditing(g.id), setDraft(g.name))} aria-label={`Rename ${g.name}`}>
                        Rename
                      </Button>
                    )}
                    {client?.deleteExploreGroup && (
                      <Button variant="ghost" className="min-h-9 px-2.5 text-[12px] text-bad" disabled={busy} onClick={() => void remove(g)} aria-label={`Delete ${g.name}`}>
                        Delete…
                      </Button>
                    )}
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
