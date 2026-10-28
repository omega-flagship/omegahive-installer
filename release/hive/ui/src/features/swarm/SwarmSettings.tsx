import { AnimatePresence, m } from 'framer-motion'
import { COORDINATOR_PICKER } from './coordinatorPicker'
import { createPortal } from 'react-dom'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ApiError } from '../../api/client'
import type { Swarm, UpdateSwarmBody } from '../../api/types'
import { bindTo, decisionFailure } from '../../lib/decisionGate'
import { shown } from '../../lib/displayName'
import { useEscape, useIsDesktop, useReducedMotion } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import { actionFailure, has, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { useUnsaved } from '../ask/dirty'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { Icon } from '../../ui/Icon'
import { Button } from '../../ui/primitives'
import { VisibilityPicker, type VisibilityValue } from '../../ui/Visibility'
import { useModalContainment } from '../../ui/useModalContainment'
import { notEmptyWords, parentProblem } from './swarmEdit'
import { learnWithMinds, openSwarmDelete, withMindsSupport } from './deleteRequest'
import { deleteActionFor } from './deleteWithMinds'

/** Hives without the archive routes answer 404; then the control stays hidden for the session. */
let archiveMissing = false

/** The swarm page's Settings button: admins only (the hive refuses everyone else). */
export function SwarmSettingsButton({ swarm, iconOnly, startOpen }: { swarm: Swarm; iconOnly?: boolean; startOpen?: boolean }) {
  const client = useHive((s) => s.client)
  const me = useResource(() => need(client, 'me')(), { isEmpty: () => false })
  const admin = me.data ? me.data.kind === 'password' || me.data.role === 'admin' : false
  const [open, setOpen] = useState(!!startOpen)
  if (!admin || !has(client, 'updateSwarm')) return null
  return (
    <>
      <Button variant="subtle" icon="edit" aria-label="Swarm settings" onClick={() => setOpen(true)}>
        {iconOnly ? null : 'Settings'}
      </Button>
      <AnimatePresence>{open && <SwarmSettings swarm={swarm} onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  )
}

type Danger = { kind: 'delete' | 'archive' | 'restore'; seen: Swarm }

function SwarmSettings({ swarm, onClose }: { swarm: Swarm; onClose: () => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const live = useHive((s) => s.swarms[swarm.id])
  const desktop = useIsDesktop()
  const reduced = useReducedMotion()
  const id = useId()
  const head = useRef<HTMLHeadingElement>(null)
  const [name, setName] = useState(swarm.name)
  const [description, setDescription] = useState(swarm.description)
  const [coordinator, setCoordinator] = useState(swarm.coordinator_id ?? '')
  const [parent, setParent] = useState(swarm.parent_mind_id ?? '')
  const [vis, setVis] = useState<VisibilityValue>({ visibility: swarm.visibility ?? 'public', shared_with: swarm.shared_with ?? [] })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [danger, setDanger] = useState<Danger | null>(null)
  const [archiveGone, setArchiveGone] = useState(archiveMissing)
  useEscape(() => !busy && !danger && onClose(), !danger)
  const box = useRef<HTMLFormElement>(null)
  // the archive/restore decision stacks above this; closing it makes this the live layer again
  useModalContainment(box)
  useEffect(() => head.current?.focus(), [])

  const s = live ?? swarm
  const members = s.member_ids.map((m) => agents[m]).filter(Boolean)
  const elsewhere = Object.values(agents)
    .filter((a) => a.swarm_id && a.swarm_id !== s.id)
    .sort((a, b) => (a.swarm_id ?? '').localeCompare(b.swarm_id ?? '') || a.name.localeCompare(b.name))
  const parentWhy = parent ? parentProblem(s.id, parent, swarms, agents) : null

  const changes: UpdateSwarmBody = {}
  if (name.trim() !== s.name) changes.name = name.trim()
  if (description !== s.description) changes.description = description
  if ((coordinator || null) !== (s.coordinator_id ?? null)) changes.coordinator_id = coordinator || null
  if ((parent || null) !== (s.parent_mind_id ?? null)) changes.parent_mind_id = parent || null
  const visChanged = vis.visibility !== (s.visibility ?? 'public') || JSON.stringify([...vis.shared_with].sort()) !== JSON.stringify([...(s.shared_with ?? [])].sort())
  const dirty = Object.keys(changes).length > 0 || visChanged
  // unsaved settings hold the orchestrator's page moves as Go cards (features/ask/dirty)
  useUnsaved(dirty)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return setErr('A swarm needs a name.')
    if (parentWhy) return setErr(parentWhy)
    setBusy(true)
    setErr(null)
    try {
      if (Object.keys(changes).length) await need(client, 'updateSwarm', 'Changing a swarm')(s.id, changes)
      if (visChanged) await need(client, 'setSwarmVisibility', 'Who can see it')(s.id, vis)
      toast({ tone: 'success', title: `${shown(name.trim())} saved` })
      onClose()
    } catch (e2) {
      setErr(actionFailure(e2, 'Could not save').body)
    } finally {
      setBusy(false)
    }
  }

  const field = 'mt-1 min-h-11 w-full rounded-xl border border-line bg-black/30 px-3 text-[13.5px] text-ink outline-none focus:border-line-2'
  const archived = !!s.archived_at
  const showArchive = !archiveGone && has(client, archived ? 'restoreSwarm' : 'archiveSwarm')
  // with its minds (host r3, with its read-only preview): while it has minds, or once archived (an earlier delete may
  // have left cleanup pending with no minds left: stand-in r1 P2-1); hidden once this hive is found without it
  const mindsHere = Object.values(agents).filter((a) => a.swarm_id === s.id && a.kind !== 'module').length
  const withMindsAction = deleteActionFor({ minds: mindsHere, archived })
  const showWithMinds = withMindsAction !== null && has(client, 'deleteSwarmWithMinds') && has(client, 'deleteSwarmPreview') && withMindsSupport(client) !== false

  return createPortal(
    <m.div
      className="xc-dress xc-backdrop fixed inset-0 z-[55] flex items-end justify-center bg-[#03030c]/70 p-3 backdrop-blur-[3px] md:items-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={() => !busy && onClose()}
      style={{ paddingBottom: desktop ? undefined : 'calc(var(--sab) + 12px)' }}
    >
      <m.form
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        onSubmit={save}
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: reduced ? 0 : 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, transition: { duration: 0.15 } }}
        className="xc-frame glass-strong thin-scroll relative max-h-[min(90dvh,820px)] w-full max-w-[560px] overflow-y-auto rounded-[24px] p-5"
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="eyebrow">Swarm settings</div>
            <h2 id={`${id}-t`} ref={head} tabIndex={-1} className="mt-0.5 font-display text-[19px] font-semibold outline-none">
              {shown(s.name)}
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex size-10 items-center justify-center rounded-xl text-ink-3 hover:bg-white/[0.07] hover:text-ink">
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="text-[12px] text-ink-3">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className={field} />
          </label>
          <label className="block">
            <span className="text-[12px] text-ink-3">Purpose</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={3} className={`${field} resize-y py-2`} />
          </label>
          <label className="block">
            <span className="text-[12px] text-ink-3">Coordinator: the member that runs this swarm</span>
            <select id={COORDINATOR_PICKER} value={coordinator} onChange={(e) => setCoordinator(e.target.value)} className={field}>
              <option value="">No coordinator</option>
              {members.map((a) => (
                <option key={a.id} value={a.id}>
                  {shown(a.name)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[12px] text-ink-3">Inside a mind: the mind elsewhere that contains this swarm</span>
            <select value={parent} onChange={(e) => setParent(e.target.value)} className={field} aria-invalid={!!parentWhy} aria-describedby={`${id}-p`}>
              <option value="">Not inside any mind (top level)</option>
              {elsewhere.map((a) => (
                <option key={a.id} value={a.id}>
                  {shown(a.name)} · {shown(swarms[a.swarm_id!]?.name ?? a.swarm_id!)}
                </option>
              ))}
            </select>
            <span id={`${id}-p`} className={parentWhy ? 'mt-1 block text-[12px] text-bad' : 'mt-1 block text-[12px] text-ink-4'}>
              {parentWhy ?? 'Swarms nest at most four levels deep, and never inside themselves.'}
            </span>
          </label>
          {has(client, 'setSwarmVisibility') && <VisibilityPicker value={vis} onChange={setVis} />}
        </div>

        <p role="status" aria-live="polite" className="mt-3 min-h-[1em] text-[12.5px] text-bad">
          {err}
        </p>
        <div className="mt-1 flex gap-2">
          <Button type="button" variant="ghost" className="flex-1" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" className="flex-[1.4]" disabled={!dirty || busy || !!parentWhy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>

        <div className="mt-5 space-y-2 rounded-xl border border-bad/20 bg-bad/[0.04] p-3">
          {showArchive && (
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">{archived ? 'Bring it back' : 'Archive'}</div>
                <div className="text-[12px] text-ink-3">{archived ? 'Use it again, with everything it had.' : 'Put it away with its history; bring it back any time.'}</div>
              </div>
              <Button type="button" variant="subtle" onClick={() => setDanger({ kind: archived ? 'restore' : 'archive', seen: { ...s } })}>
                {archived ? 'Restore…' : 'Archive…'}
              </Button>
            </div>
          )}
          {has(client, 'deleteSwarm') && (
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Delete</div>
                <div className="text-[12px] text-ink-3">Only an empty swarm: no minds, tasks, artifacts or swarms inside its minds.</div>
              </div>
              <Button type="button" variant="danger" onClick={() => setDanger({ kind: 'delete', seen: { ...s } })}>
                Delete…
              </Button>
            </div>
          )}
          {showWithMinds && (
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">{withMindsAction === 'delete' ? 'Delete swarm and its minds' : 'Finish deleting this swarm'}</div>
                <div className="text-[12px] text-ink-3">
                  {withMindsAction === 'delete'
                    ? 'Its minds are deleted; the swarm too, or it is archived when it has history. You type its name first.'
                    : 'Finishes a delete that left cleanup pending, then deletes the swarm, or keeps it archived when it has history. You type its name first.'}
                </div>
              </div>
              <Button
                type="button"
                variant="danger"
                onClick={() => {
                  onClose()
                  openSwarmDelete(s.id, { name: s.name })
                }}
              >
                {withMindsAction === 'delete' ? 'Delete with minds…' : 'Finish deleting…'}
              </Button>
            </div>
          )}
        </div>
      </m.form>

      <AnimatePresence>
        {danger && (
          <DecisionDialog
            icon={danger.kind === 'delete' ? 'trash' : 'history'}
            eyebrow={danger.kind === 'delete' ? 'Delete a swarm' : danger.kind === 'archive' ? 'Archive a swarm' : 'Restore a swarm'}
            title={danger.kind === 'delete' ? `Delete ${shown(danger.seen.name)}?` : danger.kind === 'archive' ? `Archive ${shown(danger.seen.name)}?` : `Bring ${shown(danger.seen.name)} back?`}
            facts={[
              ['Swarm', `${shown(danger.seen.name)} (${danger.seen.id})`],
              ['Minds', danger.seen.member_ids.length ? danger.seen.member_ids.map((m) => shown(agents[m]?.name ?? m)).join(', ') : 'none'],
              ['Swarms inside its minds', danger.seen.child_swarm_ids?.length ? danger.seen.child_swarm_ids.map((c) => shown(swarms[c]?.name ?? c)).join(', ') : 'none'],
              ['Services offered', danger.seen.services?.length ? danger.seen.services.join(', ') : 'none'],
              [
                'What happens',
                danger.kind === 'delete'
                  ? 'The swarm and its own budgets are removed. This cannot be undone. The hive refuses if anything still lives in it.'
                  : danger.kind === 'archive'
                    ? 'It is put away: hidden from everyday lists, its history and beliefs kept. Restore brings it back.'
                    : 'It returns to everyday lists with everything it had.',
              ],
            ]}
            bound={bindTo(danger.seen, live, ['id', 'member_ids', 'child_swarm_ids', 'archived_at'])}
            thing="This swarm"
            onClose={() => setDanger(null)}
            actions={[
              {
                label: danger.kind === 'delete' ? 'Delete swarm' : danger.kind === 'archive' ? 'Archive swarm' : 'Restore swarm',
                busyLabel: danger.kind === 'delete' ? 'Deleting' : danger.kind === 'archive' ? 'Archiving' : 'Restoring',
                tone: danger.kind === 'restore' ? 'primary' : 'danger',
                run: async () => {
                  try {
                    if (danger.kind === 'delete') {
                      await need(client, 'deleteSwarm', 'Deleting a swarm')(danger.seen.id)
                      toast({ tone: 'info', icon: 'trash', title: `${shown(danger.seen.name)} was deleted` })
                      onClose()
                      navigate({ name: 'swarms' })
                    } else {
                      await need(client, danger.kind === 'archive' ? 'archiveSwarm' : 'restoreSwarm', 'Archiving')(danger.seen.id)
                      toast({ tone: 'success', title: danger.kind === 'archive' ? `${shown(danger.seen.name)} is archived` : `${shown(danger.seen.name)} is back` })
                    }
                    return true
                  } catch (e) {
                    if (e instanceof ApiError && e.code === 'swarm_not_empty') {
                      // the hive says whether it can delete the swarm together with its minds (host 065e22d)
                      if (typeof e.envelope?.with_minds === 'boolean') learnWithMinds(client, true)
                      else learnWithMinds(client, false)
                      return notEmptyWords(e.message) + (e.envelope?.with_minds === true ? ' Or use “Delete swarm and its minds”.' : '')
                    }
                    if (e instanceof ApiError && e.status === 404 && danger.kind !== 'delete') {
                      archiveMissing = true
                      setArchiveGone(true)
                      return 'This hive cannot archive swarms yet.'
                    }
                    return decisionFailure(e)
                  }
                },
              },
            ]}
          />
        )}
      </AnimatePresence>
    </m.div>,
    document.body,
  )
}
