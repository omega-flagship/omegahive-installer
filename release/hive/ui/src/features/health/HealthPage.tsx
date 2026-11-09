import { useEffect, useMemo, useState } from 'react'
import { experienceById } from '../../experiences/registry'
import { need, useResource } from '../../lib/useResource'
import { navigate, useRoute } from '../../lib/router'
import { Screen, type ScreenItem } from '../../screens/Screen'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { useNow } from '../../lib/hooks'
import { Page } from '../../ui/Page'
import { HealthMind } from '../minds/HealthMind'
import { healthScreen, openKey, type Show } from './data'
import { useCompose } from '../../screens/useCompose'
import { IDLE_SECTION_ID, IdleMinds } from './IdleMinds'
import { SleepAndSpend } from './SleepAndSpend'

/** Parts this page still draws itself; health.metta places each one. */
const ISLANDS = { 'health-mind': <HealthMind />, 'idle-minds': <IdleMinds />, 'sleep-and-spend': <SleepAndSpend /> }

const scopeOf = (item: ScreenItem): string[] => (Array.isArray(item.scope) ? item.scope.map(String) : [])

/**
 * #/health: what is going wrong across minds, worst first, with what to do about it. The page, each mind's card and
 * each problem are atoms (health.metta) that MeTTa composes for the look being worn; this page only loads the checks,
 * states the facts, and carries out a press.
 */
export default function HealthPage() {
  const client = useHive((s) => s.client)
  const look = experienceById(useLook().current?.experience).id
  const [show, setShow] = useState<Show>('problems')
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const route = useRoute()
  const toIdle = route.name === 'health' && route.section === 'idle'
  // #/health/idle ("which minds are idle"): bring the Idle minds section into view
  useEffect(() => {
    if (toIdle) document.getElementById(IDLE_SECTION_ID)?.scrollIntoView({ block: 'start' })
  }, [toIdle])
  // polls while the tab is visible; checks again as soon as it is shown
  const res = useResource(() => need(client, 'health', 'Health checks')(), { poll: 15000, isEmpty: () => false })
  const now = useNow(15_000)
  const compose = useCompose(look)
  const { plan, data } = useMemo(() => {
    const { data, facts } = healthScreen(res, show, open, now, compose)
    return { plan: compose('health', facts), data }
  }, [res, show, open, now, compose])

  function toggle(item: ScreenItem) {
    const [mindId, key] = scopeOf(item)
    if (!mindId || !key) return
    const k = openKey(mindId, key)
    setOpen((was) => {
      const next = new Set(was)
      if (!next.delete(k)) next.add(k)
      return next
    })
  }

  return (
    <Page title="Health" eyebrow="Errors across minds" label="Health" onClose={() => navigate({ name: 'hive' })}>
      <div className="mx-auto max-w-3xl px-4 pt-2 pb-12 md:px-6">
        <Screen plan={plan} host={{
          data,
          framed: true,
          islands: ISLANDS,
          onInput: (bind, value) => { if (bind === 'show') setShow(value === 'all' ? 'all' : 'problems') },
          onOpen: (target, item) => {
            const [mindId] = scopeOf(item)
            if (target === 'mind' && mindId) navigate({ name: 'dot', id: mindId, tab: 'mind' })
          },
          onAction: (action, item) => {
            const [mindId] = scopeOf(item)
            if (action === 'reload') res.reload()
            else if (action === 'toggle-issue') toggle(item)
            else if (action === 'open-approvals') navigate({ name: 'approvals' })
            else if (action === 'open-trace' && mindId) navigate({ name: 'dot', id: mindId, tab: 'mind' })
          },
        }} />
      </div>
    </Page>
  )
}
