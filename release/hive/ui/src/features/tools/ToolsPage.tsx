import { useEffect, useMemo, useState } from 'react'
import { navigate } from '../../lib/router'
import { useHive } from '../../store/store'
import { useLook } from '../../shell/uiVariant'
import { experienceById } from '../../experiences/registry'
import { Page } from '../../ui/Page'
import { Screen, type ScreenItem } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { toolScreen, toolsScreen, withTool, type Loaded } from './data'

/**
 * #/tools and #/tools/<id>: every tool this hive offers, and one tool's own page (what it does, who made it, which
 * minds can use it). Both screens are atoms (tools.metta) that MeTTa composes for the look being worn; this page only
 * loads the data, states the facts, and carries out a press.
 */
export default function ToolsPage({ id }: { id?: string }) {
  const client = useHive((s) => s.client)
  const agents = useHive((s) => s.agents)
  const patchAgent = useHive((s) => s.patchAgent)
  const look = experienceById(useLook().current?.experience).id
  const [fetched, setFetched] = useState<Loaded>({ state: 'loading' })
  // a hive whose client offers no catalogue says so at once; otherwise the catalogue loads
  const unsupported = !!client && !client.tools
  const loaded: Loaded = useMemo(() => (unsupported ? { state: 'unsupported' } : fetched), [unsupported, fetched])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  // a failed switch belongs to the tool it happened on: opening another tool shows none
  const [failed, setFailed] = useState<{ tool: string; problem: string } | null>(null)

  useEffect(() => {
    let current = true
    if (!client?.tools) return
    client.tools().then((catalogue) => { if (current) setFetched({ state: 'ready', catalogue }) },
      (e: unknown) => { if (current) setFetched({ state: 'error', message: e instanceof Error ? e.message : 'Tools unavailable' }) })
    return () => { current = false }
  }, [client])

  const tool = id && loaded.state === 'ready' ? loaded.catalogue.items.find((t) => t.id === id) ?? null : null
  const problem = tool && failed?.tool === tool.id ? failed.problem : ''
  const minds = useMemo(() => Object.values(agents), [agents])
  const compose = useCompose(look)
  const { plan, data } = useMemo(() => {
    const { data, facts } = tool ? toolScreen(tool, minds, problem) : toolsScreen(loaded, query, !!id)
    return { plan: compose(tool ? 'tool' : 'tools', facts), data }
  }, [tool, minds, loaded, query, problem, id, compose])

  async function toggle(item: ScreenItem, on: boolean) {
    const agent = agents[String(item.id)]
    if (!agent || !tool) return
    setBusy(true)
    try {
      await patchAgent(agent.id, { options: { ...agent.options, tools: withTool(agent, tool.id, on) } })
      setFailed(null)
    } catch (e) {
      setFailed({ tool: tool.id, problem: e instanceof Error ? e.message : 'Could not change this mind’s tools' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Page title={tool ? tool.title : 'Tools'} eyebrow={tool ? 'Tool' : 'What minds can think with'} label="Tools" onClose={() => navigate({ name: 'hive' })}>
      <div className="mx-auto max-w-3xl px-4 pt-2 pb-12 md:px-6">
        <Screen plan={plan} host={{
          data,
          busy,
          framed: true,
          onInput: (bind, value) => { if (bind === 'query') setQuery(value) },
          onOpen: (target, item) => { if (target === 'tool') navigate({ name: 'tools', id: String(item.id) }) },
          onBack: () => navigate({ name: 'tools' }),
          onAction: (action, item, value) => { if (action === 'toggle-tool') void toggle(item, value === true) },
        }} />
      </div>
    </Page>
  )
}
