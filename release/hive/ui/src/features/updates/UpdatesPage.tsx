import { AnimatePresence } from 'framer-motion'
import { useMemo, useState } from 'react'
import type { UpdateHold } from '../../api/types'
import { ApiError } from '../../api/client'
import { experienceById } from '../../experiences/registry'
import { shown } from '../../lib/displayName'
import { navigate } from '../../lib/router'
import { has, need, useResource } from '../../lib/useResource'
import { Screen, type ScreenItem } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { askConfirm, ConfirmHost } from '../../ui/confirm'
import { Page } from '../../ui/Page'
import { appNamer, updatesScreen } from './data'
import { holdScopeWords, holdsFor } from './updates'
import { LiftHold, PlaceHold, type HoldTarget } from './Holds'
import { RequestUpdate } from './RequestUpdate'

const explain = (e: unknown) => (e instanceof Error ? e.message : String(e))
const scopeOf = (item: ScreenItem): string[] => (Array.isArray(item.scope) ? item.scope.map(String) : [])

/**
 * #/updates (R18): app and platform updates the hive has found, what their owners said, and what must not be
 * interrupted. Applying reloads one app in place, or restarts the hive for a platform update. A hold refuses both;
 * only an admin signed in as a person can override one, and the hive records it.
 *
 * The page, each hold and each app are atoms (updates.metta) that MeTTa composes for the look being worn; this page
 * loads the updates, states the facts, and carries out a press (Ask for an update included). Island: the dialogs for placing a hold, lifting one and
 * asking for an update (update-dialogs). Each is a decision dialog with its own form and state (a reason, an end time
 * checked as it is typed, a target picker, receipts), opened by a press and bound to the exact hold it was opened on,
 * which the blocks don't express; MeTTa decides where they sit and that they exist only once the updates are loaded.
 */
export default function UpdatesPage() {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const look = experienceById(useLook().current?.experience).id
  const [busy, setBusy] = useState(false)
  const res = useResource(() => need(client, 'updates', 'Updates')(), { poll: 15000, isEmpty: () => false })
  const [placing, setPlacing] = useState<HoldTarget | null>(null)
  const [lifting, setLifting] = useState<UpdateHold | null>(null)
  const [requesting, setRequesting] = useState<string | null>(null)
  const overview = res.data
  const canHold = has(client, 'placeHold')
  const canRelease = has(client, 'releaseHold')
  const canApply = !!client?.applyUpdate
  const canRequest = has(client, 'requestUpdate')
  const compose = useCompose(look)
  const { plan, data } = useMemo(() => {
    const { data, facts } = updatesScreen(res, { hold: canHold, release: canRelease, apply: canApply, request: canRequest }, compose)
    return { plan: compose('updates', facts), data }
  }, [res, canHold, canRelease, canApply, canRequest, compose])
  const appName = appNamer(overview?.apps ?? [])

  const apply = async (target: string, label: string, holds: UpdateHold[]) => {
    let override = false
    if (holds.length) {
      const why = holds.map((h) => `${h.held_by}: ${h.reason}`).join('; ')
      if (!(await askConfirm(`${label} is on hold (${why}). Override the hold and apply anyway? This is recorded.`, 'Override and apply'))) return
      override = true
    } else if (!(await askConfirm(target === 'platform'
      ? 'Restart the hive to run the new platform build? Running minds are stopped and started again; the page reconnects by itself.'
      : `Reload ${label} now? Only this app reloads.`, target === 'platform' ? 'Restart' : 'Reload'))) return
    setBusy(true)
    try {
      const out = await client!.applyUpdate!({ target, ...(override ? { override: true, confirm: target } : {}) })
      toast(out.restarting
        ? { tone: 'success', title: 'Restarting the hive', body: 'It will be back in a few seconds.' }
        : out.ok ? { tone: 'success', title: `${label} reloaded` } : { tone: 'error', title: `${label} reloaded with an error`, body: out.error ?? '' })
      res.reload?.()
    } catch (e) {
      const held = e instanceof ApiError && e.status === 409
      toast({ tone: 'error', title: held ? 'On hold' : 'Could not apply', body: explain(e) })
    } finally {
      setBusy(false)
    }
  }

  const onAction = (action: string, item: ScreenItem) => {
    if (action === 'retry') return res.reload()
    if (action === 'ask-update') return setRequesting('platform')
    if (!overview) return
    const [id] = scopeOf(item)
    const app = overview.apps.find((a) => a.id === id)
    if (action === 'hold-all') setPlacing({ scope: 'all', label: 'everything' })
    else if (action === 'hold-restarts') setPlacing({ scope: 'restart', label: 'the platform' })
    else if (action === 'restart') void apply('platform', 'The platform', holdsFor(overview.holds, 'platform'))
    else if (action === 'hold-app' && app) setPlacing({ scope: `program:${app.id}`, label: shown(app.name) })
    else if (action === 'reload' && app) void apply(app.target, app.name, holdsFor(overview.holds, app.target))
    else if (action === 'lift') {
      const h = overview.holds.find((x) => x.id === id)
      if (h) setLifting({ ...h })
    }
  }

  // the dialogs need the loaded updates; MeTTa places this island only once they are loaded
  const dialogs = overview && (
    <AnimatePresence>
      {placing && <PlaceHold target={placing} existing={holdsFor(overview.holds, placing.scope === 'restart' ? 'platform' : placing.scope === 'all' ? 'all' : placing.scope)} onClose={() => setPlacing(null)} onDone={() => res.reload?.()} />}
      {requesting && <RequestUpdate apps={overview.apps.map((a) => ({ id: a.id, name: a.name }))} initial={requesting} onClose={() => setRequesting(null)} onDone={() => res.reload?.()} />}
      {lifting && <LiftHold seen={lifting} live={overview.holds.find((x) => x.id === lifting.id)} label={holdScopeWords(lifting.scope, appName)} onClose={() => setLifting(null)} onDone={() => res.reload?.()} />}
    </AnimatePresence>
  )

  return (
    <Page title="Updates" eyebrow="Apps and platform" label="Updates" onClose={() => navigate({ name: 'hive' })}>
      <ConfirmHost />
      <div className="mx-auto max-w-3xl px-4 pt-2 pb-12 md:px-6">
        <Screen plan={plan} host={{ data, framed: true, busy, islands: { 'update-dialogs': dialogs }, onAction }} />
      </div>
    </Page>
  )
}
