import type { ToolsCatalogue } from '../types'

/** The simulator's tools catalogue: invented tools, each marked as a sample, never a real tool or real evidence. */
export function simToolsCatalogue(): ToolsCatalogue {
  const sample = 'Simulator sample: invented, not a real tool'
  const scope = 'invented examples only'
  return {
    offline_candidate: false,
    items: [
      { id: 'sim-weigh-evidence', title: 'Weigh the evidence', summary: 'Sets the reasons for and against a claim side by side, with how sure each one is.', maker: 'Invented Lab', origin: 'simulator', effects: ['reads memory', 'suggests beliefs'], qualification: sample, qualification_scope: scope, activatable: true },
      { id: 'sim-plan-steps', title: 'Plan in steps', summary: 'Breaks a task into small steps a person can check one by one.', maker: 'Invented Lab', origin: 'simulator', effects: ['suggests tasks'], qualification: sample, qualification_scope: scope, activatable: true },
      { id: 'sim-find-contradictions', title: 'Find contradictions', summary: 'Looks through what a mind believes for two things that cannot both be true.', maker: 'Example Works', origin: 'simulator', effects: ['reads memory'], qualification: sample, qualification_scope: scope, activatable: true },
      { id: 'sim-explain-simply', title: 'Explain it simply', summary: 'Rewrites an answer in plain words for someone new to the subject.', maker: 'Example Works', origin: 'simulator', effects: [], qualification: sample, qualification_scope: scope, activatable: false },
    ],
  }
}
