import { navigate, PARTIAL_WORDS, pluralAtLeast, shown, sortMotivations, STATUS_WORDS, tasksOf, useCountsPartial, useHive, useMotivationData, WORK_WORDS } from './sdk'

/** Read the native visibility/session-bound data. Links file work; they do not instruct a mind. */
export function Motivations({ originCurrent, className }: { originCurrent: () => boolean; className?: string }) {
  const { supported, loaded } = useMotivationData()
  const motivations = useHive((s) => s.motivations)
  const links = useHive((s) => s.taskLinks)
  const partial = useCountsPartial()
  return <section className={className} aria-label={WORK_WORDS.motivations} data-presence-region="motivations">
    <h3>{WORK_WORDS.motivations}</h3>
    <p>The why above the work. Linking a task only files it for people who can read it.</p>
    {!supported ? <p>This hive does not offer {WORK_WORDS.motivations.toLowerCase()} yet.</p> : !loaded ? <p role="status">Reading {WORK_WORDS.motivations.toLowerCase()}…</p> : <>
      {sortMotivations(Object.values(motivations)).map((m) => <article key={m.id}>
        <h4>{shown(m.title)}</h4>{m.why && <p>{m.why}</p>}
        <p>{STATUS_WORDS[m.status]} · {pluralAtLeast(tasksOf(m.id, links).length, partial, WORK_WORDS.task.toLowerCase(), WORK_WORDS.tasks.toLowerCase())}</p>
        <button type="button" onClick={() => { if (originCurrent() && useHive.getState().motivations[m.id]) navigate({ name: 'motivations', id: m.id }) }}>Open {WORK_WORDS.motivation.toLowerCase()}</button>
      </article>)}
      {!Object.keys(motivations).length && <p>No readable {WORK_WORDS.motivations.toLowerCase()} yet.</p>}
      {partial && <p role="status">Task counts {PARTIAL_WORDS}.</p>}
    </>}
    <button type="button" onClick={() => { if (originCurrent()) navigate({ name: 'motivations' }) }}>All {WORK_WORDS.motivations.toLowerCase()}</button>
  </section>
}
