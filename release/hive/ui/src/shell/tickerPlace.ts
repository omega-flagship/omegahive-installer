/**
 * Where the hive's activity ticker sits on a phone (Platform sweep, phone hive 390x844: the line showed half-hidden
 * behind the Ask). Its old place (82px over the safe area), or clear above the Ask when the Ask stands higher
 * (--ask-room: the Ask's band from the bottom, features/ask/AskHost), whichever is higher.
 */
export const PHONE_TICKER_BOTTOM = 'max(calc(var(--sab) + 82px), calc(var(--ask-room, 0px) + 8px))'
/**
 * Where it sits on desktop (audit P2 #13: its fourth, fading line sat behind the Ask's left edge): its old place above
 * the dock, or clear above the Ask's band, whichever is higher.
 */
export const DESKTOP_TICKER_BOTTOM = 'max(calc(var(--hud-bottom, 0px) + 20px), calc(var(--ask-room, 0px) + 8px))'
