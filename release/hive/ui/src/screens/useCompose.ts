import { useEffect, useMemo } from 'react'
import { useHive } from '../store/store'
import { missingBlocks, onMissingBlock, reportMissing, screensRelease } from './buildTasks'
import { rememberedCompose, SCREEN_SOURCES, type Compose } from './screenSpace'

const RELEASE = screensRelease(SCREEN_SOURCES)

/** The page's composer for the look being worn: kept answers, and a plain notice instead of a crash. Blocks a screen
 *  asked for that nothing draws yet are reported to the hive, which files one task each (best-effort). */
export function useCompose(look: string): Compose {
  const client = useHive((s) => s.client)
  useEffect(() => {
    const send = client?.reportMissingBlocks?.bind(client)
    if (!send) return
    if (missingBlocks().length) reportMissing(send, RELEASE)
    return onMissingBlock(() => reportMissing(send, RELEASE))
  }, [client])
  return useMemo(() => rememberedCompose(look), [look])
}
