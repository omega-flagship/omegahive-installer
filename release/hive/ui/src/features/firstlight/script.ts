/**
 * First Light R2: the onboarding journey's script, as DATA (storyboard and script R0.1, approved by the owner 2026-10-13, with
 * his visibility ruling of the same day). R2 plays beats 1 (arrive), 2 (your look), 3 (your keys and your limits) and
 * 8 (hello); R3 adds 5 (your apps), 6 (your Ask) and the hand-off into an app after hello. Beats 4 (tools) and 7 (tour)
 * come in later rounds and show as "comes later" on the marks, never as skipped. `r2` on a beat means "in this round".
 *
 * Each step keeps the R0.1 id it comes from (`r0`), its words, its voice kind and its optional `path`. Where R2 must
 * say something else to stay honest, the step says why in `r2` (listed in the review request):
 *  - a line that is only true in some states carries `when` (the journey checks it against the host's real answers);
 *  - the per-conversation figure (3.5) is left out: it is the Ask's budget, set in beat 6, not enforced by anything here;
 *  - the key is pasted on the person's own keys (#/me), where a key is theirs (`owner`), not on Models (the hive's key).
 *
 * Nothing in a step decides, spends or changes the hive. The only screen actions are the guided demos' own (go to a
 * page, open the Change UI gallery). Every real choice (a role, a look, a key, a limit, Wake) is the person's own press.
 *
 * Voice: not in this round. Captions only, always on (FL_VOICE is false; the voice comes later via the hive's own
 * provider route).
 */
import type { GuideAction, GuideTarget } from '../guided/types'

/** Voice is off in R2: captions only. Nothing in First Light speaks while this is false. */
export const FL_VOICE = false as const

/** Who is taking the journey: the hive's owner, a guest ("use my hive"), or anyone else signed in to this hive. */
export type FlPath = 'owner' | 'guest' | 'member'

/** The beats, in journey order (the host's progress record names them the same way). */
export type Beat = 'arrive' | 'look' | 'models' | 'tools' | 'apps' | 'ask' | 'tour' | 'hello'
export const BEATS: readonly { id: Beat; n: number; name: string; r2: boolean }[] = [
  { id: 'arrive', n: 1, name: 'Arrive', r2: true },
  { id: 'look', n: 2, name: 'Your look', r2: true },
  { id: 'models', n: 3, name: 'Your keys and your limits', r2: true },
  { id: 'tools', n: 4, name: 'Your tools and connections', r2: false },
  { id: 'apps', n: 5, name: 'Your apps', r2: true },
  { id: 'ask', n: 6, name: 'Your Ask', r2: true },
  { id: 'tour', n: 7, name: 'A short tour', r2: false },
  { id: 'hello', n: 8, name: 'Hello', r2: true },
]
export const R2_BEATS: readonly Beat[] = BEATS.filter((b) => b.r2).map((b) => b.id)
export const beatInfo = (id: Beat) => BEATS.find((b) => b.id === id)!

/** fixed: the same words for everyone; set: one of a closed set; personal: has a name or an amount; mind: the mind's own */
export type Voice = 'fixed' | 'set' | 'personal' | 'mind'

/** What a step points at: a guided-demo target, the person's own mind on the hive, or First Light's own controls. */
export type FlTarget = GuideTarget | { personalMind: true } | { flControls: true }

export type FlWait =
  /** a pause, then on (never shorter than the time to read the line) */
  | { for: 'time'; ms: number }
  /** the person picks one of the step's choices */
  | { for: 'choice'; field: 'role' | 'monthly_spend' }
  /** the person keeps a look in the gallery (or keeps the one they have) */
  | { for: 'look' }
  /** the person adds a key of their own on their keys page (or not now) */
  | { for: 'key' }
  /** the person presses Wake */
  | { for: 'wake' }
  /** the mind's first real answer (up to ms; it may come later, and is shown only when it does) */
  | { for: 'first-answer'; ms: number }
  /** R3: the person moves on from the apps ready for them (Next), or opens one */
  | { for: 'apps' }
  /** R3: the person names their Ask and says how it should be (Save), or Not now */
  | { for: 'ask' }

