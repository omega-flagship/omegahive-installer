import { create } from 'zustand'

/**
 * Which teams' folded helper groups (scene/helperGroups) are open, shared by every look that draws the map, so a group
 * opened in one look is open in another. Per page session; nothing is stored.
 */
interface HelperGroupsOpen {
  expanded: ReadonlySet<string>
  toggle(id: string): void
}

export const useHelperGroups = create<HelperGroupsOpen>()((set) => ({
  expanded: new Set<string>(),
  toggle: (id) =>
    set((s) => {
      const next = new Set(s.expanded)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { expanded: next }
    }),
}))
