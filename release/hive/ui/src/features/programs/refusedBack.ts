import { closePage, navigate } from '../../lib/router'

/** Back from a refused app with no caller's exit (Kimi town-r3 #4): back through history where it was reached in the
 *  hive, else Home. A caller's exit still wins. */
export const refusedBack = (onExit?: () => void): (() => void) => onExit ?? (() => closePage(() => navigate({ name: 'hive' })))