/** A line that is only true in some states: the journey checks it against what the host said. */
export type FlWhen =
  | 'only-mind'
  | 'not-only-mind'
  | 'limit-enforced'
  | 'limit-not-enforced'
  | 'all-ready'
  | 'not-all-ready'
  | 'look-kept'
  | 'greeted'
  /** R3: at least one app is ready for this person / none is (or the list could not be read) */
  | 'apps-ready'
  | 'no-apps'
  /** R3: the person saved their Ask's name (and how it should be) in beat 6 */
  | 'ask-saved'
  /** R3: the mind greeted and an app is ready to hand off to */
  | 'greeted-app'

export interface FlChoice {
  label: string
  value: string | number
  /** owners only (not guests, not other members) */
  owners?: true
}

/** Which card rises beside the caption while the step shows. */
export type FlCard = 'key' | 'own-limit' | 'guest-limit' | 'limit' | 'wake' | 'hello' | 'apps' | 'ask' | 'start'

export interface FlStep {
  id: string
  /** the R0.1 step this comes from (none: an R2 addition, said why in `r2`) */
  r0?: string
  beat: Beat
  /** the caption; {name} {host} {guest_limit} {look} {monthly} {mind} {app} are filled from the host's real answers */
  say: string
  voice: Voice
  /** only on these paths (none: every path) */
  path?: readonly FlPath[]
  do?: GuideAction
  target?: readonly FlTarget[]
  wait?: FlWait
  choices?: readonly FlChoice[]
  when?: FlWhen
  card?: FlCard
  /** why R2 differs from R0.1 here (review notes; never shown) */
  r2?: string
}

const OWNER = ['owner'] as const
const GUEST = ['guest'] as const
const MEMBER = ['member'] as const
const OWNER_MEMBER = ['owner', 'member'] as const
const MIND: FlTarget[] = [{ personalMind: true }]

