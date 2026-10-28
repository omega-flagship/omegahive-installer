import { useEffect, useRef, useState } from 'react'
import { NOTICE_CAPS, readNoticeList, type NoticeList, type NoticePrefs } from '../../api/notices'
import { useIdentityEpoch } from '../../lib/epochBound'
import { bindEpoch } from '../../lib/identityEpoch'
import { has, need } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { Button, Segmented } from '../../ui/primitives'

const inputClass = 'mt-1 min-h-11 rounded-xl border border-line bg-black/30 px-3 text-[13px] text-ink outline-none focus:border-line-2'
type Cap = `${typeof NOTICE_CAPS[number]}`

/** "How often may your minds interrupt you?" (G2): the person's own daily cap and quiet hours, and their notices.
 *  Only minds in your own app spaces can send these; anything over the cap or in quiet hours waits for one digest. */
export function PersonNotices() {
  const epoch = useIdentityEpoch()
  const client = useHive((s) => s.client)
  if (!has(client, 'myNotices')) return null
  return <PersonNoticesBody key={epoch} />
}

export const noticeWhen = (at: string) => {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function PersonNoticesBody() {
  const client = useHive((s) => s.client)
  const binding = useRef(bindEpoch()).current
  const [list, setList] = useState<NoticeList | null>(null)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const read = async () => {
    const value = readNoticeList(await need(client, 'myNotices', 'Notices')())
    if (!value) throw new Error('Unreadable notices')
    binding.commit(() => { setList(value); setProblem('') })
  }
  useEffect(() => {
    void read().catch(() => binding.commit(() => setProblem('Your notices could not be read. Try again.')))
    // the identity epoch remounts this body; its binding owns every answer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setProblem('')
    try { await work(); await read() }
    catch { binding.commit(() => setProblem('The change could not be confirmed. Read your settings again before relying on them.')) }
    finally { binding.commit(() => setBusy(false)) }
  }
  const save = (change: Partial<NoticePrefs>) => run(() => need(client, 'setNoticeSettings', 'Notice settings')(change))
  const prefs = list?.prefs
  const quietOn = !!prefs?.quiet_start && !!prefs?.quiet_end
  return (
    <section className="rounded-2xl border border-line bg-white/[0.02] p-4" aria-labelledby="notices-h">
      <h2 id="notices-h" className="eyebrow">Notices</h2>
      <p className="mt-2 text-[13px] text-ink-3">Only minds in your own app spaces can send you a notice. Anything over your daily limit or in quiet hours waits and comes later as one summary; nothing is thrown away. Reminders you set yourself don't count.</p>
      {problem && <p className="mt-2 text-[13px] text-warn" role="alert">{problem}</p>}
      {prefs && <>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="text-[13px] text-ink-2">How often may your minds interrupt you each day?</span>
          <Segmented<Cap>
            label="Notices a day"
            value={String(prefs.cap) as Cap}
            onChange={(v) => void save({ cap: Number(v) })}
            options={NOTICE_CAPS.map((c) => ({ value: String(c) as Cap, label: c === 0 ? 'Never' : String(c) }))}
            dense
          />
        </div>
        <fieldset className="mt-3 flex flex-wrap items-end gap-3" disabled={busy}>
          <legend className="sr-only">Quiet hours</legend>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={quietOn} onChange={(e) => void save(e.target.checked ? { quiet_start: '21:00', quiet_end: '07:00' } : { quiet_start: null, quiet_end: null })} />
            Quiet hours
          </label>
          {quietOn && <>
            <label className="text-[12.5px] text-ink-3">From<input type="time" className={`${inputClass} block`} defaultValue={prefs.quiet_start ?? ''} onBlur={(e) => e.target.value && e.target.value !== prefs.quiet_start && void save({ quiet_start: e.target.value })} /></label>
            <label className="text-[12.5px] text-ink-3">Until<input type="time" className={`${inputClass} block`} defaultValue={prefs.quiet_end ?? ''} onBlur={(e) => e.target.value && e.target.value !== prefs.quiet_end && void save({ quiet_end: e.target.value })} /></label>
          </>}
          <span className="text-[12.5px] text-ink-3">Time zone: {prefs.tz}</span>
          {(() => {
            const here = Intl.DateTimeFormat().resolvedOptions().timeZone
            return here && here !== prefs.tz ? <Button type="button" variant="ghost" className="min-h-8 px-3 text-[12px]" onClick={() => void save({ tz: here })}>Use {here}</Button> : null
          })()}
        </fieldset>
      </>}
      {list && <div className="mt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[13px] font-medium">Your notices</h3>
          {list.waiting > 0 && <>
            <span className="text-[12.5px] text-ink-3">{list.waiting} waiting</span>
            <Button type="button" variant="subtle" className="min-h-8 px-3 text-[12px]" disabled={busy || !has(client, 'releaseNotices')} onClick={() => void run(() => need(client, 'releaseNotices', 'Notices')())}>Show them now</Button>
          </>}
        </div>
        {list.notices.length === 0 && <p className="mt-2 text-[12.5px] text-ink-4">No notices yet.</p>}
        <ul className="mt-2 space-y-2">
          {list.notices.slice(0, 20).map((n) => (
            <li key={n.id} className="rounded-lg border border-line px-3 py-2 text-[13px]">
              <div className="text-[11.5px] text-ink-4">{n.kind === 'digest' ? 'Waited for you' : n.from ?? 'Reminder'} · {noticeWhen(n.at)}</div>
              <p className="mt-0.5 whitespace-pre-wrap break-words">{n.text}</p>
              {n.items && n.items.length > 0 && <ul className="mt-1 space-y-1 border-l border-line pl-3 text-[12.5px] text-ink-2">
                {n.items.map((i) => <li key={i.id} className="whitespace-pre-wrap break-words">{i.from ? `${i.from}: ` : ''}{i.text}</li>)}
              </ul>}
            </li>
          ))}
        </ul>
      </div>}
    </section>
  )
}
