// Purpose: what the stage's drawers read about an item: an artifact's row and saved text, a message found by its id,
// the name a person reads for any item, and whether an artifact's saved text is an image.
import { ApiError } from '../../api/client'
import { need, useResource } from '../../lib/useResource'
import { shown } from '../../lib/displayName'
import { useHive } from '../../store/store'
import { pageParts, useOpenScreens } from '../openScreens'
import type { ArrangeItem } from './arrangeSpace'

/** An artifact as the person may read it: its row, and its latest saved text when it has one. */
export function useArtifact(id: string, withText: boolean) {
  const client = useHive((s) => s.client)
  return useResource(async () => {
    const row = await need(client, 'artifact', 'Artifacts')(id)
    const text = withText && row.revision !== null ? await need(client, 'creationText', 'Artifacts')(id, row.revision) : null
    return { row, text }
  }, { context: `stage ${id} ${withText ? 'text' : 'row'}` })
}

export const why = (e: unknown) => (e instanceof ApiError && e.status === 404 ? 'It is no longer here, or not shown to you.' : e instanceof Error ? e.message : undefined)

/** What the person reads as the item's name: an artifact's title, a mind's name, a task's title, a message's sender. */
export function useTitle(item: ArrangeItem): string {
  const agents = useHive((s) => s.agents)
  const goals = useHive((s) => s.goals)
  const approvals = useHive((s) => s.approvals)
  const message = useMessage(item.source === 'message' ? item.key : null)
  const part = usePagePart(item.source === 'part' ? item.key : '')
  const art = useResource(async () => (item.source === 'artifact' ? need(useHive.getState().client, 'artifact', 'Artifacts')(item.key) : null), { context: `stage title ${item.key}` })
  switch (item.source) {
    case 'artifact': return art.data?.title ?? 'A creation'
    case 'mind': return agents[item.key] ? shown(agents[item.key].name) : 'A mind'
    case 'task': return goals[item.key]?.title ?? 'A task'
    case 'decision': return approvals[item.key] ? `Decision: ${approvals[item.key].skill}` : 'A decision'
    case 'message': return message ? `From ${message.direction === 'out' && agents[message.agent_id] ? shown(agents[message.agent_id].name) : 'you'}` : 'A message'
    case 'part': {
      const t = part?.part.props.title ?? part?.part.props.label
      return typeof t === 'string' && t ? t : 'Part of this page'
    }
  }
}

export function useMessage(id: string | null) {
  const messages = useHive((s) => s.messages)
  if (!id) return null
  for (const list of Object.values(messages)) {
    const m = list.find((x) => x.id === id)
    if (m) return m
  }
  return null
}

/** An image saved as text: an SVG document, or a data: URL of a picture. Anything else is not drawn as an image. */
export function imageSource(body: string): string | null {
  const t = body.trim()
  if (/^<svg[\s>]/i.test(t) || (/^<\?xml[\s\S]*?<svg[\s>]/i.test(t) && /<\/svg>\s*$/i.test(t))) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(t)}`
  if (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/.test(t)) return t.replace(/\s+/g, '')
  return null
}
/** The open page's part a stage item stands for, while that page draws it. */
export function usePagePart(key: string) {
  const screens = useOpenScreens()
  return pageParts(screens).find((p) => p.key === key) ?? null
}


