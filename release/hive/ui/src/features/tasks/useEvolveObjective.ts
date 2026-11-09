import { useEffect, useState } from 'react'
import { useHive } from '../../store/store'

/** The program whose objective it is. */
export const PROGRAM = 'omegaevolve'

/**
 * OmegaEvolve's objective as a read-only motivation (Jon Q5: "yes, but the hive should be encouraged to support it").
 * The app owns it and it cannot amend itself; this reads the app's own view each time (a projection, never a copy that
 * can drift) and shows nothing private. Tasks cannot be filed under it until the hive mirrors it (the host's next
 * phase); until then the growth lab is where work towards it is offered.
 */
export type EvolveObjective = { state: 'none' | 'reading' | 'read'; title: string | null; swarm: string | null }
export function useEvolveObjective(): EvolveObjective {
  const client = useHive((s) => s.client)
  const session = useHive((s) => s.session)
  const program = useHive((s) => s.programs?.find((p) => p.id === PROGRAM && p.enabled && !p.error))
  const firstSwarm = useHive((s) => Object.values(s.swarms).find((x) => !x.archived_at)?.id ?? null)
  const [got, setGot] = useState<{ key: string; title: string | null; swarm: string | null } | null>(null)
  const key = `${session}:${program ? 'on' : 'off'}`
  useEffect(() => {
    if (!program || !client) return
    let alive = true
    const read = async () => {
      let swarm = firstSwarm
      try {
        const homes = client.programHomes ? await client.programHomes(PROGRAM) : null
        swarm = homes?.homes[0]?.swarm_id ?? swarm
      } catch {
        /* no homes: the first open team */
      }
      if (!swarm) return { title: null, swarm: null }
      const g = await client.programView(PROGRAM, { swarm_id: swarm })
      const it = g.items.find((i) => i.id === 'objective' && i.kind === 'objective')
      return { title: it?.label ?? null, swarm }
    }
    read().then(
      (r) => alive && setGot({ key, ...r }),
      () => alive && setGot({ key, title: null, swarm: null }),
    )
    return () => {
      alive = false
    }
  }, [program, client, firstSwarm, key])
  if (!program) return { state: 'none', title: null, swarm: null }
  if (!got || got.key !== key) return { state: 'reading', title: null, swarm: null }
  return { state: got.title ? 'read' : 'none', title: got.title, swarm: got.swarm }
}
