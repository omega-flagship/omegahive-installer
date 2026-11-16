// Purpose: audit Enter handlers and form submissions for composition-safe behavior.
import ts from 'typescript'
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
 *     in the 12 lines above it (the handler's first line), or be on ENTER_ALLOW with a reason. An entry may say `guard`
 *     when the handler is longer: the function holding that line must then check `guardComposing(e)` before it.
 *  2. Every `<form onSubmit>` must be inert (`onSubmit={(e) => e.preventDefault()}`: Enter is the field's own guarded
 *     key, and a button sends on its own click), or be on FORM_ALLOW with a reason (what it does, and why a confirming
 *     Enter cannot submit it: a textarea never submits implicitly; for an <input>, features/ask/keys.ts cancels a
 *     confirming Enter's default app-wide in the capture phase).
 *
 * Entries name the file and the statement they allow, by its text (an Enter line, trimmed; a form's opening tag, its first
 * eight lines joined), never by a line number, so an edit elsewhere in the file moves nothing and an open change needs
 * no rebase for it. An entry that no longer finds its statement, or finds more than its `count`, fails as stale, so a
 * change to the statement itself is re-read; a statement two entries both allow fails as ambiguous.
 */
const SRC = new URL('.', import.meta.url).pathname
const ENTER = /['"`](Numpad)?Enter['"`]|keyCode\s*===?\s*13\b|which\s*===?\s*13\b/
const INERT = /onSubmit=\{\(e\)\s*=>\s*e\.preventDefault\(\)\}/
const WINDOW = 12

/** file: relative to src; has: the statement allowed starts with it; count: how many such statements the file has (1 when
 *  left out); guard: the handler's own guardComposing(e) stands above the scan window, in the function holding it. */
interface Allow { file: string; has: string; why: string; count?: number; guard?: true }

const ENTER_ALLOW: Allow[] = [
  { file: 'experiences/canvas/Inspect.tsx', has: 'if (e.repeat && (e.key === \'Enter\' || e.key === \' \')) e.preventDefault', why: 'only cancels a held key (auto-repeat) on buttons; acts on nothing' },
  { file: 'experiences/canvas/index.tsx', has: 'case \'Enter\':', why: 'canvas keys: the handler returns while typing (isTyping), and Enter acts only on the canvas or body' },
  { file: 'experiences/canvas/parts.tsx', has: 'if (e.key === \'Enter\' || e.key === \' \') {', why: 'keyboard activation of non-text canvas controls (focus-visible buttons and nodes)' },
  { file: 'experiences/construct/CommandLine.tsx', has: 'if (k === \'Enter\') {', guard: true, why: 'the handler starts with guardComposing, beyond the scan window' },
  { file: 'experiences/construct/index.tsx', has: 'if ((k === \'Enter\' || k === \' \') && t?.closest(\'button, a[href], [role', why: 'pane keys: the handler returns while a text field is focused (typing check above it); never a text field' },
  { file: 'experiences/construct/index.tsx', has: 'if (k === \'Enter\' || k === \'o\') {', why: 'pane keys: the handler returns while a text field is focused (typing check above it); never a text field' },
  { file: 'experiences/construct/index.tsx', has: 'if ((k === \'a\' || ((k === \'Enter\' || k === \' \') && !t?.closest(\'button', why: 'pane keys: the handler returns while a text field is focused (typing check above it); never a text field' },
  { file: 'experiences/construct/index.tsx', has: 'if (c.focus === \'session\' && (k === \'Enter\' || k === \'i\')) {', why: 'pane keys: the handler returns while a text field is focused (typing check above it); never a text field' },
  { file: 'experiences/construct/index.tsx', has: 'if (k === \'Enter\' && c.focus === \'stream\') {', why: 'pane keys: the handler returns while a text field is focused (typing check above it); never a text field' },
  { file: 'experiences/still/Needs.tsx', has: 'if (!d && (e.key === \'Enter\' || e.key === \' \')) d = DIRS[(e.target as ', why: 'Enter/Space on a decision button ([data-dir]); the decision gate applies; no text field' },
  { file: 'experiences/still/Sheets.tsx', has: 'if (e.repeat && (e.key === \'Enter\' || e.key === \' \')) {', why: 'only cancels a held key (auto-repeat) on buttons; acts on nothing' },
  { file: 'features/ask/keys.ts', has: 'if (ev.key === \'Enter\' && !s.active) ev.preventDefault?.()', why: 'the guard itself (the capture listener cancelling a confirming Enter\'s default)' },
  { file: 'features/ask/useAskField.ts', has: '} else if (e.key === \'Enter\') {', guard: true, why: 'the handler starts with guardComposing, beyond the scan window' },
  { file: 'features/code/canvas/LanguageParts.tsx', has: '} else if (e.key === \'Enter\' || e.key === \'Tab\') {', why: 'the completions listbox (a focusable list, not a text field); Enter only opens a confirmation step' },
  { file: 'features/code/map/parts.tsx', has: 'if (e.key === \'Enter\' || e.key === \' \') {', why: 'a non-text element (svg node, chart point, role=button): no IME composition can target it' },
  { file: 'features/code/map/parts.tsx', has: '<g key={id} role="button" tabIndex={0} aria-label={`${label(id)}. Open', why: 'a non-text element (svg node, chart point, role=button): no IME composition can target it' },
  { file: 'features/code/suggestions/WorkbenchSuggestionPanel.tsx', has: 'if (e.repeat && (e.key === \'Enter\' || e.key === \' \')) e.preventDefault', count: 2, why: 'only cancels a held key (auto-repeat) on buttons; acts on nothing' },
  { file: 'features/lab/charts.tsx', has: 'onKeyDown={(e) => e.key === \'Enter\' && onPick?.(p.key)}', why: 'a non-text element (svg node, chart point, role=button): no IME composition can target it' },
  { file: 'features/swarm/Constellation.tsx', has: 'if (e.key === \'Enter\' || e.key === \' \') {', why: 'a non-text element (svg node, chart point, role=button): no IME composition can target it' },
  { file: 'forms/caseFile/Construct.tsx', has: 'if (e.key === \'Enter\' && current?.item) {', why: 'app-owned form (not Surface\'s); a non-text control (button, role=button, item), and the handler skips text fields' },
  { file: 'forms/caseFile/Still.tsx', has: 'if (e.key === \'Enter\' || e.key === \' \') {', why: 'app-owned form (not Surface\'s); a non-text control (button, role=button, item), and the handler skips text fields' },
  { file: 'forms/caseFile/parts.tsx', has: 'if (e.key !== \'Enter\' && e.key !== \' \') return', why: 'app-owned form (not Surface\'s); a non-text control (button, role=button, item), and the handler skips text fields' },
  { file: 'forms/designCanvas/Stage.tsx', has: 'if ((e.key === \'Enter\' || e.key === \' \') && elId) {', why: 'element selection on the design stage (a non-text element); the stage\'s text editor is guarded' },
  { file: 'forms/lifeMap/Classic.tsx', has: 'if (e.key === \'Enter\' || e.key === \' \') {', why: 'app-owned form (not Surface\'s); a non-text control (button, role=button, item), and the handler skips text fields' },
  { file: 'forms/lifeMap/consent.ts', has: 'if (g.phase !== \'open\' || e.repeat || (e.key !== \'Enter\' && e.key !== ', why: 'app-owned form (not Surface\'s); a non-text control (button, role=button, item), and the handler skips text fields' },
  { file: 'forms/lifeMap/parts.tsx', has: 'if (e.repeat && (e.key === \'Enter\' || e.key === \' \')) {', why: 'app-owned form; only cancels a held key (auto-repeat) on buttons; acts on nothing' },
  { file: 'features/ask/AnswererPicker.tsx', has: '} else if (e.key === \'Enter\' && choices[active]) {', why: 'the who-answers listbox (role=listbox, a focusable list, not a text field): no IME composition can target it' },
  { file: 'features/programs/PersonSwarmConsent.tsx', has: 'if ((event.key === \'Enter\' || event.key === \' \') && (event.repeat', why: 'the consent buttons: only cancels a held or too-early Enter/Space (the acceptance gate); acts on nothing' },
  { file: 'ui/DecisionDialog.tsx', has: 'if (e.repeat && (e.key === \'Enter\' || e.key === \' \')) e.preventDefault', why: 'only cancels a held key (auto-repeat) on buttons; acts on nothing' },
]

const FORM_ALLOW: Allow[] = [
  { file: 'screens/Screen.tsx', has: '<form onSubmit={submit} className="space-y-1.5">', why: 'keyfield block: sends a pasted provider key to the hive to verify and store (a hive record, not a paid send); Enter or the button is the explicit submit; empty/busy refused; IME Enter cancelled app-wide (keys.ts)' },
  { file: 'screens/Screen.tsx', has: '<form onSubmit={submit} className="flex min-w-0 flex-1 gap-1.5">', why: 'rename block: renames a hive record (a key, say; not a paid send); Enter is the person\'s explicit submit, and the page changes nothing when the name is blank or the same; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'experiences/construct/Panes.tsx', has: '<form', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'experiences/cosmos/Deck.tsx', has: '<form', count: 2, why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'experiences/cosmos/Panels.tsx', has: '<form', why: 'sends to a mind, from a textarea: a textarea never submits implicitly; the only submission is the Send button\'s own click' },
  { file: 'experiences/flux/panels.tsx', has: '<form className="mt-3', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'experiences/flux/panels.tsx', has: '<form className="px-4 pb-4" onSubmit={(e) => { e.preventDefault(); sen', why: 'sends to a mind, from a textarea: a textarea never submits implicitly; the only submission is the Send button\'s own click' },
  { file: 'experiences/flux/sheets.tsx', has: '<form', count: 2, why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'experiences/still/Sheets.tsx', has: '<form', count: 2, why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'features/approvals/PolicyEditor.tsx', has: '<form onSubmit={submit} className="space-y-3">', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'features/code/CodePage.tsx', has: '<form', why: 'starts a code run (an explicit, labelled Run; not an Ask spend); plain Enter is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'features/code/FileActions.tsx', has: '{mode && <form className="space-y-2" onSubmit={(e) => { e.preventDefau', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'features/code/LiveWork.tsx', has: '<form className="mt-2.5', why: 'navigates or filters (no write, no spend)' },
  { file: 'features/code/LiveWork.tsx', has: '<form className="grid gap-2 rounded-xl border border-line p-3 md:grid-', why: 'navigates or filters (no write, no spend)' },
  { file: 'features/code/canvas/CodeCanvas.tsx', has: '<form className="cc-say"', why: 'the empty canvas\'s one-line request field (SayFirst): it opens the named file or the chooser, and the request goes out once a file is open; plain Enter or Go is the person\'s explicit submit, empty/busy refused; an IME-confirming Enter is cancelled app-wide at capture (keys.ts) and the field starts with guardComposing' },
  { file: 'features/code/canvas/CodeCanvas.tsx', has: '<form className={cx(\'cc-prompt\',', why: 'asks a mind to change code, from a textarea: no implicit submission; the only submission is the Propose button\'s own click' },
  { file: 'features/code/canvas/work/WorkStream.tsx', has: '<form', why: 'the work stream\'s one-line Ask for changes note: plain Enter or Ask again is the person\'s explicit submit (an empty or over-long note is refused with a hint, a busy decision waits); an IME-confirming Enter is cancelled app-wide at capture (keys.ts) and the field starts with guardComposing' },
  { file: 'features/code/canvas/IterationsDrawer.tsx', has: '<form', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'features/code/canvas/LanguageParts.tsx', has: '<form', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'features/dot/Chat.tsx', has: '<form', why: 'sends to a mind, from a textarea: a textarea never submits implicitly; the only submission is the Send button\'s own click' },
  { file: 'features/dot/Schedule.tsx', has: '<form onSubmit={submit} className="mb-3 space-y-3 rounded-2xl border b', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'features/goals/GoalsBoard.tsx', has: '<form onSubmit={submit} data-tour="goals-add" className="mb-3 flex fle', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'features/goals/GoalsBoard.tsx', has: '<form onSubmit={async', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'features/keys/AskMemorySection.tsx', has: '<form', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'features/settings/GoogleConnectorSettings.tsx', has: '<form className="mt-3 space-y-3" onSubmit={(e) => void save(e)}>', why: 'saves the admins\' Google client configuration (a hive record, not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'features/ownKey/OwnKeySheet.tsx', has: '<form className="ok-sheet" data-own-key-sheet={state.phase} onSubmit={(e', why: 'own-key sheet: saves the person\'s own provider key and monthly limit (hive records), then retries the one ask or review they already sent and that was refused for want of a key (the button says so: "Add key and ask"), paid from their own key within the limit they just set; Enter in the key or limit field is the person\'s explicit submit, the same as the button; an empty key or limit is refused, a second submit while saving is ignored, and a total set meanwhile is never overwritten without fresh consent (addOwnKey.ts); an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'features/keys/AddKeyForm.tsx', has: '<form onSubmit={submit} data-unsaved-scope="add-key" className="mb-5 r', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'features/keys/OwnMonthlyLimit.tsx', has: '<form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={save}>', why: 'r1.14b: saves the person\'s own-key monthly total (a hive record, not a paid send); Enter or Save is the person\'s explicit submit; the amount is validated first and an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'features/people/PeopleForms.tsx', has: '<form onSubmit={submit} className="rounded-2xl border border-line bg-t', why: 'creates an invitation (a hive record, not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'features/people/PeopleForms.tsx', has: '<form onSubmit={submit} aria-label="Add a member"', why: 'adds a member with a hive-made password (a hive record, not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'features/requestExperience/RequestPanel.tsx', has: '<form', why: 'one-line request field: plain Enter is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'features/settings/AskAudit.tsx', has: '<form', why: 'navigates or filters (no write, no spend)' },
  { file: 'features/swarm/SwarmConnections.tsx', has: 'return <form onSubmit={(e) => void submit(e)} aria-label="New swarm co', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'features/swarm/SwarmDeleteDialog.tsx', has: '<form', count: 2, why: 'no text field inside: submitted only by its own button (the delete dialog\'s confirmations)' },
  { file: 'features/swarm/SwarmServices.tsx', has: '<form onSubmit={add} className="flex flex-wrap items-center gap-2">', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'features/swarm/SwarmView.tsx', has: '<form onSubmit={add} className="mt-2.5 flex gap-1.5">', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'features/tasks/MotivationsPage.tsx', has: '<form onSubmit={submit} className="space-y-3" aria-label="New motivation"', why: 'creates, saves or renames a hive record (not a paid send); Enter or the button is the person\'s explicit submit; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
  { file: 'forms/caseFile/Construct.tsx', has: '<form className="cfx-cmd" onSubmit={submit}>', why: 'app-owned form (not Surface\'s): its own command prompt; an IME-confirming Enter is cancelled app-wide at capture (keys.ts)' },
]

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir.replace(/\/$/, '')}/${e.name}`
    if (e.isDirectory()) sources(p, out)
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|testkit)\./.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}
const FILES: { file: string; lines: string[] }[] = sources(SRC).map((p) => ({ file: p.slice(SRC.length).replace(/^\//, ''), lines: fs.readFileSync(p, 'utf8').split('\n') }))
const comment = (l: string) => /^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)

interface Hit { file: string; line: number; text: string }
/** Every Enter line in the tree with no guardComposing on it or just above it: its file, line and trimmed text. */
function unguardedEnter(): Hit[] {
  const out: Hit[] = []
  for (const { file, lines } of FILES)
    lines.forEach((l, i) => {
      if (comment(l) || !ENTER.test(l) || lines.slice(Math.max(0, i - WINDOW), i + 1).some((x) => x.includes('guardComposing('))) return
      out.push({ file, line: i + 1, text: l.trim() })
    })
  return out
}
/** Every <form> whose onSubmit (within its opening 8 lines) is not inert: its file, line and opening tag, those lines joined. */
function activeForms(): Hit[] {
  const out: Hit[] = []
  for (const { file, lines } of FILES)
    lines.forEach((l, i) => {
      const tag = lines.slice(i, i + 8).map((x) => x.trim()).join(' ')
      if (comment(l) || !l.includes('<form') || INERT.test(tag)) return
      out.push({ file, line: i + 1, text: tag })
    })
  return out
}
const where = (h: Hit) => `${h.file}:${h.line} ${h.text.slice(0, 90)}`
/** The allowances naming this statement: the same file, and its text starting with theirs. */
const allowing = (list: Allow[], h: Hit) => list.filter((a) => a.file === h.file && h.text.startsWith(a.has))
/** The statements an allowance names. */
const named = (hits: Hit[], a: Allow) => hits.filter((h) => h.file === a.file && h.text.startsWith(a.has))

/** Whether the function holding this line (its innermost one) checks `guardComposing(e)` with an early return before it. */
function guardedHandler(h: Hit): boolean {
  const text = FILES.find((f) => f.file === h.file)!.lines.join('\n')
  const sf = ts.createSourceFile(h.file, text, ts.ScriptTarget.Latest, true, h.file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const at = sf.getPositionOfLineAndCharacter(h.line - 1, 0)
  let holder: ts.Node | undefined
  const visit = (n: ts.Node) => {
    if (n.getStart(sf) > at || at >= n.end) return
    if (ts.isFunctionLike(n)) holder = n
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return !!holder && /guardComposing\(e\)[^;]*\) return/.test(text.slice(holder.getStart(sf), at))
}

describe('r2.4: every Enter handler in hive/ui/src is guarded against an IME-confirming Enter, or allowed with a reason', () => {
  it('scans the whole tree (not a list of known composers)', () => {
    expect(FILES.length).toBeGreaterThan(500)
    expect(FILES.some((f) => f.file === 'experiences/construct/Panes.tsx')).toBe(true)
    expect(FILES.some((f) => f.file === 'features/messages/MessagesPage.tsx')).toBe(true)
  })
  it('no unguarded Enter handler outside the allowlist, and none allowed twice', () => {
    const hits = unguardedEnter()
    const missing = hits.filter((h) => !allowing(ENTER_ALLOW, h).length).map(where)
    expect(missing, 'start the handler with `if (guardComposing(e)) return` (features/ask/keys), or allow it here with a reason').toEqual([])
    expect(hits.filter((h) => allowing(ENTER_ALLOW, h).length > 1).map(where), 'make one `has` longer').toEqual([])
  })
  it('every allowance is current: it names as many unguarded Enter lines as it says, with a reason, and a long handler keeps its guard', () => {
    const hits = unguardedEnter()
    for (const a of ENTER_ALLOW) {
      const mine = named(hits, a)
      expect(mine.length, `stale, now guarded, or more than counted: ${a.file} ${a.has}`).toBe(a.count ?? 1)
      expect(a.why.length, a.file).toBeGreaterThan(20)
      // the handler's guard: `if (guardComposing(e)) return`, or guardComposing(e) inside the condition of an early return
      if (a.guard) for (const h of mine) expect(guardedHandler(h), `guard gone from the handler at ${where(h)}`).toBe(true)
    }
  })
  it('the long-handler check reads the handler, not a line: it fails once the guard is gone', () => {
    const h = unguardedEnter().find((x) => x.file === 'features/ask/useAskField.ts')!
    expect(guardedHandler(h)).toBe(true)
    const file = FILES.find((f) => f.file === h.file)!
    const lines = file.lines
    try {
      file.lines = lines.map((l) => l.replace(/guardComposing\(e\)/g, 'false'))
      expect(guardedHandler(h)).toBe(false)
    } finally {
      file.lines = lines
    }
  })
})

describe('r2.4: no <form> submission sends or spends unless allowed with a reason', () => {
  it('no active <form onSubmit> outside the allowlist, and none allowed twice', () => {
    const hits = activeForms()
    const missing = hits.filter((h) => !allowing(FORM_ALLOW, h).length).map(where)
    expect(missing, 'make it `onSubmit={(e) => e.preventDefault()}` with a button that acts on its own click, or allow it here with a reason').toEqual([])
    expect(hits.filter((h) => allowing(FORM_ALLOW, h).length > 1).map(where), 'make one `has` longer').toEqual([])
  })
  it('every form allowance is current, with a reason', () => {
    const hits = activeForms()
    for (const a of FORM_ALLOW) {
      expect(named(hits, a).length, `stale or more than counted: ${a.file} ${a.has}`).toBe(a.count ?? 1)
      expect(a.why.length, a.file).toBeGreaterThan(20)
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
