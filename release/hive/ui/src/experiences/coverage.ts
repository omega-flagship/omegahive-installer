import { FEATURES, type Feature } from '../features/registry'

/**
 * What each experience does natively, in its own grammar. Everything else in the hive is still reachable in every
 * experience through the host's "Everything in the hive" directory (Ω menu), which opens the classic page in the
 * experience's companion look. Features with no classic page anywhere are reported as gaps, never hidden.
 */
export const NATIVE: Record<string, string[]> = {
  omegatown: ['minds.see', 'minds.talk', 'minds.wake', 'swarms.see', 'work.motivations', 'work.goals', 'decide.approvals', 'watch.activity', 'hive.changeui'],
  professional: ['minds.see', 'minds.talk', 'minds.wake', 'swarms.see', 'work.motivations', 'work.goals', 'decide.approvals', 'apps.list', 'watch.activity', 'hive.search', 'hive.changeui', 'hive.help'],
  // an unreviewed candidate's row goes behind registry UNREVIEWED_ALLOWED, compiled out with its registry entry
  cosmos: ['minds.see', 'minds.create', 'minds.talk', 'minds.wake', 'minds.traces', 'swarms.see', 'swarms.beliefs', 'work.goals', 'work.motivations', 'decide.approvals', 'decide.history', 'decide.rules', 'watch.activity', 'money.usage', 'hive.search', 'hive.changeui', 'hive.help'],
  construct: ['minds.see', 'minds.create', 'minds.talk', 'minds.wake', 'swarms.see', 'swarms.beliefs', 'work.goals', 'work.motivations', 'decide.approvals', 'decide.history', 'decide.rules', 'decide.stopall', 'watch.activity', 'money.usage', 'people.manage', 'hive.search', 'hive.changeui', 'hive.help'],
  still: ['minds.see', 'minds.talk', 'minds.wake', 'minds.create', 'swarms.see', 'swarms.beliefs', 'work.goals', 'work.motivations', 'decide.approvals', 'decide.history', 'decide.rules', 'watch.activity', 'money.usage', 'people.manage', 'hive.help', 'hive.search', 'hive.changeui'],
  flux: ['minds.see', 'minds.create', 'minds.talk', 'minds.wake', 'minds.traces', 'swarms.see', 'swarms.beliefs', 'work.goals', 'work.motivations', 'decide.approvals', 'decide.history', 'decide.rules', 'watch.activity', 'money.usage', 'hive.search', 'hive.changeui', 'hive.help'],
  canvas: ['minds.see', 'minds.talk', 'minds.wake', 'swarms.see', 'swarms.beliefs', 'work.goals', 'work.motivations', 'decide.approvals', 'decide.history', 'watch.activity', 'money.usage', 'people.manage', 'hive.search', 'hive.changeui'],
}

export type Reached = 'native' | 'classic' | 'gap'
export function reach(experience: string, f: Feature): Reached {
  if ((NATIVE[experience] ?? []).includes(f.id)) return 'native'
  if (f.id === 'hive.changeui') return 'native' // the host's Ω menu, in every experience
  return f.classic ? 'classic' : 'gap'
}

/**
 * The coverage grid as markdown: features × experiences. Part of every Review request. With `ask` (Surface universal
 * Ask, ASK-1), an Ask column says, per feature, whether plain words reach it through the shared fast path in every
 * shipped scope (lib/intent/reach.test.ts proves the same), and a last row names each experience's Ask skin.
 */
export function coverageReport(experiences: string[], ask?: { reached: ReadonlySet<string>; skins: Record<string, string> }): string {
  const mark = { native: '● native', classic: '○ classic', gap: '✕ no UI yet' }
  const askHead = ask ? ' Ask |' : ''
  const head = `| Feature | ${experiences.join(' | ')} |${askHead}\n|---|${experiences.map(() => '---').join('|')}|${ask ? '---|' : ''}`
  const rows = FEATURES.map((f) => `| ${f.label} | ${experiences.map((e) => mark[reach(e, f)]).join(' | ')} |${ask ? ` ${ask.reached.has(f.id) ? '● by words' : '✕ not by words'} |` : ''}`)
  if (ask) rows.push(`| **The Ask (ASK-1)** | ${experiences.map((e) => ask.skins[e] ?? '✕ none').join(' | ')} | ${ask.skins.classic ?? '✕ none'} on classic pages |`)
  const totals = experiences.map((e) => {
    const r = FEATURES.map((f) => reach(e, f))
    return `${e}: ${r.filter((x) => x === 'native').length} native, ${r.filter((x) => x === 'classic').length} classic, ${r.filter((x) => x === 'gap').length} gaps`
  })
  return `${head}\n${rows.join('\n')}\n\n${totals.join(' · ')}\n`
}

/**
 * Parity (Jon, 2026-10-05: "every UI loses different things - make sure all UIs have all features available"). Each
 * experience exports `NAV_FEATURES` from `experiences/<id>/nav.ts`: the feature ids its OWN navigation reaches (its
 * menus, panels, commands, board), not counting the host's Ω menu. coverage.test.ts requires every feature that has
 * any UI to be listed, and these first of all.
 */
export const REQUIRED_OWN = ['minds.see', 'minds.talk', 'minds.wake', 'decide.approvals', 'hive.changeui', 'swarms.launch', 'minds.create']

/** Every feature an experience's own navigation must reach: anything with a classic page or built natively anywhere. */
export const hasUi = (f: Feature): boolean => f.classic !== null || Object.values(NATIVE).some((n) => n.includes(f.id))

/** Which features an experience's own navigation misses (nav: its NAV_FEATURES, or null when it has no nav.ts yet). */
export function navGaps(nav: string[] | null): string[] {
  const own = new Set(nav ?? [])
  return FEATURES.filter((f) => hasUi(f) && !own.has(f.id)).map((f) => f.id)
}
