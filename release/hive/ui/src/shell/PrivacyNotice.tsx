import { useEffect } from 'react'
import { useHive } from '../store/store'
import { announcePrivacyNote } from './privacyNote'

/** Mounted once by App: tells a signed-in person in a hive with others, once per page load and sign-in, that per-person privacy is not in
 *  place yet (shell/privacyNote). Renders nothing itself (the note is a notice in the shared lane). */
export function PrivacyNotice({ signedIn }: { signedIn: boolean }) {
  const ready = useHive((s) => s.ready)
  const session = useHive((s) => s.session)
  const mode = useHive((s) => s.client?.mode)
  useEffect(() => {
    void announcePrivacyNote(signedIn)
  }, [signedIn, ready, session, mode])
  return null
}
