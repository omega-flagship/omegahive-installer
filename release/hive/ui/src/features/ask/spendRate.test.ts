// Purpose: tests of the words for the spend-rate guard: an Ask turn it paused says when the person can carry on, and a slowed mind's notice says when its next call fits.
import { describe, expect, it } from 'vitest'
import { clockTime } from '../../lib/format'
import { slowedNotice } from '../../shell/liveNotices'
import { readDoneLimit, spendStop } from './words'

const UNTIL = '2026-11-12T03:40:00Z'

describe('the spend-rate guard in words', () => {
  it('says when a paused Ask turn can carry on, in the person’s own clock', () => {
    const limit = readDoneLimit({ kind: 'spend_rate', current_usd: null, limit_usd: 50, estimate_usd: 0.05, retry_after: 90, until: UNTIL })
    expect(limit).toMatchObject({ kind: 'spend_rate', until: UNTIL })
    expect(spendStop(limit)).toEqual({ text: `Paused here: this is spending faster than this month allows. You can carry on at about ${clockTime(UNTIL)}.`, offer: [{ kind: 'retry', label: 'Ask again' }] })
    expect(spendStop(readDoneLimit({ kind: 'spend_rate', until: 'not a time' }))!.text).toBe('Paused here: this is spending faster than this month allows. Ask again in a little while.')
  })

  it('tells a person once that a mind is slowed and when its next call fits', () => {
    const notice = slowedNotice({ type: 'budget.slowed', at: UNTIL, agent_id: 'a_1', retry_after: 600, until: UNTIL }, { agents: { a_1: { name: 'Vega' } } } as never)
    expect(notice).toMatchObject({ tone: 'info', title: `Vega is slowed until about ${clockTime(UNTIL)}`, body: 'It is spending faster than this month allows. It carries on by itself.' })
  })
})
