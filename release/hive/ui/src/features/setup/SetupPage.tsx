import { useEffect, useMemo } from 'react'
import { experienceById } from '../../experiences/registry'
import { useAdminView } from '../../lib/useAdmin'
import { navigate } from '../../lib/router'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { Page } from '../../ui/Page'
import { startFirstLight } from '../firstlight/door'
import { useLocalOwnerHive } from './localOwner'
import { SetupChecklist } from './SetupChecklist'
import { useNudgeHidden } from './finishSetup'

/**
 * #/setup: the first-run checklist as a page, reachable from an admin's palette, Settings and every experience's
 * directory. The page is atoms (setup.metta) that MeTTa composes for the look being worn: its opening words, the
 * checklist (an island: SetupChecklist also draws the hive view's checklist), whether the checklist shows on the hive
 * view, and who sees any of it. The steps set up the hive itself, so only an admin view lists them (adminViewOf): a
 * member who opens the address is told whose job they are, and nothing shows while the hive has not said who is
 * signed in. Both viewer flags come from one read, so an admin never sees the member's words first.
 *
 * On a hive installed on its owner's own computer First Light is the onboarding and these steps are legacy, so the
 * address (and the "Getting started" entries that lead to it) opens First Light instead, as #/first-light does.
 */
export default function SetupPage() {
  return useAdminView().adminView ? <AdminSetupPage /> : <ChecklistPage />
}

function AdminSetupPage() {
  const localOwner = useLocalOwnerHive()
  useEffect(() => {
    if (!localOwner) return
    startFirstLight({ mode: 'live' })
    navigate({ name: 'hive' }, { replace: true })
  }, [localOwner])
  return localOwner === false ? <ChecklistPage /> : null
}

function ChecklistPage() {
  const [dismissed, setDismissed, principal] = useNudgeHidden('setup')
  const { adminView, loaded } = useAdminView()
  const look = experienceById(useLook().current?.experience).id
  const compose = useCompose(look)
  const plan = useMemo(
    () => compose('setup', { flags: { 'signed.in': !!principal, 'setup.hidden': dismissed, 'viewer.admin': adminView, 'viewer.known': loaded } }),
    [principal, dismissed, adminView, loaded, compose],
  )

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
