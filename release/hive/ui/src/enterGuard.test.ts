import { describe, expect, it } from 'vitest'

// node's file system, the repo's way (no Node types in the app's tsconfig): a dynamic import, typed locally
interface Dirent { name: string; isDirectory(): boolean }
const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as {
  readdirSync: (p: string, o: { withFileTypes: true }) => Dirent[]
  readFileSync: (p: string, e: 'utf8') => string
}

/**
 * uifix-r2.4 (stand-in FIX-FIRST on r2.3, Kimi r2.3): the standing guard against the CLASS, not one handler. r2.1 to r2.3
 * each fixed the composers someone had listed, and each round another surfaced (Construct's session composer, the
 * Messages composers), because the audit iterated its own list. This scans the WHOLE source tree, every .ts/.tsx under
 * hive/ui/src (tests excepted), on every run:
 *
 *  1. Every line that acts on Enter ('Enter', 'NumpadEnter', keyCode/which 13) must have `guardComposing(` on that line or
 *     in the 12 lines above it (the handler's first line), or be on ENTER_ALLOW with a reason. An entry may name the
 *     guard's own line (`guardAt`) when the handler is longer; that line must still hold `guardComposing(`.
 *  2. Every `<form onSubmit>` must be inert (`onSubmit={(e) => e.preventDefault()}`: Enter is the field's own guarded
 *     key, and a button sends on its own click), or be on FORM_ALLOW with a reason (what it does, and why a confirming
 *     Enter cannot submit it: a textarea never submits implicitly; for an <input>, features/ask/keys.ts cancels a
 *     confirming Enter's default app-wide in the capture phase).
 *
 * Entries are exact file:line plus the line's text; one that no longer matches fails as stale, so every move is re-read.
 */
