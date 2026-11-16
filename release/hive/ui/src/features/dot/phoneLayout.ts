/**
 * How tall a mind's sheet opens on a phone (demo audit P1 #6): tall enough that the chat shows a conversation, not one
 * or two lines under the header, while the top of the hive stays in view above it. Was 66dvh.
 */
export const DOT_PHONE_PEEK_GAP_PX = 128
export const DOT_PHONE_PEEK = `calc(100dvh - ${DOT_PHONE_PEEK_GAP_PX}px - var(--sat))`
