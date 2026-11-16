import { namedArtifacts } from '../../lib/artifactRefs'

/**
 * Which views a conversation names, and under which message each is drawn (MessageViews): a mind saves a view as an
 * artifact and sends its id with a short digest (hive/templates/omega/prompt.txt), so an artifact id in its words marks
 * where the view belongs, and each is drawn once, under the last of the mind's messages that names it. The id itself
 * is shown as the artifact's title (features/views/Words).
 */

/** For each of the mind's own messages (direction out), the artifact ids it is the last to name.
 *  Time: O(total length of the messages' text). */
export function lastMentions(messages: readonly { id: string; direction: string; text: string }[]): Map<string, string[]> {
  const lastBy = new Map<string, string>()   // artifact id -> the last message naming it
  for (const m of messages) if (m.direction === 'out') for (const id of namedArtifacts(m.text)) lastBy.set(id, m.id)
  const out = new Map<string, string[]>()
  for (const [artifact, message] of lastBy) out.set(message, [...(out.get(message) ?? []), artifact])
  return out
}
