import { useEffect, useMemo, useState } from 'react'
import { experienceById } from '../../experiences/registry'
import { useNow } from '../../lib/hooks'
import { navigate, useRoute } from '../../lib/router'
import { Screen, type ScreenItem } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { Page } from '../../ui/Page'
import { modelsScreen, type DefaultModel } from './data'
import { ModelPicker } from './ModelPicker'
import { buildRows, readDefaultModel, writeDefaultModel } from './modelUtil'

const scopeOf = (item: ScreenItem): string[] => (Array.isArray(item.scope) ? item.scope.map(String) : [])
const toggled = (set: ReadonlySet<string>, key: string, on: boolean): ReadonlySet<string> => {
  const next = new Set(set)
  if (on) next.add(key)
  else next.delete(key)
  return next
}

/**
 * #/models and #/models/<provider>: providers and their keys, which model new minds get by default, and which models
 * minds use now. The page, each provider's card and each model in use are atoms (models.metta) that MeTTa composes
 * for the look being worn; this page only loads the data, states the facts, and carries out a press.
 */
export default function ModelsPage() {
  const route = useRoute()
  const providers = useHive((s) => s.providers)
  const loadProviders = useHive((s) => s.loadProviders)
  const setKey = useHive((s) => s.setProviderKey)
  const removeKey = useHive((s) => s.removeProviderKey)
  const models = useHive((s) => s.models)
  const catalog = useHive((s) => s.catalog)
  const agents = useHive((s) => s.agents)
  const toast = useHive((s) => s.toast)
  const look = experienceById(useLook().current?.experience).id
  const now = useNow(60_000)
  const [def, setDef] = useState<DefaultModel>(() => readDefaultModel())
  const [replacing, setReplacing] = useState<ReadonlySet<string>>(() => new Set())
  const [confirming, setConfirming] = useState<ReadonlySet<string>>(() => new Set())
  const [checking, setChecking] = useState<ReadonlySet<string>>(() => new Set())
  const focus = route.name === 'models' ? route.provider : undefined

  useEffect(() => {
    void loadProviders()
  }, [loadProviders])

  const rows = useMemo(() => buildRows(models, catalog?.models), [models, catalog])
  const compose = useCompose(look)
  const { plan, data } = useMemo(() => {
    const { data, facts } = modelsScreen({ providers, rows, agents: Object.values(agents), def, work: { replacing, confirming, checking, focus }, now }, compose)
    return { plan: compose('models', facts), data }
  }, [providers, rows, agents, def, replacing, confirming, checking, focus, now, compose])

  async function connect(provider: string, key: string) {
    if (checking.has(provider)) return
    setChecking((s) => toggled(s, provider, true))
    try {
      // a throw (not only a falsy answer) must still end "Checking…"
      if (await setKey(provider, key)) setReplacing((s) => toggled(s, provider, false))
    } finally {
      setChecking((s) => toggled(s, provider, false))
    }
  }

  async function remove(provider: string) {
    await removeKey(provider)
    setConfirming((s) => toggled(s, provider, false))
  }

  const picker = (
    <ModelPicker
      value={def?.model ?? ''}
      options={def?.options}
      hue={252}
      onChange={(model, options) => {
        const next = { model, options }
        writeDefaultModel(next)
        setDef(next)
        toast({ tone: 'success', icon: 'check', title: 'Default model saved', body: rows.find((r) => r.id === model)?.name ?? model })
      }}
    />
  )

  return (
    <Page title="Models" eyebrow="Providers and catalogue" label="Models" onClose={() => navigate({ name: 'hive' })}>
      <div className="mx-auto max-w-3xl px-4 pt-2 pb-12 md:px-6">
        <Screen plan={plan} host={{
          data,
          framed: true,
          islands: { 'model-picker': picker },
          onOpen: (target, item) => {
            if (target === 'mind' && typeof item.id === 'string') navigate({ name: 'dot', id: item.id, tab: 'model' })
          },
          onAction: (action, item) => {
            const [provider] = scopeOf(item)
            if (action === 'clear-default') { writeDefaultModel(null); setDef(null) }
            else if (action === 'create-mind') navigate({ name: 'new' })
            else if (!provider) return
            else if (action === 'connect' && typeof item.value === 'string') void connect(provider, item.value)
            else if (action === 'replace') setReplacing((s) => toggled(s, provider, true))
            else if (action === 'cancel-replace') setReplacing((s) => toggled(s, provider, false))
            else if (action === 'ask-remove') setConfirming((s) => toggled(s, provider, true))
            else if (action === 'keep') setConfirming((s) => toggled(s, provider, false))
            else if (action === 'remove') void remove(provider)
          },
        }} />
      </div>
    </Page>
  )
}
