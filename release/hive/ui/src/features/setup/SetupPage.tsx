import { useMemo } from 'react'
import { experienceById } from '../../experiences/registry'
import { navigate } from '../../lib/router'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { Page } from '../../ui/Page'
import { SetupChecklist, useSetupDismissed } from './SetupChecklist'

/**
 * #/setup: the first-run checklist as a page, reachable from the palette, Settings and every experience's directory.
 * The page is atoms (setup.metta) that MeTTa composes for the look being worn: its opening words, the checklist (an
 * island: SetupChecklist also draws the hive view's checklist), and whether the checklist shows on the hive view.
 */
export default function SetupPage() {
  const [dismissed, setDismissed, principal] = useSetupDismissed()
  const look = experienceById(useLook().current?.experience).id
  const compose = useCompose(look)
  const plan = useMemo(() => compose('setup', { flags: { 'signed.in': !!principal, 'setup.hidden': dismissed } }), [principal, dismissed, compose])

  return (
    <Page title="Getting started" eyebrow="This hive" label="Getting started" onClose={() => navigate({ name: 'hive' })}>
      <div className="mx-auto max-w-xl px-4 pt-2 pb-12 md:px-6">
        <Screen plan={plan} host={{
          data: {},
          framed: true,
          islands: { 'setup-checklist': <SetupChecklist /> },
          onAction: (action) => {
            if (action === 'hide-on-hive') setDismissed(true)
            if (action === 'show-on-hive') setDismissed(false)
          },
        }} />
      </div>
    </Page>
  )
}
