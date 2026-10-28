import { describe, expect, it, vi } from 'vitest'

/**
 * ASK-1 (UNIVERSAL_ASK_DESIGN §6), review-blocking: the universal Ask is present and safe in every UI. This file fails
 * the build when an experience has no Ask skin entry, when AskHost leaves the shell's single mount outside the route
 * switch, when the fast path could construct an app act, or when the Ask's keyboard and screen-reader contract
 * regresses. Phase 1 shipped Classic and Still; phase 2 brings Cosmos (transmission console), Flux (liquid capsule),
 * Construct (the prompt is the Ask) and Canvas (the note card): every experience has its Ask. The app frame and form
 * items are tracked below until their phase lands.
 */
vi.mock('../shell/uiVariant', async (orig) => ({ ...(await orig<typeof import('../shell/uiVariant')>()), openGallery: () => undefined }))
vi.mock('../tour/introStore', () => ({ useIntro: { getState: () => ({ setHelp: () => undefined }) } }))

const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string; readdirSync: (p: string, o?: { recursive?: boolean }) => string[]; writeFileSync: (p: string, d: string) => void }
const SRC = new URL('..', import.meta.url).pathname
const read = (p: string) => fs.readFileSync(`${SRC}${p}`, 'utf8')
const filesUnder = (dir: string) => (fs.readdirSync(`${SRC}${dir}`, { recursive: true }) as string[]).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f)).map((f) => `${dir}/${f}`)

const { ALL_EXPERIENCES } = await import('./registry')
const { FEATURES } = await import('../features/registry')
const { coverageReport } = await import('./coverage')
const { targetFor } = await import('./targets')
const { resolve, decide } = await import('../lib/intent')
const { ASK_SKINS } = await import('../features/ask/AskHost')
const { placeAsk, askMode, OMEGA_CLEAR, liftClear, placeInExperience, ASK_HEIGHT, LIFT_MAX_SHARE, ASK_PHONE_MIN, CLOCK_ROW } = await import('../features/ask/placement')
const { SKIN_WORDS, floatingLook } = await import('../features/ask/skins')
const { presenceCommand, arcPath } = await import('../features/ask/Presence')
const { resolvePresence } = await import('../lib/presence')
const { isCommandText, COMMANDS } = await import('./construct/commands')
const { fitView, VIEW_MAX_BYTES } = await import('../features/ask/view')
const { shownMind, threadLabel, REFUSAL_WORDS } = await import('../features/ask/words')
const { REFUSAL_REASONS } = await import('../api/ask')

