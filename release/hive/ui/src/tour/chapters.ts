/** Chapter titles and one-liners, shared by the tour, its chapter list and the help sheet. */
export const CHAPTERS = [
  { id: 'hive', title: 'The hive and its minds', blurb: 'What the glowing minds are and how to read them.' },
  { id: 'swarm', title: 'A swarm and its commons', blurb: 'The shared beliefs of one swarm, drawn as stars.' },
  { id: 'dot', title: "A mind's panel", blurb: 'Chat, Thinking, Memory, Schedule, Model and Tools.' },
  { id: 'commons', title: 'Beliefs and where they came from', blurb: 'A belief, its sources and how it is revised.' },
  { id: 'goals', title: 'Tasks', blurb: 'Posting, claiming, leases, the motivations work serves, and work waiting on you.' },
  { id: 'approvals', title: 'Inbox and policy rules', blurb: 'The safety gate: approve once, always allow, rules.' },
  { id: 'lab', title: 'The Lab', blurb: 'Scorecard, drift scenarios and history.' },
  { id: 'programs', title: 'Hive apps', blurb: 'Work as maps: unfold, map, compare, detail.' },
  { id: 'safety', title: 'Safety: stop all and budgets', blurb: 'The kill switch and spending caps.' },
  { id: 'start', title: 'Your turn', blurb: 'Where to start.' },
] as const

export type ChapterId = (typeof CHAPTERS)[number]['id']

export function meta(id: ChapterId): { id: ChapterId; title: string; blurb: string } {
  return CHAPTERS.find((c) => c.id === id)!
}
