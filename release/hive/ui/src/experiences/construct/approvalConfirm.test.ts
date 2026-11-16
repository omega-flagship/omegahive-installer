import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Approval } from '../../api/types'
import { ARM_MS } from '../../lib/decisionGate'
import { useHive } from '../../store/store'
import { run } from './commands'
import { useC } from './state'

// Surface O (Review R2/R3 at the command line): `approve <n>` / `deny <n>` never answer by themselves. They preview the
// whole request, and `yes` answers that request (by id and content) only after the arming window, only while it is
// still pending and unchanged, and only for the session it was previewed in.
const ask = (over: Partial<Approval> = {}): Approval => ({
  id: 'ap_1', agent_id: 'a_vega01', skill: 'shell', command: '(shell-confirm "rm -rf /srv/scratch/run-17")', reason: 'shell always needs a person',
  risk: 'high', status: 'pending', decided_by: null, created_at: '2026-10-05T09:00:00Z', decided_at: null, ...over,
})
const answers: { id: string; how: string }[] = []
const text = () => useC.getState().console.slice(-12).map((l) => l.segs.map((s) => s.t).join('')).join('\n')
let clock = 5_000_000
const read = () => {
  clock += ARM_MS + 50
}
const client = () => ({
  approve: async (id: string, remember?: boolean) => (answers.push({ id, how: remember ? 'remember' : 'approve' }), { ...useHive.getState().approvals[id], status: 'approved' as const }),
  deny: async (id: string) => (answers.push({ id, how: 'deny' }), { ...useHive.getState().approvals[id], status: 'denied' as const }),
})

afterEach(() => vi.restoreAllMocks())
beforeEach(() => {
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  answers.length = 0
  useHive.setState({ client: client() as never, approvals: { ap_1: ask() }, agents: {}, swarms: {}, deciding: {} })
})

describe('Surface O: Construct answers a request only as previewed', () => {
  it('approve 1 previews the whole request and writes nothing', async () => {
    await run('approve 1')
    expect(answers).toHaveLength(0)
    const t = text()
    expect(t).toContain('(shell-confirm "rm -rf /srv/scratch/run-17")')
    expect(t).toContain('shell always needs a person')
    expect(t).toContain('ap_1')
    expect(t).toMatch(/HIGH RISK/)
    expect(t).toMatch(/yes.*to go ahead/)
  })

  it('a yes inside the arming window is refused; a later yes answers once', async () => {
    await run('approve 1')
    await run('yes')
    expect(answers).toHaveLength(0)
    read()
    await run('yes')
    expect(answers).toEqual([{ id: 'ap_1', how: 'approve' }])
    read()
    await run('yes')
    expect(answers).toHaveLength(1)
  })

  it('a newer request arriving at #1 after the preview does not redirect the answer', async () => {
    await run('deny 1')
    useHive.setState({ approvals: { ap_0: ask({ id: 'ap_0', command: '(shell-confirm "ls")', created_at: '2026-10-05T09:30:00Z' }), ap_1: ask() } })
    read()
    await run('yes')
    expect(answers).toEqual([{ id: 'ap_1', how: 'deny' }])
  })

  it('a request whose command changed after the preview is refused, by name', async () => {
    await run('approve 1')
    useHive.setState({ approvals: { ap_1: ask({ command: '(shell-confirm "rm -rf /srv")' }) } })
    read()
    await run('yes')
    expect(answers).toHaveLength(0)
    expect(text()).toMatch(/changed while it was open \(command\)/)
  })

  it('a request answered elsewhere after the preview is refused', async () => {
    await run('approve 1')
    useHive.setState({ approvals: { ap_1: ask({ status: 'denied', decided_by: 'user:ben' }) } })
    read()
    await run('yes')
    expect(answers).toHaveLength(0)
    expect(text()).toMatch(/already denied by user:ben elsewhere/)
  })

  it('a yes after the client changed (another session) is refused', async () => {
    await run('approve 1')
    useHive.setState({ client: client() as never })
    read()
    await run('yes')
    expect(answers).toHaveLength(0)
  })

  it('any other command cancels the preview visibly', async () => {
    await run('approve 1')
    await run('ls minds')
    read()
    await run('yes')
    expect(answers).toHaveLength(0)
    expect(text()).toMatch(/approve #1: cancelled, nothing changed/)
  })

  it('what is said to a mind and yes/no are never written to the device history', async () => {
    await run('> the door code is 4471')
    await run('say vega the door code is 4471')
    await run('no')
    const h = useC.getState().history
    expect(h.some((x) => x.includes('4471'))).toBe(false)
    expect(h).not.toContain('no')
  })
})
