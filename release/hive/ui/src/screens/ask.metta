; Purpose: the Ask on every page in every look, declared as atoms (lib_screens.metta composes them): the mark it
; collapses to, and the region its look's own Ask sits in at each of the person's sizes. Jon, 16 Nov, on an Ask that
; collapses to the Omega, is a bubble in the centre, or fills the left half: "100% the vision". MeTTa composes it for
; the look being worn; features/ask/AskHost.tsx draws the answer (features/ask/askScreen.ts), placing nothing itself.
;
; Facts AskHost states each time:
;   value ask.size   collapsed | bubble | half    the person's size (features/ask/askSize.ts), kept on their hive
;   value ask.mode   desktop | landscape | phone  the kind of screen (features/ask/placement.ts askMode)
;   flag  ask.drawn  the host draws the look's Ask on this page (not an experience's own field, an app's frame, or a
;                    look at rest)
;
; The look's own Ask (its field and thread, features/ask/skins.ts) is the page's island `ask`. An island is one element
; wherever MeTTa places it (screens/Screen.tsx keys it by name), so what the person typed stays while the size
; changes. Its (region …) says how it lays itself out:
;   mark       hidden behind the mark, still mounted
;   bubble     the look's own place, its thread rising, pinned or a sheet as before
;   half-left  the left half from top to bottom, the thread above the field; the stage arranges in the rest
;   sheet      the thread as a full-height sheet with the field at its foot (a phone has no half to spare)

(Screen ask "The Ask")

; collapsed: the Ask's own living Omega at the start of its row, which opens it again at the size it was collapsed from
(Part ask 10 mark ((glyph ask-glyph) (label (bind ask.mark.label)) (title (bind ask.mark.title)) (state (bind ask.state))
  (news ask.news) (left (bind ask.left)) (bottom (bind ask.bottom)) (mode (bind ask.mode)) (action open-ask)))
(When ask 10 (is ask.size collapsed))
(When ask 10 (on ask.drawn))

(Part ask 20 island ((name ask) (region mark)))
(When ask 20 (is ask.size collapsed))
(Part ask 21 island ((name ask) (region bubble)))
(When ask 21 (is ask.size bubble))
(Part ask 22 island ((name ask) (region half-left)))
(When ask 22 (is ask.size half))
(When ask 22 (none-of ((is ask.mode phone))))
(Part ask 23 island ((name ask) (region sheet)))
(When ask 23 (is ask.size half))
(When ask 23 (is ask.mode phone))
