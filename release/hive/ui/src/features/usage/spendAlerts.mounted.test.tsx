// Purpose: check signed-in spend notices and Usage controls through the mounted UI.
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type HiveClient } from '../../api/client'
import type { SpendAlert, SpendControl } from '../../api/spendAlerts'
import { hiveBus, useHive } from '../../store/store'
import { ScreensSpace } from '../../screens/screenSpace'
import { MiniDocument, press, reactProps, type MiniNode } from '../../ui/miniDom.testkit'
import { SpendAlertNotice } from './SpendAlertNotice'
import UsageView from './UsageView'
import { noticeFacts } from './spendAlertDisplay'
import { useSpendAlerts } from './useSpendAlerts'

const OPENED = '2026-11-23T08:00:00Z'
const hiveAlert: SpendAlert = {
  id: 'alert-hive', scope: 'hive', agent_id: null, name: null, opened_at: OPENED, closed_at: null,
  window_seconds: 3600, spent_usd: 3, projected_usd: 60, limit_usd: 50, paused: false, can_control: true,
}
const mindAlert: SpendAlert = {
  ...hiveAlert, id: 'alert-mind', scope: 'mind', agent_id: 'mind-a', name: 'Vega',
  projected_usd: null, limit_usd: null,
}

function host(initial: SpendAlert[]) {
  let alerts = initial
  const read = vi.fn(async () => alerts)
  const write = vi.fn(async (id: string, choice: SpendControl) => {
    const before = alerts.find((row) => row.id === id)
    if (!before) throw new ApiError(404, 'not_found', 'No such spend alert.')
    const after = { ...before, paused: choice === 'pause' }
    alerts = alerts.flatMap((row) => row.id !== id ? [row] : after.closed_at && !after.paused ? [] : [after])
    return after
  })
  const client = { mode: 'live', needsAuth: () => false, spendAlerts: read, controlSpendAlert: write, listUsage: async () => [] } as unknown as HiveClient
  return { client, read, write, set: (rows: SpendAlert[]) => { alerts = rows } }
}

