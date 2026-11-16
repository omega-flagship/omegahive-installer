import { creationReference, type CreationReference } from './router'
/** Explicit producer metadata; never infer artifact custody from labels, kind or item ID. */
export function designCreation(meta: unknown): CreationReference | undefined {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const value = (meta as Record<string, unknown>).design_source
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  if (Object.keys(source).sort().join(',') !== 'reference,schema' ||
      (source.schema !== 'omega-studio-source-1' && source.schema !== 'omega-scene-deck-1')) return undefined
  return creationReference(source.reference)
}
