import type { WorkItem, WorkLink } from '../types'

/**
 * SIM ONLY, INVENTED CONTENT (demo D3): the rest of the simulator's tools catalogue, so the stand-in has the size of
 * the real one (80 tools, sets, foundations and components, with the three tools, two sets, two foundations and two
 * components omegaTools.ts already has). Every name, description and composition here is made up for the simulator;
 * nothing is copied from the Tools app. Inspection only: nothing here runs.
 */

type Kit = { set: { id: string; label: string; text: string }; foundation: string; uses: string[]; tools: [string, string][] }

const KITS: Kit[] = [
  {
    set: { id: 's-plan', label: 'Planning kit (invented set)', text: '' },
    foundation: 'f-order',
    uses: ['c-steps'],
    tools: [
      ['split-into-steps', 'Splits a task into short, ordered steps.'],
      ['estimate-effort', 'Gives each step a rough small, medium or large size.'],
      ['order-by-dependency', 'Puts steps after the steps they need.'],
      ['pick-next-step', 'Names the one step to do next, and why.'],
      ['mark-blocked', 'Marks steps that wait on something outside the list.'],
      ['balance-workload', 'Spreads steps evenly across named helpers.'],
      ['group-similar-tasks', 'Groups tasks that can be done together.'],
      ['due-soon', 'Lists what is due within a stated number of days.'],
      ['weigh-options', 'Lays two or three options side by side with their trade-offs.'],
    ],
  },
  {
    set: { id: 's-read', label: 'Reading kit (invented set)', text: '' },
    foundation: 'f-shape',
    uses: ['c-lines', 'c-tone'],
    tools: [
      ['key-points', 'Lists the key points of a passage, in order.'],
      ['find-questions', 'Finds the questions a thread asked.'],
      ['unanswered-items', 'Lists the questions nobody answered yet.'],
      ['extract-dates', 'Pulls the dates mentioned in a passage.'],
      ['extract-places', 'Pulls the places mentioned in a passage.'],
      ['thread-timeline', 'Turns a thread into a short timeline.'],
      ['detect-tone', 'Says whether a message reads calm, urgent or unsure.'],
      ['diff-two-texts', 'Shows what changed between two versions of a text.'],
    ],
  },
  {
    set: { id: 's-memory', label: 'Memory kit (invented set)', text: 'Tools for keeping, finding and tidying notes.' },
    foundation: 'f-recall',
    uses: ['c-tags', 'c-dupes'],
    tools: [
      ['recall-by-tag', 'Finds notes carrying a stated tag.'],
      ['recall-recent', 'Lists the newest notes first.'],
      ['pin-a-note', 'Marks a note to keep at the top.'],
      ['list-pinned', 'Lists the pinned notes.'],
      ['merge-duplicates', 'Proposes merging notes that say the same thing.'],
      ['age-out-stale', 'Lists notes nobody has read for a long while.'],
      ['tag-suggest', 'Suggests tags for an untagged note.'],
      ['compare-notes', 'Shows where two notes agree and differ.'],
      ['forget-on-request', 'Drafts the list of notes to forget, for a person to confirm.'],
      ['export-notes', 'Lays notes out as one plain document.'],
    ],
  },
  {
    set: { id: 's-count', label: 'Counting kit (invented set)', text: 'Tools for tallies, averages and changes.' },
    foundation: 'f-tally',
    uses: ['c-numbers'],
    tools: [
      ['tally-sightings', 'Counts sightings by place and day.'],
      ['average-of-list', 'Averages a list of numbers.'],
      ['median-of-list', 'Finds the middle value of a list.'],
      ['count-by-label', 'Counts items under each label.'],
      ['running-total', 'Adds a running total to a list.'],
      ['percent-change', 'Gives the change between two numbers as a percentage.'],
      ['round-for-display', 'Rounds numbers for a readable table.'],
      ['spot-outliers', 'Flags values far from the rest.'],
      ['sum-by-day', 'Adds values up per day.'],
      ['rate-per-hour', 'Turns counts into a rate per hour.'],
    ],
  },
  {
    set: { id: 's-time', label: 'Timekeeping kit (invented set)', text: 'Tools for dates, durations and schedules.' },
    foundation: 'f-order',
    uses: ['c-date', 'c-clock'],
    tools: [
      ['next-free-slot', 'Finds the next free slot in a list of bookings.'],
      ['days-until', 'Counts the days until a date.'],
      ['sort-by-date', 'Orders items by their date.'],
      ['group-by-week', 'Groups dated items by week.'],
      ['timezone-label', 'Labels a time with a stated time zone.'],
      ['overdue-list', 'Lists items past their date.'],
      ['draft-reminder', 'Drafts the words of a reminder; it never sends one.'],
      ['duration-between', 'Gives the time between two moments.'],
      ['weekday-name', 'Names the weekday of a date.'],
      ['merge-schedules', 'Lays two schedules side by side and marks clashes.'],
    ],
  },
  {
    set: { id: 's-write', label: 'Writing kit (invented set)', text: 'Tools for tidying and reshaping text.' },
    foundation: 'f-shape',
    uses: ['c-words'],
    tools: [
      ['tidy-wording', 'Suggests plainer wording for a sentence.'],
      ['shorten-to-line', 'Shortens a paragraph to one line.'],
      ['title-case', 'Puts a heading in title case.'],
      ['bullets-to-prose', 'Turns a bullet list into a short paragraph.'],
      ['prose-to-bullets', 'Turns a paragraph into a bullet list.'],
      ['spell-check-list', 'Lists words that look misspelt.'],
      ['plain-words', 'Swaps jargon for everyday words.'],
      ['add-headings', 'Suggests headings for a long text.'],
      ['word-count', 'Counts words and sentences.'],
      ['quote-cleanly', 'Formats a quotation with its source.'],
    ],
  },
]

