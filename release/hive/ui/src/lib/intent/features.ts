/**
 * Purpose: every hive feature, and every place on the hive's home page, in plain words: what a person might type for
 * it, and how well what they typed names it. Lifted from Still (experiences/still/features.ts) into the shared fast
 * path (Surface universal Ask, phase 1) unchanged; experiences add vocabulary through vocab.ts.
 */
import { FEATURES, type Feature } from '../../features/registry'

/** Extra plain words a person uses for a feature, beyond its label and keywords. */
export const WORDS: Record<string, string[]> = {
  'minds.see': ['minds', 'every mind', 'all minds', 'who is awake'],
  'minds.create': ['new mind', 'create mind', 'create a mind', 'make a mind', 'make a new mind', 'new agent', 'add a mind'],
  'minds.talk': ['talk', 'conversation', 'chat'],
  'minds.wake': ['wake or sleep'],
  'minds.memory': ['memory', 'memories', 'atoms', 'spaces', 'reset memory'],
  'minds.schedule': ['schedule', 'wakeups', 'wake ups', 'alarms'],
  'minds.model': ['model', 'models of minds', 'which model'],
  'minds.traces': ['traces', 'logs', 'thinking', 'what a mind did'],
  'minds.shares': ['shared memory', 'shares', 'memory shares'],
  'minds.inventory': ['tools', 'inventory', 'skills'],
  'minds.move': ['move a mind', 'move mind', 'export a mind', 'import a mind', 'export', 'import'],
  'minds.outside': ['outside agent', 'claude code', 'codex', 'mcp', 'connect an agent'],
  'swarms.see': ['swarms', 'teams', 'all swarms'],
  'swarms.launch': ['start a swarm', 'new swarm', 'create a swarm', 'make a swarm', 'make a private swarm', 'launch a swarm', 'private swarm', 'start swarm'],
  'swarms.beliefs': ['beliefs', 'what swarms believe', 'swarm beliefs'],
  'swarms.archived': ['archived swarms', 'restore a swarm', 'archived'],
  'work.review': ['review work', 'awaiting review', 'review', 'accept work'],
  'hive.setup': ['getting started', 'setup', 'checklist', 'first steps'],
  'hive.identity': ['name this hive', 'rename the hive', 'hive name'],
  'swarms.edit': ['rename a swarm', 'archive a swarm', 'edit a swarm', 'change a swarm'],
  'swarms.nesting': ['holarchy', 'nested swarms', 'nesting'],
  'swarms.connections': ['connections', 'connect swarms'],
  'swarms.services': ['services', 'grants'],
  'swarms.requests': ['swarm requests', 'request inbox', 'coding requests', 'incoming requests', 'outgoing requests'],
  'swarms.lifecycle': ['lifecycle', 'leases', 'lease'],
  'work.goals': ['tasks', 'all tasks', 'my tasks', 'goals', 'all goals', 'boards', 'board', 'task board', 'task list'],
  'work.motivations': ['motivations', 'my motivations', 'show my motivations', 'our motivations', 'team motivations', 'why', 'aims', 'what we are working towards'],
  'work.flow': ['flows', 'flow', 'workflows'],
  'work.sessions': ['sessions', 'session'],
  'work.explore': ['explore'],
  'work.artifacts': ['artifacts', 'findings', 'results'],
  'work.assets': ['files', 'storage', 'assets', 'transfers'],
  'decide.approvals': ['approvals', 'requests', 'decisions', 'notifications'],
  'decide.rules': ['rules', 'policy', 'policy rules', 'permissions'],
  'decide.history': ['decision history', 'history', 'what was decided', 'past decisions'],
  'decide.asks': ['asks', "people's requests", 'requests from people', 'allowance'],
  'decide.reservations': ['settle calls', 'settle', 'unknown cost', 'unknown-cost calls', 'reservations'],
  'decide.stopall': ['stop all', 'stop everything', 'kill switch', 'stop all minds'],
  'talk.rooms': ['messages', 'rooms', 'dms', 'channels', 'group chat'],
  'talk.recent': ['recent conversations', 'my conversations', 'recent chats', 'my chats', 'conversations'],
  'talk.coffee': ['coffee room', 'coffee', 'the coffee room', 'hive chat', 'everyone in the hive'],
  'apps.list': ['apps', 'programs', 'fusion'],   // never a private app's name (Kimi town-r3 #1; as navCommands)
  'apps.open': ['open an app'],
  'apps.activity': ['activations', 'offers', 'app activations'],
  'build.code': ['code', 'code workspaces'],
  'build.roles': ['roles', 'job descriptions'],
  'build.models': ['models', 'providers', 'model providers'],
  'build.tools': ['tools', 'skills', 'thought tools', 'mind tools'],
  'build.updates': ['updates', 'holds', 'platform updates'],
  'watch.health': ['health', 'errors', 'problems'],
  'watch.healthmind': ['health mind', 'incidents'],
  'watch.lab': ['lab', 'tests', 'benchmarks', 'evals'],
  'watch.activity': ['live activity', 'activity', 'what is happening', "what's happening", 'events'],
  'money.usage': ['usage', 'spending', 'spend', 'costs', 'cost', 'money', 'budget', 'tokens'],
  'money.keys': ['keys', 'api keys', 'my keys', 'who pays'],
  'people.manage': ['people', 'members', 'users', 'invitations', 'invite', 'who can use'],
  'people.me': ['me', 'my profile', 'profile', 'you'],
  'hive.settings': ['settings', 'preferences', 'sign-in', 'password', 'disk'],
  'hive.changeui': ['change ui', 'change the look', 'experiences', 'looks'],
  'hive.search': ['search', 'search everything', 'find'],
  'hive.help': ['help', 'everything', 'what can you do', 'the tour', 'what can i do'],
}

