// Purpose: the stage's one mount, beside the one Ask, so every look draws what a mind or a person shows: it binds the
// stage to the signed-in person, hears what minds say to it (each stage frame, and after a dropped socket what this page
// missed), and loads the arranging (StageView, which brings MeTTa) with the first statement.
import { Suspense, useEffect } from 'react'
import { lazyRoute } from '../../lib/lazyRoute'
import { useMe } from '../../lib/useAdmin'
import { hiveBus, useHive } from '../../store/store'
import { bindPerson, heard, heardNow, heardUpTo, useStage } from './arrange'

const StageView = lazyRoute(() => import('./StageView'))

export function StageHost() {
  const { me, loaded } = useMe()
  // a hive that does not say who is signed in still keeps one stage for this browser
  const who = me?.principal ?? (loaded ? 'this-browser' : null)
  useEffect(() => bindPerson(who), [who])
  // a mind's statement arrives as one frame, and the stage arranges from it in that event
  useEffect(() => hiveBus.on((e) => { if (e.type === 'stage.said') heard(e) }), [])
  const client = useHive((s) => s.client)
  const resyncs = useHive((s) => s.resyncs)
  // what was said before this page opened is not replayed: its hearing starts at the newest statement the hive holds
  useEffect(() => {
    if (!client?.myStage || !who) return
    let live = true
    client.myStage(0).then((said) => { if (live) heardUpTo(said.reduce((m, s) => Math.max(m, s.seq), 0)) }, (e: unknown) => console.warn('stage: could not read where its hearing starts', e))
    return () => { live = false }
  }, [client, who])
  // after a gap in the live stream, what minds said meanwhile, once each; a page that never learned where its hearing
  // starts learns it now instead, so it never replays what was said before it opened
  useEffect(() => {
    if (!resyncs || !client?.myStage) return
    let live = true
    const from = heardNow()
    client.myStage(Math.max(0, from)).then((said) => {
      if (!live) return
      if (from < 0) heardUpTo(said.reduce((m, s) => Math.max(m, s.seq), 0))
      else said.forEach(heard)
    }, (e: unknown) => console.warn('stage: could not read what it missed', e))
    return () => { live = false }
  }, [resyncs, client])
  const said = useStage().log.length > 0
  // until something is said there is nothing to arrange, so MeTTa is not loaded; once it is, MeTTa decides everything,
  // the stage drawing nothing again after a Clear
  return said ? <Suspense fallback={null}><StageView /></Suspense> : null
}
