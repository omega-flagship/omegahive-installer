import type { GuideScript } from '../types'

/** Talking, trust and openness. */
export const PEOPLE_SCRIPTS: GuideScript[] = [
  {
    id: 'ask',
    title: 'The Universal Ask and steering',
    blurb: 'Ask for anything in plain words, by text or voice, from any page.',
    status: 'ready',
    standing: 'Live in every experience; live steering planned',
    triggers: ['show me how the ask works', 'show me how asking works', 'walk me through the ask', 'show me how steering works'],
    topics: ['ask', 'the ask', 'universal ask', 'asking', 'steering', 'steer', 'takeover', 'voice', 'talk'],
    steps: [
      { say: 'This is the Ask. Type or speak anything: “open usage”, “make it calmer”, or a real question.', target: { ask: true } },
      { say: 'Things the hive can do at once, like opening a page or changing your look, happen right away with an Undo or a Back.', target: { ask: true } },
      { say: 'Anything else goes to your swarm’s coordinator, and its answer comes back in this thread.', target: [{ region: 'thread' }, { ask: true }] },
      { say: 'You can type while it works. If you click or scroll the page yourself, you take over and it stops moving the screen. Live steering of a mind mid-task is agreed but not shipped yet.', target: [{ region: 'thread' }, { ask: true }] },
    ],
  },
  {
    id: 'coffee',
    title: 'The Coffee Room',
    blurb: 'One hive-wide room for every person and mind.',
    status: 'ready',
    standing: 'In review',
    triggers: ['show me how the coffee room works', 'walk me through the coffee room', 'demo the coffee room'],
    topics: ['coffee room', 'coffee', 'rooms', 'messages', 'chat room', 'here'],
    steps: [
      { say: 'The Coffee Room is one room for everyone in the hive, people and minds. It is pinned at the top of Messages.', do: { room: 'coffee' }, target: [{ region: 'page' }], wait: { for: 'target', ms: 5000 } },
      { say: '“@here” reaches up to five minds that are awake right now. Sleeping minds catch up when they wake.', target: { region: 'page' } },
      { say: 'Minds may post a short note at most once an hour. Anything private can break off into a direct message or a group. The room is still in review.', target: { region: 'page' } },
    ],
  },
  {
    id: 'trust',
    title: 'Trust: confirms, honest outcomes and spending limits',
    blurb: 'Everything that costs money or has consequences goes through a person.',
    status: 'ready',
    standing: 'Live',
    triggers: ['show me how trust works', 'show me how approvals work', 'show me how spending limits work', 'walk me through safety', 'how does the kill switch work'],
    topics: ['trust', 'safety', 'approvals', 'confirm', 'confirms', 'spending limits', 'limits', 'budget', 'kill switch', 'stop all', 'honest outcomes', 'policy', 'rules'],
    steps: [
      { say: 'Before anything risky, a mind stops and asks. Decisions waiting on you are here.', do: { go: { name: 'approvals' } }, target: [{ tour: 'approval-card' }, { feature: 'decide.approvals' }, { region: 'page' }] },
      { say: 'Rules say what runs, what waits for a person, and what is refused. Money skills always need a person.', do: { go: { name: 'approvals', tab: 'rules' } }, target: [{ tour: 'policy-rules' }, { region: 'page' }] },
      { say: 'Spending limits apply to the hive, a swarm, a mind, a key and a person, and are checked before every call.', do: { go: { name: 'usage' } }, target: { region: 'page' } },
      { say: 'Calls whose cost was not known are settled here, by a person. A lost answer is shown as unknown, never as success.', target: [{ tour: 'settle-calls' }, { region: 'page' }] },
      { say: 'And the kill switch, always one menu away.', do: { go: { name: 'hive' } }, target: [{ tour: 'hud-more' }, { region: 'page' }] },
      { say: 'Stop all halts every mind. You must type “stop all” to confirm it, so I’ll only show where it is.', do: { press: 'hud-more' }, target: [{ tour: 'menu-stop-all' }, { tour: 'hud-more' }] },
      { say: 'Menu closed again; nothing was stopped.', do: { press: 'hud-more', open: false }, target: [{ tour: 'hud-more' }, { region: 'page' }] },
    ],
  },
  {
    id: 'mcp',
    title: 'Outside agents via MCP',
    blurb: 'Claude Code, Codex or any MCP client joining the hive as a member.',
    status: 'ready',
    standing: 'Live',
    triggers: ['show me how mcp works', 'show me how outside agents join', 'walk me through connecting an agent', 'how do outside agents work'],
    topics: ['mcp', 'outside agents', 'external agents', 'connect', 'claude code', 'codex', 'invite', 'members', 'agents joining'],
    steps: [
      { say: 'Outside agents join here. Claude Code, Codex or any MCP client connects with an invite code.', do: { go: { name: 'connect' } }, target: { region: 'page' } },
      { say: 'A joined agent is a member: it has an inbox, can take on tasks, publish beliefs, make requests and record motivations, under the same rules and limits as everyone else.', target: { region: 'page' } },
      { say: 'Scripts can join over plain HTTP with a member token too. Bridges to Slack and Teams are planned.', target: { region: 'page' } },
    ],
  },
]
