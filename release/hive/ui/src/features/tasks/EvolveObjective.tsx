import { useMemo } from 'react'
import { experienceById } from '../../experiences/registry'
import { WORDS } from '../../lib/motivations'
import { navigate } from '../../lib/router'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { Icon } from '../../ui/Icon'
import { Page } from '../../ui/Page'
import { evolveScreen } from './motivationsData'
import { PROGRAM, useEvolveObjective, type EvolveObjective } from './useEvolveObjective'

/** The route id of OmegaEvolve's objective among the motivations (#/motivations/omegaevolve). */
export const EVOLVE_ID = 'omegaevolve'

/** The objective on the Motivations list (motivations.metta places it, and only while the app offers one). */
export function EvolveObjectiveCard({ o }: { o: EvolveObjective }) {
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

/** #/motivations/omegaevolve: the objective in full, composed by MeTTa (motivations.metta, evolve-objective). */
export function EvolveObjectiveDetail() {
  const { state, title, swarm } = useEvolveObjective()
  const compose = useCompose(experienceById(useLook().current?.experience).id)
  const { plan, data } = useMemo(() => {
    const s = evolveScreen({ state, title, swarm })
    return { ...s, plan: compose('evolve-objective', s.facts) }
  }, [state, title, swarm, compose])
  return (
    <Page label="OmegaEvolve’s objective" eyebrow={`${WORDS.motivation} · read-only`} title="OmegaEvolve’s objective" onClose={() => navigate({ name: 'motivations' })}>
      <div className="mx-auto w-full max-w-3xl px-3 pb-[calc(var(--sab)+92px)] md:px-6" data-evolve-objective-detail>
        <Screen plan={plan} host={{
          data,
          onAction: (action) => { if (action === 'open-lab' && swarm) navigate({ name: 'program', id: PROGRAM, swarm }) },
        }} />
      </div>
    </Page>
  )
}