function pendingWrite() {
  let resolve!: (value: SpendAlert) => void
  let reject!: (error: Error) => void
  const promise = new Promise<SpendAlert>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function Session({ usage = false }: { usage?: boolean }) {
  const spendAlerts = useSpendAlerts(true)
  return <>
    <SpendAlertNotice alerts={spendAlerts.alerts} onUsage={usage} look="classic" />
    {usage && <UsageView spendAlerts={spendAlerts} />}
  </>
}

let box: MiniNode
let root: Root
let location: { hash: string; search: string; pathname: string }
const initialStore = useHive.getState()

const hint = () => hiveBus.emit({ type: 'spend.alert', at: OPENED, principal: 'user:owner', alert_id: null })
const button = (label: string) => box.findAll((node) => node.tagName === 'BUTTON' &&
  (node.getAttribute('aria-label') === label || node.textContent === label))[0]

beforeEach(async () => {
  const document = new MiniDocument()
  location = { hash: '#/messages', search: '', pathname: '/' }
  const window = {
    document, location, HTMLIFrameElement: class {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval,
  }
  document.defaultView = window
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', document)
  vi.stubGlobal('HTMLIFrameElement', window.HTMLIFrameElement)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  box = document.createElement('div')
  document.body.appendChild(box)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(box as unknown as Element)
})

afterEach(async () => {
  await act(async () => root.unmount())
  useHive.setState(initialStore)
  vi.unstubAllGlobals()
})

describe('the same signed-in alerts feed the hive and Usage', () => {
  it('composes the shared notice and both owner controls in every look', () => {
    const space = ScreensSpace.open()
    for (const look of space.looks()) {
      const outside = space.compose('spend-alert-notice', look, noticeFacts([hiveAlert], false))
      expect(outside.missing, look).toEqual([])
      expect(outside.parts.map((part) => part.block)).toEqual(['bar'])
      expect(space.compose('spend-alert-notice', look, noticeFacts([hiveAlert], true)).parts).toEqual([])
      const open = space.compose('spend-alert-detail', look, { flags: { 'alert.open': true, 'alert.control': true } })
      const paused = space.compose('spend-alert-detail', look, { flags: { 'alert.paused': true, 'alert.control': true } })
      const hivePaused = space.compose('spend-alert-detail', look,
        { flags: { 'alert.paused': true, 'alert.hive': true, 'alert.control': true } })
      for (const plan of [open, paused, hivePaused]) {
        expect(plan.missing, look).toEqual([])
        expect(plan.parts.filter((part) => part.block === 'buttons')).toHaveLength(1)
      }
    }
  })

  it('rereads on a live hint and after a subscription gap, without making a paid control call', async () => {
    const owner = host([])
    useHive.setState({ client: owner.client })
    await act(async () => root.render(<Session />))
    expect(button('View Usage')).toBeUndefined()
    owner.set([mindAlert])
    await act(async () => hint())
    expect(box.textContent).toContain('Spend alert')
    expect(box.textContent).not.toContain('Vega')
    await act(async () => press(button('View Usage')))
    expect(location.hash).toBe('#/usage')
    await act(async () => root.render(<Session usage />))
    expect(button('View Usage')).toBeUndefined()
    expect(box.textContent).toContain('Vega')
    expect(box.textContent).toContain('Alert active')
    expect(box.textContent).toContain('1 hour')
    owner.set([])
    await act(async () => useHive.setState((s) => ({ resyncs: s.resyncs + 1 })))
    expect(box.textContent).toContain('No current spend alerts.')
    expect(box.textContent).not.toContain('Vega')
    expect(owner.read).toHaveBeenCalledTimes(3)
    expect(owner.write).not.toHaveBeenCalled()
  })

  it('only submits an authorized row, locks it while in flight, and resumes after detection clears', async () => {
    const owner = host([hiveAlert, { ...mindAlert, can_control: false }])
    const pause = pendingWrite()
    owner.write.mockReturnValueOnce(pause.promise)
    useHive.setState({ client: owner.client })
    await act(async () => root.render(<Session usage />))
    expect(box.textContent).toContain('projected to spend $60.00 against its $50.00 cap')
    expect(button('Pause paid calls for Vega')).toBeUndefined()
    const pauseHive = button('Pause paid calls for Hive')
    await act(async () => { press(pauseHive); press(pauseHive) })
    expect(owner.write).toHaveBeenCalledExactlyOnceWith(hiveAlert.id, 'pause')
    expect(reactProps(button('Pause paid calls for Hive')).disabled).toBe(true)
    expect(box.textContent).toContain('Updating paid call status')
    const closed = { ...hiveAlert, paused: true, closed_at: '2026-11-23T09:00:00Z' }
    owner.set([closed])
    await act(async () => pause.resolve(closed))
    expect(box.textContent).toContain('Alert cleared')
    expect(box.textContent).toContain('New paid calls on the hive’s money are paused. Calls people make on their own keys go on.')
    expect(box.textContent).not.toContain('New paid calls for this mind are paused.')
    expect(box.textContent).not.toContain('projected to spend')
    await act(async () => press(button('Resume paid calls for Hive')))
    expect(owner.write).toHaveBeenLastCalledWith(hiveAlert.id, 'resume')
    expect(box.textContent).toContain('No current spend alerts.')
  })

  it('shows a refusal immediately and refreshes away a row whose authority has changed', async () => {
    const owner = host([mindAlert])
    owner.write.mockImplementationOnce(async () => {
      owner.set([])
      throw new ApiError(403, 'owner_only', 'Only the owner can change this pause.')
    })
    useHive.setState({ client: owner.client })
    await act(async () => root.render(<Session usage />))
    await act(async () => press(button('Pause paid calls for Vega')))
    expect(box.textContent).toContain('Only the owner can change this pause.')
    expect(button('Pause paid calls for Vega')).toBeUndefined()
    expect(box.textContent).not.toContain('Vega')
  })

  it('clears earlier answers and ignores a late control for someone who signed out', async () => {
    const earlier = host([mindAlert])
    const later = host([])
    const finishing = pendingWrite()
    earlier.write.mockReturnValueOnce(finishing.promise)
    useHive.setState({ client: earlier.client })
    await act(async () => root.render(<Session usage />))
    await act(async () => press(button('Pause paid calls for Vega')))
    await act(async () => useHive.setState({ client: later.client, session: 'next' }))
    expect(box.textContent).not.toContain('Vega')
    await act(async () => finishing.reject(new Error('earlier session failed')))
    expect(box.textContent).not.toContain('earlier session failed')
    expect(later.read).toHaveBeenCalledTimes(1)
    expect(later.write).not.toHaveBeenCalled()
  })

  it('offers a retry on a failed read and displays only the fresh answer', async () => {
    const owner = host([mindAlert])
    owner.read.mockRejectedValueOnce(new Error('route temporarily unavailable'))
    useHive.setState({ client: owner.client })
    await act(async () => root.render(<Session usage />))
    expect(box.textContent).toContain('Could not load spend alerts. route temporarily unavailable')
    await act(async () => press(button('Try again')))
    expect(button('Pause paid calls for Vega')).toBeDefined()
    expect(box.textContent).not.toContain('route temporarily unavailable')
  })
})
