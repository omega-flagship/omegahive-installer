import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { Visibility } from '../api/types'
import { useAdminPeople } from '../lib/adminPeople'
import { useEscape } from '../lib/hooks'
import { useHive } from '../store/store'
import { anchoredBox } from './anchoredBox'
import { Icon } from './Icon'
import { Button, Segmented } from './primitives'
import { useModalContainment } from './useModalContainment'

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
  // only an admin may list the hive's people; a member sees the no-one line without asking (lib/adminPeople)
  const people = useAdminPeople(value.visibility === 'shared')
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
  const anchor = useRef<HTMLDivElement>(null)
  return (
    <div className="relative" ref={anchor}>
      <Button variant="subtle" onClick={() => { setDraft(current); setOpen(!open) }} aria-expanded={open}
        aria-label={`Who can see this: ${current.visibility}`} title={iconOnly ? `Who can see this: ${current.visibility}` : undefined}
        className={iconOnly ? 'min-h-11 min-w-11 !px-0 text-[12.5px]' : 'min-h-9 px-3 text-[12.5px] capitalize'}>
        <Icon name={icon as never} size={iconOnly ? 16 : 14} />{!iconOnly && ` ${current.visibility}`}
      </Button>
      {open && (
        <AnchoredDialog anchor={anchor} label="Who can see this" onClose={() => setOpen(false)}>
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
        </AnchoredDialog>
      )}
    </div>
  )
}

/**
 * The box a button opens, drawn on the page above every panel and placed from the button (ui/anchoredBox): drawn inside
 * a mind panel it was cut in half where the panel hides overflow. It is a modal dialog (ui/useModalContainment): focus
 * moves into it when it opens, Tab stays inside it, the page under it is inert, and when it closes focus goes back to
 * the button that opened it. Escape closes it.
 */
function AnchoredDialog({ anchor, label, onClose, children }: { anchor: RefObject<HTMLElement | null>; label: string; onClose: () => void; children: ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    const placeIt = () => {
      const b = anchor.current?.getBoundingClientRect()
      const x = boxRef.current?.getBoundingClientRect()
      if (b && x) setPlace(anchoredBox(b, { width: x.width, height: x.height }, { width: window.innerWidth, height: window.innerHeight }))
    }
    placeIt()
    window.addEventListener('resize', placeIt)
    return () => window.removeEventListener('resize', placeIt)
  }, [anchor])
  useEscape(onClose)
  useModalContainment(boxRef, { restoreFocus: () => anchor.current?.querySelector<HTMLElement>('button') ?? null })
  return createPortal(
    <div ref={boxRef} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} style={place ?? { top: 0, left: 0, opacity: 0 }}
      className="glass-strong fixed z-[80] w-80 max-w-[calc(100vw-1rem)] space-y-3 rounded-2xl border border-line !bg-[#0b0b22]/[0.97] p-4 outline-none">
      {children}
    </div>,
    document.body,
  )
}
