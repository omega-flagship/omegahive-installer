import type { ActionResult, ProgramActBody } from '../api/types'

export interface HostPersonActClient {
  programAct(program: string, body: ProgramActBody): Promise<ActionResult>
  /** This separate host transport consumes an advisory HTTP header, never an app's result fields. */
  hostProgramAct?(program: string, body: ProgramActBody): Promise<{ result: ActionResult; personSwarmConsentRequired: boolean }>
}

interface HostGeneration {
  client: object
  program: string
  swarm: string | null
  current: () => boolean
  consentRequired: () => void
}
const generations = new Set<HostGeneration>()

/** A registration is a specific mounted ProgramPage generation, not a persistent app-wide subscription. */
export function registerPersonSwarmHost(generation: HostGeneration): () => void {
  generations.add(generation)
  return () => { generations.delete(generation) }
}

/** Called only by host person-act and actual HostConfirm paths, never default/frame programAct. */
export async function personStartedProgramAct(
  client: HostPersonActClient, program: string, body: ProgramActBody, current: () => boolean,
): Promise<ActionResult> {
  if (!current()) throw new Error('This host act is no longer current.')
  if (!client.hostProgramAct) return client.programAct(program, body)
  // Capture before the request: an old act cannot open a newly mounted page after A -> B -> A.
  const captured = [...generations].filter((g) => g.client === client && g.program === program && g.swarm === body.swarm_id && g.current())
  const answer = await client.hostProgramAct(program, body)
  if (current() && answer.personSwarmConsentRequired === true) {
    for (const g of captured) if (generations.has(g) && g.current()) g.consentRequired()
  }
  // Return the exact original JSON body. No header, hint, card or other metadata reaches the caller/frame.
  return answer.result
}
