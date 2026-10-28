/** "What's this?" copy for every main view, the one-line first-visit hints, and the tour chapter each one plays. */
export type ViewKey =
  | 'hive'
  | 'swarm'
  | 'dot-chat'
  | 'dot-mind'
  | 'dot-memory'
  | 'dot-schedule'
  | 'dot-model'
  | 'dot-tools'
  | 'approvals'
  | 'policy'
  | 'goals'
  | 'motivations'
  | 'lab'
  | 'programs'
  | 'program'

export interface ViewHelp {
  title: string
  body: string
  /** One gentle line, shown the first time someone opens the view on their own. */
  hint: string
  /** The hint is remembered per hint key (the mind panel's tabs share one). */
  hintKey: string
  /** The tour chapter "Show me" plays. */
  chapter: string
}

export const VIEW_HELP: Record<ViewKey, ViewHelp> = {
  hive: {
    title: 'The hive',
    body: 'Every glowing orb is a mind, an AI that stays on. Minds live in swarms, circling a shared core. Hover or tap a mind to see what it is doing, and open it to talk to it.',
    hint: 'Each glowing orb is a mind, an AI that stays on. Tap one to meet it.',
    hintKey: 'hive',
    chapter: 'hive',
  },
  swarm: {
    title: 'A swarm and its commons',
    body: 'A swarm is a group of minds that share one commons: the beliefs they have gathered, each backed by evidence. Nearer the core means more confident. Tap a star to see where it came from.',
    hint: 'Each star is a belief this swarm shares. Tap one to see its evidence.',
    hintKey: 'swarm',
    chapter: 'swarm',
  },
  'dot-chat': {
    title: 'Chat',
    body: 'Talk to this mind directly. It answers in its own voice and can draw on what its swarm believes. Status buttons up top wake it, put it to sleep or stop it.',
    hint: 'This is one mind. Its tabs show its chat, its thinking, memory, schedule and model.',
    hintKey: 'dot',
    chapter: 'dot',
  },
  'dot-mind': {
    title: 'Thinking',
    body: 'Watch this mind think. Each step shows what woke it, what the model said, the commands it ran and what the safety gate decided. Replay steps back through recent thinking.',
    hint: 'This is one mind. Its tabs show its chat, its thinking, memory, schedule and model.',
    hintKey: 'dot',
    chapter: 'dot',
  },
  'dot-memory': {
    title: 'Memory',
    body: 'What this mind keeps privately, grouped into spaces. Search it, retire an item it should not keep, or reset its memory entirely.',
    hint: 'This is one mind. Its tabs show its chat, its thinking, memory, schedule and model.',
    hintKey: 'dot',
    chapter: 'dot',
  },
  'dot-schedule': {
    title: 'Schedule',
    body: 'When this mind wakes itself up and when it naps. Add wakeups that repeat or happen once, and choose how long it idles before it sleeps.',
    hint: 'This is one mind. Its tabs show its chat, its thinking, memory, schedule and model.',
    hintKey: 'dot',
    chapter: 'dot',
  },
  'dot-model': {
    title: 'Model',
    body: 'The AI model this mind runs on, its persona, its colour and its budget cap. A call that would go over the cap is refused before it runs.',
    hint: 'This is one mind. Its tabs show its chat, its thinking, memory, schedule and model.',
    hintKey: 'dot',
    chapter: 'dot',
  },
  'dot-tools': {
    title: 'Tools',
    body: 'Optional skills of thought for this mind. Read what each skill does, where it came from and what its tests establish. Enabling a skill grants no permission to save its output or act on it.',
    hint: 'Tools add optional ways to think. Every choice applies to this mind.',
    hintKey: 'dot',
    chapter: 'dot',
  },
  approvals: {
    title: 'Inbox',
    body: 'When a mind reaches for something risky, it pauses and asks here. Approve once runs that exact command one time. Always allow also adds a rule. Deny says no.',
    hint: 'Minds ask here before risky actions. Nothing runs until you decide.',
    hintKey: 'approvals',
    chapter: 'approvals',
  },
  policy: {
    title: 'Policy rules',
    body: 'Rules decide what a mind may do: allow, ask first, or deny. Set them for the whole hive, one swarm or one mind; the most specific rule wins. Try it shows the answer for any mind and skill.',
    hint: 'Rules decide what minds may do on their own and what needs you.',
    hintKey: 'policy',
    chapter: 'approvals',
  },
  goals: {
    title: 'Tasks',
    body: 'Tasks are the work itself, posted by you or by minds. A mind claims one and holds a timed lease while it works; if the lease runs out, the task goes back to Open. Amber cards are waiting on you. Show them in columns or as a list, for one swarm or all, and filter by the motivation they serve.',
    hint: 'Tasks are the work. Amber ones are waiting on you.',
    hintKey: 'goals',
    chapter: 'goals',
  },
  motivations: {
    title: 'Motivations',
    body: 'Motivations are why the work exists: aims held by a person, a swarm or a mind. Tasks are filed under them, and one task can serve several. Filing a task under a motivation tells no mind anything; only people who can read the motivation see the link.',
    hint: 'Motivations are the why. Tasks are filed under them.',
    hintKey: 'motivations',
    chapter: 'goals',
  },
  lab: {
    title: 'The Lab',
    body: 'The Lab tests the hive itself: tests for correctness, and benchmarks for speed, cost, safety and drift. The scorecard sums up the latest run of each suite. Research reports (Evolve) below it are claims as their submitters reported them, with any figures they attached: not runs, not checked by the hive, and never counted in the scorecard.',
    hint: 'The Lab tests the hive itself. The scorecard sums up the latest runs.',
    hintKey: 'lab',
    chapter: 'lab',
  },
  programs: {
    title: 'Apps',
    body: 'Apps turn a piece of work into a map you can explore. An app supplies items, links and sources; the hive lays them out and keeps your trail.',
    hint: 'Apps turn a piece of work into a map you can explore.',
    hintKey: 'programs',
    chapter: 'programs',
  },
  program: {
    title: 'An app',
    body: 'Unfold puts one item in the middle with support and doubts around it. Map shows the whole graph, Compare sets groups side by side, Detail shows one item. Sources and your trail stay in view.',
    hint: 'Try the four stages up top: Unfold, Map, Compare and Detail.',
    hintKey: 'program',
    chapter: 'programs',
  },
}
