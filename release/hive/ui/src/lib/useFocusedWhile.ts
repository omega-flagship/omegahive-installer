import { useState } from 'react'

/**
 * Whether a field is focused, for a field that exists only while `present`: its input unmounts when it goes away, and
 * an unmounted input fires no blur, so `focused` would still say true when it comes back unfocused. Going away clears it
 * while rendering (never by setState in an effect).
 */
export function useFocusedWhile(present: boolean): [boolean, (focused: boolean) => void] {
  const [focused, setFocused] = useState(false)
  if (!present && focused) setFocused(false)
  return [focused, setFocused]
}
