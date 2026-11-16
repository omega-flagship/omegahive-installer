import type { Scene, SceneElement } from './model'
import { sceneProblem, validFontFamily } from './model'
import { svg as nativeSvg, wrapText as nativeWrap } from './native/scene.mjs'

/**
 * How a scene is drawn: Design's own native `wrapText` and `svg` (./native/scene.mjs, vendored byte-exact), so the
 * canvas draws what Design's drawing would. The downloaded picture is an unverified mirror of it.
 */

export const LINE = 1.2

/** Design's own portable wrapping (native `wrapText`): explicit breaks stay paragraph boundaries; not font measurement. */
export const wrapText = (e: Pick<SceneElement, 'text' | 'fontSize' | 'width' | 'height'>): { lines: string[]; overflow: boolean } => nativeWrap(e)

export const fontOf = (e: SceneElement): string => (e.fontFamily !== undefined && validFontFamily(e.fontFamily) ? e.fontFamily : 'Arial')

/**
 * The scene as a standalone SVG document: Design's own `svg()`, run here in the canvas. It is the canvas's mirror of
 * Design's drawing, not Design's verified export (that runs only as a mind-held Studio action). Throws a plain sentence.
 */
export function sceneSvg(scene: Scene): string {
  const problem = sceneProblem(scene)
  if (problem) throw new Error(problem)
  return nativeSvg(scene)
}

/** A file name for the picture: the title in plain words, or "design". */
export const pictureName = (scene: Scene): string => `${(scene.title || 'design').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'design'}.svg`