const FOUNDATIONS: WorkItem[] = [
  { id: 'f-recall', kind: 'foundation', label: 'Recall by key (invented foundation)', text: 'Finding a stored item again by a stated key or tag.' },
  { id: 'f-tally', kind: 'foundation', label: 'Tallying (invented foundation)', text: 'Counting and combining numbers in a stated way.' },
]
const COMPONENTS: WorkItem[] = [
  ['c-steps', 'step splitter', 'Breaks a line of work into steps.'],
  ['c-tone', 'tone gauge', 'Reads the tone of a short message.'],
  ['c-tags', 'tag matcher', 'Matches notes to tags.'],
  ['c-dupes', 'duplicate finder', 'Finds items that say the same thing.'],
  ['c-numbers', 'number reader', 'Reads numbers out of text.'],
  ['c-date', 'date reader', 'Reads dates out of text.'],
  ['c-clock', 'clock reader', 'Reads times of day out of text.'],
  ['c-words', 'word counter', 'Counts words and sentences.'],
].map(([id, label, text]) => ({ id, kind: 'component', label: `${label} (invented component)`, text }))

/** The new sets (s-plan and s-read are already omegaTools.ts's own). */
const SETS: WorkItem[] = KITS.filter((k) => k.set.text).map((k) => ({ id: k.set.id, kind: 'set', label: k.set.label, text: k.set.text }))
const TOOLS: WorkItem[] = KITS.flatMap((k) => k.tools.map(([name, text]) => ({ id: `t-${name}`, kind: 'tool', label: `${name} (invented tool)`, text, flags: ['inspection-only'] })))

export const CATALOGUE_ITEMS: WorkItem[] = [...SETS, ...FOUNDATIONS, ...TOOLS, ...COMPONENTS]
export const CATALOGUE_LINKS: Omit<WorkLink, 'id'>[] = KITS.flatMap((k) =>
  k.tools.flatMap(([name], i) => [
    { from: `t-${name}`, to: k.set.id, rel: 'in_set' },
    { from: `t-${name}`, to: k.foundation, rel: 'built_on' },
    { from: `t-${name}`, to: k.uses[i % k.uses.length], rel: 'uses' },
  ]),
)

/**
 * INVENTED composition previews, in the shape the Tools app's `compose-set` returns
 * (`omega-tools-composition-preview/v1`): which component fills each role, which required roles are still open, and
 * that nothing was executed, registered or granted. One set composes completely; one has a role still unfilled.
 */
const slot = (role: string, id: string, hostShadow = false) => ({ role, implementation: { id: `sim.tools.${id}`, version: '0.0.1' }, configuration: {}, state: 'invented-sample', host_shadow: hostShadow })
const PREVIEWS: Record<string, { components: ReturnType<typeof slot>[]; unresolved: string[] }> = {
  's-plan': { components: [slot('ordering', 'key_extractor'), slot('step-splitting', 'step_splitter'), slot('sizing', 'effort_guess', true)], unresolved: [] },
  's-read': { components: [slot('line-splitting', 'line_splitter'), slot('tone', 'tone_gauge')], unresolved: [] },
  's-memory': { components: [slot('tag-matching', 'tag_matcher'), slot('duplicates', 'duplicate_finder', true)], unresolved: ['recall-ranking'] },
  's-count': { components: [slot('number-reading', 'number_reader')], unresolved: ['unit-conversion'] },
  's-time': { components: [slot('date-reading', 'date_reader'), slot('clock-reading', 'clock_reader')], unresolved: [] },
  's-write': { components: [slot('word-counting', 'word_counter')], unresolved: ['style-rules'] },
}

/** compose-set for one set: a preview only (executed: false, registered: false, authority: none). */
export function compositionPreview(setId: string): Record<string, unknown> | null {
  const p = PREVIEWS[setId]
  if (!p) return null
  return {
    schema: 'omega-tools-composition-preview/v1',
    sets: [setId],
    components: structuredClone(p.components),
    unresolved_required_slots: [...p.unresolved],
    status: p.unresolved.length ? 'incomplete' : 'complete',
    executed: false,
    registered: false,
    authority: 'none',
    effects: [],
    activation: 'separate component review and host policy required (invented)',
    compatibility: 'role and configuration checks only (invented for the simulator)',
  }
}
