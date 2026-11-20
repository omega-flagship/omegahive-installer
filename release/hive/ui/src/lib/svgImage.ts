// Purpose: turn a saved SVG document into an image URL for the browser's image decoder.

export const SVG_MIME = 'image/svg+xml'

export function svgImageSource(body: string): string {
  // The Unicode flag matches lone surrogates here and leaves valid pairs intact for encodeURIComponent.
  const text = body.replace(/[\uD800-\uDFFF]/gu, '\uFFFD')
  return `data:${SVG_MIME};charset=utf-8,${encodeURIComponent(text)}`
}
