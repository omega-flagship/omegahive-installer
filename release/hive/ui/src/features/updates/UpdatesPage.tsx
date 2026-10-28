import { AnimatePresence } from 'framer-motion'
import { useState } from 'react'
import type { AppUpdate, UpdateHold } from '../../api/types'
import { ApiError } from '../../api/client'
import { ago } from '../../lib/format'
import { navigate } from '../../lib/router'
import { need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { askConfirm, ConfirmHost } from '../../ui/confirm'
import { Page } from '../../ui/Page'
import { Button } from '../../ui/primitives'
import { ResourceView } from '../../ui/ResourceView'
import { holdScopeWords, holdsFor, short } from './updates'
import { LiftHold, PlaceHold, type HoldTarget } from './Holds'
import { RequestUpdate } from './RequestUpdate'
import { has } from '../../lib/useResource'
import { shown } from '../../lib/displayName'

const card = 'rounded-2xl border border-line bg-white/[0.03] p-4'

const explain = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * #/updates (R18): app and platform updates the hive has found, what their owners said, and what must not be
 * interrupted. Applying reloads one app in place, or restarts the hive for a platform update. A hold refuses both;
 * only an admin signed in as a person can override one, and the hive records it.
 */
export default function UpdatesPage() {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const res = useResource(() => need(client, 'updates', 'Updates')(), { poll: 15000, isEmpty: () => false })
  const [placing, setPlacing] = useState<HoldTarget | null>(null)
  const [lifting, setLifting] = useState<UpdateHold | null>(null)
  const [requesting, setRequesting] = useState<string | null>(null)
  const canHold = has(client, 'placeHold')
  const appName = (id: string) => shown(res.data?.apps.find((a) => a.id === id)?.name ?? id)

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

  return (
    <Page title="Updates" eyebrow="Apps and platform" label="Updates" onClose={() => navigate({ name: 'hive' })}
      actions={has(client, 'requestUpdate') && res.data ? <Button variant="subtle" icon="replay" onClick={() => setRequesting('platform')}>Ask for an update…</Button> : undefined}>
      <ConfirmHost />
      <div className="mx-auto max-w-3xl space-y-6 px-4 pt-2 pb-12 md:px-6">
        <ResourceView res={res} errorTitle="Could not check for updates" unsupported={{ body: 'This hive does not report updates yet.' }}>
          {(data) => {
            const waiting = data.apps.filter((a) => a.update_available || a.load_error)
            return (
              <>
                <section className={data.holds.length ? 'rounded-2xl border border-warn/40 bg-warn/[0.08] p-4' : card} aria-labelledby="holds-h" data-tour="update-holds">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 id="holds-h" className={data.holds.length ? 'text-[14px] font-medium text-warn' : 'text-[14px] font-medium text-ink'}>
                      {data.holds.length ? `On hold: don't interrupt (${data.holds.length})` : 'Holds'}
                    </h2>
                    {canHold && (
                      <Button variant="subtle" icon="pause" disabled={busy} onClick={() => setPlacing({ scope: 'all', label: 'everything' })}>
                        Hold everything…
                      </Button>
                    )}
                  </div>
                  {data.holds.length === 0 ? (
                    <p className="mt-1 text-[13px] text-ink-3">Nothing is held. Hold the platform or an app below when work must not be interrupted.</p>
                  ) : (
                    <ul className="mt-2 space-y-2 text-[13px]">
                      {data.holds.map((h) => (
                        <li key={h.id} className="flex flex-wrap items-center justify-between gap-2">
                          <span className="min-w-0 flex-1 text-ink-2">
                            <span className="text-ink">{holdScopeWords(h.scope, appName)}</span>
                            {' '}· {h.reason} · {h.held_by}, {ago(h.created_at)}{h.until ? ` · until ${new Date(h.until).toLocaleString()}` : ' · until released'}
                          </span>
                          {has(client, 'releaseHold') && (
                            <Button variant="subtle" disabled={busy} onClick={() => setLifting({ ...h })}>
                              Lift…
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className={card} aria-labelledby="platform-h">
                  <h2 id="platform-h" className="text-[14px] font-medium text-ink">Platform</h2>
                  <p className="mt-1 text-[13px] text-ink-3">
                    Running build <code className="font-mono text-ink-2">{short(data.platform.running_build)}</code>, started {ago(data.platform.started_at)}.
                    {data.platform.update_available
                      ? ` ${data.platform.commits_waiting.length} change${data.platform.commits_waiting.length === 1 ? '' : 's'} waiting for a restart.`
                      : ' Up to date.'}
                  </p>
                  {data.platform.update_available && (
                    <>
                      <ul className="mt-2 max-h-48 space-y-1 overflow-auto text-[12.5px]">
                        {data.platform.commits_waiting.map((c) => (
                          <li key={c.commit} className="text-ink-2"><code className="font-mono text-ink-4">{c.commit}</code> {c.subject}</li>
                        ))}
                      </ul>
                      {data.platform.request && <p className="mt-2 text-[12.5px] text-ink-3">From {data.platform.request.requested_by}: {data.platform.request.note}</p>}
                      <Button className="mt-3" variant="primary" disabled={busy || !data.platform.supervised || !client?.applyUpdate}
                        onClick={() => void apply('platform', 'The platform', holdsFor(data.holds, 'platform'))}>
                        {holdsFor(data.holds, 'platform').length ? 'Restart (on hold)' : 'Restart to update'}
                      </Button>
                      {!data.platform.supervised && <p className="mt-2 text-[12px] text-ink-4">This hive can't restart itself; restart it on its host.</p>}
                    </>
                  )}
                  {canHold && (
                    <Button className="mt-3 ml-2" variant="subtle" icon="pause" disabled={busy} onClick={() => setPlacing({ scope: 'restart', label: 'the platform' })}>
                      Hold restarts…
                    </Button>
                  )}
                </section>

                <section className={card} aria-labelledby="apps-h">
                  <h2 id="apps-h" className="text-[14px] font-medium text-ink">Apps</h2>
                  <p className="mt-1 text-[13px] text-ink-3">
                    {waiting.length ? `${waiting.length} of ${data.apps.length} need attention.` : data.apps.length === 1 ? 'The one app is running what is on disk.' : `All ${data.apps.length} apps are running what is on disk.`}
                  </p>
                  <ul className="mt-3 divide-y divide-line">
                    {data.apps.map((a: AppUpdate) => {
                      const held = holdsFor(data.holds, a.target)
                      return (
                        <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                          <div className="min-w-0 text-[13px]">
                            <div className="text-ink">{shown(a.name)} <span className="text-ink-4">· {a.loaded_version ?? 'not loaded'}{a.update_available && a.disk_version ? ` → ${a.disk_version}` : ''}</span></div>
                            {a.load_error && <div className="text-bad">Load error: {a.load_error}</div>}
                            {a.update_available && a.disk_version === a.loaded_version && <div className="text-ink-3">Same version number, changed code.</div>}
                            {a.removed_on_disk && <div className="text-warn">Its folder is gone; it keeps running until the next restart.</div>}
                            {a.request && <div className="text-ink-3">From {a.request.requested_by}: {a.request.note}</div>}
                          </div>
                          <div className="flex shrink-0 gap-2">
                            {canHold && (
                              <Button variant="ghost" icon="pause" disabled={busy} aria-label={`Hold reloads of ${shown(a.name)}`} onClick={() => setPlacing({ scope: `program:${a.id}`, label: shown(a.name) })}>
                                Hold…
                              </Button>
                            )}
                            {(a.update_available || a.load_error) && (
                              <Button variant={held.length ? 'subtle' : 'primary'} disabled={busy || !client?.applyUpdate}
                                onClick={() => void apply(a.target, a.name, held)}>
                                {held.length ? 'Reload (on hold)' : 'Reload'}
                              </Button>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </section>

                {data.history.length > 0 && (
                  <section className={card} aria-labelledby="hist-h">
                    <h2 id="hist-h" className="text-[14px] font-medium text-ink">Recent</h2>
                    <ul className="mt-2 space-y-1 text-[12.5px] text-ink-3">
                      {data.history.map((h) => (
                        <li key={h.id}>
                          {ago(h.at)} · {h.target === 'platform' ? 'Platform restart' : `${h.target.slice(8)} reloaded`} by {h.by}
                          {h.ok ? '' : ` · error: ${h.error}`}{h.overrode.length ? ' · overrode a hold' : ''}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <AnimatePresence>
                  {placing && <PlaceHold target={placing} existing={holdsFor(data.holds, placing.scope === 'restart' ? 'platform' : placing.scope === 'all' ? 'all' : placing.scope)} onClose={() => setPlacing(null)} onDone={() => res.reload?.()} />}
                  {requesting && <RequestUpdate apps={data.apps.map((a) => ({ id: a.id, name: a.name }))} initial={requesting} onClose={() => setRequesting(null)} onDone={() => res.reload?.()} />}
                  {lifting && <LiftHold seen={lifting} live={data.holds.find((x) => x.id === lifting.id)} label={holdScopeWords(lifting.scope, appName)} onClose={() => setLifting(null)} onDone={() => res.reload?.()} />}
                </AnimatePresence>
                <p className="text-[12px] text-ink-4">
                  A mind can apply updates only if an admin gives it the exact skill <code className="font-mono">hive-update-apply</code>; no default or
                  wildcard rule grants it, and minds can never override a hold.
                </p>
              </>
            )
          }}
        </ResourceView>
      </div>
    </Page>
  )
}
