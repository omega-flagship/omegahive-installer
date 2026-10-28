import { describe, expect, it } from 'vitest'
import { MEMORY_COLOR_SLOTS, memoryThemeContrast, memoryThemeStyle, readMemoryThemes, resolveMemoryTheme } from './memoryTheme'

describe('P8 release-bound host display tokens', () => {
  const release = {
    memory_theme: { accent: '#123456', font: 'serif', radius: 8, motion: 'lively',
      calm: { accent: '#234567', font: 'mono', dark: { accent: '#345678', surface: '#000000', panel: '#101010' } } },
    memory_theme_dark: { accent: '#456789', surface: '#010101', panel: '#101010' },
  }

  it('selects a declared variant by name and dark mode only', () => {
    expect(resolveMemoryTheme(release).accent).toBe('#123456')
    expect(resolveMemoryTheme(release, { theme: 'calm' }).accent).toBe('#234567')
    expect(resolveMemoryTheme(release, { theme: 'calm', mode: 'dark' }).accent).toBe('#345678')
    expect(resolveMemoryTheme(release, { mode: 'dark' }).accent).toBe('#456789')
    expect(resolveMemoryTheme(release, { theme: 'undeclared', mode: 'dark' }).accent).toBe('#456789')
  })

  it('uses light tokens when the chosen declaration has no dark override', () => {
    const theme = { memory_theme: { accent: '#123456', calm: { accent: '#234567' } } }
    expect(resolveMemoryTheme(theme, { mode: 'dark' })).toEqual(resolveMemoryTheme(theme))
    expect(resolveMemoryTheme(theme, { theme: 'calm', mode: 'dark' })).toEqual(resolveMemoryTheme(theme, { theme: 'calm' }))
  })

  it('replaces missing, withdrawn and invalid runtime values with a renderable host default', () => {
    expect(resolveMemoryTheme({ memory_theme: { font: 'withdrawn-font' } })).toEqual(resolveMemoryTheme({}))
    expect(resolveMemoryTheme(release, { fonts: ['system'] }).font).toBe('system')
    expect(resolveMemoryTheme(release, { fonts: [] }).fontFamily).toBe('system-ui, sans-serif')
    expect(resolveMemoryTheme(release, { reducedMotion: true }).motion).toBe('none')
    expect(resolveMemoryTheme(null)).toEqual(resolveMemoryTheme({}))
  })

  it.each<[unknown]>([
    [{ surface: 'url(https://example.invalid/pixel)' }], [{ accent: '#fff' }], [{ text: '<script>1</script>' }],
    [{ font: 'url(font.woff)' }], [{ motion: '@import x' }], [{ radius: true }], [{ radius: Infinity }], [{ radius: NaN }],
    [{ radius: -1 }], [{ radius: 33 }], [{ padding: 4 }], [{ accentText: '#ffffff' }],
    [{ constructor: {} }], [{ Upper: {} }], [{ 'name-is-more-than-twentyfour': {} }],
    [{ calm: { dark: { font: 'unlisted' } } }], [{ calm: { nested: {} } }],
  ])('refuses unsafe or unknown declaration tokens [%#]: %j', (memory_theme: unknown) => {
    expect(readMemoryThemes({ memory_theme })).toBeNull()
  })

  it('validates every branch and caps named variants at four', () => {
    expect(readMemoryThemes({ memory_theme: { a: {}, b: {}, c: {}, d: { dark: { font: 'mono' } } } })).not.toBeNull()
    expect(readMemoryThemes({ memory_theme: { a: {}, b: {}, c: {}, d: {}, e: {} } })).toBeNull()
    expect(readMemoryThemes({ memory_theme_dark: { nested: {} } })).toBeNull()
    expect(readMemoryThemes({ memory_theme_dark: null })).toBeNull()
    expect(readMemoryThemes({ memory_theme: Object.create({ accent: '#123456' }) })).toBeNull()
  })

  it('rejects accessor objects without evaluating untrusted theme values', () => {
    let read = false
    const theme = Object.defineProperty({}, 'accent', { enumerable: true, get: () => { read = true; return '#123456' } })
    expect(readMemoryThemes({ memory_theme: theme })).toBeNull()
    expect(read).toBe(false)
  })

  it('does not let a malformed name inject tokens or bypass the default', () => {
    for (const theme of [{ accent: '#ff0000' }, 'calm;url(x)', 'Upper', 'constructor', 'prototype']) {
      expect(resolveMemoryTheme(release, { theme })).toEqual(resolveMemoryTheme(release))
    }
  })

  it('keeps every foreground AA even with conflicting surfaces, in every variant and mode', () => {
    const badContrast = { memory_theme: { surface: '#ffffff', panel: '#000000', text: '#777777', muted: '#777777', accent: '#777777',
      low: { surface: '#777777', panel: '#777777', accent: '#777777', dark: { surface: '#000000', panel: '#010101', accent: '#ffffff' } } } }
    for (const theme of [undefined, 'low']) for (const mode of ['light', 'dark'] as const) {
      const rendered = resolveMemoryTheme(badContrast, { theme, mode })
      for (const ink of ['text', 'muted', 'positive', 'danger'] as const) for (const background of ['surface', 'panel'] as const) {
        expect(memoryThemeContrast(rendered[ink], rendered[background])).toBeGreaterThanOrEqual(4.5)
      }
      expect(['#ffffff', '#0b0820']).toContain(rendered.accentText)
      expect(memoryThemeContrast(rendered.accentText, rendered.accent)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('substitutes a middle accent when both allowed foreground choices would fail', () => {
    expect(Math.max(memoryThemeContrast('#777777', '#ffffff'), memoryThemeContrast('#777777', '#0b0820'))).toBeLessThan(4.5)
    const resolved = resolveMemoryTheme({ memory_theme: { accent: '#777777' } })
    expect(resolved.accent).not.toBe('#777777')
    expect(memoryThemeContrast(resolved.accent, resolved.accentText)).toBeGreaterThanOrEqual(4.5)
  })

  it('only emits bounded CSS data and generic fonts, with no network-producing values', () => {
    const theme = resolveMemoryTheme(release, { theme: 'calm' })
    const style = memoryThemeStyle(theme)
    expect(Object.values(style).join(' ')).not.toMatch(/url\(|https?:|data:|@import|<|>/i)
    expect(style['--memory-accent-text']).toBe(theme.accentText)
    expect(style['--memory-radius']).toBe('8px')
    expect(MEMORY_COLOR_SLOTS).toHaveLength(8)
    expect(style.fontFamily).toBe('ui-monospace, monospace')
    expect(memoryThemeStyle(resolveMemoryTheme(release, { reducedMotion: true }))['--memory-motion-ms']).toBe('0ms')
  })
})
