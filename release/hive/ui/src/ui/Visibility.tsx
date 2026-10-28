import { useEffect, useState } from 'react'
import type { Person } from '../api/client'
import type { Visibility } from '../api/types'
import { useHive } from '../store/store'
import { Icon } from './Icon'
import { Button, Segmented } from './primitives'

export interface VisibilityValue {
  visibility: Visibility
  shared_with: string[]
}

const WORDS: Record<Visibility, string> = {
  private: 'Only you (and the hive’s admins)',
  shared: 'You and the people you choose',
  public: 'Everyone signed in to this hive',
}

/** Choose who can see a mind or swarm: private, shared with named people, or public. Admins always can. */
export function VisibilityPicker({ value, onChange, label = 'Who can see it' }: { value: VisibilityValue; onChange: (v: VisibilityValue) => void; label?: string }) {
  const client = useHive((s) => s.client)
  const [people, setPeople] = useState<Person[] | null>(null)
  useEffect(() => {
    if (value.visibility !== 'shared' || people || !client?.listPeople) return
    void client.listPeople().then((d) => setPeople(d.people)).catch(() => setPeople([]))
  }, [value.visibility, client, people])
  return (
    <fieldset className="space-y-2">
      <legend className="text-[12.5px] text-ink-3">{label}</legend>
      <Segmented
        label={label}
        value={value.visibility}
        onChange={(v) => onChange({ ...value, visibility: v as Visibility })}
        options={[
          { value: 'private', label: 'Private' },
          { value: 'shared', label: 'Shared' },
          { value: 'public', label: 'Public' },
        ]}
      />
      <p className="text-[12px] text-ink-4">{WORDS[value.visibility]}</p>
      {value.visibility === 'shared' && (
        <div className="flex flex-wrap gap-2">
          {people === null ? (
            <span className="text-[12px] text-ink-4">Loading people…</span>
          ) : people.length === 0 ? (
            <span className="text-[12px] text-ink-4">No one else here yet. Invite people from People first.</span>
          ) : (
            people.map((p) => {
              const principal = `user:${p.id}`
              const on = value.shared_with.includes(principal)
              return (
                <label key={p.id} className="flex items-center gap-2 rounded-xl border border-line px-3 py-1.5 text-[13px] text-ink">
                  <input type="checkbox" checked={on}
                    onChange={(e) => onChange({ ...value, shared_with: e.target.checked ? [...value.shared_with, principal] : value.shared_with.filter((x) => x !== principal) })} />
                  {p.name || p.email}
                </label>
              )
            })
          )}
        </div>
      )}
    </fieldset>
  )
}

/** A chip showing who can see something, which opens the picker to change it (owner or admin). */
/** `iconOnly`: the button shows its icon alone (its name stays in the label), for a phone's crowded row. */
export function VisibilityControl({ kind, id, value, iconOnly = false }: { kind: 'agent' | 'swarm'; id: string; value?: VisibilityValue; iconOnly?: boolean }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const current: VisibilityValue = { visibility: value?.visibility ?? 'public', shared_with: value?.shared_with ?? [] }
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(current)
  const [busy, setBusy] = useState(false)
  const setter = kind === 'agent' ? client?.setAgentVisibility : client?.setSwarmVisibility
  const save = (v: VisibilityValue) => (kind === 'agent' ? client!.setAgentVisibility!(id, v) : client!.setSwarmVisibility!(id, v))
  const icon = current.visibility === 'public' ? 'people' : current.visibility === 'shared' ? 'link' : 'shield'
  return (
    <div className="relative">
      <Button variant="subtle" onClick={() => { setDraft(current); setOpen(!open) }} aria-expanded={open}
        aria-label={`Who can see this: ${current.visibility}`} title={iconOnly ? `Who can see this: ${current.visibility}` : undefined}
        className={iconOnly ? 'min-h-11 min-w-11 !px-0 text-[12.5px]' : 'min-h-9 px-3 text-[12.5px] capitalize'}>
        <Icon name={icon as never} size={iconOnly ? 16 : 14} />{!iconOnly && ` ${current.visibility}`}
      </Button>
      {open && (
        <div className="glass-strong absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] space-y-3 rounded-2xl border border-line !bg-[#0b0b22]/[0.97] p-4">
          <VisibilityPicker value={draft} onChange={setDraft} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={busy || !setter}
              onClick={async () => {
                setBusy(true)
                try {
                  await save(draft)
                  toast({ tone: 'success', title: `Now ${draft.visibility}` })
                  setOpen(false)
                } catch (e) {
                  toast({ tone: 'error', title: 'Could not change who can see it', body: e instanceof Error ? e.message : String(e) })
                } finally {
                  setBusy(false)
                }
              }}>
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
