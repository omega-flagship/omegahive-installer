export type Scope = 'mind' | 'swarm' | 'grand'
type Goal = { swarm_id?: string; id: string; title: string; status: string; assignee?: string | null; claimed_by?: string | null; parent_id?: string | null; result?: string | null }
type RequestRecord = { origin_owner?: string | null; receiving_holder?: string | null; id: string; kind: string; state: string; from_goal: string; receiving_goal: string; result?: {review_receipt?: unknown} | null }
export type Board = { kind: Scope; entity_id: string | null; goals: Goal[]; requests: RequestRecord[] }
export type Matches = { candidates: { entity_id: string; name: string; active_claims: number; eligibility: string; capacity: string; cost: string; verified_capabilities: string[]; reasons: string[]; uncertainties: string[] }[] }
