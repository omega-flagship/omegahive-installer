/**
 * Demo mode: what to try in the Ask (Surface demo D2). Each phrase goes to the answering mind, never to a local
 * shortcut (demoTries.test.ts holds that), and the simulated mind acts on it (api/sim/ask.ts). The one exception
 * (Surface demo D4): "show me around" starts the showreel, which the Ask hands to before anything else in demo mode
 * (features/showreel/hook); on a hive without the showreel it still goes to the mind.
 */
export const DEMO_TRIES: { say: string; shows: string }[] = [
  { say: 'drive the page for me', shows: 'The Ask moves the page: it opens Swarms, points at them, opens search, types and marks where search starts. Click or scroll the page while it works and you take over.' },
  { say: 'open tools in Kelp', shows: 'Kelp does not allow Omega Tools, so the Ask’s move ends on the page that says why.' },
  { say: 'call me Ada, and I prefer short answers', shows: 'The Ask learns about you and keeps it in this browser only. Its first answer also learns a few invented notes.' },
  { say: 'show me around', shows: 'The showreel: the demo plays the hive by itself, with a cursor and drawings. Type “why?” to pause it and ask.' },
]
