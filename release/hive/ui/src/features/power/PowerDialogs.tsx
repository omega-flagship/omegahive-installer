import { useMemo } from 'react'
import { useHive } from '../../store/store'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { whoWords } from './api'
import { usePower } from './store'
import { RestSettingDialog } from './RestSetting'

const minds = (n: number) => `${n} mind${n === 1 ? '' : 's'}`

/** The two power decisions, each with its full context (DecisionDialog: nothing decided before it is all on screen). */
export function PowerDialogs() {
  const dialog = usePower((s) => s.dialog)
  const snapshot = usePower((s) => s.snapshot)
  const gate = usePower((s) => s.gate)
  const by = usePower((s) => s.by)
  const since = usePower((s) => s.since)
  const agents = useHive((s) => s.agents)
  const awake = useMemo(() => Object.values(agents).filter((a) => a.status !== 'stopped').length, [agents])
  const close = () => usePower.getState().openDialog(null)
  if (!dialog) return null
  if (dialog === 'rest') return <RestSettingDialog onClose={close} />

  if (dialog === 'off')
    return (
      <DecisionDialog
        icon="power"
        eyebrow="Hive power"
        title="Turn the hive off?"
        thing="The hive"
        bound={{ kind: 'ready' }}
        facts={[
          ['Awake now', minds(awake)],
          ['What happens', 'Every mind is stopped. The hive first records which were meant to be awake, so the power button wakes exactly those again.'],
          ['Everyone sees', 'A resting screen in every view and experience until an admin turns the hive on. It shows no hive data.'],
          ['Still working', 'Sign-in, and this power switch for admins. Background work stops with the minds.'],
          ['If a mind will not stop', 'It is named afterwards as still running; the others are stopped anyway.'],
        ]}
        actions={[{ label: 'Turn the hive off', busyLabel: 'Turning off', tone: 'danger', run: () => usePower.getState().turnOff() }]}
        onClose={close}
      />
    )

  return (
    <DecisionDialog
      icon="power"
      eyebrow="Hive power"
      title="Wake all minds?"
      thing="The hive"
      bound={{ kind: 'ready' }}
      facts={[
        ['Will wake', snapshot === null ? 'The minds recorded when the hive was last turned off or stopped' : snapshot === 0 ? 'Nothing: no minds are waiting to be woken' : `Up to ${minds(snapshot)}, as recorded when the hive was last turned off or stopped`],
        ['Stays as it is', 'A mind someone stopped on purpose before then, a deleted one, one in an archived swarm, one that moved, and one already awake.'],
        ['Awake now', minds(awake)],
        ...(gate === 'on' && whoWords(by) ? ([['Last turned on', `by ${whoWords(by)}${since ? `, ${new Date(since).toLocaleString()}` : ''}`]] as [string, string][]) : []),
        ['Afterwards', 'Which minds woke, which were skipped and why, and any that failed.'],
      ]}
      actions={[{ label: 'Wake all', busyLabel: 'Waking', tone: 'primary', run: () => usePower.getState().wakeAll() }]}
      onClose={close}
    />
  )
}
