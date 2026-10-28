import { useEffect, useState } from 'react'

/** Re-render every `ms` while the tab is visible. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let t = 0
    const arm = () => {
      clearInterval(t)
      if (!document.hidden) t = window.setInterval(() => setNow(Date.now()), ms)
    }
    arm()
    const vis = () => {
      if (!document.hidden) setNow(Date.now())
      arm()
    }
    document.addEventListener('visibilitychange', vis)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', vis)
    }
  }, [ms])
  return now
}
