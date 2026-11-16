// Purpose: a session page's words for a person: a mind's request as one plain line, and a repository by its name.
import type { Risk, SessionItem } from '../../api/types'
import type { Target } from '../code/CodePage'
import { explainApproval } from '../../experiences/still/language'

type ApprovalItem = Extract<SessionItem, { type: 'approval' }>

const STATUS: Record<string, string> = { pending: 'Waiting for you', approved: 'Allowed', used: 'Allowed', denied: 'Not allowed', expired: 'Expired' }
const RISK: Record<string, string> = { high: 'high risk', medium: 'medium risk', low: 'low risk' }

/**
 * A request in one line: "Asha wants to run a command on the computer", "Asha wants to read notes/plan.md" (the
 * words are Still's explainApproval, shared), why a person is asked, its risk and its answer so far. No skill name, no
 * MeTTa: those are under "Show the command".
 */
export function approvalLine(mind: string, a: Pick<ApprovalItem, 'skill' | 'command' | 'reason' | 'risk' | 'status'>): { wants: string; why: string; risk: string | null; status: string } {
  // explainApproval reads the risk only for its stakes line, which is not used here; an unknown risk reads as low
  const e = explainApproval({ ...a, risk: (a.risk in RISK ? a.risk : 'low') as Risk })
  const what = e.wants === 'read a file' && e.detail ? `read ${e.detail}` : e.wants
  return { wants: `${mind} wants to ${what}`, why: e.why, risk: RISK[a.risk] ?? null, status: STATUS[a.status] ?? 'Answered' }
}

/** Repository id → its name, from Code's targets (a repository's own entry first). An unnamed repository is left out. */
export function repositoryNames(targets: readonly Pick<Target, 'kind' | 'label' | 'repository_id'>[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  for (const t of [...targets].sort((a, b) => Number(b.kind === 'repository') - Number(a.kind === 'repository'))) {
    const label = t.label?.trim()
    if (t.repository_id && label && label !== t.repository_id && !names.has(t.repository_id)) names.set(t.repository_id, label)
  }
  return names
}
