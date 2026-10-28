/**
 * SIM ONLY. Demo mode's defaults (Surface demo D2): what plain demo mode (`?sim=1`, the demo build) plays when nothing
 * else is asked for. Every name, note and line here is INVENTED; nothing reaches a hive, a model or the network.
 *
 * - The visitor is Ada Brightwater (user:p_ada, an invented admin), not the hive's operator.
 * - One app is refused in one swarm (Omega Tools in Kelp), so the Ask's refused move shows RefusedHere.
 * - The Ask's memory is on, and its first answer teaches a few invented notes about Ada (memory: learning).
 * - Two swarms' team rooms (the host's, r6) open mid-conversation; their minds @-mention each other and reply.
 * - Two extra swarms for the swarm-delete cases the base fixtures do not seed: one that deletes cleanly, and one
 *   archived with a delete half-finished (cleanup still owed for a mind already deleted).
 */
import type { Swarm } from '../types'

/** Is this page plain demo mode: the demo build, or `?sim=1`. */
export function isDemoMode(search: string, mode: string): boolean {
  return mode === 'demo' || new URLSearchParams(search).get('sim') === '1'
}

/** The app a swarm refuses by default in demo mode (`?refuse=` replaces it). */
export const DEMO_REFUSE = ['omega-tools@s_kelp']

/** INVENTED: what the demo's Ask learns about Ada on its first answer (kept in the browser, never on the hive). */
export const DEMO_MEMORY_NOTES: { statement: string; kind: 'name' | 'preference' | 'project' | 'place'; confidence: number }[] = [
  { statement: 'Call them Ada', kind: 'name', confidence: 0.9 },
  { statement: 'Prefers short answers with the numbers first', kind: 'preference', confidence: 0.8 },
  { statement: 'Leads the kelp canopy survey write-up', kind: 'project', confidence: 0.7 },
]

/**
 * INVENTED: two team rooms' opening conversations (minutes ago). Team rooms are the host's (r6): every swarm has one
 * private "<swarm> team" group holding its owner and its minds, and admins who open it. `you` is the visitor (Ada, an
 * admin who opened it before); `@Name` mentions a mind. As on the host, minds answer each other at most three times in a
 * row before a person speaks again (rooms.py turn_cap).
 */
export const DEMO_TEAM_TALK: Record<string, { from: string; text: string; ago: number }[]> = {
  s_lyra: [
    { from: 'you', text: 'Morning, everyone. What should we look at first tonight?', ago: 84 },
    { from: 'Vega', text: '@Deneb the seeing forecast drops after midnight. Can you take the early window on the binaries?', ago: 82 },
    { from: 'Deneb', text: 'Yes. I will start at nine and hand the late window to @Mira if the cloud holds off.', ago: 80 },
    { from: 'Mira', text: 'Fine by me. @Vega, do you want the flare list cross-checked before I start?', ago: 77 },
    { from: 'you', text: 'Yes please, Mira. Two of last night’s flares looked odd to me too.', ago: 75 },
    { from: 'Vega', text: 'Agreed. I will post the two candidates here so everyone sees the same list.', ago: 73 },
  ],
  s_forge: [
    { from: 'you', text: 'How is the parser review going?', ago: 52 },
    { from: 'Anvil', text: '@Bellows the parser passes on the recorded tides. Can you check what the review cost so far?', ago: 50 },
    { from: 'Bellows', text: 'Forty-two cents of the two dollars allowed. @Anvil, plenty left for the second pass.', ago: 48 },
    { from: 'you', text: 'Good. Write it up for Lyra once the second pass is done.', ago: 46 },
    { from: 'Anvil', text: 'Will do. I will post the summary here first.', ago: 45 },
  ],
}

/** INVENTED: what a teammate says when another mind @-mentions it in a team room (the sim's stand-in for its turn). */
export const DEMO_TEAM_ASKS = [
  'can you take a look at the latest numbers?',
  'do you have a minute to check my working?',
  'could you pick up the next item on our list?',
  'what did you make of this morning’s results?',
]
export const DEMO_TEAM_REPLIES = [
  'On it. I will post what I find here.',
  'Yes. Give me a few minutes and I will report back.',
  'Looks sound to me; one small thing to tidy, which I have noted.',
  'Done. Nothing surprising, and the totals add up.',
]

/** INVENTED: the two extra swarms for the swarm-delete cases (see the header). Their minds borrow a seeded mind's model. */
export const DEMO_SWARMS: { swarm: Omit<Swarm, 'member_ids' | 'created_at'>; daysAgo: number; archivedDaysAgo?: number; minds: { id: string; name: string; hue: number; persona: string; status: 'asleep' | 'stopped' }[] }[] = [
  {
    // a normal swarm: two sleeping minds, no tasks, nothing running; it deletes cleanly
    swarm: { id: 's_drift', name: 'Driftwood', description: 'A small practice swarm for sorting beach-survey photos.', hue: 32, coordinator_id: 'a_drft13', parent_mind_id: null, parent_swarm_id: null, child_swarm_ids: [], services: [], owner: 'user:p_ada', visibility: 'public' },
    daysAgo: 12,
    minds: [
      { id: 'a_drft13', name: 'Pebble', hue: 30, persona: 'Sorts survey photos by beach and tide.', status: 'asleep' },
      { id: 'a_drft14', name: 'Shingle', hue: 52, persona: 'Checks the photo labels and flags blurry ones.', status: 'asleep' },
    ],
  },
  {
    // archived with a delete half-finished: Reed was deleted but its workspace is still to be cleaned up, Rush remains
    swarm: { id: 's_salt', name: 'Saltmarsh', description: 'Retired marsh-bird count swarm, part way through being deleted.', hue: 110, coordinator_id: null, parent_mind_id: null, parent_swarm_id: null, child_swarm_ids: [], services: [], owner: 'user:p_ada', visibility: 'public', archived_by: 'user:p_ada' },
    daysAgo: 30,
    archivedDaysAgo: 1,
    minds: [{ id: 'a_salt16', name: 'Rush', hue: 118, persona: 'Counted wading birds at the marsh hides.', status: 'stopped' }],
  },
]
/** INVENTED: minds already deleted whose cleanup is still owed, by swarm (the host's mind_cleanup rows). */
export const DEMO_CLEANUP_OWED: Record<string, string[]> = { s_salt: ['a_salt15'] }
