import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { liveToastAction, useHive, type Toast } from './store'

/**
 * Kimi K4: toast() replaces an equal (title, body, tone) toast. The replaced toast can still be on screen (the Hud's
 * exit animation keeps its button mounted), and anything may hold its action. Only the newest copy's action may run;
 * a replaced, dismissed or expired toast's action never runs. Invented data only.
 */

beforeEach(() => {
  vi.useFakeTimers()
  useHive.setState({ toasts: [] })
})
afterEach(() => {
  useHive.setState({ toasts: [] })
  vi.useRealTimers()
})

const find = (title: string) => useHive.getState().toasts.filter((t) => t.title === title)

describe('toast actions (Kimi K4)', () => {
  it('a replaced copy keeps its button on screen but its action never runs; the newest carries its own', () => {
    const ran: string[] = []
    useHive.getState().toast({ tone: 'info', title: 'Invented ask', body: 'ls', action: { label: 'Review', run: () => ran.push('first') } })
    const first = find('Invented ask')[0]
    // what the Hud rendered for the first copy (its exit animation still shows this button after the replace)
    const firstButton = first.action!
    useHive.getState().toast({ tone: 'info', title: 'Invented ask', body: 'ls', action: { label: 'Review', run: () => ran.push('second') } })
    const now = find('Invented ask')
    expect(now).toHaveLength(1)
    expect(now[0].id).not.toBe(first.id)
    firstButton.run()
    expect(ran).toEqual([])
    now[0].action!.run()
    expect(ran).toEqual(['second'])
  })

  it('a dismissed toast’s action never runs', () => {
    const ran: string[] = []
    useHive.getState().toast({ tone: 'info', title: 'Invented run finished', action: { label: 'Open run', run: () => ran.push('x') } })
    const t = find('Invented run finished')[0]
    useHive.getState().dismissToast(t.id)
    t.action!.run()
    expect(ran).toEqual([])
  })

  it('an expired toast’s action never runs; a live one runs once per press', () => {
    const ran: string[] = []
    useHive.getState().toast({ tone: 'info', title: 'Invented short', ttl: 1000, action: { label: 'Go', run: () => ran.push('short') } })
    const t = find('Invented short')[0]
    t.action!.run()
    expect(ran).toEqual(['short'])
    vi.advanceTimersByTime(1500)
    expect(find('Invented short')).toHaveLength(0)
    t.action!.run()
    expect(ran).toEqual(['short'])
  })

  it('a toast dropped off the end of the stack (more than four) cannot run', () => {
    const ran: string[] = []
    useHive.getState().toast({ tone: 'info', title: 'Invented 0', action: { label: 'Go', run: () => ran.push('0') } })
    const oldest = find('Invented 0')[0]
    for (let i = 1; i <= 4; i++) useHive.getState().toast({ tone: 'info', title: `Invented ${i}` })
    expect(find('Invented 0')).toHaveLength(0)
    oldest.action!.run()
    expect(ran).toEqual([])
  })

  it('liveToastAction keeps the label and checks the list at the moment of the press', () => {
    let list: Toast[] = [{ id: 7, tone: 'info', title: 't' }]
    const ran: number[] = []
    const a = liveToastAction({ label: 'L', run: () => ran.push(1) }, 7, () => list)
    expect(a.label).toBe('L')
    a.run()
    list = []
    a.run()
    expect(ran).toEqual([1])
  })
})
