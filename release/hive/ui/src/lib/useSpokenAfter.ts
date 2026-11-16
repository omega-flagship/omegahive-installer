import { useEffect, useState } from 'react'

/**
 * Words for a polite live region, said a moment after they settle ("2 notices waiting."): `text` is what should be said
 * now, or null for nothing. A new text is said `delay` ms after it last changed, so a burst is said once, and until then
 * the words already said stay. Nothing to say (null) clears them at once, so a later text is said fresh, after the
 * delay again. The clear happens while rendering (React's pattern for state that follows a prop), never by setState in
 * an effect; only the timer sets the words.
 */
export function useSpokenAfter(text: string | null, delay = 1000): string {
  const [said, setSaid] = useState('')
  const [was, setWas] = useState(text)
  if (text !== was) {
    setWas(text)
    if (!text && said) setSaid('')
  }
  useEffect(() => {
    if (!text) return
    const timer = window.setTimeout(() => setSaid(text), delay)
    return () => window.clearTimeout(timer)
  }, [text, delay])
  return said
}
