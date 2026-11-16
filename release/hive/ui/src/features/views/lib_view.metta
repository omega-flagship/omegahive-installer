; Purpose: the language a mind writes a view in. A view is MeTTa the mind holds, the hive composes it with the same
; rules as its own screens (screens/lib_screens.metta), and the person's look draws it (screens/Screen.tsx).
;
; A view's text is declarations only. A line that starts with ! is refused, so nothing a mind wrote runs when the view
; loads. Each open view gets its own MeTTa space holding the standard library, lib_screens, looks, this file and the
; view's atoms (features/views/mettaView.ts), so a view cannot touch the hive's screens or another view.
;
; What a view declares:
;   (Screen tip "Tip calculator")                 exactly one screen; its parts, in order, are the screens vocabulary:
;   (Part tip 10 header ((title "Tip calculator")))     Part, RolePart, When, Row, Region, Depth
;   (Start bill "")                               a value the person can change, and where it starts
;   (= (value tip) (* (num (state bill)) 0.15))   a value worked out from the others; (bind tip) in a part shows it,
;                                                 and a part's When can test it
;   (= (on split) ((set people 2) (say "Split it")))   what a press does: set a value, or put words in the maker's
;                                                 message box for the person to send
; A press on a row of a list sends its id: (= (on open $id) ...); a tick sends whether it is now on: (= (on tick $id
; $on) ...). Helpers: (state key) is a value as it stands, (num x) a number from typed text ("" is 0), (fixed x 2)
; a number as text with that many decimals.
;
; Before each composition the runtime states facts from the values, so When works as on the hive's own screens:
; a list gives (count key) its length, a text gives (count key) 1 when it is not empty, a whole number n >= 0 gives
; (count key) n, True or False gives the flag key, and a number or a one-word text gives (is key value).

; ---------- the blocks a view may use. A block not listed here is refused, so a block added to the hive later is not a
; view's until it is listed. Left out on purpose: island (draws a part the hive's page offers), keyfield and reveal
; (they take or show a secret, so a view could pose as the hive asking for a key), stack (nests composed screens a
; view cannot make), line, orbs and orrery (they draw minds and swarms from the hive's own data).
(ViewBlock header)
(ViewBlock section)
(ViewBlock paragraph)
(ViewBlock note)
(ViewBlock notice)
(ViewBlock facts)
(ViewBlock tally)
(ViewBlock progress)
(ViewBlock list)
(ViewBlock cards)
(ViewBlock entries)
(ViewBlock chips)
(ViewBlock code)
(ViewBlock empty)
(ViewBlock waiting)
(ViewBlock fields)
(ViewBlock search)
(ViewBlock segmented)
(ViewBlock segments)
(ViewBlock tabs)
(ViewBlock pills)
(ViewBlock menus)
(ViewBlock switcher)
(ViewBlock toggles)
(ViewBlock chooser)
(ViewBlock rename)
(ViewBlock actions)
(ViewBlock buttons)
(ViewBlock confirm)
(ViewBlock disclosure)

; ---------- what the runtime asks of a view (each answers one value)
(= (view-blocks) (collapse (match &self (ViewBlock $b) $b)))
(= (view-screens) (collapse (match &self (Screen $s $t) $s)))
(= (view-starts) (collapse (match &self (Start $k $v) ($k $v))))
(= (view-values) (collapse (match &self (= (value $k) $body) $k)))
; parts, conditions and placements naming a screen the view did not declare: a typo that would draw nothing
(= (view-stray $s)
   (let* (($p (collapse (match &self (Part $x $o $b $props) (if (== $x $s) (empty) ($x $o)))))
          ($r (collapse (match &self (RolePart $x $o $role $props) (if (== $x $s) (empty) ($x $o)))))
          ($w (collapse (match &self (When $x $o $c) (if (== $x $s) (empty) ($x $o))))))
         (Stray $p $r $w)))
