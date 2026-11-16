import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AnswerParagraph } from './answerText'

const html = (text: string) => renderToStaticMarkup(createElement(AnswerParagraph, { text, mark: (t: string) => t, className: 'ask-answer' }))

// Jon, 4 Nov: the thread showed "- **First attempt:** I used a request type…" literally
describe('answer markdown, the little minds write', () => {
  it('bullets become a list and **bold** is bold; no asterisks left', () => {
    const out = html('- **First attempt:** I used a request type the hive does not accept.\n- **Second attempt:** I tried a Studio session.')
    expect(out).toMatch(/^<ul class="ask-answer" data-answer-list="">/)
    expect(out).toContain('<li><strong>First attempt:</strong> I used a request type the hive does not accept.</li>')
    expect(out).not.toContain('**')
  })
  it('bold inside a sentence; a heading marker dropped; ordinary text untouched', () => {
    expect(html('The headline is **Nine Lives**, with subtext.')).toBe('<p class="ask-answer">The headline is <strong>Nine Lives</strong>, with subtext.</p>')
    expect(html('## Poster brief')).toBe('<p class="ask-answer">Poster brief</p>')
    expect(html('5 * 3 = 15, and a - b')).toBe('<p class="ask-answer">5 * 3 = 15, and a - b</p>')
  })
  it('nothing is turned into markup: angle brackets stay text', () => {
    expect(html('**<b>x</b>**')).toBe('<p class="ask-answer"><strong>&lt;b&gt;x&lt;/b&gt;</strong></p>')
  })
})
