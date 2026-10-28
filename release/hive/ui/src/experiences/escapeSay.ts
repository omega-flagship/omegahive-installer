/**
 * Leaving an experience for the classic hive, and saying so (ExperienceHost: its Ω "Back to the classic hive" and the
 * crash guard). The words are for the person who left: when the answer arrives after a sign-in change, escapeToClassic
 * answers 'stale' and nothing is said, so the next person never hears about someone else's escape (r1f). The binding
 * is taken here before the await and the words go through its commit (r1g), since a change can also land after
 * escapeToClassic's own last check and before this resumes.
 */
import { useHive } from '../store/store'
import { escapeToClassic } from '../shell/uiVariant'
import { bindEpoch, STALE } from '../lib/identityEpoch'

type Say = (t: { tone: 'info' | 'error'; title: string; body?: string }) => void
const toast: Say = (t) => useHive.getState().toast(t)

/**
 * Escape now and, unless the answer is stale, tell the person: always (`when: 'always'`, the crash guard) or only when
 * it was kept on this device alone (`when: 'local'`, the Ω way back). Resolves to what escapeToClassic said.
 */
export async function escapeAndSay(
  title: string,
  opts: { body?: string; when: 'always' | 'local'; say?: Say; escape?: (client: ReturnType<typeof useHive.getState>['client']) => Promise<'saved' | 'local' | 'stale'> } = { when: 'always' },
): Promise<'saved' | 'local' | 'stale'> {
  // bound BEFORE the await (r1g): escapeToClassic's own check ran in an earlier continuation than this one
  const binding = bindEpoch()
  const where = await (opts.escape ?? escapeToClassic)(useHive.getState().client)
  if (where === 'stale') return where
  if (opts.when === 'local' && where !== 'local') return where
  const said = binding.commit(() =>
    (opts.say ?? toast)({
      tone: where === 'saved' ? 'info' : 'error',
      title,
      body: [opts.body, where === 'local' ? 'Saved on this device only; it will sync when the hive can be reached.' : ''].filter(Boolean).join(' '),
    }),
  )
  return said === STALE ? 'stale' : where
}
