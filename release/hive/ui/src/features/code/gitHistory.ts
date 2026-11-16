export type HistoryMode = 'snapshot' | 'original'
export interface GitHistoryReceipt { workspace_id: string; history_kind: string; original_history_included: boolean; baseline_commit: string; source_base_commit: string; published: boolean }
export function verifyGitHistory(receipt: GitHistoryReceipt, workspace: string, mode?: HistoryMode) {
  if (receipt.workspace_id !== workspace || receipt.published !== false) throw new Error('Unexpected Git review scope or publication')
  const original = receipt.history_kind === 'original-parent-ancestry'
  if (!original && receipt.history_kind !== 'reconstructed-manifest-snapshots' || original !== receipt.original_history_included ||
      original && receipt.baseline_commit !== receipt.source_base_commit ||
      mode && original !== (mode === 'original')) throw new Error('Git history receipt differs from selected mode or original parent')
}
export function gitExportBody(source: { id: string; generation: number; tree_digest: string }, branch: string, message: string, mode: HistoryMode, operation: string) {
  return { operation_id: operation, expected_generation: source.generation, expected_tree_digest: source.tree_digest, branch, message,
    ...(mode === 'original' ? { history_mode: 'original' as const } : {}) }
}
