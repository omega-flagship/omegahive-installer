import type { Asset, AssetStore } from '../../api/moneyWork'
import { bindTo, decisionFailure } from '../../lib/decisionGate'
import { bytes } from '../../lib/format'
import { need } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { boundRun, type ToastFn } from '../../lib/epochBound'
import type { Stale } from '../../lib/identityEpoch'
import type { HiveClient } from '../../api/client'
import type { DecisionResult } from '../../lib/decisionGate'

/**
 * The stores a this-machine-only file still has copies in that must go (assets.py: pending_removal when the hive says,
 * else every non-local placement of a local-only file). Empty when there is nothing to clean up. Pure.
 */
export function pendingRemoval(a: Pick<Asset, 'local_only' | 'placements' | 'pending_removal'>, stores: AssetStore[]): string[] {
  if (!a.local_only) return []
  if (a.pending_removal) return a.pending_removal
  return a.placements.filter((p) => (stores.find((s) => s.name === p)?.kind ?? 'unknown') !== 'local')
}

/** What the last cleanup said, from the file's history (the hive records failures; it never raises them). Pure. */
export function cleanupOutcome(a: Pick<Asset, 'history'>): { removed: string[]; failed: Record<string, string> } | null {
  const h = [...a.history].reverse().find((x) => x.event === 'local_only_cleanup') as (Asset['history'][number] & { failed?: Record<string, string> }) | undefined
  return h ? { removed: h.removed ?? [], failed: h.failed ?? {} } : null
}

/** The cleanup action, bound to the identity it was pressed under (r5): its answer is written only for that person. */
export function cleanupRun(d: { client: HiveClient | null; seen: Pick<Asset, 'sha256'>; stores: AssetStore[]; onDone: (a: Asset) => void; toast: ToastFn }): () => Promise<DecisionResult | Stale> {
  return boundRun(async (binding) => {
    try {
      const next = await need(d.client, 'cleanupAsset', 'Cleaning up a file')(d.seen.sha256)
      binding.commit(() => d.onDone(next))
      const left = pendingRemoval(next, d.stores)
      const out = cleanupOutcome(next)
      if (left.length) {
        const why = Object.entries(out?.failed ?? {}).map(([s, e]) => `${s}: ${e}`).join('; ')
        return { failed: `Still in ${left.join(', ')}${why ? ` (${why})` : ''}. The hive kept a record; try again later.` }
      }
      binding.commit(() => d.toast({ tone: 'success', icon: 'database', title: `${next.name} is on this machine only`, body: out?.removed.length ? `Removed from ${out.removed.join(', ')}.` : 'Nothing was left to remove.' }))
      return true
    } catch (e) {
      return decisionFailure(e)
    }
  })
}

/**
 * Clean up a stored file (POST /api/assets/{sha}/cleanup; admins; Surface missing-UI batch 1, audit item 15): retry
 * removing a this-machine-only file's copies from other stores, one attempt each. A store that refuses keeps its copy
 * and is recorded, so the outcome shown is the hive's own record afterwards.
 */
export function CleanupDialog({ seen, live, stores, onClose, onDone }: { seen: Asset; live: Asset | undefined; stores: AssetStore[]; onClose: () => void; onDone: (a: Asset) => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const pending = pendingRemoval(seen, stores)
  return (
    <DecisionDialog
      icon="database"
      eyebrow="Clean up a file"
      title={`Remove ${seen.name} from ${pending.join(', ')}?`}
      facts={[
        ['File', seen.name],
        ['sha256', <span className="font-mono text-[11px]">{seen.sha256}</span>],
        ['Size', bytes(seen.bytes)],
        ['Kept on', 'this machine only'],
        ['Still copied in', pending.join(', ')],
        ['Effect', 'One attempt per store to delete the copy. The copy on this machine stays. A store that refuses keeps its copy, and that is recorded.'],
      ]}
      bound={bindTo(seen, live, ['sha256', 'placements', 'local_only'])}
      thing="This file"
      onClose={onClose}
      actions={[
        {
          label: 'Remove the copies',
          busyLabel: 'Removing',
          tone: 'danger',
          run: cleanupRun({ client, seen, stores, onDone, toast }),
        },
      ]}
    />
  )
}
