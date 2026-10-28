/**
 * SIM ONLY. The demo showreel's scenes (Surface demo D4): each a guided script the conductor's tour.step plays, plus
 * the showreel's cursor, acts, marks, answers to "why?" and its trace of "how". Every name, number, note and file here
 * is INVENTED, in the shapes the hive really uses; the traces are labelled "Synthetic trace" wherever they show. The
 * code references (file and line) are real and checked (scenes.test.ts), and every truth value in a Reasoning layer is
 * computed from the hive's own lib_pln / lib_nal (pln/), never typed in.
 *
 * r2 (on 3eced24): Ada's personal mind (#/me/mind; it never flips "Use my swarm talk in answers" and never presses
 * Forget) and the swarm delete preview (the live dialog reads the host's GET /api/swarms/{id}/delete-preview; the demo
 * opens it through the same opener as Settings and never presses Delete).
 */
import { href } from '../../lib/router'
import type { GuideScript } from '../guided/types'
import type { Scene } from './types'

const synthetic = 'synthetic' as const
/** a step whose move the showreel's own acts make: the guided step itself moves nothing (`ui: close` is harmless) */
const stay = { ui: 'close' } as const

export const SCENES: Scene[] = [
  {
    id: 'showreel-personal-mind',
    title: 'Your personal mind',
    steps: [
      {
        cursor: [{ tour: 'nav-me' }],
        before: [{ kind: 'navigate', route: href({ name: 'me', view: 'mind' }), label: 'Your mind' }],
        guide: { say: 'Ada’s own personal mind. It shows what it remembers about her, kept in this browser, and her choice whether her swarm talk is used in answers. That choice is hers: off until she turns it on.', caption: 'What it remembers, and your choice', do: stay, target: [{ tour: 'mind-remembers' }, { region: 'page' }] },
        draw: [
          { kind: 'underline', target: [{ tour: 'mind-remembers' }], label: 'Kept in this browser' },
          { kind: 'arrow', target: [{ tour: 'mind-talk-recall' }], label: 'Your choice; the demo never flips it' },
        ],
        why: 'To show that a personal mind is yours: what it remembers is kept in your browser, you can read and forget any of it, and whether your swarm talk is used in answers is your switch alone. The demo never flips it and never presses Forget.',
        seeing: 'Ada’s personal mind (Ada is invented): the notes it remembers, the copies of her swarm talk, and the “Use my swarm talk in answers” switch.',
        click: 'I clicked You, then your mind. Opening it only reads; nothing is changed or forgotten.',
        trace: {
          source: synthetic,
          screen: { component: 'PersonalMindPage › Remembers', control: 'You › Your mind', sent: 'GET /api/me/mind (the simulator answers it)' },
          code: [
            { file: 'hive/ui/src/features/mind/PersonalMindPage.tsx', line: 319, symbol: 'Use my swarm talk in answers', excerpt: '<Switch checked={mem.talkRecall} onChange={(on) => askMemory.setTalkRecall(on)} label="Use my swarm talk in answers" disabled={!mem.ready} />' },
            { file: 'hive/ui/src/api/live.ts', line: 546, symbol: 'myMind', excerpt: "myMind = () => this.request<unknown>('GET', '/api/me/mind')" },
          ],
          hive: [{ method: 'GET', route: '/api/me/mind', handler: 'the owner-only personal-mind route (Platform’s; not in this release’s host, so the simulator answers it)', check: 'owner only: a person reads only their own mind; what it remembers never leaves the browser' }],
          mind: {
            skill: 'mind-revise!',
            loop: 'The personal mind’s memory core (lib_mind.metta): a note learned again is revised with lib_hive’s hive-truth-revision, an exact copy of lib_nal’s Truth_Revision',
            metta: '(mind-revise! b_short_answers (stv 0.9 0.5) (s2) 1760010000 7)',
          },
          atomspace: {
            space: '&mind (Ada’s personal mind, in this browser)',
            before: [
              { id: 's', text: '(Said b_short_answers preference "Prefers short answers with the numbers first")', kind: 'node' },
              { id: 'b', text: '(Belief b_short_answers)', kind: 'link', targets: ['s'], stv: [0.8, 0.8] },
            ],
            after: [
              { id: 's', text: '(Said b_short_answers preference "Prefers short answers with the numbers first")', kind: 'node' },
              { id: 'b', text: '(Belief b_short_answers)', kind: 'link', targets: ['s'], stv: [0.8200000000000002, 0.8333333333333334] },
            ],
          },
          reasoning: [{ case: 'nal-rev-mind', premises: ['(Belief b_short_answers): as held', '(Belief b_short_answers): learned again (disjoint evidence)'], conclusion: '(Belief b_short_answers)' }],
          memory: { recalled: [{ text: 'Prefers short answers with the numbers first', why: 'Ada said it again in this conversation, so the note is revised, not added twice' }], stored: [] },
          files: [],
        },
      },
    ],
  },
  {
    id: 'showreel-team-room',
    title: 'A swarm’s own room',
    steps: [
      {
        cursor: [{ feature: 'swarms.see' }],
        before: [{ kind: 'navigate', route: href({ name: 'swarm', id: 's_lyra' }), label: 'Lyra' }],
        guide: { say: 'This is Lyra, a swarm of three minds watching the night sky. Its Chat button opens the swarm’s own room.', caption: 'Lyra: three minds and their room', do: stay, target: [{ tour: 'swarm-chat' }, { region: 'page' }] },
        draw: [{ kind: 'circle', target: [{ tour: 'swarm-chat' }], label: 'The swarm’s room' }],
        why: 'To show where minds talk to each other: every swarm has one private room holding its owner and its minds.',
        seeing: 'Lyra’s swarm page: its minds, what it believes, and the Chat button that opens the swarm’s own room.',
        click: 'I clicked Swarms to reach Lyra. Nothing was changed: opening a page is a read.',
        trace: {
          source: synthetic,
          screen: { component: 'SwarmView', control: 'Swarms (nav)', sent: 'GET /api/swarms/s_lyra' },
          code: [{ file: 'hive/ui/src/features/swarm/SwarmView.tsx', line: 143, symbol: 'Chat with this swarm', excerpt: 'aria-label="Chat with this swarm"' }],
          hive: [{ method: 'GET', route: '/api/swarms/{swarm_id}', handler: 'hive/core/app.py swarm', check: 'operator(request): a signed-in person of this hive' }],
          mind: { skill: '(none)', loop: 'No mind turn: the page read the swarm.', metta: '(match &self (Swarm s_lyra $name $minds) ($name $minds))' },
          reasoning: [],
          atomspace: {
            space: '&self',
            before: [{ id: 'sw', text: '(Swarm s_lyra "Lyra")', kind: 'node' }, { id: 'v', text: 'Vega', kind: 'node' }, { id: 'm1', text: '(MemberOf Vega s_lyra)', kind: 'link', targets: ['v', 'sw'] }],
            after: [{ id: 'sw', text: '(Swarm s_lyra "Lyra")', kind: 'node' }, { id: 'v', text: 'Vega', kind: 'node' }, { id: 'm1', text: '(MemberOf Vega s_lyra)', kind: 'link', targets: ['v', 'sw'] }],
          },
          memory: { recalled: [], stored: [] },
          files: [],
        },
      },
      {
        cursor: [{ tour: 'swarm-chat' }],
        before: [{ kind: 'team-room', swarm: 's_lyra', label: 'Lyra’s room' }],
        guide: { say: 'Lyra’s room. Vega asks Deneb to take the early window by @-mention, and Deneb hands the late one to Mira.', caption: 'Minds hand work to each other with @Name', do: stay, target: [{ tour: 'room-messages' }, { region: 'page' }] },
        draw: [{ kind: 'underline', target: [{ tour: 'room-messages' }], label: 'Vega → Deneb → Mira' }],
        why: 'To show minds working together in the open: a mind @-mentions another mind in its swarm, that mind answers, and the person can join in.',
        seeing: 'The swarm room’s conversation: Ada (an invented visitor) and three invented minds planning tonight’s observing.',
        click: 'I clicked Chat on Lyra’s page. It opens the swarm’s own room; the hive adds an owner or admin who opens it.',
        trace: {
          source: synthetic,
          screen: { component: 'SwarmView → MessagesPage', control: 'Chat (Chat with this swarm)', sent: 'POST /api/swarms/s_lyra/room, then #/messages/<room>' },
          code: [
            { file: 'hive/ui/src/features/swarm/SwarmView.tsx', line: 149, symbol: 'client.swarmRoom', excerpt: 'const room = await client.swarmRoom(id)' },
            { file: 'hive/ui/src/api/live.ts', line: 522, symbol: 'swarmRoom', excerpt: "swarmRoom = (swarmId: string) => this.request<import('./types').Room>('POST', `/api/swarms/${enc(swarmId)}/room`)" },
            { file: 'hive/core/rooms.py', line: 520, symbol: 'swarm_room', excerpt: 'def swarm_room(self, viewer, swarm_id):' },
          ],
          hive: [{ method: 'POST', route: '/api/swarms/{swarm_id}/room', handler: 'hive/core/app.py swarm_room → rooms.swarm_room', check: 'visibility.check_path(viewer, swarm_id); an owner or admin joins on opening, anyone else gets “not found”' }],
          mind: {
            skill: 'pln-step, then send',
            loop: '(omegaclaw 412): receive → getContext → the reply’s commands → command-results (src/loop.metta)',
            metta: '((pln-step (seeing-drops-after-midnight (stv 0.9 0.9))\n           ((Implication seeing-drops-after-midnight observe-binaries-early) (stv 0.8 0.9)))\n (send "@Deneb the seeing forecast drops after midnight. Can you take the early window on the binaries?"))',
          },
          atomspace: {
            space: '&self (Vega)',
            before: [
              { id: 'p', text: 'seeing-drops-after-midnight', kind: 'node', stv: [0.9, 0.9] },
              { id: 'q', text: 'observe-binaries-early', kind: 'node' },
              { id: 'pq', text: '(Implication seeing-drops-after-midnight observe-binaries-early)', kind: 'link', targets: ['p', 'q'], stv: [0.8, 0.9] },
            ],
            after: [
              { id: 'p', text: 'seeing-drops-after-midnight', kind: 'node', stv: [0.9, 0.9] },
              { id: 'q', text: 'observe-binaries-early', kind: 'node', stv: [0.7220000000000001, 0.5832] },
              { id: 'pq', text: '(Implication seeing-drops-after-midnight observe-binaries-early)', kind: 'link', targets: ['p', 'q'], stv: [0.8, 0.9] },
            ],
          },
          reasoning: [{ case: 'pln-mp-room', premises: ['seeing-drops-after-midnight', '(Implication seeing-drops-after-midnight observe-binaries-early)'], conclusion: 'observe-binaries-early' }],
          memory: { recalled: [{ text: 'Deneb prefers the early window when the seeing is good', why: 'it names Deneb and the early window, both in this message' }], stored: ['Asked Deneb to take the early window tonight'] },
          files: [],
        },
      },
    ],
  },
  {
    id: 'showreel-swarm-delete',
    title: 'Swarm delete preview',
    steps: [
      {
        cursor: [{ feature: 'swarms.see' }],
        before: [{ kind: 'navigate', route: href({ name: 'swarm', id: 's_drift' }), label: 'Driftwood' }],
        dialog: { kind: 'swarm-delete', swarm: 's_drift', name: 'Driftwood' },
        guide: { say: 'Deleting a swarm with its minds starts with the hive’s own preview: which minds go, what happens to their tasks, and what is kept. Nothing is deleted unless you type the swarm’s name and press Delete yourself.', caption: 'The preview first; only your typed name deletes', do: stay, target: [{ tour: 'swarm-delete-preview' }, { region: 'page' }] },
        draw: [
          { kind: 'circle', target: [{ tour: 'swarm-delete-preview' }], label: 'What would go, from the hive’s preview' },
          { kind: 'arrow', target: [{ tour: 'swarm-delete-press' }], label: 'Only after you type its name' },
        ],
        why: 'To show that a delete is never a surprise: the hive previews exactly what would go and what is kept, and the delete only happens after you type the swarm’s name. The demo opens the preview and never presses Delete.',
        seeing: 'The delete warning for Driftwood, an invented practice swarm with two sleeping minds: the hive’s preview of what would be deleted and kept.',
        click: 'I opened Driftwood and its “Delete swarm and its minds” warning, the same warning Settings opens. Reading the preview writes nothing.',
        trace: {
          source: synthetic,
          screen: { component: 'SwarmDeleteDialog', control: 'Delete swarm and its minds… (opened; never pressed)', sent: 'GET /api/swarms/s_drift/delete-preview' },
          code: [
            { file: 'hive/ui/src/features/swarm/SwarmDeleteDialog.tsx', line: 107, symbol: 'deleteSwarmPreview', excerpt: 'const preview = client?.deleteSwarmPreview?.bind(client)' },
            { file: 'hive/ui/src/api/live.ts', line: 322, symbol: 'deleteSwarmPreview', excerpt: "deleteSwarmPreview = (id: string) => this.request<import('./client').SwarmDeletePreview>('GET', `/api/swarms/${enc(id)}/delete-preview`)" },
            { file: 'hive/core/app.py', line: 1183, symbol: 'swarm_delete_preview', excerpt: 'async def swarm_delete_preview(swarm_id: str, request: Request):' },
            { file: 'hive/core/hive.py', line: 530, symbol: 'delete_preview', excerpt: 'def delete_preview(self, swarm_id):' },
          ],
          hive: [{ method: 'GET', route: '/api/swarms/{swarm_id}/delete-preview', handler: 'hive/core/app.py swarm_delete_preview → hive.delete_preview', check: 'admin(request); read-only, writes nothing; an advisory snapshot (the confirmed delete re-checks everything itself)' }],
          mind: { skill: '(none)', loop: 'No mind turn: the page read the hive’s preview.', metta: '(match &self (MemberOf $m s_drift) $m)' },
          atomspace: {
            space: '&self',
            before: [{ id: 'sw', text: '(Swarm s_drift "Driftwood")', kind: 'node' }, { id: 'p', text: '(MemberOf Pebble s_drift)', kind: 'link', targets: ['sw'] }, { id: 'h', text: '(MemberOf Shingle s_drift)', kind: 'link', targets: ['sw'] }],
            after: [{ id: 'sw', text: '(Swarm s_drift "Driftwood")', kind: 'node' }, { id: 'p', text: '(MemberOf Pebble s_drift)', kind: 'link', targets: ['sw'] }, { id: 'h', text: '(MemberOf Shingle s_drift)', kind: 'link', targets: ['sw'] }],
          },
          reasoning: [],
          memory: { recalled: [], stored: [] },
          files: [],
        },
      },
    ],
  },
  {
    id: 'showreel-studio',
    title: 'Studio save',
    steps: [
      {
        cursor: [{ feature: 'apps.list' }],
        before: [{ kind: 'navigate', route: href({ name: 'program', id: 'omegadesign', swarm: 's_lyra' }), label: 'Studio in Lyra' }],
        guide: { say: 'Studio, Lyra’s design app. It starts from what you would like to make, or from a design the swarm already keeps.', caption: 'Pick up a kept design', do: stay, target: [{ tour: 'design-recent' }, { region: 'page' }] },
        draw: [{ kind: 'circle', target: [{ tour: 'design-recent' }], label: 'Kept in the hive' }],
        why: 'To show where a saved design lives: Studio lists the designs this swarm keeps in the hive, each at its latest revision.',
        seeing: 'Studio in Lyra with invented designs: the empty canvas, and the night-sky festival poster at revision 4.',
        click: 'I clicked Apps to open Studio. Opening it only reads the swarm’s designs.',
        trace: {
          source: synthetic,
          screen: { component: 'DesignCanvas (Empty)', control: 'Apps → Studio', sent: 'GET /api/swarms/s_lyra/artifacts?kind=studio-source&limit=6' },
          code: [{ file: 'hive/ui/src/forms/designCanvas/useCanvas.ts', line: 222, symbol: 'client.swarmArtifacts', excerpt: "client.swarmArtifacts(scope, { kind: 'studio-source', limit: 6 }).then(take).catch(() => take([]))" }],
          hive: [{ method: 'GET', route: '/api/swarms/{swarm_id}/artifacts', handler: 'hive/core/app.py swarm_artifacts → collab.swarm_artifacts', check: 'operator(request); visibility.check_path(viewer, swarm_id); metadata only' }],
          mind: { skill: '(none)', loop: 'No mind turn: the page read the swarm’s designs.', metta: '(match &self (Kept (Design $id) (Revision $n)) ($id $n))' },
          atomspace: {
            space: '&self (Studio in Lyra)',
            before: [{ id: 'd', text: '(Design night-sky-poster)', kind: 'node' }, { id: 'r4', text: '(Revision night-sky-poster 4)', kind: 'link', targets: ['d'] }],
            after: [{ id: 'd', text: '(Design night-sky-poster)', kind: 'node' }, { id: 'r4', text: '(Revision night-sky-poster 4)', kind: 'link', targets: ['d'] }],
          },
          reasoning: [],
          memory: { recalled: [], stored: [] },
          files: [],
        },
      },
      {
        cursor: [{ tour: 'design-recent' }],
        before: [{ kind: 'design', swarm: 's_lyra', title: 'Night-sky festival poster', label: 'Night-sky festival poster' }],
        guide: { say: 'The poster, at revision 4. Saving is under Deliver: Keep this version sends it to the hive, the hive shows exactly what would be kept, and only your yes makes it revision 5.', caption: 'Keep → your confirm → revision 5', do: stay, target: [{ tour: 'design-title' }, { region: 'page' }] },
        draw: [
          { kind: 'underline', target: [{ tour: 'design-title' }], label: 'Revision 4, as kept' },
          { kind: 'arrow', target: [{ tour: 'design-modes' }], label: 'Deliver → Keep' },
        ],
        why: 'To show that saving is always yours: the app asks, the hive shows what would be kept, and only your yes writes the next revision. The demo never presses Keep or Confirm.',
        seeing: 'An invented poster open on the canvas at revision 4, with its modes; Keep this version lives under Deliver.',
        click: 'I clicked the poster in “pick up where you left off”. Opening a design is a read; keeping one is yours.',
        trace: {
          source: synthetic,
          screen: { component: 'DesignCanvas (useCanvas keep)', control: 'Deliver → Keep this version in the hive (yours to press)', sent: 'POST /api/programs/omegadesign/confirm, then POST /api/programs/omegadesign/act {action:"save-source"}' },
          code: [
            { file: 'hive/ui/src/forms/designCanvas/useCanvas.ts', line: 290, symbol: 'keep', excerpt: 'const keep = useCallback(async () => {' },
            { file: 'hive/ui/src/forms/designCanvas/useCanvas.ts', line: 326, symbol: "act('save-source')", excerpt: "r = op.fence.valid() ? await act('save-source', [], sent) : { status: 'refused', message: 'Not sent: the sign-in or the design changed.' }" },
            { file: 'hive/core/app.py', line: 2967, symbol: 'program_confirm', excerpt: 'async def program_confirm(program_id: str, request: Request):' },
          ],
          hive: [
            { method: 'POST', route: '/api/programs/{program_id}/confirm', handler: 'hive/core/app.py program_confirm → program_actions.mint_confirm', check: 'a person session only; visibility.check_path; a single-use confirm token after the person’s yes (§9d)' },
            { method: 'POST', route: '/api/programs/{program_id}/act', handler: 'hive/core/app.py program_act → programs.act', check: 'the confirm token must match this exact payload; Studio must be switched on in the swarm' },
          ],
          mind: {
            skill: 'nal-step',
            loop: '(omegaclaw 77): after a kept revision, the swarm’s coordinator notes who can now see it',
            metta: '(nal-step ((--> night-sky-poster confirmed-save) (stv 0.9 0.9))\n          ((--> confirmed-save visible-to-lyra) (stv 0.95 0.9)))',
          },
          atomspace: {
            space: '&self (Studio in Lyra)',
            before: [{ id: 'd', text: '(Design night-sky-poster)', kind: 'node' }, { id: 'r4', text: '(Revision night-sky-poster 4)', kind: 'link', targets: ['d'] }],
            after: [
              { id: 'd', text: '(Design night-sky-poster)', kind: 'node' },
              { id: 'r4', text: '(Revision night-sky-poster 4)', kind: 'link', targets: ['d'] },
              { id: 'r5', text: '(Revision night-sky-poster 5)', kind: 'link', targets: ['d'] },
              { id: 'v', text: '(--> night-sky-poster visible-to-lyra)', kind: 'link', targets: ['d'], stv: [0.855, 0.69255] },
            ],
          },
          reasoning: [{ case: 'nal-ded-studio', premises: ['(--> night-sky-poster confirmed-save)', '(--> confirmed-save visible-to-lyra)'], conclusion: '(--> night-sky-poster visible-to-lyra)' }],
          memory: { recalled: [{ text: 'Lyra keeps one poster per event, newest revision first', why: 'it is about this design and its revisions' }], stored: [] },
          files: [{ path: 'apps/omegadesign/s_lyra/night-sky-poster/rev-5.json', change: 'added', bytes: 4182, diff: '+ {"revision": 5, "kept_by": "user:p_ada", "source": "editable"}' }],
        },
      },
    ],
  },
  {
    id: 'showreel-tools',
    title: 'Tools inspect',
    steps: [
      {
        cursor: [{ feature: 'apps.list' }],
        before: [{ kind: 'navigate', route: href({ name: 'program', id: 'omega-tools', swarm: 's_lyra' }), label: 'Omega Tools in Lyra' }],
        guide: { say: 'The tools catalogue: tools, sets and foundations a mind can use. Inspect shows what a tool is; examples are banked, never run here.', caption: 'Inspection only: nothing here runs', do: stay, target: [{ tour: 'program-stage-view' }, { region: 'page' }] },
        draw: [{ kind: 'circle', target: [{ tour: 'program-stage-view' }], label: 'Inspect, never run' }],
        why: 'To show what a mind could use before it uses anything: you can look inside every tool, and its examples are recorded, not executed.',
        seeing: 'Omega Tools in Lyra, with invented tools such as sort-by-urgency and draft-checklist, grouped into sets.',
        click: 'I clicked Apps to open Omega Tools. Inspect is a read; nothing in this app executes.',
        trace: {
          source: synthetic,
          screen: { component: 'ProgramHost (omega-tools)', control: 'Inspect', sent: 'POST /api/programs/omega-tools/act {action:"inspect-tool", items:["t-urgency"]}' },
          code: [
            { file: 'hive/ui/src/store/store.ts', line: 1214, symbol: 'client.programAct', excerpt: 'const r = await client.programAct(s0.programId, { swarm_id: s0.swarmId, action, items, params: sent, base_revision: s0.graph?.revision ?? null })' },
            { file: 'hive/core/app.py', line: 2952, symbol: 'program_act', excerpt: 'async def program_act(program_id: str, request: Request):' },
          ],
          hive: [{ method: 'POST', route: '/api/programs/{program_id}/act', handler: 'hive/core/app.py program_act → programs.act', check: 'visibility.check_path(viewer, swarm_id); check_named_minds; the app declares inspect-tool as a read' }],
          mind: {
            skill: 'pln-step',
            loop: '(omegaclaw 233): a mind choosing a tool for a sorting job weighs what two tools share',
            metta: '(pln-step ((Inheritance sort-by-urgency reads-task-list) (stv 0.7 0.9))\n          ((Inheritance sort-by-urgency inspection-only) (stv 0.6 0.8)))',
          },
          atomspace: {
            space: '&self (a Lyra mind)',
            before: [
              { id: 'c', text: 'sort-by-urgency', kind: 'node' },
              { id: 'a', text: 'reads-task-list', kind: 'node' },
              { id: 'b', text: 'inspection-only', kind: 'node' },
              { id: 'ca', text: '(Inheritance sort-by-urgency reads-task-list)', kind: 'link', targets: ['c', 'a'], stv: [0.7, 0.9] },
              { id: 'cb', text: '(Inheritance sort-by-urgency inspection-only)', kind: 'link', targets: ['c', 'b'], stv: [0.6, 0.8] },
            ],
            after: [
              { id: 'c', text: 'sort-by-urgency', kind: 'node' },
              { id: 'a', text: 'reads-task-list', kind: 'node' },
              { id: 'b', text: 'inspection-only', kind: 'node' },
              { id: 'ca', text: '(Inheritance sort-by-urgency reads-task-list)', kind: 'link', targets: ['c', 'a'], stv: [0.7, 0.9] },
              { id: 'cb', text: '(Inheritance sort-by-urgency inspection-only)', kind: 'link', targets: ['c', 'b'], stv: [0.6, 0.8] },
              { id: 'ab', text: '(Inheritance reads-task-list inspection-only)', kind: 'link', targets: ['a', 'b'], stv: [0.43333333333333335, 0.3016759776536313] },
            ],
          },
          reasoning: [{ case: 'pln-ind-tools', premises: ['reads-task-list (term A, default)', 'inspection-only (term B, default)', 'sort-by-urgency (term C, default)', '(Inheritance sort-by-urgency reads-task-list)', '(Inheritance sort-by-urgency inspection-only)'], conclusion: '(Inheritance reads-task-list inspection-only)' }],
          memory: { recalled: [], stored: [] },
          files: [],
        },
      },
    ],
  },
  {
    id: 'showreel-lab',
    title: 'Lab: a stalled run, two versions',
    steps: [
      {
        cursor: [{ feature: 'watch.lab' }],
        before: [{ kind: 'open', feature: 'watch.lab', label: 'Lab' }],
        guide: { say: 'The Lab runs test suites. This run looks stalled: no new case for a while, so the Lab says so plainly and offers Cancel.', caption: 'A stalled run, said plainly', do: stay, target: [{ tour: 'lab-stalled' }, { region: 'page' }] },
        draw: [{ kind: 'circle', target: [{ tour: 'lab-stalled' }], label: 'Stalled: no new case' }],
        why: 'To show the hive noticing when work stops moving: a run with no new case for much longer than expected is called stalled, with the time since its last progress.',
        seeing: 'The Lab overview: suites with their last runs; one invented run shows as Stalled with the minutes since its last case.',
        click: 'I clicked Lab in the navigation. It only reads the runs.',
        trace: {
          source: synthetic,
          screen: { component: 'LabView', control: 'Lab (nav)', sent: 'GET /api/lab/suites, GET /api/lab/runs' },
          code: [
            { file: 'hive/ui/src/features/lab/stallCompare.ts', line: 23, symbol: 'stalledFor', excerpt: "export function stalledFor(run: Pick<LabRunSummary, 'status' | 'started_at'>, cases: Pick<LabCase, 'duration_ms'>[], estimateS: number, now = Date.now()): number | null {" },
            { file: 'hive/core/app.py', line: 2336, symbol: 'lab_runs', excerpt: 'async def lab_runs(request: Request, suite: str = "", limit: int = 50):' },
          ],
          hive: [{ method: 'GET', route: '/api/lab/runs', handler: 'hive/core/app.py lab_runs → lab.runs', check: 'operator(request); at most 200 runs' }],
          mind: {
            skill: 'pln-step',
            loop: '(omegaclaw 958): the health mind revises what it believes about the run from two observations, then decides to say so',
            metta: '(pln-step ((Evaluation stalled run-ops-7) (stv 0.8 0.9))\n          ((Evaluation stalled run-ops-7) (stv 0.6 0.5)))',
          },
          atomspace: {
            space: '&self (the health mind)',
            before: [
              { id: 'r', text: 'run-ops-7', kind: 'node' },
              { id: 's1', text: '(Evaluation stalled run-ops-7)', kind: 'link', targets: ['r'], stv: [0.8, 0.9] },
              { id: 'o', text: '(Implication (Evaluation stalled run-ops-7) offer-cancel)', kind: 'link', targets: ['s1'], stv: [0.9, 0.9] },
            ],
            after: [
              { id: 'r', text: 'run-ops-7', kind: 'node' },
              { id: 's1', text: '(Evaluation stalled run-ops-7)', kind: 'link', targets: ['r'], stv: [0.78, 0.9090909090909091] },
              { id: 'o', text: '(Implication (Evaluation stalled run-ops-7) offer-cancel)', kind: 'link', targets: ['s1'], stv: [0.9, 0.9] },
              { id: 'c', text: 'offer-cancel', kind: 'node', stv: [0.7064, 0.5743636363636364] },
            ],
          },
          reasoning: [
            { case: 'pln-rev-stalled', premises: ['(Evaluation stalled run-ops-7): no new case for 14 minutes', '(Evaluation stalled run-ops-7): the last heartbeat is old'], conclusion: '(Evaluation stalled run-ops-7)' },
            { case: 'pln-mp-stalled', premises: ['(Evaluation stalled run-ops-7) (revised, step 1)', '(Implication (Evaluation stalled run-ops-7) offer-cancel)'], conclusion: 'offer-cancel' },
          ],
          memory: { recalled: [{ text: 'Operations runs usually finish a case every two minutes', why: 'it sets how long “too long” is for this suite' }], stored: ['run-ops-7 looked stalled at 21:40'] },
          files: [],
        },
      },
      {
        cursor: [{ tour: 'lab-stalled' }],
        before: [{ kind: 'navigate', route: href({ name: 'lab', suite: 'bench-core', tab: 'compare' }), label: 'Compare' }],
        guide: { say: 'Two versions of the same suite, side by side: version B against version A, case by case and measure by measure.', caption: 'B against A, in one sentence', do: stay, target: [{ tour: 'lab-compare' }, { region: 'page' }] },
        draw: [{ kind: 'underline', target: [{ tour: 'lab-compare' }], label: 'Better on, worse on' }],
        why: 'To show how you tell whether a change helped: the same cases run on two versions, and the Lab says where B is better and where it is worse.',
        seeing: 'Compare for an invented core suite: two invented commits, how many cases each passed, and the measures that moved.',
        click: 'I opened Compare for the core suite. Picking versions is a read.',
        trace: {
          source: synthetic,
          screen: { component: 'Compare', control: 'Compare (tab)', sent: 'GET /api/lab/runs?suite=bench-core, GET /api/lab/runs/{a}, GET /api/lab/runs/{b}' },
          code: [
            { file: 'hive/ui/src/features/lab/stallCompare.ts', line: 87, symbol: 'compareRuns', excerpt: 'export function compareRuns(aCases: LabCase[], bCases: LabCase[]): Comparison {' },
            { file: 'hive/core/app.py', line: 2347, symbol: 'lab_run', excerpt: 'async def lab_run(run_id: str, request: Request):' },
          ],
          hive: [{ method: 'GET', route: '/api/lab/runs/{run_id}', handler: 'hive/core/app.py lab_run → lab.run', check: 'operator(request)' }],
          mind: {
            skill: 'pln-step',
            loop: '(omegaclaw 961): a mind reviewing the comparison chains two links',
            metta: '(pln-step ((Inheritance version-b fewer-failures) (stv 0.9 0.9))\n          ((Inheritance fewer-failures better-candidate) (stv 0.8 0.9)))',
          },
          atomspace: {
            space: '&self (a reviewing mind)',
            before: [
              { id: 'b', text: 'version-b', kind: 'node' },
              { id: 'f', text: 'fewer-failures', kind: 'node' },
              { id: 'g', text: 'better-candidate', kind: 'node' },
              { id: 'bf', text: '(Inheritance version-b fewer-failures)', kind: 'link', targets: ['b', 'f'], stv: [0.9, 0.9] },
              { id: 'fg', text: '(Inheritance fewer-failures better-candidate)', kind: 'link', targets: ['f', 'g'], stv: [0.8, 0.9] },
            ],
            after: [
              { id: 'b', text: 'version-b', kind: 'node' },
              { id: 'f', text: 'fewer-failures', kind: 'node' },
              { id: 'g', text: 'better-candidate', kind: 'node' },
              { id: 'bf', text: '(Inheritance version-b fewer-failures)', kind: 'link', targets: ['b', 'f'], stv: [0.9, 0.9] },
              { id: 'fg', text: '(Inheritance fewer-failures better-candidate)', kind: 'link', targets: ['f', 'g'], stv: [0.8, 0.9] },
              { id: 'bg', text: '(Inheritance version-b better-candidate)', kind: 'link', targets: ['b', 'g'], stv: [0.7222222222222223, 0.5832] },
            ],
          },
          reasoning: [{ case: 'pln-ded-compare', premises: ['version-b (term P, default)', 'fewer-failures (term Q, default)', 'better-candidate (term R, default)', '(Inheritance version-b fewer-failures)', '(Inheritance fewer-failures better-candidate)'], conclusion: '(Inheritance version-b better-candidate)' }],
          memory: { recalled: [], stored: ['B passed more core cases than A'] },
          files: [],
        },
      },
    ],
  },
  {
    id: 'showreel-health',
    title: 'Health: a spend cap',
    steps: [
      {
        cursor: [{ feature: 'watch.health' }],
        before: [{ kind: 'open', feature: 'watch.health', label: 'Health' }],
        after: [{ kind: 'point', target: { feature: 'watch.health' }, caption: 'Health' }],
        guide: { say: 'Health shows which minds are awake or asleep, and why. Quench has used its whole budget, so the hive refuses its model calls until someone raises the cap.', caption: 'At its cap: calls refused, plainly', do: stay, target: [{ tour: 'health-cap' }, { tour: 'health-sleep-spend' }, { region: 'page' }] },
        draw: [{ kind: 'circle', target: [{ tour: 'health-cap' }, { tour: 'health-sleep-spend' }], label: 'Spend cap reached' }],
        why: 'To show a budget doing its job: a mind that reaches its cap stops spending, the hive says so in plain words, and only a person can raise it.',
        seeing: 'Health in demo mode: invented minds awake and asleep under their sleep rules, and Quench at its invented $10 cap with its calls refused.',
        click: 'I clicked Health in the navigation. It only reads.',
        trace: {
          source: synthetic,
          screen: { component: 'SleepAndSpend', control: 'Health (nav)', sent: 'GET /api/health' },
          code: [
            { file: 'hive/ui/src/features/health/sleepSpend.ts', line: 30, symbol: 'atCap', excerpt: "export const atCap = (a: Pick<Agent, 'budget_usd' | 'spent_usd'>) => a.budget_usd > 0 && a.spent_usd >= a.budget_usd" },
            { file: 'hive/core/app.py', line: 2615, symbol: 'health_overview', excerpt: 'async def health_overview(request: Request, swarm_id: str | None = None):' },
          ],
          hive: [{ method: 'GET', route: '/api/health', handler: 'hive/core/app.py health_overview → health.overview', check: 'operator(request); visibility.filter_items keeps only minds this person may see' }],
          mind: {
            skill: 'pln-step',
            loop: '(omegaclaw 1204): the health mind explains the refusals it sees',
            metta: '(pln-step ((Inheritance quench calls-refused) (stv 0.9 0.9))\n          ((Inheritance at-spend-cap calls-refused) (stv 0.8 0.9)))',
          },
          atomspace: {
            space: '&self (the health mind)',
            before: [
              { id: 'q', text: 'quench', kind: 'node' },
              { id: 'r', text: 'calls-refused', kind: 'node' },
              { id: 'k', text: 'at-spend-cap', kind: 'node' },
              { id: 'qr', text: '(Inheritance quench calls-refused)', kind: 'link', targets: ['q', 'r'], stv: [0.9, 0.9] },
              { id: 'kr', text: '(Inheritance at-spend-cap calls-refused)', kind: 'link', targets: ['k', 'r'], stv: [0.8, 0.9] },
            ],
            after: [
              { id: 'q', text: 'quench', kind: 'node' },
              { id: 'r', text: 'calls-refused', kind: 'node' },
              { id: 'k', text: 'at-spend-cap', kind: 'node' },
              { id: 'qr', text: '(Inheritance quench calls-refused)', kind: 'link', targets: ['q', 'r'], stv: [0.9, 0.9] },
              { id: 'kr', text: '(Inheritance at-spend-cap calls-refused)', kind: 'link', targets: ['k', 'r'], stv: [0.8, 0.9] },
              { id: 'qk', text: '(Inheritance quench at-spend-cap)', kind: 'link', targets: ['q', 'k'], stv: [0.7222222222222223, 0.42163100057836905] },
            ],
          },
          reasoning: [{ case: 'pln-abd-health', premises: ['quench (term A, default)', 'calls-refused (term B, default)', 'at-spend-cap (term C, default)', '(Inheritance quench calls-refused)', '(Inheritance at-spend-cap calls-refused)'], conclusion: '(Inheritance quench at-spend-cap)' }],
          memory: { recalled: [{ text: 'Quench’s cap was set to $10 for the tide survey', why: 'it is the cap the refusals point to' }], stored: ['Quench reached its cap; calls refused since'] },
          files: [],
        },
      },
    ],
  },
]

/** The guided scripts the conductor's tour.step plays (registered for demo mode only, never listed or matched). */
export const SCENE_SCRIPTS: GuideScript[] = SCENES.map((s) => ({
  id: s.id,
  title: s.title,
  blurb: `Demo showreel: ${s.title}`,
  triggers: [],
  topics: [],
  status: 'ready',
  standing: 'Demo showreel (simulated hive)',
  steps: s.steps.map((x) => x.guide),
}))

/** Every step in play order, with its scene and place. */
export const PLAYLIST = SCENES.flatMap((scene, si) => scene.steps.map((step, i) => ({ scene, si, i, step })))
