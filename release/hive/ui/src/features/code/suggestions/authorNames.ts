// Purpose: name a proposal's author in the Code drawer the way the Create card does, never by a mind's id.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { HiveClient } from '../../../api/client'
import { useHive } from '../../../store/store'
import { requestChildren } from '../canvas/vibeRoute'
import { authorLabel } from './model'

/** a mind's id as the hive makes it (hive/core/db.py new_id("a"): "a_" and 32 hex digits) */
const MIND_ID = /^a_[0-9a-f]{32}$/
/** The mind an author names: `agent:<id>`, or the bare mind id the hive records for a request helper's proposal
 *  (minds.py claims actor); null for a person or any other author. */
export const authorMind = (author: string): string | null =>
  author.startsWith('agent:') ? author.slice(6) : MIND_ID.test(author) ? author : null

/**
 * A proposal's author as a person reads it, the rule the card follows (canvas/vibeRoute authorName): the hive names a
 * mind it started for a request after its template ("foundation.code-helper.v1 6efe"), so such a mind is said as its
 * swarm ("Create · Code"); another mind by its name; a mind this page does not know as "a mind"; a person as authorLabel
 * says. While the swarm's children are not read yet, or can't be, a known mind is said as its swarm, never its id.
 * Cost: one children read (at most 5 GETs) per swarm of a shown mind, once per mount of the drawer.
 */
export function useAuthorNames(client: HiveClient | null | undefined, authors: readonly string[]): (author: string) => string {
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  // the swarms of the minds shown, each read once: null while unread or unreadable
  const wanted = useMemo(() => [...new Set(authors.map((a) => {
    const id = authorMind(a)
    return (id && agents[id]?.swarm_id) || null
  }).filter((s): s is string => !!s))].sort().join(' '), [authors, agents])
  const [children, setChildren] = useState<Record<string, ReadonlySet<string> | null>>({})
  const asked = useRef<{ client: unknown; swarms: Set<string> }>({ client: null, swarms: new Set() })
  useEffect(() => {
    if (!client) return
    // another client (another person) asks again and drops what the last one read
    if (asked.current.client !== client) {
      asked.current = { client, swarms: new Set() }
      setChildren({})
    }
    const mine = asked.current
    for (const swarm of wanted ? wanted.split(' ') : []) {
      if (mine.swarms.has(swarm)) continue
      mine.swarms.add(swarm)
      void requestChildren(client, swarm, null).then(
        (m) => { if (asked.current === mine) setChildren((c) => ({ ...c, [swarm]: m ? new Set(m.keys()) : null })) },
        () => { if (asked.current === mine) setChildren((c) => ({ ...c, [swarm]: null })) },
      )
    }
  }, [client, wanted])
  return (author: string) => {
    const id = authorMind(author)
    if (!id) return authorLabel(author)
    const mind = agents[id]
    if (!mind) return 'a mind'
    const swarm = mind.swarm_id ? swarms[mind.swarm_id]?.name : undefined
    const kids = mind.swarm_id ? children[mind.swarm_id] : null
    // only a mind known not to be a request's helper is said by its own name
    if (kids && !kids.has(id)) return mind.name
    return swarm ?? 'a mind'
  }
}
