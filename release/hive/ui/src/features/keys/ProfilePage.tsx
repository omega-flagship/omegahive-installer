import { useEffect, useMemo, useState } from 'react'
import { experienceById } from '../../experiences/registry'
import { need, useResource } from '../../lib/useResource'
import { navigate } from '../../lib/router'
import { Screen, type ScreenHost, type ScreenItem } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { ClockPref, LookSection } from '../../shell/LookSection'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { Page } from '../../ui/Page'
import { PersonalMindLink } from '../mind/PersonalMindLink'
import { GoogleConnectorSettings } from '../settings/GoogleConnectorSettings'
import { PersonNotices } from '../settings/PersonNotices'
import { MemorySection } from './AskMemorySection'
import { AddKeyPanel } from './AddKeyForm'
import { profileScreen } from './data'
import { DemoAskCard } from './DemoAskCard'
import { OwnMonthlyLimit } from './OwnMonthlyLimit'

const scopeOf = (item: ScreenItem): string[] => (Array.isArray(item.scope) ? item.scope.map(String) : [])
const toggled = (set: ReadonlySet<string>, key: string, on: boolean): ReadonlySet<string> => {
  const next = new Set(set)
  if (on) next.add(key)
  else next.delete(key)
  return next
}

/** Panels this page still draws itself; profile.metta places each one, and each decides for itself whether it shows. */
const PANELS = {
  'personal-mind': <PersonalMindLink />,
  'google-connector': <GoogleConnectorSettings />,
  'person-notices': <PersonNotices />,
  'look': <LookSection />,
  'clock': <ClockPref />,
  'demo-ask': <DemoAskCard />,
  'ask-memory': <MemorySection />,
  'own-limit': <OwnMonthlyLimit />,
}

/**
 * #/me: you, your keys, and which minds each key pays for. The page, each provider's keys and each key are atoms
 * (profile.metta) that MeTTa composes for the look being worn; this page loads the data, states the facts, and carries
 * out a press.
 *
 * Islands: the panels above the keys (your personal mind, Google, notices, the look and clock, the demo card, the Ask's
 * memory) and the monthly total on your own keys are their own components, used elsewhere too, each loading its own
 * data and holding its own form. The add-key form is one as well (AddKeyForm.tsx): what is pasted never enters the
 * page's data.
 */
export default function ProfilePage() {
  const keys = useHive((s) => s.keys)
  const loadKeys = useHive((s) => s.loadKeys)
  const updateKey = useHive((s) => s.updateKey)
  const refreshKey = useHive((s) => s.refreshKey)
  const removeKey = useHive((s) => s.removeKey)
  const agents = useHive((s) => s.agents)
  const client = useHive((s) => s.client)
  const look = experienceById(useLook().current?.experience).id
  const me = useResource(() => need(client, 'me', 'Who you are')(), { isEmpty: () => false })
  const [keysError, setKeysError] = useState<unknown>(undefined)
  const [adding, setAdding] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [editing, setEditing] = useState<ReadonlySet<string>>(() => new Set())
  const [confirming, setConfirming] = useState<ReadonlySet<string>>(() => new Set())
  const reloadKeys = () => {
    setKeysError(undefined)
    loadKeys().catch((e) => setKeysError(e))
  }
  useEffect(() => {
    loadKeys().catch((e) => setKeysError(e))
  }, [loadKeys, client])

  const compose = useCompose(look)
  const { plan, data } = useMemo(() => {
    const { data, facts } = profileScreen({
      me, keys, keysError, agents: Object.values(agents), connected: !!client, signingOut, adding, work: { editing, confirming },
    }, compose)
    return { plan: compose('profile', facts), data }
  }, [me, keys, keysError, agents, client, signingOut, adding, editing, confirming, compose])

  const signOut = async () => {
    if (signingOut || !client) return
    setSigningOut(true)
    try {
      await signOutNow(client, navigate)
    } finally {
      setSigningOut(false)
    }
  }
  const remove = async (id: string) => {
    await removeKey(id)
    setConfirming((s) => toggled(s, id, false))
  }

  const host: ScreenHost = {
    data,
    framed: true,
    islands: { ...PANELS, 'add-key': <AddKeyPanel onDone={() => setAdding(false)} /> },
    onOpen: (target, item) => {
      const [, id] = scopeOf(item)
      if (target === 'mind' && typeof item.id === 'string') navigate({ name: 'dot', id: item.id, tab: 'model' })
      else if (target === 'rename' && id) setEditing((s) => toggled(s, id, true))
    },
    onAction: (action, item) => {
      if (action === 'retry') return reloadKeys()
      if (action === 'sign-out') return void signOut()
      if (action === 'add-key') return setAdding(true)
      // a press on a key comes back scoped [provider, key]
      const [, id] = scopeOf(item)
      const k = id ? keys?.find((x) => x.id === id) : undefined
      if (!k) return
      if (action === 'rename') {
        const label = typeof item.value === 'string' ? item.value : ''
        setEditing((s) => toggled(s, k.id, false))
        if (label && label !== k.label) void updateKey(k.id, { label })
      } else if (action === 'stop-rename') setEditing((s) => toggled(s, k.id, false))
      else if (action === 'refresh') void refreshKey(k.id)
      else if (action === 'make-default') void updateKey(k.id, { default: true })
      else if (action === 'ask-remove') setConfirming((s) => toggled(s, k.id, true))
      else if (action === 'keep') setConfirming((s) => toggled(s, k.id, false))
      else if (action === 'remove') void remove(k.id)
    },
  }

  return (
    <Page title="You & your keys" eyebrow="Profile" label="You & your keys" onClose={() => navigate({ name: 'hive' })}>
      <div className="mx-auto max-w-3xl px-4 pt-2 pb-12 md:px-6">
        <Screen plan={plan} host={host} />
      </div>
    </Page>
  )
}

/**
 * Sign out of this hive. The live client tells the hive to end the session (bearer and sign-in cookie) and waits for it
 * briefly; the app then shows the sign-in screen. The page moves to the hive first, so the next person never lands on
 * the previous person's profile.
 */
export async function signOutNow(client: { logout(): void | Promise<void> }, go: (r: { name: 'hive' }) => void): Promise<void> {
  go({ name: 'hive' })
  await client.logout()
}
