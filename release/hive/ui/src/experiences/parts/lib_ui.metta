; lib_ui: the UI's named parts as a MeTTa AtomSpace (Surface one-experience r1, CANDIDATE).
;
; Every look draws the same few roles its own way (PLAN_ONE_EXPERIENCE_REST_TO_PRO_R1, "naming, linking and
; customization in a real AtomSpace"). The parts and their links are atoms in this space; these rules are the only
; way the Ask reads them (read-only in round 1: list and explain; no swapping or blending yet).
;
; Atoms (looks, states, roles, libraries, components and props are symbols; docs and dates are strings):
;   (UiPart look state name)            a part: its identity IS this expression
;   (UiRole part role)                  the concept it plays (shared roles: ω question field apps pro-gesture power)
;   (UiIn part state)                   the states it is on screen in
;   (UiNext state state transition)     how the shell moves between states
;   (UiImpl part library component)     what draws it (three.js, react, css, …) and which component
;   (UiSource component "path")         where that component lives in this repo (checked by parts.test.ts)
;   (UiSlot part prop)                  each customisable property (colour, motion, material, density, glyph, …)
;   (UiOwnedBy part part)               a look's presentation of a part one owner keeps (the one Ask, the one Ω)
;   (UiDoc part "plain words")          what it is, said plainly
;   (UiHistory part round what "date")  its history: which round added or changed it
;   (UiSharedRole role)                 a role every look provides (links a part to its counterparts in other looks)
;   (UiIntent part intent)              what the part means, as an intent of inventory/intents.metta (contract R1 §4):
;                                       its words are say-for look intent, so each look phrases it in its own voice
;
; Written in the subset MeTTaScript runs (let*, collapse, match), as lib_mind is.

(= (ui-parts $look $state)
   (collapse (match &self (UiPart $look $state $n) (UiPart $look $state $n))))

(= (ui-parts-of-look $look)
   (collapse (match &self (UiPart $look $state $n) (UiPart $look $state $n))))

; the parts in a state: the look's own, and the shell's that are on screen in it (the one Ask, …)
(= (ui-on-screen $look $state)
   (collapse (match &self (UiIn (UiPart $l $s $n) $state)
                    (if (or (== $l $look) (== $l shell)) (UiPart $l $s $n) (empty)))))

(= (ui-playing $look $role)
   (collapse (match &self (UiRole (UiPart $look $s $n) $role) (UiPart $look $s $n))))

(= (ui-playing-in $look $state $role)
   (collapse (match &self (UiRole (UiPart $look $state $n) $role) (UiPart $look $state $n))))

(= (ui-playing-anywhere $role)
   (collapse (match &self (UiRole $p $role) $p)))

(= (ui-roles-of $part) (collapse (match &self (UiRole $part $r) $r)))
(= (ui-states-of $part) (collapse (match &self (UiIn $part $s) $s)))
(= (ui-impls $part) (collapse (match &self (UiImpl $part $lib $c) ($lib $c))))
(= (ui-slots $part) (collapse (match &self (UiSlot $part $prop) $prop)))
(= (ui-docs $part) (collapse (match &self (UiDoc $part $d) $d)))
(= (ui-owners $part) (collapse (match &self (UiOwnedBy $part $o) $o)))
(= (ui-history $part) (collapse (match &self (UiHistory $part $round $what $when) ($round $what $when))))
(= (ui-next $from) (collapse (match &self (UiNext $from $to $tr) ($to $tr))))
(= (ui-shared-roles) (collapse (match &self (UiSharedRole $r) $r)))

; a part's counterparts: other looks' parts playing a role it plays (the links a later blend chooses among)
(= (ui-counterparts (UiPart $look $state $name))
   (collapse (match &self (UiRole (UiPart $look $state $name) $role)
                    (match &self (UiRole (UiPart $l2 $s2 $n2) $role)
                           (if (== $l2 $look) (empty) (UiPart $l2 $s2 $n2))))))

; everything the space links to one part, in one answer
(= (ui-explain $part)
   (let* (($roles (ui-roles-of $part))
          ($states (ui-states-of $part))
          ($impls (ui-impls $part))
          ($slots (ui-slots $part))
          ($docs (ui-docs $part))
          ($owners (ui-owners $part))
          ($history (ui-history $part))
          ($others (ui-counterparts $part)))
         (UiExplained $part $roles $states $impls $slots $docs $owners $history $others)))

; what draws the parts, and where each component lives (the source check reads these)
(= (ui-components) (collapse (match &self (UiImpl $p $lib $c) $c)))
(= (ui-source $c) (collapse (match &self (UiSource $c $path) $path)))

; ---------- parts and intents: one space (Ask-and-apps contract R1 §4). intents.metta is loaded beside these rules.
(= (ui-intents-of $part) (collapse (match &self (UiIntent $part $i) $i)))
; the words a look says for a part: the look's own phrase for each intent the part means, else the default
(= (ui-words $look $part) (collapse (match &self (UiIntent $part $i) (say-for $look $i))))
(= (ui-is-shared-role $r) (not (== (collapse (match &self (UiSharedRole $r) $r)) ())))
(= (ui-in-rest-or-awake $p) (not (== (collapse (match &self (UiIn $p $s) (if (or (== $s rest) (== $s awake)) $s (empty)))) ())))
(= (ui-has-intent $p) (not (== (collapse (match &self (UiIntent $p $i) $i)) ())))
; guard (must be empty for the build to pass): a rest or awake part playing a shared role with no intent
(= (ui-unbound-part-role)
   (collapse (match &self (UiRole $p $role)
                    (if (and (ui-is-shared-role $role) (ui-in-rest-or-awake $p))
                        (if (ui-has-intent $p) (empty) $p)
                        (empty)))))
; guard: a part bound to an intent the inventory doesn't define
(= (ui-unknown-intent)
   (collapse (match &self (UiIntent $p $i) (if (== (collapse (match &self (intent $i $k) $k)) ()) ($p $i) (empty)))))
