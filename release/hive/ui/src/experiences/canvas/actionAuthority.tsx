import { createContext, useContext, type ReactNode } from 'react'
import { useVisibleAuthority } from '../../lib/useVisibleAuthority'

const CanvasCurrent = createContext<() => boolean>(() => false)
export const useCanvasCurrent = () => useContext(CanvasCurrent)

/** The retained Board is owned only by the native hive's Pro presentation. */
export function CanvasActionBoundary({ children }: { children: ReactNode }) {
  const current = useVisibleAuthority('hive-pro', true, 'canvas-board')
  return <CanvasCurrent.Provider value={current}>{children}</CanvasCurrent.Provider>
}
