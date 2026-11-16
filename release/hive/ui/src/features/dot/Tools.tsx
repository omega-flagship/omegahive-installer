import { useEffect, useState } from 'react'
import type { Agent, ToolsCatalogue } from '../../api/types'
import { useHive } from '../../store/store'
import { ReasoningModules } from './reasoning/ReasoningModules'

export function Tools({ agent }: { agent: Agent }) {
  const client = useHive((s) => s.client)
  const save = useHive((s) => s.patchAgent)
  const [catalogue, setCatalogue] = useState<ToolsCatalogue | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let current = true
    if (!client?.tools) return
    client.tools().then((data) => { if (current) setCatalogue(data) },
      (e: unknown) => { if (current) setError(e instanceof Error ? e.message : 'Tools unavailable') })
    return () => { current = false }
  }, [client])
  const enabled = agent.options?.tools ?? []
  async function toggle(id: string) {
    setBusy(true)
    const tools = enabled.includes(id) ? enabled.filter((x) => x !== id) : [...enabled, id]
    try {
      await save(agent.id, { options: { ...agent.options, tools } })
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the selection')
    } finally {
      setBusy(false)
    }
  }
  return <section className="space-y-4 px-4 py-4" aria-label="Tools">
    <div><h2 className="text-lg font-medium">Tools for {agent.name}</h2>
      <p className="text-sm text-ink-3">Optional skills of thought. Outputs are advisory; saving a thought or acting on it uses the mind’s existing permissions.</p></div>
    {error && <p role="alert">{error}</p>}
    {!client?.tools && <p>This host does not offer the Tools catalogue yet.</p>}
    {catalogue && <p className="text-sm text-ink-3">Choose the advisory skills this mind can use. App access is controlled by its existing Hive grants. An Omega mind rebuilds its skill wrappers when the selection changes.</p>}
    {catalogue?.items.map((item) => <article key={item.id} className="space-y-2 rounded-xl border border-line p-4">
      <label className="flex items-center justify-between gap-3"><span className="font-medium">{item.title}</span>
        <input type="checkbox" aria-label={`Enable ${item.title}`} checked={enabled.includes(item.id)}
          disabled={busy || !item.activatable}
          onChange={() => void toggle(item.id)} /></label>
      <p className="text-sm text-ink-2">{item.summary}</p>
      <p className="text-xs text-ink-3">{item.origin === 'donor' ? 'Reused native mechanism' : 'New sample'} · {item.effects.length ? item.effects.join(', ') : 'No effects'} · {item.activatable ? 'Selectable advisory skill' : 'Catalogue only'}</p>
      <p className="text-xs text-ink-3">{item.qualification}: {item.qualification_scope}</p>
      <p className="text-xs text-ink-4">{item.maker}</p>
    </article>)}
    {catalogue && !catalogue.items.length && <p>No reviewed tool package is configured.</p>}
    <ReasoningModules agent={agent} />
  </section>
}
