import { describe, expect, it, vi } from 'vitest'
import { MettaView, roundedText, ViewProblem, type ViewFrame } from './mettaView'
import { viewAnswerer } from './viewProtocol'
import tipSource from '../../../../tests/fixtures/views-tip.metta?raw'

vi.setConfig({ testTimeout: 20_000 })

// A view as a mind writes it, composed by the hive's own screen rules: the tip calculator the server tests and the
// browser check share (hive/tests/fixtures/views-tip.metta), and the change a mind makes to it (other tips, from 18%).
const tipChanged = tipSource
  .replace('(option "10" "10%") (option "15" "15%") (option "20" "20%")', '(option "18" "18%") (option "20" "20%") (option "25" "25%")')
  .replace('(Start pct "15")', '(Start pct "18")')

const blocks = (f: ViewFrame) => f.plan.parts.map((p) => `${p.order}:${p.block}`)
const opened = (source = tipSource) => {
  const view = new MettaView()
  view.load(source)
  return view
}
const problem = (fn: () => unknown) => {
  try { fn() } catch (e) { if (e instanceof ViewProblem) return e.message; throw e }
  throw new Error('no ViewProblem')
}

describe('a view written in MeTTa', () => {
  it('is composed by the screen rules from its own atoms, with its values worked out and its conditions read', () => {
    expect(tipChanged).not.toBe(tipSource)
    const view = opened()
    const empty = view.render('classic')
    expect(empty.plan.title).toBe('Tip calculator')
    // no bill yet: the note shows, the sums and the booking do not
    expect(blocks(empty)).toEqual(['10:header', '20:fields', '30:segmented', '50:note'])
    expect(empty.data).toMatchObject({ bill: '', people: '2', pct: '15', tip: '0.00', total: '0.00', each: '0.00' })

    view.input('bill', '84.50')
    const filled = view.render('classic')
    expect(blocks(filled)).toEqual(['10:header', '20:fields', '30:segmented', '40:facts', '60:actions'])
    expect(filled.data).toMatchObject({ bill: '84.50', tip: '12.68', total: '97.18', each: '48.59' })
    view.input('pct', '20')
    view.input('people', '4')
    expect(view.render('classic').data).toMatchObject({ tip: '16.90', total: '101.40', each: '25.35' })
    view.input('people', '0')
    expect(view.render('classic').data.each).toBe('')   // its own guard against dividing by no one
  })

  it('a press answers with what to do: words for its maker here, nothing for a press it has no rule for', () => {
    const view = opened()
    view.input('bill', '84.50')
    expect(view.press({ intent: 'book' })).toEqual(['Please book a table for 2. The bill comes to 97.18 with the tip.'])
    expect(view.press({ intent: 'nothing-handles-this' })).toEqual([])
  })

  it('a press can set values, read an item it was pressed on, and a tick says on or off', () => {
    const view = opened(`(Screen count "Count")
(Part count 10 actions ((items ((action "Add one" add) (action "Reset" reset)))))
(Part count 20 facts ((rows ((row "Count" (bind n)) (row "Picked" (bind picked)) (row "Ticked" (bind ticked))))))
(Start n 0)
(= (on add) ((set n (+ (num (state n)) 1))))
(= (on reset) ((set n 0) (say "Reset to " 0)))
(= (on pick $id) ((set picked $id)))
(= (on tick $id $on) ((set ticked ($id $on))))`)
    view.press({ intent: 'add' })
    view.press({ intent: 'add' })
    expect(view.render('classic').data.n).toBe(2)
    expect(view.press({ intent: 'reset' })).toEqual(['Reset to 0'])
    view.press({ intent: 'pick', item: { id: 'tea' } })
    view.press({ intent: 'tick', item: { id: 'milk' }, on: true })
    expect(view.render('classic').data).toMatchObject({ n: 0, picked: 'tea', ticked: ['milk', true] })
  })

  it('takes up the mind\'s change in place and keeps what the person typed', () => {
    const view = opened()
    view.input('bill', '84.50')
    expect(view.render('classic').data.tip).toBe('12.68')
    const changed = view.replace(tipChanged, 'classic')
    // the new tips, starting at 18%, worked out on the bill the person had typed
    expect(changed.data).toMatchObject({ bill: '84.50', pct: '18', tip: '15.21', total: '99.71' })
    const options = changed.plan.parts.find((p) => p.block === 'segmented')?.props.options
    expect(JSON.stringify(options)).toContain('25%')
  })

  it('keeps the view it had when a change cannot be drawn, and says why', () => {
    const view = opened()
    view.input('bill', '10')
    expect(problem(() => view.replace(`${tipSource}\n(Part tip 70 keyfield ((label "Your key")))`, 'classic'))).toBe('part 70 uses the keyfield block, which a view may not use')
    expect(view.render('classic').data).toMatchObject({ bill: '10', tip: '1.50' })
  })

  it('refuses what would run as it loads, a block a view may not use, and a screen it does not name', () => {
    expect(problem(() => opened(`${tipSource}\n!(add-atom &self (Start bill "1"))`))).toBe('a line in it starts with !, and a view holds declarations only')
    expect(problem(() => opened('(Part tip 10 note ((text "x")))'))).toBe('it names no screen: (Screen <name> "Title")')
    expect(problem(() => opened('(Screen a "A")\n(Screen b "B")'))).toBe('it names 2 screens, and a view has one')
    expect(problem(() => opened('(Screen a "A")\n(Part b 10 note ((text "x")))'))).toBe('it has parts on a screen it does not name: (b 10)')
    for (const block of ['island', 'keyfield', 'reveal', 'stack', 'orbs']) {
      expect(problem(() => opened(`(Screen a "A")\n(Part a 10 ${block} ((name x)))`).render('classic'))).toBe(`part 10 uses the ${block} block, which a view may not use`)
    }
    // a view cannot widen what it may use: its own (ViewBlock …) comes after the list was read
    expect(problem(() => opened('(Screen a "A")\n(ViewBlock island)\n(Part a 10 island ((name x)))').render('classic'))).toContain('may not use')
    expect(problem(() => opened('(Screen a "A")\n(Part a 10 timeless ())').render('classic'))).toBe('part 10 asks for timeless, which nothing draws')
  })

  it('a rule that loops ends on its step budget as a mistake the frame can show', () => {
    const view = opened('(Screen a "A")\n(Part a 10 note ((text (bind spin))))\n(= (spin-more $x) (spin-more (+ $x 1)))\n(= (value spin) (spin-more 0))')
    expect(problem(() => view.render('classic'))).toMatch(/^its value spin cannot be worked out: .*StackOverflow/)
    expect(problem(() => opened('(Screen a "A")\n(= (value twice) 1)\n(= (value twice) 2)').render('classic'))).toBe('its value twice cannot be worked out: value answered 2 times')
  })

  it('writes money rounded half away from zero on its decimal value, where toFixed alone rounds the binary one', () => {
    expect([(84.5 * 0.15).toFixed(2), (1.005).toFixed(2)]).toEqual(['12.67', '1.00'])
    expect(roundedText(84.5 * 0.15, 2)).toBe('12.68')
    expect(roundedText(1.005, 2)).toBe('1.01')
    expect(roundedText(-1.005, 2)).toBe('-1.01')
    expect([roundedText(2.5, 0), roundedText(-2.5, 0), roundedText(1e-7, 2), roundedText(123456789.125, 2)]).toEqual(['3', '-3', '0.00', '123456789.13'])
    expect([roundedText(Number.NaN, 2), roundedText(Number.POSITIVE_INFINITY, 2)]).toEqual(['', ''])
  })

  it('the example a mind\'s prompt teaches composes and works out its value', async () => {
    // node:fs by name, as screens/engine.test.ts reads page sources: the app's types know no node modules
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string }
    const prompt = fs.readFileSync(new URL('../../../../templates/omega/prompt.txt', import.meta.url), 'utf8')
    const line = prompt.split('\n').find((text: string) => text.includes('save it as a view')) ?? ''
    const start = line.indexOf('{"kind":"view"')
    const example = JSON.parse(line.slice(start, line.indexOf('"}', start) + 2)) as { body: string }
    const view = opened(example.body)
    view.input('bill', '20')
    const frame = view.render('classic')
    expect(blocks(frame)).toEqual(['10:fields', '20:facts'])
    expect(frame.data.tip).toBe('3.00')
  })

  it('the worker answers by the protocol, and refuses everything when its scope was not bared', () => {
    const answer = viewAnswerer({ ok: true, open: [] })
    const first = answer({ id: 1, kind: 'open', source: tipSource, look: 'classic' })
    expect(first.id === 1 && 'ok' in first && first.ok && blocks(first.frame)).toEqual(['10:header', '20:fields', '30:segmented', '50:note'])
    const typed = answer({ id: 2, kind: 'input', key: 'bill', text: '84.50', look: 'classic' })
    expect('ok' in typed && typed.ok && typed.frame.data.tip).toBe('12.68')
    const booked = answer({ id: 3, kind: 'press', press: { intent: 'book' }, look: 'classic' })
    expect('ok' in booked && booked.ok && booked.frame.says).toHaveLength(1)
    expect(answer({ id: 4, kind: 'replace', source: '!(x)', look: 'classic' })).toEqual({ id: 4, ok: false, problem: 'a line in it starts with !, and a view holds declarations only' })
    const unsafe = viewAnswerer({ ok: false, open: ['fetch'] })
    expect(unsafe({ id: 1, kind: 'open', source: tipSource, look: 'classic' })).toEqual({ id: 1, ok: false, problem: "this browser left a way out of the view's worker open (fetch)" })
  })
})
