import { useEffect, useState } from 'react'
import { WORDS } from '../../lib/motivations'
import { navigate } from '../../lib/router'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Page } from '../../ui/Page'
import { Button } from '../../ui/primitives'

/** The route id of OmegaEvolve's objective among the motivations (#/motivations/omegaevolve). */
export const EVOLVE_ID = 'omegaevolve'
const PROGRAM = 'omegaevolve'

/**
 * OmegaEvolve's objective as a read-only motivation (owner Q5: "yes, but the hive should be encouraged to support it").
 * The app owns it and it cannot amend itself; this reads the app's own view each time (a projection, never a copy that
 * can drift) and shows nothing private. Tasks cannot be filed under it until the hive mirrors it (the host's next
 * phase); until then the growth lab is where work towards it is offered.
 */
function useEvolveObjective(): { state: 'none' | 'reading' | 'read'; title: string | null; swarm: string | null } {
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

export function EvolveObjectiveCard() {
  const o = useEvolveObjective()
  if (o.state === 'none') return null
  return (
    <button
      type="button"
      onClick={() => navigate({ name: 'motivations', id: EVOLVE_ID })}
      className="flex w-full flex-col gap-1.5 rounded-[20px] border border-[#a3e635]/25 bg-[#a3e635]/[0.05] p-4 text-left hover:bg-[#a3e635]/[0.08]"
      data-evolve-objective
    >
      <span className="flex items-center gap-2 text-[11.5px] font-semibold tracking-wide text-[#bef264] uppercase">
        <Icon name="flask" size={13} /> OmegaEvolve’s objective · read-only
      </span>
      <span className="text-[15px] leading-snug font-semibold text-ink">{o.title ?? '…'}</span>
      <span className="text-[12.5px] text-ink-3">The hive is encouraged to support it. OmegaEvolve keeps it; it cannot amend itself.</span>
    </button>
  )
}

export function EvolveObjectiveDetail() {
  const o = useEvolveObjective()
  return (
    <Page label="OmegaEvolve’s objective" eyebrow={`${WORDS.motivation} · read-only`} title="OmegaEvolve’s objective" onClose={() => navigate({ name: 'motivations' })}>
      <div className="mx-auto w-full max-w-3xl space-y-4 px-3 pb-[calc(var(--sab)+92px)] md:px-6" data-evolve-objective-detail>
        {o.state === 'none' ? (
          <p className="text-[14px] text-ink-3">OmegaEvolve is not turned on in this hive, so its objective is not shown.</p>
        ) : (
          <>
            <p className="text-[18px] leading-snug font-semibold text-ink">{o.title ?? '…'}</p>
            <ul className="list-disc space-y-1 pl-5 text-[13.5px] text-ink-2">
              <li>Owned by the OmegaEvolve app. It is fixed: it cannot amend itself, and nobody edits it here.</li>
              <li>Read from the app each time you open it, so it is never a copy that can drift.</li>
              <li>Filing tasks under it arrives when the hive mirrors it as a motivation (its next phase). Until then, offer work towards it in the growth lab.</li>
            </ul>
            {o.swarm && (
              <Button variant="primary" icon="flask" onClick={() => navigate({ name: 'program', id: PROGRAM, swarm: o.swarm! })} className="min-h-10">
                Open the growth lab
              </Button>
            )}
          </>
        )}
      </div>
    </Page>
  )
}
