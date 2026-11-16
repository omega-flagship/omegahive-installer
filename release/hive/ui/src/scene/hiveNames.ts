import type { Viewer } from './visibleSet'

/** Who is looking and the display names they may see, by principal (scene/viewer's state). */
export interface NamesState {
  viewer: Viewer
  names: Readonly<Record<string, string>>
}

/** A hive's label as this viewer may read it (Q1 default: the person's surname, the last word of their name). */
export function hiveLabel(hive: string, state: NamesState, own: string | null): string {
  if (hive === 'hive:cloud') return 'Cloud hive'
  if (own && hive === own) return 'Your hive'
  if (state.viewer.visitor) return 'A hive'
  const name = hive.startsWith('hive:') ? state.names[hive.slice(5)] : undefined
  const surname = name?.split(/\s+/).filter(Boolean).pop()
  return surname ? `${surname} hive` : 'A hive'
}

/** Words a person may call a hive by ("Ada's hive", "the Brightwater hive", "Ada Brightwater's hive"). */
export function hiveAliases(hive: string, state: NamesState, own: string | null): string[] {
  if (hive === 'hive:cloud') return ['cloud', 'the cloud', 'cloud hive', 'the cloud hive']
  if (own && hive === own) return ['my', 'mine', 'my own', 'your']
  if (state.viewer.visitor) return []
  const name = hive.startsWith('hive:') ? state.names[hive.slice(5)] : undefined
  if (!name) return []
  const words = name.split(/\s+/).filter(Boolean)
  return [...new Set([name, words[0], words[words.length - 1]].filter(Boolean))]
}