const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}' -]+/gu, ' ').replace(/\s+/g, ' ').trim()
const FILLER = /^(please |can you |could you |i want to |i'd like to |let me |let's |how do i |)?(show( me)?|see|view|open|go to|take me to|where is|where are|find|)\s*(my |the |all |a |an |)/

/** The words as phrases are matched: folded whole, folded with the polite opening and show/open verb taken off, and the
 * latter's words; null when nothing is left to match. */
type Query = { whole: string; t: string; words: string[] }
function query(input: string): Query | null {
  const whole = fold(input)
  const t = whole.replace(FILLER, '').trim()
  return t.length >= 2 ? { whole, t, words: t.split(' ') } : null
}

/** Words that only frame a request, asking, when, how politely, to whom or in what container: a request made of a
 * phrase and these asks for what the phrase names ("which minds are idle", "live activity please", "what have you
 * learned lately", "the tasks page"); any other word brings a subject of its own. */
const FRAMING = new Set(['which', 'what', 'who', 'how', 'many', 'much', 'is', 'are', 'was', 'were', 'be', 'there', 'do',
  'does', 'did', 'have', 'has', 'had', 'a', 'an', 'to', 'show', 'tell', 'see', 'give', 'lately', 'recently', 'now', 'today',
  'tonight', 'yet', 'so', 'far', 'right', 'currently', 'please', 'again', 'here', 'at', 'the', 'moment', 'this', 'week',
  'morning', 'for', 'me', 'my', 'us', 'our', 'you', 'your', 'hive', 'any', 'all', 'in', 'on', 'of', 'page', 'pages',
  'screen', 'view', 'list', 'tab', 'panel'])

/**
 * How well the words name one of these folded phrases: 4 an exact phrase, 3 every word of a phrase of two or more
 * with nothing else but framing words, 2 (when `explicit`, i.e. after show/open) a phrase the words begin, else 0.
 * A word inside a longer request about something else names nothing ("federated learning" is not "learned
 * lately"), nor does a short question that holds a phrase's every word but has its own subject ("what is happening
 * with my order" is not the live activity page), as Jon noted on #363. Time: the phrases' words times the request's
 * words.
 */
