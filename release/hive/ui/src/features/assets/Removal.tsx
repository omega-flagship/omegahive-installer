// Purpose: carry out MeTTa-composed file deletion and folder unlinking through an identity-bound confirmation.
import { useMemo, useState } from 'react'
import type { HiveClient } from '../../api/client'
import type { Asset, LinkedFolder } from '../../api/moneyWork'
import { experienceById } from '../../experiences/registry'
import { bindTo, decisionFailure, type Bound, type DecisionResult } from '../../lib/decisionGate'
import { shown } from '../../lib/displayName'
import { boundRun, useIdentityEpoch, type ToastFn } from '../../lib/epochBound'
import { bytes } from '../../lib/format'
import type { Stale } from '../../lib/identityEpoch'
import { has, need } from '../../lib/useResource'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { DecisionDialog } from '../../ui/DecisionDialog'

export type RemovalSubject = { kind: 'asset'; value: Asset } | { kind: 'folder'; value: LinkedFolder }

/** Both operations publish their answer only to the identity that confirmed them. */
export function removalRun(d: { client: HiveClient | null; seen: RemovalSubject; onGone: (id: string) => void; toast: ToastFn }): () => Promise<DecisionResult | Stale> {
  return boundRun(async (binding) => {
    try {
      if (d.seen.kind === 'asset') {
        const a = d.seen.value
        await need(d.client, 'deleteAsset', 'Deleting files')(a.sha256)
        binding.commit(() => d.onGone(a.sha256))
        binding.commit(() => d.toast({ tone: 'success', title: `${a.name} deleted`, body: 'Its recorded copies and storage history were removed.' }))
      } else {
        const f = d.seen.value
        await need(d.client, 'unlinkFolder', 'Unlinking folders')(f.id)
        binding.commit(() => d.onGone(f.id))
        binding.commit(() => d.toast({ tone: 'success', title: `${f.label} unlinked`, body: 'Its files stay on disk and its write receipts stay.' }))
      }
      return true
    } catch (e) {
      return decisionFailure(e)
    }
  })
}

/** What was inspected must still be the same file or folder when the confirmation is pressed. */
export function removalBound(seen: RemovalSubject, live: RemovalSubject | undefined): Bound {
  if (seen.kind === 'asset') return bindTo(seen.value, live?.kind === 'asset' ? live.value : undefined, ['sha256', 'name', 'placements', 'owners', 'history'])
  return bindTo(seen.value, live?.kind === 'folder' ? live.value : undefined, ['id', 'label', 'root', 'owner_swarm', 'writable', 'writers'])
}

/** An identity change discards the opened snapshot, including a credential replacement on the same client. */
export function RemovalControl(props: { subject: RemovalSubject; live: RemovalSubject | undefined; admin: boolean; onGone: (id: string) => void }) {
  return <Control key={useIdentityEpoch()} {...props} />
}

function Control({ subject, live, admin, onGone }: { subject: RemovalSubject; live: RemovalSubject | undefined; admin: boolean; onGone: (id: string) => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const swarms = useHive((s) => s.swarms)
  const [seen, setSeen] = useState<RemovalSubject | null>(null)
  const compose = useCompose(experienceById(useLook().current?.experience).id)
  const screen = subject.kind === 'asset' ? 'assets-delete' : 'assets-unlink'
  const allowed = admin && has(client, subject.kind === 'asset' ? 'deleteAsset' : 'unlinkFolder')
  const open = seen !== null
  const plan = useMemo(() => compose(screen, { flags: { 'removal.allowed': allowed, 'removal.open': open } }), [compose, screen, allowed, open])
  const confirmation = useMemo(() => compose(`${screen}-confirm`, {}), [compose, screen])
  const modal = plan.parts.find((p) => p.block === 'island')
  const name = subject.kind === 'asset' ? subject.value.name : subject.value.label
  const data: Record<string, unknown> = { 'file.name': name }
  if (seen?.kind === 'asset') Object.assign(data, { 'file.name': seen.value.name, 'file.sha256': seen.value.sha256, 'file.size': bytes(seen.value.bytes), 'file.stores': seen.value.placements.join(', ') || 'no recorded copies' })
  if (seen?.kind === 'folder') Object.assign(data, { 'file.name': seen.value.label, 'folder.root': seen.value.root, 'folder.swarm': shown(swarms[seen.value.owner_swarm]?.name ?? seen.value.owner_swarm) })
  return <Screen plan={plan} host={{ data, onAction: (action) => { if (action === 'remove' && allowed) setSeen(structuredClone(subject)) }, islands: {
    'confirmation': seen && modal && <DecisionDialog
      icon="database" eyebrow={plan.title ?? ''} title={confirmation.title} facts={[]}
      bound={removalBound(seen, live)} thing={seen.kind === 'asset' ? 'This file' : 'This folder'} onClose={() => setSeen(null)}
      canAct={() => allowed}
      actions={[{ label: String(modal.props.label), busyLabel: String(modal.props.waiting), tone: 'danger', run: removalRun({ client, seen, onGone, toast }) }]}
    ><Screen plan={confirmation} host={{ data }} /></DecisionDialog>,
  } }} />
}
