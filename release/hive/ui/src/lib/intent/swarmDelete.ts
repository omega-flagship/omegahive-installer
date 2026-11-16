/**
 * "delete the Forge swarm" in the shared fast path (Jon 2026-10-07): it only OPENS the swarm-delete warning (effect
 * 'open-decision'), which shows what goes and needs the exact name typed. The Ask never deletes anything itself.
 * Several swarms with the name: "which one?" with chips.
 */
import { shortIds } from './ident'
import type { Candidate, Chip, Named, World } from './types'

const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim()

const DELETE = /^(?:please\s+|can you\s+|could you\s+)?(?:delete|remove)\s+(.+?)[.!]?$/i
const WITH_MINDS = /\s+(?:and|with|together with|along with|plus)\s+(?:all\s+)?(?:of\s+)?(?:its|the|their)\s+minds$/i

/** "delete the Forge swarm" (or "delete swarm Forge", "delete Forge and its minds"): open its warning; nothing more. */
export function deleteSwarmCandidates(raw: string, world: World): Candidate[] {
  const m = raw.match(DELETE)
  if (!m) return []
  let body = m[1].trim()
  const minds = WITH_MINDS.test(body)
  body = body.replace(WITH_MINDS, '').trim()
  let said = minds
  const tail = body.match(/^(?:the\s+)?(.+?)\s+swarm$/i)
  const head = body.match(/^(?:the\s+)?swarm\s+(?:called\s+|named\s+)?(.+)$/i)
  if (tail) [body, said] = [tail[1], true]
  else if (head) [body, said] = [head[1], true]
  else body = body.replace(/^the\s+/i, '')
  if (!said || !body) return []
  const t = fold(body)
  // live swarms and archived ones (an earlier delete may have left one archived with cleanup pending)
  const known = new Set(world.swarms.map((x) => x.id))
  const all = [...world.swarms, ...(world.archivedSwarms ?? []).filter((x) => !known.has(x.id))]
  const hits = all.filter((x) => fold(x.name) === t)
  if (!hits.length) return []
  const sid = shortIds(all.map((x) => x.id))
  const who = (x: Named) => `swarm · #${sid.get(x.id) ?? x.id.slice(-6)}`
  const parts = (x: Named) => [{ t: 'Delete ' }, { t: x.name, em: true }, { t: ` (${who(x)})`, who: true }, { t: ' and its minds. A warning opens; nothing is deleted until you type its name.' }]
  if (hits.length === 1) return [{ key: `delete-swarm-${hits[0].id}`, tag: 'Delete', act: { do: 'deleteSwarm', swarm: hits[0] }, effect: 'open-decision', confidence: 0.95, parts: parts(hits[0]) }]
  const chips: Chip[] = hits.slice(0, 6).map((x) => ({ key: x.id, label: x.name, who: who(x), act: { do: 'deleteSwarm', swarm: x } }))
  return [{ key: 'delete-swarm-which', tag: 'Which', effect: 'open-decision', confidence: 0.95, parts: [{ t: 'Delete the swarm ' }, { t: hits[0].name, em: true }], clarify: { question: `Which one? ${hits.length} swarms are called ${hits[0].name}.`, chips } }]
}
