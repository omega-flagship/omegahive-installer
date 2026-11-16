import type { Agent, ToolsCatalogue } from '../../api/types'
import type { ScreenFacts } from '../../screens/screenSpace'
import { withResource, type ResourceLike } from '../../screens/resourceFacts'

/**
 * What the Tools screens are told: the values they draw (bound by path) and this moment's facts (counts and flags)
 * from which MeTTa composes them (tools.metta). Pure.
 */
export type Tool = ToolsCatalogue['items'][number]
export type Loaded = { state: 'loading' } | { state: 'unsupported' } | { state: 'error'; message: string } | { state: 'ready'; catalogue: ToolsCatalogue }

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean)
/** Every word of the search appears in the tool's name, summary, maker, origin or effects. */
export function matches(tool: Tool, query: string): boolean {
  const hay = [tool.title, tool.summary, tool.maker, tool.origin, ...tool.effects].join(' ').toLowerCase()
  return words(query).every((w) => hay.includes(w))
}

export function toolsScreen(loaded: Loaded, query: string, gone = false): { data: Record<string, unknown>; facts: ScreenFacts } {
  const all = loaded.state === 'ready' ? loaded.catalogue.items : []
  const shown = all.filter((t) => matches(t, query)).sort((a, b) => a.title.localeCompare(b.title))
  return withResource(resourceOf(loaded), {
    data: { 'tools.all': all, 'tools.shown': shown, query },
    facts: {
      counts: { 'tools.all': all.length, 'tools.shown': shown.length },
      flags: {
        'tool.gone': gone && loaded.state === 'ready',
        offline: loaded.state === 'ready' && loaded.catalogue.offline_candidate,
      },
    },
  })
}

/** Where the catalogue is, as the standard resource state (a failure's words are its error). */
function resourceOf(loaded: Loaded): ResourceLike {
  if (loaded.state === 'error') return { status: 'error', error: loaded.message }
  return { status: loaded.state, error: undefined }
}

export interface MindRow { id: string; name: string; on: boolean }

export function toolScreen(tool: Tool, agents: Agent[], problem = ''): { data: Record<string, unknown>; facts: ScreenFacts } {
  const minds: MindRow[] = agents
    .map((a) => ({ id: a.id, name: a.name, on: (a.options?.tools ?? []).includes(tool.id) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const data: Record<string, unknown> = { 'tool.minds': minds, 'tool.effects': tool.effects, 'change.problem': problem }
  for (const [k, v] of Object.entries(tool)) if (typeof v === 'string') data[`tool.${k}`] = v
  return {
    data,
    facts: {
      counts: { 'tool.effects': tool.effects.length, 'tool.minds': minds.length },
      flags: { 'tool.activatable': tool.activatable, 'change.failed': problem !== '' },
    },
  }
}

/** A mind's tools after turning one on or off: its other tools stay as they are. */
export function withTool(agent: Agent, toolId: string, on: boolean): string[] {
  const current = agent.options?.tools ?? []
  return on ? [...new Set([...current, toolId])] : current.filter((t) => t !== toolId)
}
