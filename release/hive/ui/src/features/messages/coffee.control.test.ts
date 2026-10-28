import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '../../api/types'
import { ConfirmHost } from '../../ui/confirm'
import { Switch } from '../../ui/primitives'
import { COFFEE_DISCLOSURE } from './coffee'
import { CoffeeMembershipControl } from './CoffeeParts'

// Coffee UI r3, stand-in coffeeui2 P3: CoffeeMembershipControl itself, as the mind's settings mount it. The store, the
// signed-in person and the in-app confirmation are replaced at their modules, so the test goes through the control's own
// wiring (useHive -> patchAgent/toast/swarms, useMe -> admin, askConfirm) and its real switch. INVENTED data only.

const h = vi.hoisted(() => ({
  askConfirm: vi.fn<(message: string, label?: string) => Promise<boolean>>(),
  patchAgent: vi.fn<(id: string, body: unknown) => Promise<unknown>>(),
  toast: vi.fn(),
  admin: true,
  swarms: {} as Record<string, { id: string; visibility: string }>,
}))
vi.mock('../../ui/confirm', () => ({ askConfirm: h.askConfirm, ConfirmHost: function ConfirmHost() { return null } }))
vi.mock('../../lib/useAdmin', () => ({ useMe: () => ({ me: undefined, admin: h.admin, loaded: true }) }))
vi.mock('../../store/store', () => ({
  useHive: (sel: (s: unknown) => unknown) => sel({ patchAgent: h.patchAgent, toast: h.toast, swarms: h.swarms }),
}))

/** Render the control one level down (to the view it mounts) and collect every element; Switch stays a leaf. */
function render(agent: Agent): ReactNode {
  const el = CoffeeMembershipControl({ agent }) as ReactElement
  const View = el.type as (p: unknown) => ReactNode
  return View(el.props)
}
function elements(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out))
  else if (isValidElement(node)) {
    out.push(node)
    elements((node.props as { children?: ReactNode }).children, out)
  }
  return out
}
type SwitchProps = { checked: boolean; onChange: (on: boolean) => Promise<void> | void }
const switchOf = (agent: Agent) => elements(render(agent)).find((e) => e.type === Switch) as ReactElement<SwitchProps> | undefined

const mind = (over: Partial<Agent>) => ({ id: 'a_q', name: 'Quill', hue: 200, swarm_id: null, visibility: 'private', coffee: 'private', ...over }) as unknown as Agent
const privateMind = mind({})

beforeEach(() => {
  h.askConfirm.mockReset()
  h.patchAgent.mockReset().mockResolvedValue({ id: 'a_q' })
  h.toast.mockReset()
  h.admin = true
  h.swarms = {}
})

describe('CoffeeMembershipControl: the switch asks before a private mind becomes visible', () => {
  it('cancel: the person is asked, and nothing is sent', async () => {
    h.askConfirm.mockResolvedValue(false)
    const sw = switchOf(privateMind)
    expect(sw?.props.checked).toBe(false)
    await sw!.props.onChange(true)
    expect(h.askConfirm).toHaveBeenCalledTimes(1)
    expect(h.askConfirm.mock.calls[0][0]).toBe(COFFEE_DISCLOSURE)
    expect(h.patchAgent).not.toHaveBeenCalled()
    expect(h.toast).not.toHaveBeenCalled()
  })

  it('confirm: the person is asked, then PATCH {coffee: true} is sent and the change is said', async () => {
    h.askConfirm.mockResolvedValue(true)
    await switchOf(privateMind)!.props.onChange(true)
    expect(h.askConfirm).toHaveBeenCalledTimes(1)
    expect(h.askConfirm.mock.calls[0][0]).toBe(COFFEE_DISCLOSURE)
    expect(h.patchAgent).toHaveBeenCalledTimes(1)
    expect(h.patchAgent).toHaveBeenCalledWith('a_q', { coffee: true })
    expect(h.askConfirm.mock.invocationCallOrder[0]).toBeLessThan(h.patchAgent.mock.invocationCallOrder[0])
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Quill is in the Coffee Room' }))
  })

  it("a public mind in a private swarm (the store's swarm) also asks first", async () => {
    h.swarms = { s_p: { id: 's_p', visibility: 'private' } }
    h.askConfirm.mockResolvedValue(false)
    await switchOf(mind({ swarm_id: 's_p', visibility: 'public', coffee: 'opted_out' } as Partial<Agent>))!.props.onChange(true)
    expect(h.askConfirm).toHaveBeenCalledTimes(1)
    expect(h.patchAgent).not.toHaveBeenCalled()
  })

  it('admin only: a member gets no switch and can send nothing; the same mind gives an admin the asking switch', async () => {
    h.admin = false
    expect(switchOf(privateMind)).toBeUndefined()
    expect(elements(render(privateMind)).some((e) => (e.props as { children?: unknown }).children === COFFEE_DISCLOSURE)).toBe(false)
    expect(h.askConfirm).not.toHaveBeenCalled()
    expect(h.patchAgent).not.toHaveBeenCalled()
    // the contrast: the admin's switch on the same mind exists and goes through the confirmation
    h.admin = true
    h.askConfirm.mockResolvedValue(false)
    const sw = switchOf(privateMind)
    expect(sw).toBeDefined()
    await sw!.props.onChange(true)
    expect(h.askConfirm).toHaveBeenCalledTimes(1)
    expect(h.patchAgent).not.toHaveBeenCalled()
  })

  it('taking a member out never asks; an app module shows no control', async () => {
    await switchOf(mind({ coffee: 'member', visibility: 'public' } as Partial<Agent>))!.props.onChange(false)
    expect(h.askConfirm).not.toHaveBeenCalled()
    expect(h.patchAgent).toHaveBeenCalledWith('a_q', { coffee: false })
    expect(render(mind({ coffee: 'not_a_mind' } as Partial<Agent>))).toBeNull()
  })

  // Coffee UI r4, stand-in r3 P2: askConfirm only shows a dialog where a ConfirmHost is mounted, and nothing on the
  // mind's Model tab path (DotPanel, App) mounts one. The control mounts its own host wherever it has a switch.
  it('the control mounts a ConfirmHost with its switch, so the question is actually shown', () => {
    const tree = elements(render(privateMind))
    expect(tree.some((e) => e.type === Switch)).toBe(true)
    expect(tree.some((e) => e.type === ConfirmHost)).toBe(true)
  })
})
