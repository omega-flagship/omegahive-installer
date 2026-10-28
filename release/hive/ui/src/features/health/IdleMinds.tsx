import { useEffect, useState } from 'react'
import { plainText } from '../../lib/beliefSentence'
import {
  askedBy, clipReply, noticedSentence, questionText, REMIND_LOST, remindButton, replyWords, showRemind, showSleep, STATUS_LABEL, totalLine, windowSentence,
  type IdleMind, type IdleRecord, type IdleStatus, type Viewer,
} from '../../api/idleMinds'
import { cx } from '../../lib/cx'
import { shown } from '../../lib/displayName'
import { ago, money } from '../../lib/format'
import { useNow } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import { useMe } from '../../lib/useAdmin'
import { need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { ConfirmHost } from '../../ui/confirm'
import { askConfirmBound, bindEpoch, identityKey } from '../../lib/identityEpoch'
import { Button } from '../../ui/primitives'
import { ResourceView } from '../../ui/ResourceView'
import { cardView, sleepFlow } from './idleCard'

export const IDLE_SECTION_ID = 'idle-minds'

const TONE: Record<IdleStatus, string> = {
  asked: 'border-warn/40 bg-warn/[0.08] text-warn',
  noticed: 'border-warn/30 bg-warn/[0.05] text-warn',
  replied: 'border-line-2 bg-white/[0.04] text-ink-2',
  resolved: 'border-good/30 bg-good/[0.06] text-good',
  slept: 'border-line bg-white/[0.02] text-ink-3',
  superseded: 'border-line bg-white/[0.02] text-ink-3',
  unsent: 'border-bad/40 bg-bad/[0.08] text-bad',
  quiet: 'border-line bg-white/[0.02] text-ink-3',
}

/**
 * Health's idle minds (Platform idle-minds r2): who Health noticed awake with no input, what it asked, and whether the
 * mind answered. Nothing here sleeps a mind by itself; the person may Remind (Health asks again now) or Sleep it.
 * Only admins and a mind's owner see it; another person's personal mind shows only under the admin's opt-in audit,
 * read-only. Remind and Sleep show only when the host says this viewer may (may_remind / may_sleep, Platform r2.4).
 */
export function IdleMinds() {
  const client = useHive((s) => s.client)
  const swarms = useHive((s) => s.swarms)
  const { me, admin } = useMe()
  const [audit, setAudit] = useState(false)
  const auditing = admin && audit
  const viewer: Viewer = { principal: me?.principal ?? null, admin, auditing }
  const res = useResource(() => need(client, 'idleMinds', 'Idle minds')({ includePersonal: auditing }), { poll: 30_000, isEmpty: () => false, context: { who: me?.principal ?? null, auditing } })

  return (
    <section id={IDLE_SECTION_ID} aria-labelledby="idle-h" className="scroll-mt-4 space-y-3 rounded-2xl border border-line bg-white/[0.03] p-4" data-tour="health-idle">
      <ConfirmHost />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="idle-h" className="eyebrow">Idle minds</h2>
        {res.data && <span className="text-[12.5px] text-ink-3">{windowSentence(res.data.window)}</span>}
        <Button variant="ghost" icon="replay" className="ml-auto" onClick={res.reload} disabled={res.refreshing} aria-label="Check idle minds again" />
      </div>
      {admin && (
        <label className="flex items-center gap-2 text-[12px] text-ink-3">
          <input type="checkbox" checked={audit} onChange={(e) => setAudit(e.target.checked)} />
          Include people’s personal minds (audit, read-only)
        </label>
      )}
      <ResourceView res={res} errorTitle="Could not read idle minds" unsupported={{ body: 'This hive does not report idle minds yet.' }}>
        {(data) => (
          <>
            <p className="text-[13px] font-medium text-ink" data-idle-total>{totalLine(data.minds, money)}</p>
            {data.minds.length === 0 ? (
              <p className="text-[12.5px] text-ink-4">No awake minds, and Health asked none in the last 7 days.</p>
            ) : (
              <ul className="space-y-3" aria-label="Idle minds">
                {data.minds.map((m) => (
                  <IdleCard
                    key={m.id}
                    mind={m}
                    rowAt={data.read_at}
                    viewer={viewer}
                    swarmName={m.swarm_id && swarms[m.swarm_id] ? shown(swarms[m.swarm_id].name) : null}
                    onChanged={res.reload}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </ResourceView>
    </section>
  )
}

export interface IdleCardProps {
  mind: IdleMind
  viewer: Viewer
  swarmName: string | null
  onChanged?: () => void
  /** when the idle list this row came from was read (IdleOverview.read_at) */
  rowAt: number
}

export function IdleCard({ mind: row, rowAt, viewer, swarmName, onChanged }: IdleCardProps) {
  const agent = useHive((s) => s.agents[row.id])
  const agentAt = useHive((s) => s.flagsAt[row.id])
  // r1.4: flags from whichever source was read later; status from the live store
  const mind = cardView(row, rowAt, agent, agentAt)
  // an agent.updated for this mind re-reads its host flags while the card is shown
  useEffect(() => useHive.getState().watchAgentFlags(row.id), [row.id])
  // a 5 s clock: the times shown, and Remind coming back on once its minute is up
  const now = useNow(5_000)
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null)
  const [history, setHistory] = useState(false)
  const name = shown(mind.name)
  const reply = replyWords(mind)
  const clipped = clipReply(reply.text === null ? null : plainText(reply.text))
  // only the host's flags decide (Platform r2.4); absent is no
  const canRemind = showRemind(mind)
  const canSleep = showSleep(mind)
  // Remind's minute lives in the store by mind id: a remount or a list reload never turns it back on early
  const remindedAt = useHive((s) => s.remindedAt[mind.id])
  // the clock may lag a click by up to a tick: never earlier than the Remind itself
  const btn = remindButton(remindedAt, Math.max(now, remindedAt ?? 0))

  const onRemind = async () => {
    // r1.4: bound to the identity the person clicked under; a change meanwhile sends nothing and says nothing
    const who = identityKey()
    try {
      const r = await useHive.getState().remindIdle(mind.id, name, who)
      if (!r) return
      setSaid(r)
      if (r.ok) onChanged?.()
    } catch {
      setSaid({ ok: false, text: REMIND_LOST })
    }
  }
  const onSleep = async () => {
    // r1.4: the identity is captured when the confirmation OPENS; a change while it is open answers "no", and the
    // checked sleep is bound to that same identity, so nothing is ever sent as the next person
    const who = identityKey()
    const binding = bindEpoch()
    const r = await sleepFlow(
      who,
      () => askConfirmBound(`Put ${name} to sleep? It stops until someone wakes it. Health only asked; this is your choice.`, 'Put to sleep', { binding }),
      (w) => useHive.getState().sleepChecked(mind.id, name, w),
    )
    if (!r) return
    setSaid(r)
    if (r.ok) onChanged?.()
  }

  return (
    <li className="rounded-xl border border-line bg-black/20 p-3" data-idle-mind={mind.id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button className="text-left text-[14px] font-medium text-ink hover:underline" onClick={() => navigate({ name: 'dot', id: mind.id })}>{name}</button>
        <span className="text-[11.5px] text-ink-4">
          {swarmName ?? 'No swarm'} · {mind.mind_status || 'unknown'}{mind.personal ? ' · personal mind' : ''}
        </span>
        <span className={cx('ml-auto rounded-full border px-2.5 py-0.5 text-[11px]', TONE[mind.status])} data-idle-status={mind.status}>{STATUS_LABEL[mind.status]}</span>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-3 tabular-nums">
        {mind.idle_calls_24h} idle call{mind.idle_calls_24h === 1 ? '' : 's'} · {money(mind.idle_spend_24h)} idle spend in the last 24 h
        {mind.last_input_at ? ` · last input ${ago(mind.last_input_at, now)}` : ''}
      </p>
      <p className="mt-1 text-[13px] text-ink-2"><span className="text-ink-4">Noticed: </span>{noticedSentence(mind, money)}</p>
      {mind.question && (
        <div className="mt-2 space-y-1.5 text-[13px]">
          <p className="text-ink-2">
            <span className="text-ink-4">{cap(askedBy(mind.question_by, viewer.principal))} asked {mind.question_at ? ago(mind.question_at, now) : ''}: </span>
            “{questionText(mind.question)}”
          </p>
          <p className="text-ink-2" data-idle-reply>
            <span className="text-ink-4">{reply.label}{mind.reply_at ? ` ${ago(mind.reply_at, now)}` : ''}{clipped.text ? ': ' : ''}</span>
            {clipped.text && <>“{clipped.text}”</>}
            {clipped.text && (
              <button className="ml-2 text-[12px] text-ink-3 underline-offset-2 hover:underline" onClick={() => navigate({ name: 'dot', id: mind.id })} data-idle-open-reply>
                {clipped.clipped ? 'Read it all in the conversation' : 'Open the conversation'}
              </button>
            )}
          </p>
        </div>
      )}
      {mind.personal && !mind.is_mine && !canRemind && !canSleep && (
        <p className="mt-2 text-[12px] text-ink-4" data-idle-readonly>Someone else’s personal mind: only they can remind it or put it to sleep.</p>
      )}
      {said && <p role="status" className={cx('mt-2 text-[12.5px]', said.ok ? 'text-ink-2' : 'text-warn')}>{said.text}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {canRemind && (
          <Button variant="ghost" onClick={() => void onRemind()} disabled={!btn.on} data-idle-remind={mind.id}>
            {btn.label}
          </Button>
        )}
        {canSleep && (
          <Button variant="ghost" onClick={() => void onSleep()} data-idle-sleep={mind.id}>Sleep</Button>
        )}
        <Button variant="ghost" onClick={() => setHistory(!history)} aria-expanded={history}>{history ? 'Hide history' : 'History'}</Button>
      </div>
      {history && <IdleHistory id={mind.id} auditing={viewer.auditing} who={viewer.principal} />}
    </li>
  )
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

/** Health's records for one mind, newest first, at most 20. */
function IdleHistory({ id, auditing, who }: { id: string; auditing: boolean; who: string | null }) {
  const client = useHive((s) => s.client)
  const now = useNow(60_000)
  const res = useResource(() => need(client, 'idleMind', 'Idle history')(id, { includePersonal: auditing }), { isEmpty: () => false, context: { id, auditing, who } })
  return (
    <div className="mt-2">
      <ResourceView res={res} errorTitle="Could not read its history" unsupported={{ body: 'This hive does not keep Health’s questions yet.' }}>
        {(d) =>
          !d || d.history.length === 0 ? (
            <p className="text-[12.5px] text-ink-4">Health has not asked this mind anything yet.</p>
          ) : (
            <ol className="space-y-1.5" aria-label="Health’s questions, newest first">
              {d.history.map((r, i) => (
                <HistoryRow key={r.question_id ?? i} r={r} now={now} who={who} />
              ))}
            </ol>
          )
        }
      </ResourceView>
    </div>
  )
}

function HistoryRow({ r, now, who }: { r: IdleRecord; now: number; who: string | null }) {
  const reply = replyWords(r)
  return (
    <li className="rounded-lg border border-line bg-black/20 px-3 py-2 text-[12.5px] leading-snug">
      <div className="flex flex-wrap items-center gap-2 text-ink-4">
        <span>{r.question_at ? ago(r.question_at, now) : ''} · asked by {askedBy(r.question_by, who)}</span>
        <span className={cx('ml-auto rounded-full border px-2 py-0.5 text-[10.5px]', TONE[r.status])}>{STATUS_LABEL[r.status]}</span>
      </div>
      {r.question && <p className="mt-1 text-ink-2">“{questionText(r.question)}”</p>}
      <p className="mt-0.5 text-ink-3">{reply.label}{reply.text ? `: “${clipReply(plainText(reply.text)).text}”` : ''} · Health saw {r.idle_calls_24h} idle call{r.idle_calls_24h === 1 ? '' : 's'}, {money(r.idle_spend_24h)}</p>
    </li>
  )
}
