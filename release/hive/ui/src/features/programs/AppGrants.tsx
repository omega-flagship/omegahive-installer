import { AnimatePresence } from 'framer-motion'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ApiError, type HiveClient } from '../../api/client'
import { decisionFailure, type DecisionResult } from '../../lib/decisionGate'
import { ago } from '../../lib/format'
import { has, need } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { appGrantsNote, appGrantsWords, noteAppGrants, onAppGrantsNote } from '../../shell/liveNotices'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { Button } from '../../ui/primitives'
import { boundRun, type ToastFn } from '../../lib/epochBound'
import type { EpochBinding, Stale } from '../../lib/identityEpoch'

/**
 * Pause or restore an app's host-managed access (POST /api/programs/{id}/grants/revoke|restore; Surface missing-UI
 * batch 1, audit item 6). The host decides who may: pausing is the app's owner's (or the hive's own machine, as a
 * break-glass); restoring is the owner's alone and takes effect at the next restart. The hive has no read that says
 * whether an app's access is paused now, so this shows only what this page heard (the app.grants_* events, which reach
 * admins) and the outcome of the person's own decision; it never guesses the current state.
 */

/** The words a refusal of these routes shows (programs.py revoke_grants/restore_grants). Pure. */
export function grantsRefusal(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null
  if (e.code === 'no_grants') return 'This app has no access the hive manages, so there is nothing to pause.'
  if (e.code === 'owner_required') return e.message || "Only the app's owner can do that."
  if (e.status === 404) return 'This app is not in this hive.'
  return null
}

/** One decision, bound to the identity it was pressed under (r5): `run` writes its completion through `binding.commit`. */
const decide = (run: (binding: EpochBinding) => Promise<unknown>): Promise<DecisionResult | Stale> =>
  boundRun(async (binding) => {
    try {
      await run(binding)
      return true
    } catch (e) {
      const words = grantsRefusal(e)
      return words ?? decisionFailure(e)
    }
  })()

/** Pausing or restoring an app's access, bound to the identity it was pressed under (r5). */
export function appGrantsRun(d: { client: HiveClient | null; programId: string; name: string; session: string; what: 'pause' | 'restore'; toast: ToastFn }): () => Promise<DecisionResult | Stale> {
  const { client, programId, name, session, toast } = d
  return () =>
    decide(async (binding) => {
      if (d.what === 'pause') {
        const out = await need(client, 'revokeProgramGrants', 'Pausing app access')(programId)
        binding.commit(() => {
          noteAppGrants({ program: out.program, kind: 'revoked', by: null, at: new Date().toISOString(), session })
          toast({ tone: 'success', icon: 'pause', title: `${name}'s access is paused`, body: 'Dropped now and at every start until its owner restores it.' })
        })
      } else {
        const out = await need(client, 'restoreProgramGrants', 'Restoring app access')(programId)
        binding.commit(() => {
          noteAppGrants({ program: out.program, kind: 'restored', by: null, at: new Date().toISOString(), session })
          toast({ tone: 'success', icon: 'replay', title: `${name}'s access will be restored`, body: `Takes effect at the ${out.takes_effect}.` })
        })
      }
    })
}

export function AppGrants({ programId, name, onDeciding }: { programId: string; name: string; onDeciding: (on: boolean) => void }) {
  const client = useHive((s) => s.client)
  const session = useHive((s) => s.session)
  const toast = useHive((s) => s.toast)
  const note = useSyncExternalStore(onAppGrantsNote, () => appGrantsNote(programId, session))
  const [asking, setAsking] = useState<'pause' | 'restore' | null>(null)
  useEffect(() => onDeciding(asking !== null), [asking, onDeciding])
  if (!has(client, 'revokeProgramGrants') && !has(client, 'restoreProgramGrants')) return null
  return (
    <section aria-labelledby={`grants-${programId}`} className="space-y-2" data-app-grants>
      <h3 id={`grants-${programId}`} className="text-[14px] font-medium text-ink">
        Its access
      </h3>
      <p className="text-[12.5px] leading-relaxed text-ink-3">
        Some apps hold access the hive manages for them (read grants their owner set up). Pausing drops that access now and at every start, until the owner restores it.
        Only the app’s owner can pause or restore; the hive’s own machine can also pause, as an emergency stop. Restoring takes effect at the next restart.
      </p>
      <p className="rounded-xl border border-line bg-shade/20 px-3 py-2 text-[12.5px] text-ink-2" role="status">
        {note ? (
          <>
            {appGrantsWords(note, name)} <span className="text-ink-4">({ago(note.at)})</span>
          </>
        ) : (
          'The hive does not say whether this app’s access is paused right now; changes appear here as they happen.'
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {has(client, 'revokeProgramGrants') && (
          <Button variant="danger" icon="pause" onClick={() => setAsking('pause')}>
            Pause its access…
          </Button>
        )}
        {has(client, 'restoreProgramGrants') && (
          <Button variant="subtle" icon="replay" onClick={() => setAsking('restore')}>
            Restore its access…
          </Button>
        )}
      </div>
      <AnimatePresence>
        {asking && (
          <DecisionDialog
            icon={asking === 'pause' ? 'pause' : 'replay'}
            eyebrow="App access"
            title={asking === 'pause' ? `Pause ${name}'s access?` : `Restore ${name}'s access?`}
            facts={[
              ['App', `${name} (${programId})`],
              ['What changes', asking === 'pause' ? 'Its host-managed grants are dropped now, and again at every start. Opening the app does not renew them.' : 'Its grants are minted again at the next restart. Nothing changes before then.'],
              ['Who may', asking === 'pause' ? "The app's owner, or the hive's own machine (emergency stop)" : "The app's owner only"],
              ['Recorded', 'The hive records who did it and tells admins at once'],
            ]}
            bound={{ kind: 'ready' }}
            thing="This app"
            onClose={() => setAsking(null)}
            actions={[
              {
                label: asking === 'pause' ? 'Pause access' : 'Restore access',
                busyLabel: asking === 'pause' ? 'Pausing' : 'Restoring',
                tone: asking === 'pause' ? 'danger' : 'primary',
                run: appGrantsRun({ client, programId, name, session, what: asking, toast }),
              },
            ]}
          />
        )}
      </AnimatePresence>
    </section>
  )
}
