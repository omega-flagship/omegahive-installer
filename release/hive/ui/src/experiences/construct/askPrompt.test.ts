import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useHive } from '../../store/store'
import { useAskStore } from '../../store/ask'
import { promptRoute, run } from './commands'
import { useC } from './state'

/**
 * Review's condition for Construct's prompt-as-Ask (2026-10-06): command-first parsing, and a failed command stays a
 * command refusal. A line whose first word is a command is run as that command whatever it then says; it never quietly
 * becomes a request to a model. Only a line whose first word is not a command goes to the Ask, plus an explicit `ask …`.
 * INVENTED data; no client is called.
 */
const text = () => useC.getState().console.slice(-6).map((l) => l.segs.map((s) => s.t).join('')).join('\n')
const asked = vi.fn()

beforeEach(() => {
  asked.mockReset()
  useC.getState().clear()
  useC.getState().openMind(null)
  // a client that would take an Ask turn, so any fall-through would be seen
  useHive.setState({ client: { mode: 'sim', ask: asked } as never, agents: {}, swarms: {}, approvals: {} })
})

describe('Construct: where a typed line goes', () => {
  it('a command whose arguments do not parse is the command (its refusal), never the Ask', () => {
    expect(promptRoute('wake')).toEqual({ to: 'command' })
    expect(promptRoute('wake nobody-by-that-name')).toEqual({ to: 'command' })
    expect(promptRoute('approve seventeen')).toEqual({ to: 'command' })
  })
  it('`status of lyra` is the status command; `ask status of lyra` is the Ask, explicitly', () => {
    expect(promptRoute('status of lyra')).toEqual({ to: 'command' })
    expect(promptRoute('ask status of lyra')).toEqual({ to: 'ask', text: 'status of lyra', forced: true })
    expect(promptRoute('ask')).toEqual({ to: 'command' }) // alone: the ask log toggles
  })
  it('plain words (first word not a command) go to the Ask', () => {
    expect(promptRoute('show me what Vega did today')).toEqual({ to: 'ask', text: 'show me what Vega did today', forced: false })
    expect(promptRoute('make it calmer')).toMatchObject({ to: 'ask', forced: false })
    expect(promptRoute('vega hello')).toMatchObject({ to: 'ask', forced: false })
    expect(promptRoute('  ')).toEqual({ to: 'none' })
  })
  it('a refused command prints its own refusal and sends nothing to the Ask', async () => {
    await run('wake')
    expect(text()).toMatch(/✗ wake: which mind\?/)
    await run('wake nobody-by-that-name')
    expect(text()).toMatch(/✗ wake:/)
    await run('approve seventeen')
    expect(text()).toMatch(/✗|nothing|no request/i)
    expect(asked).not.toHaveBeenCalled()
    expect(useAskStore.getState().log).toHaveLength(0)
    expect(useAskStore.getState().open).toBeNull()
  })
  it('`status of lyra` runs status (the command), and nothing reaches the Ask', async () => {
    await run('status of lyra')
    expect(asked).not.toHaveBeenCalled()
    expect(useAskStore.getState().log).toHaveLength(0)
  })
  it('the prompt routes Enter by promptRoute: commands to run(), asks to the shared hook only', async () => {
    const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync: (p: string, e: 'utf8') => string }
    const src = fs.readFileSync(new URL('./CommandLine.tsx', import.meta.url).pathname, 'utf8')
    // uifix-r2.2 (stand-in P1): `ask <words>` is a request for the Ask too: its paid row is shown, and Enter goes through
    // the Ask's guarded submission (useAskField forcedAsk); nothing in the prompt sends to a mind by itself
    expect(src).toMatch(/const asking = !tab && route\.to === 'ask'\n/)
    expect(src).toMatch(/if \(k === 'Enter' && !tab && asking\)/)
    expect(src).toContain("useAskField({ experience: 'construct', forcedAsk, onDispatch: echoDispatch })")
    // uifix-r2.3 (Kimi r2.2 #1): the echo, and cancelling a pending yes/no, only once the Ask acts
    expect(src).toMatch(/const echoDispatch = [\s\S]{0,120}cancelAwaiting\(\)/)
    expect(src).toContain('const askEnter = (e: KeyboardEvent<HTMLInputElement>) => f.onKeyDown(e)')
    expect(src).toMatch(/return r\.to === 'ask' && r\.forced \? r\.text : null/)
    expect(src).not.toMatch(/f\.run\(\{ do: 'mind'/)
  })
})