const SRC = new URL('.', import.meta.url).pathname
const ENTER = /['"`](Numpad)?Enter['"`]|keyCode\s*===?\s*13\b|which\s*===?\s*13\b/
const INERT = /onSubmit=\{\(e\)\s*=>\s*e\.preventDefault\(\)\}/
const WINDOW = 12

interface Allow { at: string; has: string; why: string; guardAt?: string }

const ENTER_ALLOW: Allow[] = [
  { at: 'experiences/canvas/Inspect.tsx:72', has: 'if (e.repeat && (e.key === \'Enter\' || e.key === \' \')) e.preventDefault', why: 'only cancels a held key (auto-repeat) on buttons; acts on nothing' },
  { at: 'experiences/canvas/index.tsx:575', has: 'case \'Enter\':', why: 'canvas keys: the handler returns while typing (isTyping), and Enter acts only on the canvas or body' },
  { at: 'experiences/canvas/parts.tsx:46', has: 'if (e.key === \'Enter\' || e.key === \' \') {', why: 'keyboard activation of non-text canvas controls (focus-visible buttons and nodes)' },
  { at: 'experiences/construct/CommandLine.tsx:203', has: 'if (k === \'Enter\') {', why: 'the handler starts with guardComposing at line 156, beyond the scan window', guardAt: 'experiences/construct/CommandLine.tsx:156' },
  { at: 'experiences/construct/index.tsx:308', has: 'if ((k === \'Enter\' || k === \' \') && t?.closest(\'button, a[href], [role', why: 'pane keys: the handler returns while a text field is focused (typing check above it); never a text field' },
  { at: 'experiences/construct/index.tsx:353', has: 'if (k === \'Enter\' || k === \'o\') {', why: 'pane keys: the handler returns while a text field is focused (typing check above it); never a text field' },
  { at: 'experiences/construct/index.tsx:378', has: 'if ((k === \'a\' || ((k === \'Enter\' || k === \' \') && !t?.closest(\'button', why: 'pane keys: the handler returns while a text field is focused (typing check above it); never a text field' },
  { at: 'experiences/construct/index.tsx:387', has: 'if (c.focus === \'session\' && (k === \'Enter\' || k === \'i\')) {', why: 'pane keys: the handler returns while a text field is focused (typing check above it); never a text field' },
  { at: 'experiences/construct/index.tsx:392', has: 'if (k === \'Enter\' && c.focus === \'stream\') {', why: 'pane keys: the handler returns while a text field is focused (typing check above it); never a text field' },
  { at: 'experiences/still/Needs.tsx:125', has: 'if (!d && (e.key === \'Enter\' || e.key === \' \')) d = DIRS[(e.target as ', why: 'Enter/Space on a decision button ([data-dir]); the decision gate applies; no text field' },
  { at: 'experiences/still/Sheets.tsx:476', has: 'if (e.repeat && (e.key === \'Enter\' || e.key === \' \')) {', why: 'only cancels a held key (auto-repeat) on buttons; acts on nothing' },
  { at: 'features/ask/keys.ts:69', has: 'if (ev.key === \'Enter\' && !s.active) ev.preventDefault?.()', why: 'the guard itself (the capture listener cancelling a confirming Enter\'s default)' },
  // ask-send-r1: was :514/:491; useFocusWithin and keepFieldFocus (25 lines) were added above it in useAskField.ts;
  // create-draw-live: was :659/:635; askNow and the field-words subscription (26 lines) were added above it
  { at: 'features/ask/useAskField.ts:685', has: '} else if (e.key === \'Enter\') {', why: 'the handler starts with guardComposing at line 661, beyond the scan window', guardAt: 'features/ask/useAskField.ts:661' },
  { at: 'features/code/canvas/LanguageParts.tsx:174', has: '} else if (e.key === \'Enter\' || e.key === \'Tab\') {', why: 'the completions listbox (a focusable list, not a text field); Enter only opens a confirmation step' },
  { at: 'features/code/map/parts.tsx:268', has: 'if (e.key === \'Enter\' || e.key === \' \') {', why: 'a non-text element (svg node, chart point, role=button): no IME composition can target it' },
  { at: 'features/code/map/parts.tsx:395', has: '<g key={id} role="button" tabIndex={0} aria-label={`${label(id)}. Open', why: 'a non-text element (svg node, chart point, role=button): no IME composition can target it' },
  { at: 'features/code/suggestions/WorkbenchSuggestionPanel.tsx:819', has: 'if (e.repeat && (e.key === \'Enter\' || e.key === \' \')) e.preventDefault', why: 'only cancels a held key (auto-repeat) on buttons; acts on nothing' },
  { at: 'features/code/suggestions/WorkbenchSuggestionPanel.tsx:882', has: 'if (e.repeat && (e.key === \'Enter\' || e.key === \' \')) e.preventDefault', why: 'only cancels a held key (auto-repeat) on buttons; acts on nothing' },
  { at: 'features/lab/charts.tsx:440', has: 'onKeyDown={(e) => e.key === \'Enter\' && onPick?.(p.key)}', why: 'a non-text element (svg node, chart point, role=button): no IME composition can target it' },
  { at: 'features/swarm/Constellation.tsx:171', has: 'if (e.key === \'Enter\' || e.key === \' \') {', why: 'a non-text element (svg node, chart point, role=button): no IME composition can target it' },
  { at: 'forms/caseFile/Construct.tsx:252', has: 'if (e.key === \'Enter\' && current?.item) {', why: 'app-owned form (not Surface\'s); a non-text control (button, role=button, item), and the handler skips text fields' },
  { at: 'forms/caseFile/Still.tsx:25', has: 'if (e.key === \'Enter\' || e.key === \' \') {', why: 'app-owned form (not Surface\'s); a non-text control (button, role=button, item), and the handler skips text fields' },
  { at: 'forms/caseFile/parts.tsx:485', has: 'if (e.key !== \'Enter\' && e.key !== \' \') return', why: 'app-owned form (not Surface\'s); a non-text control (button, role=button, item), and the handler skips text fields' },
  { at: 'forms/designCanvas/Stage.tsx:331', has: 'if ((e.key === \'Enter\' || e.key === \' \') && elId) {', why: 'element selection on the design stage (a non-text element); the stage\'s text editor is guarded' },
  { at: 'forms/lifeMap/Classic.tsx:409', has: 'if (e.key === \'Enter\' || e.key === \' \') {', why: 'app-owned form (not Surface\'s); a non-text control (button, role=button, item), and the handler skips text fields' },
  { at: 'forms/lifeMap/consent.ts:71', has: 'if (g.phase !== \'open\' || e.repeat || (e.key !== \'Enter\' && e.key !== ', why: 'app-owned form (not Surface\'s); a non-text control (button, role=button, item), and the handler skips text fields' },
  { at: 'forms/lifeMap/parts.tsx:449', has: 'if (e.repeat && (e.key === \'Enter\' || e.key === \' \')) {', why: 'app-owned form; only cancels a held key (auto-repeat) on buttons; acts on nothing' },
  { at: 'features/ask/AnswererPicker.tsx:156', has: '} else if (e.key === \'Enter\' && choices[active]) {', why: 'the who-answers listbox (role=listbox, a focusable list, not a text field): no IME composition can target it' },
  { at: 'features/programs/PersonSwarmConsent.tsx:101', has: 'if ((event.key === \'Enter\' || event.key === \' \') && (event.repeat', why: 'the consent buttons: only cancels a held or too-early Enter/Space (the acceptance gate); acts on nothing' },
  { at: 'ui/DecisionDialog.tsx:145', has: 'if (e.repeat && (e.key === \'Enter\' || e.key === \' \')) e.preventDefault', why: 'only cancels a held key (auto-repeat) on buttons; acts on nothing' },]

const FORM_ALLOW: Allow[] = [
  { at: 'screens/Screen.tsx:532', has: '<form onSubmit={submit} className="space-y-1.5">', why: 'keyfield block: sends a pasted provider key to the hive to verify and store (a hive record, not a paid send); Enter or the button is the explicit submit; empty/busy refused; IME Enter cancelled app-wide (keys.ts)' },
  { at: 'screens/Screen.tsx:571', has: '<form onSubmit={submit} className="flex min-w-0 flex-1 gap-1.5">', why: 'rename block: renames a hive record (a key, say; not a paid send); Enter is the person\'s explicit submit, and the page changes nothing when the name is blank or the same; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'experiences/construct/Panes.tsx:778', has: '<form', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'experiences/cosmos/Deck.tsx:667', has: '<form', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'experiences/cosmos/Deck.tsx:1038', has: '<form', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'experiences/cosmos/Panels.tsx:500', has: '<form', why: 'sends to a mind, from a textarea: a textarea never submits implicitly; the only submission is the Send button\'s own click' },
  { at: 'experiences/flux/panels.tsx:114', has: '<form', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'experiences/flux/panels.tsx:321', has: '<form className="px-4 pb-4" onSubmit={(e) => { e.preventDefault(); sen', why: 'sends to a mind, from a textarea: a textarea never submits implicitly; the only submission is the Send button\'s own click' },
  { at: 'experiences/flux/sheets.tsx:422', has: '<form', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'experiences/flux/sheets.tsx:813', has: '<form', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'experiences/still/Sheets.tsx:142', has: '<form', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'experiences/still/Sheets.tsx:382', has: '<form', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'features/approvals/PolicyEditor.tsx:236', has: '<form onSubmit={submit} className="space-y-3">', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'features/code/CodePage.tsx:940', has: '<form', why: 'starts a code run (an explicit, labelled Run; not an Ask spend); plain Enter is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'features/code/FileActions.tsx:40', has: '{mode && <form className="space-y-2" onSubmit={(e) => { e.preventDefau', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'features/code/LiveWork.tsx:136', has: '<form', why: 'navigates or filters (no write, no spend)' },
  { at: 'features/code/LiveWork.tsx:175', has: '<form className="grid gap-2 rounded-xl border border-line p-3 md:grid-', why: 'navigates or filters (no write, no spend)' },
  // create-code-r1: the change prompt moved down (the work stream and the empty canvas's request field were added above it)
  { at: 'features/code/canvas/CodeCanvas.tsx:820', has: '<form', why: 'the empty canvas\'s one-line request field (SayFirst): it opens the named file or the chooser, and the request goes out once a file is open; plain Enter or Go is the person\'s explicit submit, empty/busy refused; an IME-confirming Enter is cancelled app-wide at capture (keys.ts) and the field starts with guardComposing' },
  { at: 'features/code/canvas/CodeCanvas.tsx:852', has: '<form', why: 'asks a mind to change code, from a textarea: no implicit submission; the only submission is the Propose button\'s own click' },
  { at: 'features/code/canvas/work/WorkStream.tsx:99', has: '<form', why: 'the work stream\'s one-line Ask for changes note: plain Enter or Ask again is the person\'s explicit submit (an empty or over-long note is refused with a hint, a busy decision waits); an IME-confirming Enter is cancelled app-wide at capture (keys.ts) and the field starts with guardComposing' },
  { at: 'features/code/canvas/IterationsDrawer.tsx:90', has: '<form', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'features/code/canvas/LanguageParts.tsx:25', has: '<form', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'features/dot/Chat.tsx:204', has: '<form', why: 'sends to a mind, from a textarea: a textarea never submits implicitly; the only submission is the Send button\'s own click' },
  { at: 'features/dot/Schedule.tsx:287', has: '<form onSubmit={submit} className="mb-3 space-y-3 rounded-2xl border b', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  // metta-screens-explore: the My groups rename form (MyGroups.tsx:101) became the screens' rename block (screens/Screen.tsx)
  { at: 'features/goals/GoalsBoard.tsx:330', has: '<form onSubmit={submit} data-tour="goals-add" className="mb-3 flex fle', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'features/goals/GoalsBoard.tsx:603', has: '<form', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'features/keys/AskMemorySection.tsx:44', has: '<form', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'features/settings/GoogleConnectorSettings.tsx:163', has: '<form className="mt-3 space-y-3" onSubmit={(e) => void save(e)}>', why: 'saves the admins\' Google client configuration (a hive record, not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'features/ownKey/OwnKeySheet.tsx:92', has: '<form className="ok-sheet" data-own-key-sheet={state.phase} onSubmit={(e', why: 'own-key sheet: saves the person\'s own provider key and monthly limit (hive records), then retries the one ask or review they already sent and that was refused for want of a key (the button says so: "Add key and ask"), paid from their own key within the limit they just set; Enter in the key or limit field is the person\'s explicit submit, the same as the button; an empty key or limit is refused, a second submit while saving is ignored, and a total set meanwhile is never overwritten without fresh consent (addOwnKey.ts); an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  // metta-screens-profile: the add-key form moved from ProfilePage.tsx:172 to the page's island file; the rename form
  // (ProfilePage.tsx:245) became the screens' rename block (screens/Screen.tsx)
  { at: 'features/keys/AddKeyForm.tsx:61', has: '<form onSubmit={submit} data-unsaved-scope="add-key" className="mb-5 r', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'features/keys/OwnMonthlyLimit.tsx:80', has: '<form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={save}>', why: 'r1.14b: saves the person\'s own-key monthly total (a hive record, not a paid send); Enter or Save is the person\'s explicit submit; the amount is validated first and an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  // metta-screens-mind: the personal mind's rename form (PersonalMindPage.tsx:238) became the screens' rename block (screens/Screen.tsx)
  // metta-screens-people: the invitation form moved from PeoplePage.tsx (listed at :195, already stale at :242) to the
  // page's islands file; the member form (PeoplePage.tsx:335, never listed) moved with it and is listed now
  { at: 'features/people/PeopleForms.tsx:40', has: '<form onSubmit={submit} className="rounded-2xl border border-line bg-t', why: 'creates an invitation (a hive record, not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'features/people/PeopleForms.tsx:93', has: '<form onSubmit={submit} aria-label="Add a member"', why: 'adds a member with a hive-made password (a hive record, not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'features/requestExperience/RequestPanel.tsx:68', has: '<form', why: 'one-line request field: plain Enter is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'features/settings/AskAudit.tsx:47', has: '<form', why: 'navigates or filters (no write, no spend)' },
  { at: 'features/swarm/SwarmConnections.tsx:96', has: 'return <form onSubmit={(e) => void submit(e)} aria-label="New swarm co', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'features/swarm/SwarmDeleteDialog.tsx:343', has: '<form', why: 'no text field inside: submitted only by its own button (the delete dialog\'s confirmations)' },
  { at: 'features/swarm/SwarmDeleteDialog.tsx:366', has: '<form', why: 'no text field inside: submitted only by its own button (the delete dialog\'s confirmations)' },
  { at: 'features/swarm/SwarmServices.tsx:92', has: '<form onSubmit={add} className="flex flex-wrap items-center gap-2">', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'features/swarm/SwarmView.tsx:265', has: '<form onSubmit={add} className="mt-2.5 flex gap-1.5">', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'features/tasks/MotivationsPage.tsx:168', has: '<form onSubmit={submit} className="space-y-3" aria-label="New motivation"', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'features/usage/Limits.tsx:132', has: '<form', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'features/usage/Limits.tsx:172', has: '<form', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { at: 'forms/caseFile/Construct.tsx:429', has: '<form className="cfx-cmd" onSubmit={submit}>', why: 'app-owned form (not Surface\'s): its own command prompt; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },]

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir.replace(/\/$/, '')}/${e.name}`
    if (e.isDirectory()) sources(p, out)
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|testkit)\./.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}
const FILES: { file: string; lines: string[] }[] = sources(SRC).map((p) => ({ file: p.slice(SRC.length).replace(/^\//, ''), lines: fs.readFileSync(p, 'utf8').split('\n') }))
const lineOf = (at: string) => {
  const [file, n] = [at.slice(0, at.lastIndexOf(':')), Number(at.slice(at.lastIndexOf(':') + 1))]
  return FILES.find((f) => f.file === file)?.lines[n - 1]
}
const comment = (l: string) => /^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)

/** Every Enter line in the tree with no guardComposing on it or just above it. */
function unguardedEnter(): { at: string; text: string }[] {
  const out: { at: string; text: string }[] = []
  for (const { file, lines } of FILES)
    lines.forEach((l, i) => {
      if (comment(l) || !ENTER.test(l)) return
      if (lines.slice(Math.max(0, i - WINDOW), i + 1).some((x) => x.includes('guardComposing('))) return
      out.push({ at: `${file}:${i + 1}`, text: l.trim() })
    })
  return out
}
/** Every <form> whose onSubmit (within its opening 8 lines) is not inert. */
function activeForms(): { at: string; text: string }[] {
  const out: { at: string; text: string }[] = []
  for (const { file, lines } of FILES)
    lines.forEach((l, i) => {
      if (comment(l) || !l.includes('<form')) return
      if (INERT.test(lines.slice(i, i + 8).map((x) => x.trim()).join(' '))) return
      out.push({ at: `${file}:${i + 1}`, text: l.trim() })
    })
  return out
}

describe('r2.4: every Enter handler in hive/ui/src is guarded against an IME-confirming Enter, or allowed with a reason', () => {
  it('scans the whole tree (not a list of known composers)', () => {
    expect(FILES.length).toBeGreaterThan(500)
    expect(FILES.some((f) => f.file === 'experiences/construct/Panes.tsx')).toBe(true)
    expect(FILES.some((f) => f.file === 'features/messages/MessagesPage.tsx')).toBe(true)
  })
  it('no unguarded Enter handler outside the allowlist', () => {
    const allowed = new Set(ENTER_ALLOW.map((a) => a.at))
    const missing = unguardedEnter().filter((x) => !allowed.has(x.at))
    expect(missing, 'start the handler with `if (guardComposing(e)) return` (features/ask/keys), or allow it here with a reason').toEqual([])
  })
  it('every allowance is current: its line still acts on Enter unguarded, holds the recorded text, and has a reason', () => {
    const found = new Set(unguardedEnter().map((x) => x.at))
    for (const a of ENTER_ALLOW) {
      expect(found.has(a.at), `stale or now guarded: ${a.at}`).toBe(true)
      expect(lineOf(a.at)?.trim().startsWith(a.has), `moved or changed: ${a.at}`).toBe(true)
      expect(a.why.length, a.at).toBeGreaterThan(20)
      // the handler's guard: `if (guardComposing(e)) return`, or guardComposing(e) inside the condition of an early return
      if (a.guardAt) expect(lineOf(a.guardAt), `guard line ${a.guardAt}`).toMatch(/guardComposing\(e\)[^;]*\) return/)
    }
  })
})

describe('r2.4: no <form> submission sends or spends unless allowed with a reason', () => {
  it('no active <form onSubmit> outside the allowlist', () => {
    const allowed = new Set(FORM_ALLOW.map((a) => a.at))
    const missing = activeForms().filter((x) => !allowed.has(x.at))
    expect(missing, 'make it `onSubmit={(e) => e.preventDefault()}` with a button that acts on its own click, or allow it here with a reason').toEqual([])
  })
  it('every form allowance is current, with a reason', () => {
    const found = new Set(activeForms().map((x) => x.at))
    for (const a of FORM_ALLOW) {
      expect(found.has(a.at), `stale: ${a.at}`).toBe(true)
      expect(lineOf(a.at)?.trim().startsWith(a.has), `moved or changed: ${a.at}`).toBe(true)
      expect(a.why.length, a.at).toBeGreaterThan(20)
    }
  })
  it('the two Professional forms that wrap the Ask and a mind conversation are inert', () => {
    for (const f of ['experiences/professional/Ask.tsx', 'experiences/professional/Conversation.tsx']) {
      const src = FILES.find((x) => x.file === f)!.lines.join('\n')
      expect(src, f).toMatch(INERT)
      expect(src, f).not.toMatch(/type="submit"/)
    }
  })
})
