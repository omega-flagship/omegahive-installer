/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HIVE_URL?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  __hiveScene?: {
    screenPos(id: string): { x: number; y: number; r: number } | null
    focus(id: string): void
    /** the shown galaxies as drawn (ids of shown hives only; world and screen places), for UI checks */
    galaxies(): { id: string; cloud: boolean; x: number; y: number; r: number; sx: number; sy: number; sr: number; open: boolean; visible: boolean }[]
    overview(): void
    handleAt(x: number, y: number): string | null
    /** the galaxy names' screen boxes as last drawn (CSS px), for layout checks (sim/dev only) */
    labels(): { id: string; left: number; top: number; right: number; bottom: number }[]
  }
  /** Sim mode only: the in-browser hive, to act as another client. */
  __hiveSim?: import('./api/client').HiveClient
}