function scoreIn(q: Query, phrases: string[], explicit: boolean): number {
  let best = 0
  for (const p of phrases) {
    if (p === q.t || p === q.whole) best = Math.max(best, 4)
    else {
      const pw = p.split(' ')
      if (pw.length > 1 && pw.every((w) => q.words.includes(w)) && q.words.every((w) => pw.includes(w) || FRAMING.has(w))) best = Math.max(best, 3)
      else if (explicit && q.t.length >= 4 && p.startsWith(q.t)) best = Math.max(best, 2)
    }
  }
  return best
}

/**
 * The phrases a feature answers to, folded once per feature and kept (features are static data; folding is Unicode
 * normalisation plus regexes, and the fast path asks for every feature's phrases on every keystroke).
 */
const phraseCache = new WeakMap<Feature, string[]>()
export const phrasesOf = (f: Feature): string[] => {
  let ps = phraseCache.get(f)
  if (!ps) {
    ps = [fold(f.label), ...((Object.hasOwn(WORDS, f.id) ? WORDS[f.id] : null) ?? []).map(fold), ...(f.keywords ? f.keywords.split(',').map(fold) : [])].filter(Boolean)
    phraseCache.set(f, ps)
  }
  return ps
}

/**
 * Every feature the words ask for, with how well: 4 an exact phrase, 3 every word of a phrase present in a short
 * request, 2 (when `explicit`, i.e. after show/open) a phrase the words begin. Best first.
 */
export function scoreFeatures(input: string, explicit = false): { f: Feature; s: number }[] {
  const q = query(input)
  if (!q) return []
  const scored: { f: Feature; s: number }[] = []
  for (const f of FEATURES) {
    const best = scoreIn(q, phrasesOf(f), explicit)
    if (best) scored.push({ f, s: best })
  }
  return scored.sort((a, b) => b.s - a.s)
}

/** A place on the hive's home page the Ask scrolls to (understand.ts): what needs the person, what is happening now,
 * and what the hive learned lately. */
export type HomePlace = 'needs' | 'now' | 'learned'

/**
 * What a person types for each place on the home page, matched by the rule features use (scoreIn), so a request merely
 * holding one of their words goes to a mind: a research question on federated learning, an order's status, deciding
 * between laptops. The apostrophe-less spellings are how people type them.
 */
const HOME_PLACES: Record<HomePlace, string[]> = {
  needs: ['what needs me', 'what needs my attention', 'what needs my approval', 'what needs my decision', 'what do you need from me',
    'do you need me', 'anything for me', 'is there anything for me', 'what is waiting for me', "what's waiting for me",
    'whats waiting for me', 'waiting for me', 'inbox', 'my inbox', 'notifications', 'my notifications', 'approvals', 'my approvals', 'decisions waiting',
    'what do i need to decide', 'what do i need to approve', 'my to do', 'to do list'],
  now: ['what is happening', "what's happening", 'whats happening', 'what is going on', "what's going on", 'whats going on',
    'who is awake', 'who is thinking', 'who is busy', 'status', 'hive status', 'what are the minds doing',
    'what is everyone doing', "what's everyone doing", 'whats everyone doing'],
  learned: ['what did the hive learn', 'what has the hive learned', 'what have you learned', 'what did you learn',
    'learned lately', 'what was learned', 'what is new', "what's new", 'whats new', 'beliefs', 'what do the minds believe',
    'what did you discover', 'what have you discovered', 'what have you found out', 'what was found', 'discoveries'],
}
const homePhrases = Object.fromEntries(Object.entries(HOME_PLACES).map(([k, ps]) => [k, ps.map(fold)])) as Record<HomePlace, string[]>

/** How well the words ask for a place on the home page, by the features' rule (scoreIn): 3 or more names it. */
export function homePlaceScore(input: string, place: HomePlace): number {
  const q = query(input)
  return q ? scoreIn(q, homePhrases[place], false) : 0
}

/** The features the words ask for, best first (scoreFeatures), at most `most`. */
export function matchFeatures(input: string, explicit = false, most = 3): Feature[] {
  return scoreFeatures(input, explicit).slice(0, most).map((x) => x.f)
}

/** The request with its polite opening and show/open verb taken off, folded: what names the feature. */
export const featureWords = (input: string): string => fold(input).replace(FILLER, '').trim()
export { fold as foldWords }
