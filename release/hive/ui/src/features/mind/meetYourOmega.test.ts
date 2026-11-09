import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { useFlDoor } from '../firstlight/door'
import { MeetYourOmega } from './PersonalMindLink'

afterEach(() => useFlDoor.getState().close())

describe('"Meet your omega" on You (#/me): the explicit way back into First Light', () => {
  it('is a plain button that asks for live First Light through the one door', () => {
    const html = renderToStaticMarkup(createElement(MeetYourOmega))
    expect(html).toContain('Meet your omega')
    expect(html).toContain('type="button"')
    expect(useFlDoor.getState().asked).toBeNull()
    const el = MeetYourOmega() as { props: { onClick: () => void } }
    el.props.onClick()
    expect(useFlDoor.getState().asked).toMatchObject({ mode: 'live' })
  })
})