export const FL_SCRIPT: { id: string; title: string; triggers: readonly string[]; steps: readonly FlStep[] } = {
  id: 'first-light',
  title: 'First Light',
  // R0.1 triggers (words people say to the Ask; never shown)
  triggers: ['show me onboarding', 'show me first light', 'start first light', 'set me up', 'run first light again'],
  steps: [
    // ---------------------------------------------------------------- 1 · Arrive
    { id: '1.1', r0: '1.1', beat: 'arrive', path: OWNER, voice: 'personal', say: 'Hello, {name}. Welcome to your hive.', do: { go: { name: 'hive' } }, target: MIND, wait: { for: 'time', ms: 2400 } },
    {
      id: '1.2', r0: '1.2', beat: 'arrive', path: OWNER, voice: 'fixed', when: 'only-mind', target: MIND,
      say: 'It’s yours: your keys, your minds, your limits. Right now it holds one mind, your own. It’s asleep. We’ll wake it at the end.',
    },
    {
      id: '1.2b', beat: 'arrive', path: OWNER, voice: 'fixed', when: 'not-only-mind', target: MIND,
      say: 'It’s yours: your keys, your minds, your limits. That small light is your own mind. It’s asleep. We’ll wake it at the end.',
      r2: '1.2 says the hive holds one mind; that is true only of a new hive, so an owner with other minds hears this',
    },
    { id: '1.1g', r0: '1.1g', beat: 'arrive', path: GUEST, voice: 'personal', say: 'Hello, {name}. Welcome to {host}’s hive. You’re here as {host}’s guest.', do: { go: { name: 'hive' } }, target: MIND, wait: { for: 'time', ms: 2400 } },
    {
      id: '1.2g', r0: '1.2g', beat: 'arrive', path: GUEST, voice: 'personal', when: 'limit-enforced', target: MIND,
      say: 'This hive runs on {host}’s keys, not yours. Your minds can spend up to {guest_limit} a month here, and the hive stops them there. That small light is your own mind. It’s asleep. We’ll wake it at the end.',
    },
    {
      id: '1.2gn', beat: 'arrive', path: GUEST, voice: 'personal', when: 'limit-not-enforced', target: MIND,
      say: 'This hive runs on {host}’s keys, not yours. {host} hasn’t set a limit for you yet, so your minds can’t think here yet. That small light is your own mind. It’s asleep.',
      r2: '1.2g names a limit; with no live invite limit there is none to name',
    },
    { id: '1.1m', beat: 'arrive', path: MEMBER, voice: 'personal', say: 'Hello, {name}. Welcome to {host}’s hive.', do: { go: { name: 'hive' } }, target: MIND, wait: { for: 'time', ms: 2400 }, r2: 'R0.1 covers owners and guests; a person who was here before own hives (or a public visitor) is neither' },
    { id: '1.2m', beat: 'arrive', path: MEMBER, voice: 'fixed', target: MIND, say: 'That small light is your own mind. It’s asleep. We’ll wake it at the end.', r2: 'as 1.1m' },
    {
      id: '1.3', r0: '1.3', beat: 'arrive', voice: 'fixed', target: [{ ask: true }], wait: { for: 'choice', field: 'role' },
      say: 'First, what will you mostly do here?',
      choices: [
        { label: 'Build and code', value: 'coder' },
        { label: 'Research and think things through', value: 'researcher' },
        { label: 'Host friends', value: 'admin', owners: true },
        { label: 'Just look around', value: 'explorer' },
      ],
    },
    { id: '1.4', r0: '1.4', beat: 'arrive', voice: 'fixed', target: [{ flControls: true }], say: 'Thanks. You can pause or skip at any time, and I’ll remember where we were.' },

    // ---------------------------------------------------------------- 2 · Your look
    { id: '2.1', r0: '2.1', beat: 'look', voice: 'fixed', do: { ui: 'gallery' }, target: [{ tour: 'change-ui' }], say: 'Let’s make it feel like yours. Each of these is a different way to see the same hive.' },
    { id: '2.2', r0: '2.2', beat: 'look', voice: 'fixed', target: [{ tour: 'change-ui' }], wait: { for: 'look' }, say: 'Tap one to try it. Nothing changes until you keep it.' },
    { id: '2.3', r0: '2.3', beat: 'look', voice: 'set', when: 'look-kept', say: '{look} it is. You can change it any time from the menu.', r2: '2.4 (each experience introduces itself) is not built yet; it follows in a later round' },

    // ---------------------------------------------------------------- 3 · Your keys and your limits (owner)
    {
      id: '3.1', r0: '3.1', beat: 'models', path: OWNER, voice: 'fixed', do: { go: { name: 'me' } }, target: [{ tour: 'your-keys' }],
      say: 'Minds think with models. A model is the thinking engine, made by companies like Anthropic or OpenAI.',
      r2: 'goes to your own keys (#/me), not Models: a key added there is yours (owner = you), which is what your own limit covers; a key on Models is the hive’s',
    },
    { id: '3.2', r0: '3.2', beat: 'models', path: OWNER, voice: 'fixed', target: [{ tour: 'your-keys' }], card: 'key', say: 'Your hive runs on your own key. It’s like a library card for a model. You pay the model company directly, and nobody else can see your key.' },
    {
      id: '3.3', r0: '3.3', beat: 'models', path: OWNER, voice: 'fixed', target: [{ tour: 'your-keys' }], wait: { for: 'key' }, card: 'key',
      say: 'Paste your key here, with Add a key. Or choose a model on your own computer.',
      r2: '“or connect a coding subscription in the next step” left out: beat 4 is not in this round',
    },
    {
      id: '3.4', r0: '3.4', beat: 'models', path: OWNER, voice: 'fixed', target: [{ ask: true }], wait: { for: 'choice', field: 'monthly_spend' }, card: 'key',
      say: 'How much may your own minds spend in a month?',
      choices: [
        { label: '$5', value: 5 },
        { label: '$20', value: 20 },
        { label: '$50', value: 50 },
        { label: 'Another amount', value: 'other' },
        { label: 'Not sure yet: start at $5', value: 5 },
      ],
    },
    { id: '3.5', r0: '3.5', beat: 'models', path: OWNER, voice: 'personal', when: 'limit-enforced', card: 'own-limit', say: 'Okay, up to {monthly} a month. You can change it any time.', r2: 'the per-conversation figure is the Ask’s budget (beat 6), not set or enforced here, so it is not named' },
    { id: '3.6', r0: '3.6', beat: 'models', path: OWNER, voice: 'fixed', when: 'limit-enforced', card: 'own-limit', say: 'The hive stops your minds at this limit. Your model company may have its own limits too. Check those with them.' },
    {
      id: '3.6n', beat: 'models', path: OWNER, voice: 'personal', when: 'limit-not-enforced', card: 'own-limit',
      say: 'You chose {monthly} a month, but it isn’t a limit yet: nothing enforces it until you add a key of your own and choose again here.',
      r2: 'with no key of your own the hive has nothing to hold a limit on, so the choice is recorded and named as not enforced',
    },
    { id: '3.7', r0: '3.7', beat: 'models', path: OWNER, voice: 'fixed', target: [{ ask: true }], say: 'Anything you share later, a mind or a key, gets its own limit, set by you. People can also ask you for a limit on one of your minds. You say yes, change the amount, or say no.' },

    // ---------------------------------------------------------------- 3 · guest
    { id: '3.1g', r0: '3.1g', beat: 'models', path: GUEST, voice: 'personal', target: [{ region: 'fl-guest-limit' }], card: 'guest-limit', say: '{host}’s hive runs on {host}’s keys. You never see them, and you don’t need your own.' },
    { id: '3.2g', r0: '3.2g', beat: 'models', path: GUEST, voice: 'personal', when: 'limit-enforced', target: [{ region: 'fl-guest-limit' }], card: 'guest-limit', say: 'Your minds can spend up to {guest_limit} a month here, and the hive stops them at that limit. Need more? Ask {host}; {host} decides.' },
    {
      id: '3.2gn', beat: 'models', path: GUEST, voice: 'personal', when: 'limit-not-enforced', target: [{ region: 'fl-guest-limit' }], card: 'guest-limit',
      say: '{host} hasn’t set a limit for you yet, so your minds can’t think here yet. Ask {host} for one; {host} decides.',
      r2: 'R0.1’s blocked line said “I’ve let Hazel know”; nothing is sent unless the person asks, so it says what they can do',
    },
    { id: '3.3g', r0: '3.3g', beat: 'models', path: GUEST, voice: 'fixed', target: [{ region: 'fl-guest-limit' }], card: 'guest-limit', say: 'Whenever you like, you can start your own hive with your own key, and take your mind with you.' },

    // ---------------------------------------------------------------- 3 · member (R2 addition)
    {
      id: '3.1m', beat: 'models', path: MEMBER, voice: 'fixed', target: [{ region: 'fl-limit' }], card: 'limit',
      say: 'Here is what your minds may spend in this hive, and whose key pays.',
      r2: 'R0.1 covers owners and guests; anyone else sees their limit exactly as the hive reports it',
    },

    // ---------------------------------------------------------------- 5 · Your apps (R3)
    {
      id: '5.1', beat: 'apps', voice: 'fixed', when: 'apps-ready', target: [{ region: 'fl-apps' }], card: 'apps', wait: { for: 'apps' },
      say: 'These apps are ready for you. There’s nothing to set up: open one whenever you like.',
      r2: 'R3: the apps the host says are installed for this person (P14: a person app opens in their own space, ready)',
    },
    {
      id: '5.1n', beat: 'apps', voice: 'fixed', when: 'no-apps', target: [{ region: 'fl-apps' }], card: 'apps', wait: { for: 'time', ms: 3200 },
      say: 'No apps are ready for you in this hive yet. When one is added for you, it works straight away.',
      r2: 'R3: with none ready (or the list unreadable) nothing is offered, and nothing claims an app',
    },

    // ---------------------------------------------------------------- 6 · Your Ask (R3)
    {
      id: '6.1', beat: 'ask', voice: 'fixed', target: [{ region: 'fl-ask' }], card: 'ask', wait: { for: 'ask' },
      say: 'Now your Ask: the mind you talk to. What do you want it to be? Give it a name, and say in a few words how it should be.',
      r2: 'R3, at its simplest: a name and a few words, saved on the person’s own mind (its name and persona). The per-conversation budget stays as it is',
    },
    { id: '6.2', beat: 'ask', voice: 'personal', when: 'ask-saved', target: MIND, card: 'ask', say: '{mind} it is. You can change this any time on your mind’s page.', r2: 'R3' },

    // ---------------------------------------------------------------- 8 · Hello
    { id: '8.1', r0: '8.1', beat: 'hello', voice: 'fixed', when: 'all-ready', do: { go: { name: 'me', view: 'mind' } }, target: MIND, say: 'Everything’s ready. Let’s wake your mind.' },
    { id: '8.1b', beat: 'hello', voice: 'fixed', when: 'not-all-ready', do: { go: { name: 'me', view: 'mind' } }, target: MIND, say: 'Let’s wake your mind.', r2: '“Everything’s ready” only when every beat so far is ready' },
    { id: '8.2', r0: '8.2', beat: 'hello', voice: 'fixed', target: [{ region: 'fl-wake' }], wait: { for: 'wake' }, card: 'wake', say: 'Press Wake when you’re ready.' },
    {
      id: '8.3', r0: '8.3', beat: 'hello', voice: 'mind', target: [{ region: 'fl-hello' }], wait: { for: 'first-answer', ms: 30000 }, card: 'hello',
      say: '(the mind, in its own words)',
    },
    { id: '8.4', r0: '8.4', beat: 'hello', path: OWNER_MEMBER, voice: 'fixed', when: 'greeted', card: 'hello', say: 'That’s First Light. Your mind is awake. Talk to it any time.' },
    { id: '8.4g', r0: '8.4g', beat: 'hello', path: GUEST, voice: 'fixed', when: 'greeted', card: 'hello', say: 'That’s First Light. Your mind is awake. When you’re ready for your own hive and your own key, you can move out and take your mind with you.' },
    {
      id: '8.5', beat: 'hello', voice: 'fixed', when: 'greeted-app', target: [{ region: 'fl-start' }], card: 'start',
      say: 'Start talking in {app}. It’s the everyday place for you and your mind.',
      r2: 'R3: the hand-off. One press opens the app the person will talk in (the first app ready for them); First Light ends there',
    },
  ],
}

