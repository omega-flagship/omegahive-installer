import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import gallerySource from '../../shell/ChangeUi.tsx?raw'
import panelSource from './RequestPanel.tsx?raw'

/** "Request an experience", step 1: the tile is in the gallery of every experience, drawn only in tokens. */
vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} })

const { ExperienceList } = await import('../../shell/ChangeUi')
const { ALL_EXPERIENCES, EXPERIENCES } = await import('../../experiences/registry')
const { RequestExperience, RequestTile } = await import('./RequestPanel')

describe('the Request an experience tile', () => {
  it.each(ALL_EXPERIENCES.map((e) => [e.id] as const))('shows in the gallery while in %s, after the built-in experiences', (id) => {
    const html = renderToStaticMarkup(createElement(ExperienceList, { experiences: EXPERIENCES, showing: id, saved: 'classic', onPick: () => undefined, request: createElement(RequestExperience) }))
    expect(html).toContain('data-tour="experience-request"')
    expect(html).toContain('Request an experience')
    const last = Math.max(...EXPERIENCES.map((e) => html.indexOf(`data-tour="experience-${e.id}"`)))
    expect(html.indexOf('data-tour="experience-request"')).toBeGreaterThan(last)
  })
  it('the gallery mounts the tile in its Experiences list (one gallery for every experience)', () => {
    expect(gallerySource).toMatch(/<ExperienceList[^>]*request=\{<RequestExperience \/>\}/)
  })
  it('is drawn in the experience’s tokens: no colour literals, no motion of its own', () => {
    const html = renderToStaticMarkup(createElement(RequestTile, { onOpen: () => undefined }))
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|white|black/i)
    expect(panelSource).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|bg-white|bg-black|text-white|text-black/i)
    expect(panelSource).not.toMatch(/framer-motion|animate-/)
  })
})