describe('ASK-1.1: every experience has the Ask', () => {
  it('every experience in the tree has an Ask skin (Classic, Still, Cosmos, Flux, Construct, Canvas); none is left to come', () => {
    for (const e of ALL_EXPERIENCES) expect(ASK_SKINS[e.id], e.id).toBeDefined()
    expect(ASK_SKINS.classic).toBe('capsule')
    expect(ASK_SKINS.still).toBe('still-line')
    expect(ASK_SKINS.cosmos).toBe('transmission')
    expect(ASK_SKINS.flux).toBe('liquid')
    expect(ASK_SKINS.construct).toBe('command-line')
    expect(ASK_SKINS.canvas).toBe('note')
    expect(Object.entries(ASK_SKINS).filter(([, v]) => v === 'phase-2').map(([k]) => k)).toEqual([])
    for (const e of ALL_EXPERIENCES) expect(ASK_SKINS[e.id], e.id).not.toBe('phase-2')
  })
  it('AskHost is mounted ONCE in App.tsx, outside the route switch, so every classic page and app route has it', () => {
    const app = read('App.tsx')
    expect(app.match(/<AskHost\b/g)).toHaveLength(1)
    const at = app.indexOf('<AskHost')
    const before = app.slice(0, at)
    // not inside any route-conditional block: every <AnimatePresence> opened before it is closed before it
    expect((before.match(/<AnimatePresence/g) ?? []).length).toBe((before.match(/<\/AnimatePresence>/g) ?? []).length)
    expect(app.slice(Math.max(0, at - 200), at)).not.toMatch(/route\.name ===/)
  })
  it('Still keeps its question box as the heart: it runs on the shared engine (lifted, not forked)', () => {
    expect(read('experiences/still/intent.ts')).toMatch(/export \* from '..\/..\/lib\/intent\/understand'/)
    expect(read('experiences/still/Ask.tsx')).toMatch(/useAskField\(/)
  })
  it('tracked for phase 2 (the design §5): the app-frame host lane and form vocabularies/exportView', () => {
    // Phase 1: an app route (#/program) is covered by the single App-level mount; AppFrame's own lane comes in phase 2.
    const pending = { appFrameLane: !read('features/programs/AppFrame.tsx').includes('AskHost'), formExportView: !read('forms/contract.ts').includes('exportView') }
    expect(pending).toEqual({ appFrameLane: true, formExportView: true }) // flip these when phase 2 lands; the test then demands them
  })
})

describe('ASK-1.2: one engine (lib/intent), vocabulary only', () => {
  it('no experience forks the engine: only lib/intent defines resolve/understand', () => {
    const offenders: string[] = []
    for (const f of filesUnder('experiences')) if (/export function (understand|resolve)\b/.test(read(f))) offenders.push(f)
    expect(offenders).toEqual([])
  })
})

describe('the announcer is hidden for sight and read aloud (Kimi r3 #3)', () => {
  it('index.css carries a global .sr-only rule (not only a form’s scoped one), and the announcer uses it', () => {
    const css = read('index.css')
    expect(css).toMatch(/\/\* screen-reader-only text \(global\) \*\/\n\.sr-only \{ position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect\(0, 0, 0, 0\); white-space: nowrap; border: 0; \}\s*$/)
    expect(read('features/ask/VoiceParts.tsx')).toMatch(/className="sr-only" role="status" aria-live="assertive"/)
  })
})

describe('voice: words only (the opt-in sentence\'s promise, enforced: Kimi 8)', () => {
  it('no Ask file opens a microphone stream, records, or processes audio; voice files make no request of their own', () => {
    const offenders: string[] = []
    for (const f of [...filesUnder('lib/intent'), ...filesUnder('features/ask')]) {
      if (f.endsWith('.test.ts')) continue
      const src = read(f)
      if (/getUserMedia|MediaRecorder|AudioContext|createMediaStreamSource|AudioWorklet/.test(src)) offenders.push(`${f}: audio API`)
      if (/voice|Voice/.test(f) && /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/.test(src)) offenders.push(`${f}: a request`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})

describe('ASK-1.6: no path from the Ask to an app act except action-needs-confirm → DecisionDialog → confirm', () => {
  const askFiles = [...filesUnder('lib/intent'), ...filesUnder('features/ask')]
  it('the fast path and the Ask components never call an app or a client action directly', () => {
    const offenders: string[] = []
    for (const f of askFiles) {
      const src = read(f)
      // the client calls the Ask components make. Reads: me() (who is signed in), and Earlier's owner-scoped GET /api/ask
      // and GET /api/ask/{op} (my own kept turns; missing-UI batch 1). Not a read: client.askActResult() is a POST, the
      // conductor's bounded report of what an on-screen act did (conductor vocabulary v1 §2), an existing reporting
      // exception, not batch authority (stand-in r3 item 4). Nothing else, and never an action; confirmAct only from the dialog
      if (/\bprogramAct\b|\.act\(|person_act|kind:\s*'app_act'|askConfirm\s*\(|client\.(?!me\b|askActResult\b|askHistory\b|askTurn\b)\w+\(/.test(src)) offenders.push(f)
      const confirms = src.match(/confirmAct\(\)/g) ?? []
      if (confirms.length && !(f.endsWith('AskHost.tsx') && confirms.length === 1 && /actions=\{\[\{ label: 'Confirm'[^\]]*confirmAct\(\)/.test(src))) offenders.push(`${f}: confirmAct outside the DecisionDialog`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
  it('the conductor’s only call to the hive is the act-result report, and its acts are on-screen only', () => {
    const src = read('features/ask/conductor.ts')
    expect([...src.matchAll(/client\??\.(\w+)\??\.?\(/g)].map((m) => m[1])).toEqual(['askActResult'])
    expect(src).not.toMatch(/sendMessage|createGoal|agentAction|askConfirm|confirmAct|programAct|\.submit\(|requestSubmit|dispatchEvent/)
  })
    it('the intent act union has no app act', () => {
    const types = read('lib/intent/types.ts')
    const union = types.slice(types.indexOf('export type IntentAct'), types.indexOf('/** A chip'))
    expect(union).not.toMatch(/app|program|act'/i)
  })
  it('the store confirms only the proposal the DecisionDialog showed, by its id and digest, in one place', () => {
    const store = read('store/ask.ts')
    expect(store.match(/askConfirm\(/g)).toHaveLength(1)
    expect(store).toMatch(/askConfirm\(c\.op, c\.proposal\.id, c\.proposal\.digest\)/)
    expect(read('features/ask/AskHost.tsx')).toMatch(/<DecisionDialog/)
  })
  it('no typed words resolve to anything that acts in an app', () => {
    for (const t of ['save a note in design', 'approve everything', 'delete all goals', 'act save_note']) {
      const cs = resolve(t, { experience: 'classic' }, { minds: [], swarms: [], pending: 0 })
      for (const c of cs) expect(['route', 'feature', 'scoped', 'look', 'search', 'scroll', 'gallery', 'mind', undefined]).toContain(c.act?.do)
      expect(['mind', 'none', 'choose', 'run', 'open-decision', 'limit']).toContain(decide(cs, { orchestrator: true }).kind)
    }
  })
  it('live never sends confirm, which is ahead of the host: the live client lacks it', () => {
    const live = read('api/live.ts')
    // steer is on the host and sent (api/liveAsk.test.ts); takeover is Platform's own patch with its own test
    expect(live).not.toMatch(/askConfirm\s*=/)
  })
  it('r3 (Kimi #4): the live client has no confirm at run time, however it might be added', async () => {
    const { LiveClient } = await import('../api/live')
    const c = new LiveClient('https://hive.invalid') as unknown as Record<string, unknown>
    expect(c.askConfirm).toBeUndefined()
    expect('askConfirm' in c).toBe(false)
    expect('askConfirm' in Object.getPrototypeOf(c)).toBe(false)
  })
  it('live sends the takeover to the host, so the turn stops there and not only on the page', () => {
    const live = read('api/live.ts')
    expect(live).toMatch(/askTakeover = \(op: string\) => this\.askRequest<[^>]*>\('POST', `\/api\/ask\/\$\{enc\(op\)\}\/takeover`, \{ reason: 'user_took_over' \}\)/)
  })
})

describe('ASK-1.5: keyboard, screen reader, reduced motion', () => {
  const host = read('features/ask/AskHost.tsx')
  const classic = read('features/ask/ClassicAsk.tsx')
  const thread = read('features/ask/Thread.tsx')
  const css = read('features/ask/ask.css')
  it('⌘K, Ctrl+K and / summon the Ask; a Jump to Ask link; the Ask is a landmark', () => {
    // the summon rule lives in features/ask/summon.ts (behaviour tested in summon.test.ts); the host binds it in capture
    const summon = read('features/ask/summon.ts')
    expect(summon).toMatch(/\(e\.metaKey \|\| e\.ctrlKey\) && k === 'k'/)
    expect(summon).toMatch(/e\.key === '\/'/)
    expect(host).toMatch(/handleAskKey\(e, \{/)
    expect(summon).toMatch(/export function handleAskKey/)
    expect(host).toMatch(/window\.addEventListener\('keydown', onKey, true\)/)
    expect(host).toMatch(/Jump to Ask/)
    expect(host).toMatch(/<section aria-label="Ask"/)
  })
  it('combobox over a listbox whose options are named by their preview sentence; the thread is a polite log', () => {
    expect(classic).toMatch(/role="combobox"/)
    expect(classic).toMatch(/role="listbox"/)
    // named by the preview sentence; a paid row adds who pays after it (j0-fixes r1), never instead of it
    expect(classic).toMatch(/aria-label=\{(?:c\.pays \? `\$\{sentence\(c\)\}\. \$\{c\.pays\}` : )?sentence\(c\)\}/)
    expect(thread).toMatch(/role="log"\s+aria-live="polite"/)
  })
  it('listening is announced assertively with its voice layer named, the mic carries aria-pressed; Esc steps back', () => {
    const parts = read('features/ask/VoiceParts.tsx')
    expect(parts).toMatch(/aria-live="assertive"/)
    expect(parts).toMatch(/v\.layerWords/)
    expect(read('features/ask/useAskVoice.ts')).toMatch(/'aria-pressed': listening/)
    // every skin with a field mounts the voice: the announcer, the listening line and the mic's own handlers
    for (const skin of [classic, read('features/ask/StillLine.tsx'), read('experiences/still/Ask.tsx')]) {
      expect(skin).toMatch(/useAskVoice\(/)
      expect(skin).toMatch(/<VoiceAnnouncer v=\{v\} \/>/)
      expect(skin).toMatch(/<VoiceListening v=\{v\}/)
      expect(skin).toMatch(/\{\.\.\.v\.button\}/)
      expect(skin).toMatch(/v\.onFieldKey\(e\)/)
    }
    expect(read('features/ask/useAskField.ts')).toMatch(/Esc steps back/)
  })
  it('reduced motion: no drifting, spinning or gliding; and the look’s own motion: none', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
    expect(css).toMatch(/html\[data-ui-motion='none'\]/)
  })
  it('z-order: the Ask (55) under toasts (70) and the DecisionDialog (60); Ω stays above (80)', () => {
    expect(css).toMatch(/\.ask-root \{[^}]*z-index: 55/)
  })
})

describe('placement: clear of Ω and the safe areas, on every screen', () => {
  it('desktop: bottom centre, at most 640 wide; dock layout lifts above the dock', () => {
    const p = placeAsk({ width: 1440, height: 900, layout: 'rail', page: false, tabBar: false, omegaRight: null })
    expect(p).toMatchObject({ mode: 'desktop', width: 640 })
    expect(p.left).toBe((1440 - 640) / 2)
    expect(placeAsk({ width: 1440, height: 900, layout: 'dock', page: false, tabBar: false, omegaRight: null }).bottom).toBeGreaterThan(80)
  })
  it('Ω on screen: the Ask starts right of its area', () => {
    for (const w of [1440, 390, 360]) {
      const p = placeAsk({ width: w, height: 800, layout: 'rail', page: false, tabBar: false, omegaRight: 60 })
      // on Ω's row it starts right of Ω; a phone too narrow for that rises above the row instead (audit P1 #1)
      if (p.bottom < CLOCK_ROW) expect(p.left, String(w)).toBeGreaterThanOrEqual(60 + OMEGA_CLEAR)
      else expect(p.width, String(w)).toBe(w - 20)
      expect(p.left + p.width, String(w)).toBeLessThanOrEqual(w)
    }
  })
  it('audit P1 #1: on a phone, an Ask squeezed between Ω and the clock rises above their row at full width', () => {
    // an app page or mind sheet (no tab bar), Still, Professional: Ω at the left, the clock at the right of one row
    const tight = placeAsk({ width: 390, height: 844, layout: 'rail', page: true, tabBar: false, omegaRight: 91, clockLeft: 312 })
    expect(tight.bottom).toBeGreaterThanOrEqual(12 + 36 + 8)
    expect(tight.left).toBe(10)
    expect(tight.width).toBe(370)
    expect(tight.width).toBeGreaterThanOrEqual(ASK_PHONE_MIN)
    // room enough on the row (no Ω): it stays on the row, ending before the clock
    const roomy = placeAsk({ width: 390, height: 844, layout: 'rail', page: true, tabBar: false, omegaRight: null, clockLeft: 330 })
    expect(roomy.bottom).toBeLessThan(20)
    expect(roomy.left + roomy.width).toBeLessThanOrEqual(330 - OMEGA_CLEAR)
    // desktop is unchanged: never lifted for width
    expect(placeAsk({ width: 1440, height: 900, layout: 'rail', page: true, tabBar: false, omegaRight: 91, clockLeft: 1300 }).bottom).toBeLessThan(20)
  })
  it('phone: above the tab bar on the hive and on the pages it stays over, at the bottom without it; landscape 844×390: a compact capsule in the left half', () => {
    expect(placeAsk({ width: 390, height: 844, layout: 'rail', page: false, tabBar: true, omegaRight: null }).bottom).toBeGreaterThanOrEqual(70)
    expect(placeAsk({ width: 390, height: 844, layout: 'rail', page: true, tabBar: true, omegaRight: null }).bottom).toBeGreaterThanOrEqual(70)
    expect(placeAsk({ width: 390, height: 844, layout: 'rail', page: true, tabBar: false, omegaRight: null }).bottom).toBeLessThan(20)
    // the classic rail on screen (desktop, or a landscape phone): the Ask starts right of it, never over it
    expect(placeAsk({ width: 844, height: 390, layout: 'rail', page: false, tabBar: false, omegaRight: null, railX: 84 }).left).toBeGreaterThanOrEqual(84)
    expect(placeAsk({ width: 1024, height: 768, layout: 'rail', page: false, tabBar: false, omegaRight: null, railX: 232 }).left).toBeGreaterThanOrEqual(232)
    expect(askMode(844, 390)).toBe('landscape')
    // Kimi K3 follow-up (9593fd1) P2-3: centred in the content area right of the rail, not over the full viewport
    const r = placeAsk({ width: 1024, height: 768, layout: 'rail', page: false, tabBar: false, omegaRight: null, railX: 232 })
    expect(r.width).toBe(640)
    expect(r.left).toBe(232 + (1024 - 232 - 640) / 2)
    expect(r.left - 232).toBe(1024 - (r.left + r.width))
    const wide = placeAsk({ width: 1440, height: 900, layout: 'rail', page: true, tabBar: false, omegaRight: null, railX: 84 })
    expect(wide.left - 84).toBe(1440 - (wide.left + wide.width))
    // no rail on screen: centred over the whole width, as before
    const none = placeAsk({ width: 1440, height: 900, layout: 'topbar', page: false, tabBar: false, omegaRight: null })
    expect(none.left).toBe((1440 - 640) / 2)
    const l = placeAsk({ width: 844, height: 390, layout: 'rail', page: true, tabBar: false, omegaRight: 60 })
    expect(l.left + l.width).toBeLessThanOrEqual(844 / 2)
  })
})

describe('the view export (context.view) and the words', () => {
  it('fits the built host: refs {kind, ref} only, ≤ 50, ≤ 2 KB; private apps send nothing (Platform r2 Q6)', () => {
    const big = { title: 'Goals', summary: 's'.repeat(900), refs: Array.from({ length: 80 }, (_, i) => ({ kind: 'goal' as const, ref: `g_${'x'.repeat(40)}${i}`, label: 'secret label' })), acts: ['a'] }
    const v = fitView(big)
    expect(new TextEncoder().encode(JSON.stringify(v)).length).toBeLessThanOrEqual(VIEW_MAX_BYTES)
    expect(JSON.stringify(v)).not.toContain('secret label')
    expect(v.summary!.length).toBeLessThanOrEqual(500)
    const p = fitView(big, { privateApp: true })
    expect(p).toEqual({})
  })
  it('the answering mind is never presented as Omega; threads read "<coordinator> about <mind>"', () => {
    expect(shownMind('Omega')).toBe('the orchestrator')
    expect(shownMind(' omega ')).toBe('the orchestrator')
    expect(threadLabel('Vega', 'Altair')).toBe('Vega about Altair')
  })
  it('every refusal in the closed set has the page’s own sentence', () => {
    for (const r of REFUSAL_REASONS) expect(REFUSAL_WORDS[r]?.say, r).toMatch(/\w/)
  })
})

describe('the coverage report gains an Ask column', () => {
  it('every feature is reached by words in classic, still, cosmos, flux, construct and canvas; the report says so', async () => {
    const scoped = Object.fromEntries(FEATURES.map((f) => [f.id, targetFor(f)?.kind] as const).filter((x): x is [string, 'mind' | 'swarm'] => x[1] === 'mind' || x[1] === 'swarm'))
    const world = { minds: [{ id: 'a_vega01', name: 'Vega', awake: true, swarm: 'Lyra' }], swarms: [{ id: 's_lyra', name: 'Lyra' }], pending: 0 }
    const reached = new Set(
      FEATURES.filter((f) =>
        ['classic', 'still', 'cosmos', 'flux', 'construct', 'canvas'].every((scope) =>
          [`open ${f.label.toLowerCase()}`, f.label].some((u) =>
            resolve(u, { experience: scope }, world, scoped).some((c) => (c.act && 'id' in c.act && c.act.id === f.id) || c.key.startsWith(`route-${f.id}-`) || !!c.clarify?.chips.some((ch) => ch.act && 'id' in ch.act && ch.act.id === f.id)),
          ),
        ),
      ).map((f) => f.id),
    )
    const ids = ALL_EXPERIENCES.filter((e) => e.id !== 'classic').map((e) => e.id)
    const skins = Object.fromEntries(Object.entries(ASK_SKINS).map(([k, v]) => [k, v === 'phase-2' ? '◌ phase 2' : `● ${v}`]))
    const md = coverageReport(ids, { reached, skins })
    expect(md).toContain('| Ask |')
    expect(md).not.toContain('✕ not by words')
    const out = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.COVERAGE_REPORT_ASK
    if (out) fs.writeFileSync(out, `# Experience coverage, with the Ask column (ASK-1)\n\n${md}`)
  })
})

describe('ASK-1 phase 2: Cosmos, Flux and Construct, each in its own grammar, on the one store', () => {
  const host = read('features/ask/AskHost.tsx')
  const floating = read('features/ask/ClassicAsk.tsx')
  const cmdLine = read('experiences/construct/CommandLine.tsx')
  const css = read('features/ask/ask.css')
  const ccss = read('experiences/construct/construct.css')

  it('every skin is the shared hook and store: no skin forks the Ask (one useAskField; nothing but the store sends)', () => {
    expect(floating).toMatch(/useAskField\(\{ experience \}\)/)
    // uifix-r2.2: Construct's `ask <words>` rides the same hook (forcedAsk), never a send of its own
    expect(cmdLine).toMatch(/useAskField\(\{ experience: 'construct', forcedAsk, onDispatch: echoDispatch \}\)/)
    for (const src of [floating, cmdLine]) {
      expect(src).not.toMatch(/askSend|client\.ask|\.ask\(/)
      expect(src).not.toMatch(/create<|zustand/)
    }
  })
  it('the floating looks: Cosmos’s transmission console, Flux’s liquid capsule, Construct’s terminal line over a page', () => {
    expect(floatingLook('transmission')).toBe('transmission')
    expect(floatingLook('liquid')).toBe('liquid')
    expect(floatingLook('command-line')).toBe('terminal')
    expect(floatingLook('note')).toBe('note')
    expect(floatingLook('still-line')).toBeNull()
    for (const [look, w] of Object.entries(SKIN_WORDS)) {
      expect(w.placeholder, look).toMatch(/\w/)
      expect(w.answeringPlaceholder, look).toMatch(/\w/) // the field stays live while it answers: steering
      expect(`${w.placeholder} ${w.answeringPlaceholder} ${w.step('Vega', 'reading', false)}`, look).not.toMatch(/omega/i)
    }
    expect(SKIN_WORDS.transmission.thread).toBe('transmission')
    expect(SKIN_WORDS.liquid.thread).toBe('liquid')
    expect(SKIN_WORDS.terminal.thread).toBe('terminal')
    expect(SKIN_WORDS.note.thread).toBe('note')
    expect(host).toMatch(/<FloatingAsk place=\{place\} experience=\{experience\} inputRef=\{inputRef\} look=\{floating!\} \/>/)
  })
  it('Construct: the prompt IS the Ask; commands parse first, anything else falls through to the Ask', () => {
    for (const c of ['ls minds', 'help', 'wake vega', '> hello', 'ask what is new', 'ask']) expect(isCommandText(c), c).toBe(true)
    for (const c of ['show me my goals', 'make it calmer', 'what is Vega doing', 'vega hello', 'hel']) expect(isCommandText(c), c).toBe(false)
    expect(COMMANDS.some((c) => c.name === 'ask')).toBe(true)
    // its own landmark (dropped while a page covers it: then the host's floating line is the one Ask), combobox, data-ask-input
    expect(cmdLine).toMatch(/<section aria-label=\{covered \? undefined : 'Ask'\} data-ask-zone=""/)
    expect(cmdLine).toMatch(/role="combobox"/)
    expect(cmdLine).toMatch(/role="listbox" aria-label="What this will do"/)
    expect(cmdLine).toMatch(/aria-label=\{sentence\(c\)\}/)
    expect(cmdLine).toMatch(/data-ask-input=""/)
    // the host knows it: summon and Jump to Ask focus it while it is live; typing in it is steering, never a takeover
    expect(host).toMatch(/'command-line': \{ box: '\.cx-root \.cx-cmd', input: '\.cx-root \.cx-cmd \[data-ask-input\]' \}/)
    expect(host).toMatch(/closest\('\.ask-root, \[data-ask-zone\]'\)/)
    // the words asked are never written to the terminal's history on this device (only commands are)
    expect(cmdLine).toMatch(/cancelAwaiting\(\)\n\s+useC\.getState\(\)\.echo/)
    expect(cmdLine).not.toMatch(/pushHistory/)
  })
  it('keyboard and screen reader: the same contract in every new skin', () => {
    // the floating looks are the same component as Classic's capsule (combobox, listbox, log, assertive listening)
    expect(floating).toMatch(/export function FloatingAsk/)
    expect(floating).toMatch(/role="combobox"/)
    expect(floating).toMatch(/<VoiceAnnouncer v=\{v\} \/>/) // listening is announced assertively (VoiceParts)
    expect(floating).toMatch(/aria-label=\{v\.label\}/)
    expect(read('features/ask/Thread.tsx')).toMatch(/role="log"\s+aria-live="polite"/)
  })
  it('reduced motion: every new ornament stops, flights and currents are not drawn, moves are instant', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s+\.ask-root \.ask-stars,/)
    for (const sel of ['.ask-cx-trail', '.ask-cx-ship', '.ask-fx-current', '.ask-cv-cursor', '.ask-cv-pencil path']) {
      expect(css).toMatch(new RegExp(`html\\[data-ui-motion='none'\\] ${sel.replace('.', '\\.')}`))
    }
    expect(ccss).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s+\.cx-ask-log \.ask-answer/)
    expect(host).toMatch(/if \(animate && !reduced\)/)
  })
  it('a mind’s animated move plays the experience’s own transition (Cosmos warp, Flux wash, Construct tear)', () => {
    expect(host).toMatch(/veil\.dataset\.look = experience/)
    for (const look of ['cosmos', 'flux', 'construct', 'canvas']) expect(css).toContain(`.ask-move-veil[data-look='${look}']`)
  })
  it('presence: each experience draws it its own way; the targets carry data-presence attributes', () => {
    expect(host).toMatch(/if \(skin === 'transmission'\) return <CosmosPresence \/>/)
    expect(host).toMatch(/if \(skin === 'liquid'\) return <FluxPresence \/>/)
    expect(host).toMatch(/if \(skin === 'command-line'\) return <ConstructPresence \/>/)
    expect(host).toMatch(/if \(skin === 'note'\) return <CanvasPresence \/>/)
    expect(host).toMatch(/\{!underModal && <SkinPresence skin=\{skin\} \/>\}/)
    // every experience marks its minds, its swarms (where shown) and where decisions wait
    const cosmos = read('experiences/cosmos/index.tsx') + read('experiences/cosmos/Labels.tsx')
    const flux = read('experiences/flux/index.tsx')
    const construct = read('experiences/construct/Panes.tsx')
    for (const [name, src] of [['cosmos', cosmos], ['flux', flux]] as const) {
      expect(src, name).toMatch(/data-presence-ref=\{`mind:\$\{/)
      expect(src, name).toMatch(/data-presence-ref=\{`swarm:\$\{/)
      expect(src, name).toMatch(/decide\.approvals/)
    }
    expect(construct).toMatch(/data-presence-ref=\{`mind:\$\{a\.id\}`\}/)
    const canvas = read('experiences/canvas/parts.tsx')
    expect(canvas).toMatch(/data-presence-ref=\{`mind:\$\{a\.id\}`\}/)
    expect(canvas).toMatch(/data-presence-ref=\{p\.swarm \? `swarm:\$\{p\.id\}` : undefined\}/)
    // where decisions wait: the top bar's Decisions (always on screen), not the lane far out on the board
    expect(read('experiences/canvas/overlays.tsx')).toMatch(/data-cv-decisions data-presence-feature="decide\.approvals"/)
    expect(construct).toMatch(/inbox: 'decide\.approvals'/)
    // Construct's second operator: the orchestrator's presence as the command it stands for
    expect(presenceCommand({ verb: 'point', target: { feature: 'decide.approvals' } })).toBe('point decide.approvals')
    expect(presenceCommand({ verb: 'look', target: { entity: { kind: 'mind', ref: 'a_vega01' } } })).toBe('look mind:a_vega01')
    expect(presenceCommand({ verb: 'sketch', target: { region: 'page' } })).toBe('sketch #page')
    expect(read('experiences/construct/index.tsx')).toMatch(/watchAskEcho\(\)/)
    expect(read('experiences/construct/askEcho.ts')).toMatch(/useAskStore\.subscribe/)
    // the flight's arc starts and ends where it should
    expect(arcPath({ x: 10, y: 20 }, { x: 110, y: 20 })).toMatch(/^M10 20 Q60 42 110 20$/)
  })
  it('presence resolves on each experience’s targets (a fake document), and never off screen', () => {
    const el = (box: { left: number; top: number; width: number; height: number }) => ({ getBoundingClientRect: () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height }), closest: () => null })
    const doc = (map: Record<string, ReturnType<typeof el>[]>) => ({ querySelectorAll: (sel: string) => map[sel] ?? [] })
    const vp = { width: 1440, height: 900 }
    // Cosmos's beacon, Flux's pill drop, Construct's inbox pane: each marked decide.approvals
    const r = resolvePresence({ feature: 'decide.approvals' }, doc({ '[data-presence-feature="decide.approvals"]': [el({ left: 560, top: 20, width: 316, height: 36 })] }), vp)
    expect(r.kind).toBe('found')
    const off = resolvePresence({ entity: { kind: 'mind', ref: 'a_vega01' } }, doc({ '[data-presence-ref="mind:a_vega01"]': [el({ left: 2000, top: 20, width: 40, height: 20 })] }), vp)
    expect(off.kind).toBe('not-on-screen')
  })
})

describe('keep-clear: inside an experience the Ask never covers the chrome it asked to keep clear', () => {
  const vp = { width: 1440, height: 900 }
  const base = placeAsk({ width: 1440, height: 900, layout: 'rail', page: false, tabBar: false, omegaRight: 48 })
  it('lifted just above a navigator / pill it would meet (Cosmos navigator, Flux pill)', () => {
    const nav = { left: 360, top: 834, right: 1080, bottom: 882 }
    const p = liftClear(base, [nav], vp)
    expect(p.bottom).toBe(900 - 834 + 8)
    const top = 900 - p.bottom - ASK_HEIGHT
    expect(900 - p.bottom <= nav.top && top >= 0).toBe(true)
  })
  it('left where it is when nothing is in its way (a box beside it, or one in the top part: notices handle those)', () => {
    expect(liftClear(base, [{ left: 0, top: 834, right: 300, bottom: 882 }], vp)).toBe(base)
    expect(liftClear(base, [{ left: 400, top: 20, right: 1000, bottom: 60 }], vp)).toBe(base)
  })
  it('stacked chrome: lifted above each in turn; the bottom safe area counts', () => {
    const p = liftClear(base, [{ left: 300, top: 840, right: 1100, bottom: 890 }, { left: 500, top: 790, right: 900, bottom: 836 }], vp)
    expect(p.bottom).toBe(900 - 790 + 8)
    const withSab = liftClear(base, [{ left: 360, top: 834, right: 1080, bottom: 882 }], vp, 20)
    expect(withSab.bottom).toBe(900 - 20 - 834 + 8)
  })
  it('never lifted above the lower part of the screen (a tall column is not a floor)', () => {
    const p = liftClear(base, [{ left: 0, top: 500, right: 1440, bottom: 900 }], vp)
    expect(900 - p.bottom - ASK_HEIGHT).toBeGreaterThanOrEqual(900 * (1 - LIFT_MAX_SHARE) - 1)
  })
  it('phone and landscape: above the navigator row right of Ω', () => {
    const phone = placeAsk({ width: 390, height: 844, layout: 'rail', page: false, tabBar: false, omegaRight: 48 })
    const lifted = liftClear(phone, [{ left: 64, top: 784, right: 382, bottom: 832 }], { width: 390, height: 844 })
    expect(lifted.bottom).toBeGreaterThanOrEqual(844 - 784 + 8)
    const land = placeAsk({ width: 844, height: 390, layout: 'rail', page: false, tabBar: false, omegaRight: 48 })
    const l2 = liftClear(land, [{ left: 64, top: 330, right: 832, bottom: 378 }], { width: 844, height: 390 })
    expect(390 - l2.bottom).toBeLessThanOrEqual(330)
  })
  it('phone: once lifted above the row Ω and the OS clock share, the field takes the full content width (not a few characters)', () => {
    // a wide phone (600), where the row between Ω and the clock is roomy enough to stay on (at 390 it is too tight, and
    // the Ask rises above the row at once: the audit P1 #1 test above)
    const W = 600
    const H = 844
    const clockLeft = W - 12 - 60
    const p = { width: W, height: H, layout: 'rail' as const, page: false, tabBar: false, omegaRight: 48, clockLeft }
    // on the clock's row: between Ω and the clock
    const row = placeAsk(p)
    expect(row.left).toBeGreaterThanOrEqual(48 + OMEGA_CLEAR)
    expect(row.left + row.width).toBeLessThanOrEqual(clockLeft - OMEGA_CLEAR)
    // a toolbar / navigator between Ω and the clock lifts it above that row: there it is as wide as the screen allows
    const bar = { left: 64, top: H - 16 - 48, right: W - 84, bottom: H - 16 }
    const lifted = placeInExperience(p, [bar])
    expect(lifted.bottom).toBe(H - bar.top + 8)
    expect(lifted.left).toBe(10)
    expect(lifted.width).toBe(W - 20)
    // nothing in the way: it stays on the clock's row, between Ω and the clock
    expect(placeInExperience(p, [])).toEqual(row)
    // the wider field would meet other chrome lower than the narrow one: the narrow lifted field stays
    const side = { left: 0, top: bar.top - 70, right: 40, bottom: bar.top - 2 }
    const kept = placeInExperience(p, [bar, side])
    expect(kept.bottom).toBe(H - bar.top + 8)
    expect(kept.left).toBeGreaterThanOrEqual(48 + OMEGA_CLEAR)
    // landscape keeps its compact capsule in the left half
    const land = placeInExperience({ ...p, width: 844, height: 390, clockLeft: 844 - 12 - 60 }, [{ left: 64, top: 330, right: 760, bottom: 378 }])
    expect(land.mode).toBe('landscape')
    expect(land.left + land.width).toBeLessThanOrEqual(844 / 2)
  })
  it('AskHost measures the kept-clear chrome (not its own marks, not Ω) and lifts the floating skins; the Ask is itself kept clear', () => {
    const host = read('features/ask/AskHost.tsx')
    expect(host).toMatch(/document\.querySelectorAll\('\[data-xc-keep-clear\]'\)/)
    expect(host).toMatch(/el\.closest\('\.ask-root, \[data-omega-button\]'\)/)
    expect(host).toMatch(/placeInExperience\(\{[\s\S]*?clockLeft \}, keep\.boxes, keep\.sab\)/)
    expect(read('features/ask/placement.ts')).toMatch(/const lifted = liftClear\(base, boxes, vp, sab\)/)
    // only chrome actually on top counts (a route drawn over the experience covers it), looked at through the Ask itself
    expect(host).toMatch(/document\.elementsFromPoint\?\.\(cx, cy\)/)
    expect(host).toMatch(/useKeepClear\(experience !== 'classic' && skin !== 'phase-2'\)/)
    expect(read('features/ask/ClassicAsk.tsx')).toMatch(/className="ask-dock"[^>]*data-xc-keep-clear=""/)
  })
})

describe('Canvas: the note card, and one material per experience', () => {
  const css = read('features/ask/ask.css')
  const phase2 = css.slice(css.indexOf("/* ================================================================ phase 2: the experiences' own skins"))
  it('the phase-2 skins, their threads and presence take every colour from the chrome tokens (no colour of their own)', () => {
    // neutral drop shadows (black) are the only literal colour left
    const literal = phase2.match(/#[0-9a-fA-F]{3,8}\b|rgba?\((?!0 0 0 \/)[^)]*\)|hsla?\(/g) ?? []
    expect(literal).toEqual([])
    expect(phase2).toMatch(/--color-ink: var\(--xc-ink\)/)
    for (const skin of ['transmission', 'liquid', 'command-line', 'note']) expect(phase2).toContain(`[data-skin='${skin}']`)
    // the skins' own Ask additions in Construct's sheet too
    const ccss = read('experiences/construct/construct.css')
    expect(ccss).not.toMatch(/rgba\(132, 246, 230/)
  })
  it('Canvas’s keys: "/" and ⌘K are the Ask’s (search stays on the toolbar, labels no longer advertise them)', () => {
    const idx = read('experiences/canvas/index.tsx')
    const over = read('experiences/canvas/overlays.tsx')
    expect(idx).not.toMatch(/case '\/': setSearchOpen/)
    expect(over).toMatch(/label="Search the canvas" onClick=\{onSearch\}/)
    expect(over).not.toMatch(/kbd="⌘K"|kbd="\/"/)
  })
  it('the pencil (Canvas only): a hand-drawn loop around the target, a little more than one turn, the same every render', async () => {
    const { pencilLoop } = await import('../features/ask/Presence')
    const box = { left: 100, top: 100, right: 200, bottom: 140 }
    const a = pencilLoop(box, 3)
    expect(a).toBe(pencilLoop(box, 3))
    expect(a).not.toBe(pencilLoop(box, 4))
    const pts = a.slice(1).split(' L').map((p) => p.split(' ').map(Number))
    expect(pts).toHaveLength(27)
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThan(70)
      expect(x).toBeLessThan(230)
      expect(y).toBeGreaterThan(75)
      expect(y).toBeLessThan(165)
    }
    expect(read('features/ask/Presence.tsx')).toMatch(/const sketch = shown\.item\.verb === 'sketch'/)
  })
})