/** What each beat says when it ends (storyboard R0.1 "States"), by path where they differ. Live lines come from the host. */
export const BEAT_LINES = {
  arrive: { ready: 'Got it.', skipped: 'I’ll show you a little of everything.', blocked: 'I can’t reach your hive just now. Nothing is lost.' },
  look: { ready: 'Look kept.', skipped: 'We’ll keep this look for now.', blocked: 'Your look couldn’t be saved just now, so it’s only on this screen.' },
  models: { skipped: 'No key yet, so your hive can’t think. If someone invited you to use their hive, that works too.' },
  hello: { skipped: 'Your mind stays asleep for now.' },
  apps: { skipped: 'Your apps are there whenever you want them.', none: 'No apps are ready for you yet.' },
  ask: { skipped: 'Your Ask keeps its name for now. You can change it on your mind’s page.', noMind: 'Your mind isn’t ready yet, so there’s nothing to name. Try again in a moment.' },
} as const

/** The steps one path plays, in order. */
export const stepsFor = (path: FlPath, steps: readonly FlStep[] = FL_SCRIPT.steps): FlStep[] => steps.filter((s) => !s.path || s.path.includes(path))

/** A step's choices for this path (Host friends is for owners only). */
export const choicesFor = (step: FlStep, path: FlPath): FlChoice[] => (step.choices ?? []).filter((c) => !c.owners || path === 'owner')

/** The first step of a beat on this path (-1: none). */
export const firstOf = (steps: readonly FlStep[], beat: Beat): number => steps.findIndex((s) => s.beat === beat)
