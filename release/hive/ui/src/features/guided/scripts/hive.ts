import { EXPERIENCES } from '../../../experiences/registry'
import type { GuideScript, GuideStep } from '../types'

// The experiences demo names and counts what this build offers (a release, surface-preview and dev differ).
const NUMBER = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
const counted = (n: number) => NUMBER[n] ?? String(n)
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
const offered = EXPERIENCES.map((e) => (e.id === 'classic' ? 'Classic' : e.name))
const listed = offered.length > 1 ? `${offered.slice(0, -1).join(', ')} and ${offered[offered.length - 1]}` : offered.join('')
/** The experiences the demo previews, each only when this build offers it. */
const PREVIEWS: [string, GuideStep][] = (
  [
    ['still', { say: 'This is Still: one question box, one decision at a time, and the hive told in sentences. I am only previewing it.', do: { experience: 'still' }, target: [{ region: 'now' }, { region: 'needs' }], wait: { for: 'target', ms: 5000 } }],
    ['construct', { say: 'This is Construct: a terminal where everything is a command. Same hive, same minds.', do: { experience: 'construct' }, wait: { for: 'time', ms: 1600 } }],
    ['cosmos', { say: 'And Cosmos: fly through the hive as a galaxy, where swarms are star systems.', do: { experience: 'cosmos' }, wait: { for: 'time', ms: 1800 } }],
  ] as [string, GuideStep][]
).filter(([id]) => EXPERIENCES.some((e) => e.id === id))
const firstShown = PREVIEWS[0]?.[0] ?? EXPERIENCES.find((e) => e.id !== 'classic')?.id

/** The hive, its minds and swarms. */
export const HIVE_SCRIPTS: GuideScript[] = [
  {
    id: 'hive',
    title: 'The hive and its minds',
    blurb: 'Who lives here, who is awake, and what one mind looks like up close.',
    status: 'ready',
    standing: 'Live',
    triggers: ['show me how the hive works', 'give me a tour of the hive', 'walk me through the hive', 'show me the minds'],
    topics: ['hive', 'the hive', 'minds', 'a mind', 'omegahive', 'agents'],
    steps: [
      { say: 'This is the hive: one home for many minds and the people who work with them.', do: { go: { name: 'hive' } }, target: [{ tour: 'hud-stats' }, { region: 'page' }], wait: { for: 'time', ms: 600 } },
      { say: 'This strip counts who is awake, who is thinking and who is asleep, right now.', target: [{ tour: 'hud-stats' }, { region: 'now' }] },
      { say: 'Let’s open one mind: {mind}. Its header says where it lives and how it is doing.', do: { mind: 'chat' }, target: { tour: 'dot-header' } },
      { say: 'You power each mind on its own here: wake, rest or stop. Nothing changes until you press one.', target: { tour: 'dot-controls' } },
      { say: 'Its budget is capped. A call over the cap is refused, not charged.', target: { tour: 'dot-budget' } },
      { say: 'Explore lists everything in the hive, filtered and grouped, when you want the whole picture.', do: { go: { name: 'explore' } }, target: { region: 'page' } },
    ],
  },
  {
    id: 'swarms',
    title: 'Swarms and the holarchy',
    blurb: 'Groups of minds with one purpose, and swarms nested inside minds.',
    status: 'ready',
    standing: 'Live',
    triggers: ['show me how swarms work', 'walk me through swarms', 'show me how the holarchy works', 'explain the holarchy'],
    topics: ['swarm', 'swarms', 'holarchy', 'teams', 'nested swarms', 'constellation', 'coordinator'],
    steps: [
      { say: 'A swarm is a group of minds with one purpose. Here are this hive’s swarms.', do: { go: { name: 'swarms' } }, target: { region: 'page' } },
      { say: 'Opening {swarm}. Its members are listed with the mind that coordinates them.', do: { swarm: 'members' }, target: [{ tour: 'swarm-members' }, { region: 'page' }] },
      { say: 'Every swarm keeps a commons of shared beliefs, drawn as a sky: the surer a belief, the brighter and nearer the core.', do: { swarm: 'commons' }, target: [{ tour: 'swarm-constellation' }, { tour: 'swarm-sky' }, { region: 'page' }] },
      { say: 'Swarms can live inside minds, and those inside others: a holarchy. Explore draws it as one constellation.', do: { go: { name: 'explore' } }, target: { region: 'page' } },
      { say: 'A swarm you no longer need is archived with its history, and can be restored later.', do: { go: { name: 'swarms' } }, target: [{ tour: 'archived-swarms' }, { region: 'page' }] },
    ],
  },
  {
    id: 'experiences',
    title: 'Swapping experiences',
    blurb: `${cap(counted(offered.length))} whole ways to live in the same hive: ${listed}.`,
    status: 'ready',
    standing: 'Live',
    triggers: ['show me how swapping experiences works', 'show me how to change the ui', 'walk me through the experiences', 'demo experiences', 'show me how change ui works'],
    topics: ['experiences', 'experience', 'swap experiences', 'swapping experiences', 'change ui', 'looks', 'still', 'cosmos', 'flux', 'construct', 'canvas experience', 'themes'],
    steps: [
      { say: `The hive has ${counted(offered.length)} experiences. Each one can reach every feature; only the way you move through it changes.`, do: { ui: 'gallery' }, target: [{ tour: 'change-ui' }, { region: 'page' }] },
      { say: 'Here they are. Picking one previews it; nothing is kept until you say so.', target: [...(firstShown ? [{ tour: `experience-${firstShown}` }] : []), { tour: 'change-ui' }] },
      ...PREVIEWS.map(([, step]) => step),
      { say: 'Back to your own experience. Your look was never changed: the demo only previewed.', do: { experience: null }, wait: { for: 'time', ms: 900 } },
    ],
  },
  {
    id: 'power',
    title: 'Power modes and resting',
    blurb: 'Turning one mind, or the whole hive, off and on again, and the resting screen.',
    status: 'ready',
    standing: 'Live',
    triggers: ['show me how power modes work', 'show me how resting works', 'how do i turn the hive off', 'walk me through power'],
    topics: ['power', 'power modes', 'resting', 'rest', 'off', 'wake all', 'turn the hive off', 'sleep', 'resting screen'],
    steps: [
      { say: 'Each mind has its own power: wake it, rest it or stop it from its panel.', do: { mind: 'chat' }, target: { tour: 'dot-controls' } },
      { say: 'The hive’s power lives in the menu: Off remembers who was awake, and Wake all brings back exactly those minds. Both ask you first.', do: { go: { name: 'hive' } }, target: [{ tour: 'hud-more' }, { region: 'page' }] },
      { say: 'While the hive is off, each experience shows its own calm resting art, and people who are not admins see a resting screen made for them. I won’t turn it off for this demo.', target: [{ tour: 'hud-more' }, { region: 'page' }] },
    ],
  },
]
