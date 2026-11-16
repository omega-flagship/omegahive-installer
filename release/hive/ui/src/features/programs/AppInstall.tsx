import { useState } from 'react'
import { installBody } from '../../api/personApps'
import { cx } from '../../lib/cx'
import { shown } from '../../lib/displayName'
import { actionFailure, errorMessage, has, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { Button, Skeleton } from '../../ui/primitives'

/**
 * P14 "Install": installing is the review, one act by a named admin, bound to this pinned release. A person app is then
 * ready for each allowed person on first open (no activation step); a swarm app is turned on in the swarms picked here
 * ("Use in"), so nothing is left switched off by accident.
 */
export function AppInstall({ programId, name, admin }: { programId: string; name: string; admin: boolean }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const swarms = useHive((s) => s.swarms)
  const res = useResource(() => need(client, 'programInstall', 'Installing apps')(programId), { context: programId })
  const people = useResource(() => need(client, 'listPeople', 'People')(), { context: 'people' })
  const [everyone, setEveryone] = useState(true)
  const [chosen, setChosen] = useState<string[]>([])
  const [useIn, setUseIn] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  if (res.status === 'unsupported') return <p className="text-[13px] text-ink-4">This hive installs apps another way.</p>
  if (res.status === 'loading') return <Skeleton className="h-24 rounded-xl" />
  if (res.status === 'error') return <p className="text-[13px] text-bad">Could not read the install: {errorMessage(res.error)}</p>
  const status = res.data
  if (!status) return null
  const person = status.placement === 'person'
  const review = status.review
  const body = installBody(status, { everyone, people: chosen, useIn })
  const toggle = (list: string[], set: (l: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  const install = async () => {
    if (!body) return
    setBusy(true)
    try {
      const out = await need(client, 'installProgram', 'Installing apps')(programId, body)
      res.mutate(() => out)
      toast({ tone: 'success', title: `${name} is installed`, body: person ? 'It is ready for each allowed person the first time they open it.' : useIn.length ? `It is on in ${useIn.length} swarm${useIn.length === 1 ? '' : 's'}.` : 'Turn it on in a swarm when you need it.' })
    } catch (e) {
      toast(actionFailure(e, 'Could not install'))
      res.reload()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-3 text-[13px]" data-app-install={status.placement}>
      <p className="text-ink-3">
        {person
          ? `${name} runs in each person's own private space. Installing it makes it ready the first time each allowed person opens it, on their own AI key.`
          : `${name} serves shared swarms. Pick where to use it now, so nothing is left switched off.`}
      </p>
      <p className="text-ink-2" data-app-installed={status.installed ? 'yes' : 'no'}>
        {status.installed ? `Installed${review ? ` by ${review.by.replace(/^user:/, '')}` : ''}.` : review?.revoked ? 'Its install was withdrawn.' : review ? 'This release has not been reviewed yet.' : 'Not installed yet.'}
      </p>
      {admin && has(client, 'installProgram') && !status.release_digest && (
        <p className="text-ink-4">Only a pinned release can be installed here.</p>
      )}
      {admin && has(client, 'installProgram') && status.release_digest && (
        <>
          {person ? (
            <fieldset className="rounded-xl border border-line bg-shade/20 p-3">
              <legend className="px-1 text-ink-3">Who can use it</legend>
              <label className="flex min-h-9 items-center gap-2"><input type="radio" checked={everyone} onChange={() => setEveryone(true)} /> {status.person_allow === 'all' ? 'Everyone in this hive' : 'Everyone the app allows'}</label>
              <label className="flex min-h-9 items-center gap-2"><input type="radio" checked={!everyone} onChange={() => setEveryone(false)} /> Only these people</label>
              {!everyone && (
                <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto">
                  {(people.data?.people ?? []).filter((p) => !p.disabled && (status.person_allow === 'all' || (status.person_allow ?? []).includes(`user:${p.id}`))).map((p) => (
                    <li key={p.id}><label className="flex min-h-9 items-center gap-2"><input type="checkbox" checked={chosen.includes(`user:${p.id}`)} onChange={() => toggle(chosen, setChosen, `user:${p.id}`)} /> {p.name || p.email}</label></li>
                  ))}
                </ul>
              )}
            </fieldset>
          ) : (
            <fieldset className="rounded-xl border border-line bg-shade/20 p-3">
              <legend className="px-1 text-ink-3">Use in</legend>
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {Object.values(swarms).map((s) => (
                  <li key={s.id}><label className={cx('flex min-h-9 items-center gap-2')}><input type="checkbox" checked={useIn.includes(s.id)} onChange={() => toggle(useIn, setUseIn, s.id)} /> {shown(s.name)}</label></li>
                ))}
              </ul>
            </fieldset>
          )}
          <Button variant="primary" disabled={busy || !body} onClick={() => void install()}>{busy ? 'Installing…' : status.installed ? 'Install again' : 'Install'}</Button>
        </>
      )}
    </div>
  )
}
