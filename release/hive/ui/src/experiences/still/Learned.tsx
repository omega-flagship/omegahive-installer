import { AnimatePresence, m } from 'framer-motion'
import { useMemo, useState } from 'react'
import { openClassic, shown, useHive, type Belief } from '../sdk'
import { ago, beliefSentence, spell } from './language'
import { asWritten, beliefLine } from '../../lib/beliefSentence'
import { StillMeter } from './StillMeter'
import { AsWritten, Sureness } from '../../ui/Belief'
import { useNow, useSprings } from './shared'

const FIRST = 5
const MOST = 12
const keyOf = (b: Pick<Belief, 'swarm_id' | 'statement'>) => `${b.swarm_id}\u0000${b.statement}`

/**
 * An editorial reading list. It holds still while you read: new findings gather quietly and join the list only
 * when you ask, so nothing moves under your eyes.
 */
export function Learned() {
  const beliefs = useHive((s) => s.beliefs)
  const swarms = useHive((s) => s.swarms)
  const [more, setMore] = useState(false)
  const [shot, setShot] = useState<{ keys: string[]; at: number } | null>(null)
  const now = useNow()
  const sp = useSprings()

  const live = useMemo(() => {
    const all: Belief[] = []
    for (const sid in beliefs) for (const st in beliefs[sid]) all.push(beliefs[sid][st])
    return all.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 60)
  }, [beliefs])

  if (shot === null && live.length) setShot({ keys: live.slice(0, MOST).map(keyOf), at: Date.parse(live[0].updated_at) })

  const byKey = useMemo(() => new Map(live.map((b) => [keyOf(b), b])), [live])
  const items = (shot?.keys ?? []).map((k) => byKey.get(k) ?? findBelief(beliefs, k)).filter((b): b is Belief => !!b)
  const fresh = shot ? live.filter((b) => Date.parse(b.updated_at) > shot.at).length : 0
  const list = more ? items : items.slice(0, FIRST)

  if (!items.length) return <p className="st-quiet">Nothing learned yet. As minds share what they find, it will read here like a notebook.</p>

  return (
    <div>
      <AnimatePresence>
        {fresh > 0 && (
          <m.button
            key="fresh"
            className="st-more"
            style={{ marginTop: -14, marginBottom: 10, display: 'block' }}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={sp.fade}
            onClick={() => setShot({ keys: live.slice(0, MOST).map(keyOf), at: Date.parse(live[0].updated_at) })}
          >
            {fresh === 1 ? 'One more thing' : `${cap(spell(Math.min(fresh, 99)))} more things`} since you sat down. Bring {fresh === 1 ? 'it' : 'them'} in.
          </m.button>
        )}
      </AnimatePresence>
      <ol className="st-learned">
        <AnimatePresence initial={false}>
          {list.map((b, i) => {
            return (
              <m.li
                key={keyOf(b)}
                data-presence-ref={`swarm:${b.swarm_id}`}
                layout="position"
                initial={sp.reduced ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ ...sp.soft, delay: sp.reduced ? 0 : Math.min(i, 8) * 0.03 }}
              >
                <span className="st-num" aria-hidden>
                  {i + 1}
                </span>
                <button className="st-belief" title={beliefLine(b.statement, b.tv)} onClick={() => openClassic({ name: 'swarm', id: b.swarm_id, statement: b.statement })}>
                  {beliefSentence(b)}
                </button>
                <span className="st-byline">
                  <span>{shown(swarms[b.swarm_id]?.name) || 'The hive'}</span>
                  <span aria-hidden>·</span>
                  <StillMeter tv={b.tv} />
                  <Sureness tv={b.tv} />
                  <span aria-hidden>·</span>
                  <span>{ago(b.updated_at, now)}</span>
                  <AsWritten text={asWritten(b.statement, b.tv)} />
                </span>
              </m.li>
            )
          })}
        </AnimatePresence>
      </ol>
      {items.length > FIRST && (
        <button className="st-more" onClick={() => setMore(!more)} aria-expanded={more}>
          {more ? 'Fewer' : `Keep reading — ${spell(items.length - FIRST)} more`}
        </button>
      )}
    </div>
  )
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

function findBelief(beliefs: Record<string, Record<string, Belief>>, k: string): Belief | undefined {
  const [sid, st] = k.split('\u0000')
  return beliefs[sid]?.[st]
}
