import { describe, expect, it, vi } from 'vitest'

vi.mock('../ask/useAskField', () => ({ fillAsk: vi.fn(), askNowFromField: vi.fn() }))
const { askInstead, askWords } = await import('./askInstead')

describe('Enter in a palette that lists nothing asks the Ask’s mind to find the words', () => {
  it('frames the box’s words as a request to find them, keeping a find, search or look for already typed', () => {
    expect(askWords('poem about bees')).toBe('Find poem about bees')
    expect(askWords('  search the artifacts for marsupials ')).toBe('search the artifacts for marsupials')
    expect(askWords('Look for the storm report')).toBe('Look for the storm report')
    expect(askWords('   ')).toBe('')
  })

  it('fills the Ask, closes the palette, then asks; a turn already open keeps the words in the field', async () => {
    const order: string[] = []
    const fill = vi.fn((_w: string, _o: { replace: true }) => (order.push('fill'), 'filled' as const))
    const close = vi.fn(() => { order.push('close') })
    const ask = vi.fn(async (_o: Record<string, never>) => (order.push('ask'), 'asked'))
    expect(await askInstead('poem about bees', close, { fill, ask })).toBe('asked')
    expect(fill).toHaveBeenCalledWith('Find poem about bees', { replace: true })
    expect(order).toEqual(['fill', 'close', 'ask'])
    expect(await askInstead('poem about bees', close, { fill, ask: async () => 'busy' })).toBe('kept')
  })

  it('leaves the palette open when the Ask cannot take the words, and asks nothing for an empty box', async () => {
    const close = vi.fn()
    const ask = vi.fn(async () => 'asked')
    expect(await askInstead('poem', close, { fill: () => 'none', ask })).toBe('none')
    expect(await askInstead('poem', close, { fill: () => 'kept', ask })).toBe('none')
    expect(await askInstead('  ', close, { fill: () => 'filled', ask })).toBe('none')
    expect(close).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
  })
})
