/**
 * Artifact ids in a mind's words. A mind names what it saved by id (hive/templates/omega/prompt.txt), and the hive
 * draws a view under the message that names it (features/views/MessageViews). A person reads the artifact's title in
 * the id's place (the words MeTTa composes in every look, features/views/Words), or words where only words fit (withoutIds), and never the id, the way
 * an MCP Apps host shows a tool's ui:// resource under the call and never in its text.
 */

/** An artifact id as the hive makes them (db.new_id("ar"): "ar_" and 32 hex digits). */
const ID = 'ar_[0-9a-f]{32}'
/** An id alone, or a code span holding only an id (`ar_…` in any run of backticks), which reads as the id itself. */
const REF = new RegExp(`(\`+)(${ID})\\1|\\b(${ID})\\b`, 'g')

export type RefPiece = { text: string; ref?: undefined } | { ref: string; text?: undefined }

/** The text cut at each artifact id, in order. Time: one pass over the text. */
export function refPieces(text: string): RefPiece[] {
  const out: RefPiece[] = []
  let from = 0
  for (const m of text.matchAll(REF)) {
    const at = m.index ?? 0
    if (at > from) out.push({ text: text.slice(from, at) })
    out.push({ ref: m[2] ?? m[3] })
    from = at + m[0].length
  }
  if (from < text.length) out.push({ text: text.slice(from) })
  return out
}

/** The distinct artifact ids a text names, in the order it names them. */
export const namedArtifacts = (text: string): string[] => [...new Set(refPieces(text).flatMap((p) => (p.ref === undefined ? [] : [p.ref])))]

/** What an id reads as where only words fit (a preview, a line of activity, a reply as it streams in). */
export const UNNAMED_ARTIFACT = 'an artifact'

/** The text with every artifact id said as words (UNNAMED_ARTIFACT), never as the id. */
export const withoutIds = (text: string): string => text.replace(REF, UNNAMED_ARTIFACT)
