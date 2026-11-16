import type { GuideScript } from '../types'

/**
 * Brain modules that run in the mind but have no screen yet, each with a READY banked tour (Root, 20261006-235125Z:
 * attention-demo-focus, skill-demo-nominate, energy-demo-reserve, scratch-demo-promotion). When the demo starts its
 * steps are read from the hive's Omega Tools catalogue (features/guided/banked) and shown as recorded, "banked /
 * synthetic, not run now". `steps` here are what exists today: played, with an honest note, when the catalogue is
 * not on this hive or the script cannot be read. `answer` is the honest summary said with them.
 */
export const MODULE_SCRIPTS: GuideScript[] = [
  {
    id: 'attention',
    viewer: 'attention',
    title: 'Attention (ECAN)',
    blurb: 'What a mind is focused on, and what it lets fade.',
    status: 'ready',
    banked: 'attention-demo-focus',
    needs: 'viewer',
    standing: 'Live in the mind, no screen yet: banked synthetic demo',
    hooks: ['attention-demo-focus'],
    answer: 'Attention runs inside each mind today: an ECAN-style pass spreads importance over its memory within a budget, and it notices memory pressure. It has no screen yet; a viewer is being built. Today you can see its effects in the mind’s memory and thinking.',
    nearest: ['memory', 'thinking'],
    triggers: ['show me how attention works', 'show me how ecan works', 'walk me through attention', 'demo attention'],
    topics: ['attention', 'ecan', 'focus', 'importance', 'salience', 'forgetting', 'immune system', 'memory pressure'],
    steps: [{ say: 'Attention’s effects show in what the mind keeps: its memory spaces.', do: { mind: 'memory' }, target: [{ tour: 'memory-spaces' }, { region: 'page' }] }],
  },
  {
    id: 'self-knowledge',
    viewer: 'self',
    title: 'Self-knowledge (skill affordances)',
    blurb: 'How a mind looks up and explains its own skills.',
    status: 'ready',
    banked: 'skill-demo-nominate',
    needs: 'viewer',
    standing: 'Live in the mind, no screen yet: banked synthetic demo',
    hooks: ['skill-demo-nominate'],
    answer: 'A mind can look up its own skills and explain them symbolically. That runs today, but it has no screen of its own yet; a viewer is being built. Its skill cards already feed the Tools inventory, which you can see now.',
    nearest: ['reasoning', 'thinking'],
    triggers: ['show me how self knowledge works', 'show me how a mind knows its skills', 'walk me through affordances', 'demo self knowledge'],
    topics: ['self knowledge', 'self-knowledge', 'affordances', 'affordance', 'skill cards', 'explain skill', 'choose skill'],
    steps: [{ say: 'Today: the Tools inventory, built from the mind’s own skill cards.', do: { mind: 'model' }, target: [{ tour: 'mind-tools' }, { region: 'page' }] }],
  },
  {
    id: 'energy',
    viewer: 'energy',
    title: 'Energy and continuity',
    blurb: 'How a mind regulates its effort and cost, and sleeps and wakes itself.',
    status: 'ready',
    banked: 'energy-demo-reserve',
    needs: 'viewer',
    standing: 'Live in the mind, no screen yet: banked synthetic demo',
    hooks: ['energy-demo-reserve'],
    answer: 'A mind regulates its own effort and cost, and can sleep and wake itself. That runs today, but there is no screen for it yet; a viewer is being built. Today you can see its budget, its schedule and the hive’s spend.',
    nearest: ['power', 'trust'],
    triggers: ['show me how energy works', 'walk me through energy', 'show me how a mind saves energy', 'demo energy'],
    topics: ['energy', 'effort', 'energy mode', 'self regulation', 'continuity', 'reserve', 'cost per call'],
    steps: [
      { say: 'Today: the mind’s budget and model, set by a person.', do: { mind: 'model' }, target: [{ tour: 'model-budget' }, { tour: 'model-list' }, { region: 'page' }] },
      { say: 'And its schedule: when it wakes, and why.', do: { mind: 'schedule' }, target: [{ tour: 'schedule-wakeups' }, { region: 'page' }] },
    ],
  },
  {
    id: 'scratch',
    viewer: 'scratch',
    title: 'Scratch space',
    blurb: 'Short-lived memory for drafts and hypotheses.',
    status: 'ready',
    banked: 'scratch-demo-promotion',
    needs: 'viewer',
    standing: 'Live in the mind (on by default), no screen yet: banked synthetic demo',
    hooks: ['scratch-demo-promotion'],
    answer: 'Scratch space is short-lived memory for drafts and hypotheses: it expires, is cleaned up, and can be promoted to durable memory. It runs today but has no screen yet; a viewer is being built. Durable memory you can see now.',
    nearest: ['memory'],
    triggers: ['show me how scratch space works', 'show me how scratch works', 'walk me through scratch memory', 'demo scratch'],
    topics: ['scratch', 'scratch space', 'scratch memory', 'drafts', 'hypotheses', 'promotion', 'short term memory'],
    steps: [{ say: 'Today: durable memory, where promoted scratch ends up.', do: { mind: 'memory' }, target: [{ tour: 'memory-spaces' }, { region: 'page' }] }],
  },
]
