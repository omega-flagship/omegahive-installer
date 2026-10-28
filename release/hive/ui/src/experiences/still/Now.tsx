import { m } from 'framer-motion'
import { Fragment, memo, useMemo, useState } from 'react'
import { openClassic, shown, useHive } from '../sdk'
import { ago, beliefTopic, cap, joinNames, spell } from './language'
import { inkOf, isAwake, useMinds, useNow, useSprings, type Lite } from './shared'

const SHOW = 6

/** Minds as sentences. The dot breathes while a mind thinks; that is all the chrome there is. */
export function Now({ focusId, onOpen }: { focusId: string | null; onOpen: (id: string) => void }) {
  const agents = useMinds()
  const swarms = useHive((s) => s.swarms)
  const thinking = useHive((s) => s.thinking)
  const activity = useHive((s) => s.activity)
  const agentAction = useHive((s) => s.agentAction)
  const [all, setAll] = useState(false)
  const [waking, setWaking] = useState<Record<string, true>>({})
  const now = useNow()

  const { awake, resting, off, troubled } = useMemo(() => {
    const list = Object.values(agents).sort((a, b) => (a.swarm_id ?? '~').localeCompare(b.swarm_id ?? '~') || a.name.localeCompare(b.name))
    return {
      awake: list.filter((a) => isAwake(a)),
      resting: list.filter((a) => a.status === 'asleep'),
      off: list.filter((a) => a.status === 'stopped' || a.status === 'created'),
      troubled: list.filter((a) => a.status === 'error'),
    }
  }, [agents])

  const lastOf = useMemo(() => {
    const out: Record<string, (typeof activity)[number]> = {}
    for (const a of activity) if (a.agent_id && !out[a.agent_id] && (a.kind === 'belief' || a.kind === 'message' || a.kind === 'goal')) out[a.agent_id] = a
    return out
  }, [activity])

  const name = (a: Lite) => <MindName id={a.id} label={shown(a.name)} hidden={focusId === a.id} onOpen={onOpen} />

  const sentence = (a: Lite) => {
    const phase = thinking[a.id]
    const last = lastOf[a.id]
    const swarm = shown(swarms[a.swarm_id ?? '']?.name)
    const topic = last?.kind === 'belief' && last.statement ? beliefTopic(last.statement) : null
    if (phase === 'llm') return { state: 'thinking', text: topic ? ` is thinking about ${topic}.` : ' is thinking.' }
    if (phase === 'skills') return { state: 'working', text: topic ? ` is at work, checking ${topic}.` : ' is at work with its tools.' }
    if (last?.kind === 'message' && last.text === 'said something') return { state: 'idle', text: ` is awake${swarm ? ` in ${swarm}` : ''}, and last spoke ${ago(last.at, now)}.` }
    if (topic) return { state: 'idle', text: ` is awake, last turning over ${topic}.` }
    if (last?.kind === 'goal') return { state: 'idle', text: ` ${last.text.replace(/^claimed/, 'took on')}.` }
    return { state: 'idle', text: swarm ? ` is awake in ${swarm}, listening.` : ' is awake, roaming between swarms.' }
  }

  const wake = (a: Lite) => {
    setWaking((w) => ({ ...w, [a.id]: true }))
    void agentAction(a.id, 'wake').finally(() => setWaking(({ [a.id]: _gone, ...w }) => w))
  }

  if (!Object.keys(agents).length)
    return <p className="st-quiet">There are no minds in this hive yet. Ask for “new mind” to make the first.</p>

  const shownAwake = all ? awake : awake.slice(0, SHOW)
  return (
    <div>
      {awake.length === 0 && <p className="st-quiet">Everyone is resting. The hive is quiet.</p>}
      <ul className="st-now">
        {troubled.map((a) => (
          <li key={a.id}>
            <span className="st-dot" data-state="asleep" style={{ ['--c' as string]: 'var(--red)' }}>
              <i />
            </span>
            <span>
              {name(a)} has run into a problem.{' '}
              <button className="st-inline-btn" onClick={() => openClassic({ name: 'dot', id: a.id, tab: 'mind' })}>
                look
              </button>
            </span>
          </li>
        ))}
        {shownAwake.map((a) => {
          const s = sentence(a)
          return (
            <li key={a.id}>
              <span className="st-dot" data-state={s.state} style={{ ['--c' as string]: inkOf(a.hue) }} aria-hidden>
                <i />
                <i />
              </span>
              <span>
                <strong>
                  {name(a)}
                </strong>
                {s.text}
              </span>
            </li>
          )
        })}
        {(resting.length > 0 || off.length > 0) && (
          <li>
            <span className="st-dot" data-state="asleep" style={{ ['--c' as string]: 'var(--ink-3)' }} aria-hidden>
              <i />
            </span>
            <span>
              {resting.length > 0 && (
                <>
                  {resting.map((a, i) => (
                    <Fragment key={a.id}>
                      {i > 0 && (i === resting.length - 1 ? ' and ' : ', ')}
                      {name(a)}
                    </Fragment>
                  ))}{' '}
                  {resting.length === 1 ? 'is' : 'are'} asleep.{' '}
                </>
              )}
              {off.length > 0 && (
                <>
                  {cap(joinNames(off.map((a) => shown(a.name))))} {off.length === 1 ? 'is' : 'are'} switched off.
                </>
              )}
              {resting.length > 0 && (
                <span className="st-wakes">
                  {resting.map((a) => (
                    <button key={a.id} className="st-inline-btn" disabled={!!waking[a.id]} onClick={() => wake(a)}>
                      {waking[a.id] ? `waking ${shown(a.name)}` : `wake ${shown(a.name)}`}
                    </button>
                  ))}
                </span>
              )}
            </span>
          </li>
        )}
      </ul>
      {awake.length > SHOW && (
        <button className="st-more" onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? 'Fewer' : `And ${spell(awake.length - SHOW)} more awake…`}
        </button>
      )}
    </div>
  )
}

/** A mind's name: the shared element that grows into the reading room's title. Memoised so a busy hive
 *  does not make framer re-measure every name on every event. */
const MindName = memo(function MindName({ id, label, hidden, onOpen }: { id: string; label: string; hidden: boolean; onOpen: (id: string) => void }) {
  const sp = useSprings()
  if (hidden)
    return (
      <span className="st-name" style={{ visibility: 'hidden' }} data-presence-ref={`mind:${id}`}>
        {label}
      </span>
    )
  return (
    <m.button layoutId={`st-name-${id}`} transition={sp.soft} className="st-name st-serif" style={{ color: 'var(--ink)', fontSize: 'inherit', lineHeight: 'inherit' }} onClick={() => onOpen(id)} data-presence-ref={`mind:${id}`}>
      {label}
    </m.button>
  )
})
