import { toViewer } from '../banked'
import type { GuideScript } from '../types'

/**
 * Brain modules with no demo to play yet (requested from Codex, coordination/inbox/20261007T0545Z-…; Root's replies
 * 20261006-231924Z-… and 20261006-235125Z-…). Each is a stub: the Ask answers honestly ("being built"), offers the
 * nearest real demos, and can show what exists today. Temporal's demos (temporal-demo-sequence/anticipation) are
 * explicitly UNAVAILABLE in Root's catalogue, pending their Reason/Atom owners; Assume's hooks are proposed only. None
 * is called. When one lands, its script needs only real steps (or a `banked` hook) and `status: 'ready'`.
 */
export const STUB_SCRIPTS: GuideScript[] = [
  {
    id: 'temporal',
    viewer: 'temporal',
    title: 'Temporal reasoning',
    blurb: 'Reasoning over time and sequence.',
    status: 'stub',
    needs: 'module and viewer',
    standing: 'Being built',
    hooks: ['temporal-demo-sequence', 'temporal-demo-anticipation'],
    answer: 'Temporal reasoning is being built. The capability set exists but its engine isn’t bound yet. First up: ordering events, time-bound beliefs, and expectations confirmed or missed.',
    nearest: ['beliefs', 'memory'],
    triggers: ['show me how temporal reasoning works', 'explain temporal reasoning', 'walk me through temporal reasoning', 'demo temporal reasoning'],
    topics: ['temporal reasoning', 'temporal', 'time', 'time reasoning', 'sequence', 'sequences', 'ordering events', 'anticipation', 'expectations', 'nal 7', 'nal-7', 'event calculus'],
    steps: [
      { say: 'What exists today around time: a mind’s wakeups, set by a person, which tell it why it woke.', do: { mind: 'schedule' }, target: [{ tour: 'schedule-wakeups' }, { region: 'page' }] },
      { say: 'And its memory keeps events and episodes by time, which the engine will reason over once it is bound.', do: { mind: 'memory' }, target: [{ tour: 'memory-spaces' }, { region: 'page' }] },
      toViewer('temporal', 'This is where its current state will show. There is no reader yet, and it says so.'),
    ],
  },
  {
    id: 'assume',
    viewer: 'assume',
    title: 'Assume: causal prediction',
    blurb: 'The mind’s own predictive situation graph: features, actions and outcomes.',
    status: 'stub',
    needs: 'viewer',
    standing: 'Live in the mind (on by default), no screen yet',
    hooks: ['assume-demo-*'],
    answer: 'Assume is the hive’s causal reasoning: a predictive situation graph each mind owns. It predicts, audits, records outcomes and errors, learns, and proposes changes that are written back only after review. It runs today but has no screen yet; a viewer is being built, and its built-in demo set will make it the first to show.',
    nearest: ['reasoning', 'thinking'],
    triggers: ['show me how assume works', 'show me how causal reasoning works', 'walk me through prediction', 'demo assume'],
    topics: ['assume', 'causal reasoning', 'causal', 'causality', 'cause and effect', 'prediction', 'predict', 'fabricpc', 'situation graph'],
    steps: [
      { say: 'Today: its steps show in the mind’s Thinking, like any other skill.', do: { mind: 'mind' }, target: [{ tour: 'mind-replay' }, { region: 'page' }] },
      toViewer('assume', 'This is where its current state will show. There is no reader yet, and it says so.'),
    ],
  },
]
