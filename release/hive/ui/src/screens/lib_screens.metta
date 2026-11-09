; Screens composed by MeTTa. A screen is atoms: its parts, in order, the conditions each part needs, and either the
; block that draws it or only the role it plays (then the look decides the block). MeTTa decides what is drawn: which
; parts show for the facts of this moment, which block draws each, and what falls back when a block is missing. The
; browser only draws the answer (screens/Screen.tsx) and fills in the bound values.
;
; Written in the subset MeTTaScript runs (car-atom takes bound values only; every lookup goes through let).

; ---------- the blocks the renderer can draw: (Block name role)
(Block header heading)
(Block section group)
(Block search filter)
(Block chips tags)
(Block list collection)
(Block cards collection)
(Block facts details)
(Block toggles choices)
(Block notice message)
(Block empty absence)
(Block actions commands)
(Block segments pick)
(Block menus pick)
(Block entries collection)
(Block note message)
(Block waiting absence)
(Block confirm commands)
(Block reveal secret)
(Block island embed)
(Block tally summary)
(Block segmented filter)
(Block stack nest)
(Block line title)
(Block disclosure opener)
(Block code excerpt)
(Block keyfield entry)
(Block orbs crowd)
(Block chooser setting)
(Block buttons commands)
(Block tabs pick)
(Block pills pick)
(Block switcher filter)
(Block orrery circle)
(Block paragraph prose)
(Block fields form)
(Block rename naming)
(Block progress measure)

; which block a role uses when neither the screen nor the look decides (rank 1 is the default)
(Prefer heading header 1)
(Prefer group section 1)
(Prefer filter search 1)
(Prefer tags chips 1)
(Prefer collection list 1)
(Prefer collection cards 2)
(Prefer details facts 1)
(Prefer choices toggles 1)
(Prefer message notice 1)
(Prefer absence empty 1)
(Prefer commands actions 1)
(Prefer pick segments 1)
(Prefer pick menus 2)
(Prefer collection entries 3)
(Prefer message note 2)
(Prefer absence waiting 2)
(Prefer commands confirm 2)
(Prefer secret reveal 1)
(Prefer embed island 1)
(Prefer summary tally 1)
(Prefer filter segmented 2)
(Prefer nest stack 1)
(Prefer title line 1)
(Prefer opener disclosure 1)
(Prefer excerpt code 1)
(Prefer entry keyfield 1)
(Prefer crowd orbs 1)
(Prefer setting chooser 1)
(Prefer commands buttons 3)
(Prefer pick tabs 3)
(Prefer pick pills 4)
(Prefer filter switcher 3)
(Prefer circle orrery 1)
(Prefer prose paragraph 1)
(Prefer form fields 1)
(Prefer naming rename 1)
(Prefer measure progress 1)

; blocks a screen may ask for that nothing draws yet, by the role they play: each falls back to that role's block and
; becomes a build task
(Wants timeline collection)
(Wants gallery collection)
(Wants table collection)
(Wants chart details)
(Wants stepper choices)

; ---------- helpers
(= (scr-first $xs $default) (if (== $xs ()) $default (car-atom $xs)))
(= (scr-fact $k) (let $v (collapse (match &self (Fact $k $x) $x)) (scr-first $v none)))

; a condition on this moment's facts. A value is stored as (Val v) and compared the same way, so a word the standard
; library defines (member, empty, and …) is data here, never a call.
; Counts are (Fact (count <source>) n); flags are (Fact <flag> yes|no).
(= (scr-holds (has $src)) (let $n (scr-fact (count $src)) (if (== $n none) False (> $n 0))))
(= (scr-holds (none $src)) (let $n (scr-fact (count $src)) (if (== $n none) True (== $n 0))))
(= (scr-holds (on $flag)) (== (scr-fact $flag) yes))
(= (scr-holds (off $flag)) (if (== (scr-fact $flag) yes) False True))
(= (scr-holds (is $k $v)) (== (scr-fact $k) (Val $v)))
; (any (c …)) holds when one of its conditions holds; (none-of (c …)) when none does. (Not `not`: that is a standard
; library function, so a condition headed by it would be run, not matched.)
(= (scr-holds (any $cs)) (scr-any $cs))
(= (scr-holds (none-of $cs)) (if (scr-any $cs) False True))
(= (scr-any $cs)
   (if (== $cs ()) False
       (let* (($h (car-atom $cs)) ($t (cdr-atom $cs))) (if (scr-holds $h) True (scr-any $t)))))

; a part shows when none of its conditions fails
(= (scr-shown $s $o)
   (== (collapse (match &self (When $s $o $c) (if (scr-holds $c) (empty) $c))) ()))

; ---------- which block draws a part
; a role: the look's own choice, else the role's default
(= (scr-for-role $look $r)
   (let $lp (collapse (match &self (LookPrefers $look $r $b) $b))
        (if (== $lp ())
            (let $d (collapse (match &self (Prefer $r $b 1) $b)) (Use (scr-first $d none) role))
            (Use (car-atom $lp) look))))

(= (scr-mark-fallback (Use $b $how) $wanted) (Use $b (fallback $wanted)))

; a named block: itself when drawable; a wanted one falls back to its role's block; anything else is unknown
(= (scr-block $look $b)
   (let $r (collapse (match &self (Block $b $role) $role))
        (if (== $r ())
            (let $w (collapse (match &self (Wants $b $role) $role))
                 (if (== $w ())
                     (Use none (unknown $b))
                     (let* (($role (car-atom $w)) ($u (scr-for-role $look $role))) (scr-mark-fallback $u $b))))
            (Use $b direct))))

; ---------- depth: where a part sits in space. A flat look draws a layer as elevation (a shadow, a lift); a look
; with a 3D space (looks.metta: LookSpace) places it at that layer's distance from the person, nearest first.
(Layer ground 0)
(Layer surface 1)
(Layer raised 2)
(Layer float 3)
(RoleDepth heading float)
(RoleDepth message raised)
(RoleDepth commands raised)
(RoleDepth secret raised)
(RoleDepth filter raised)
(RoleDepth pick raised)
(RoleDepth absence surface)
(RoleDepth collection surface)
(RoleDepth details surface)
(RoleDepth choices surface)
(RoleDepth tags surface)
(RoleDepth group ground)
(RoleDepth embed surface)
(RoleDepth summary surface)
(RoleDepth nest surface)
(RoleDepth title surface)
(RoleDepth opener surface)
(RoleDepth excerpt surface)
(RoleDepth entry raised)
(RoleDepth crowd surface)
(RoleDepth setting surface)
(RoleDepth circle surface)
(RoleDepth prose surface)
(RoleDepth form surface)
(RoleDepth naming raised)
(RoleDepth measure surface)

; a part's layer: what the screen says for it, else its role's, else surface
(= (scr-role-of-block $b)
   (let $r (collapse (match &self (Block $b $role) $role))
        (if (== $r ()) (let $w (collapse (match &self (Wants $b $role) $role)) (scr-first $w none)) (car-atom $r))))
(= (scr-layer $s $o $role)
   (let $own (collapse (match &self (Depth $s $o $l) $l))
        (if (== $own ())
            (let $d (collapse (match &self (RoleDepth $role $l) $l)) (scr-first $d surface))
            (car-atom $own))))
; ---------- where a part sits on the page: its region (main, or aside: a side column on a wide screen) and its row
; (parts sharing a (Row s o name) are drawn side by side, wrapping on a narrow screen)
(= (scr-region $s $o) (let $r (collapse (match &self (Region $s $o $x) $x)) (scr-first $r main)))
(= (scr-row $s $o) (let $r (collapse (match &self (Row $s $o $x) $x)) (scr-first $r none)))

(= (scr-at $s $o $role)
   (let* (($l (scr-layer $s $o $role)) ($z (collapse (match &self (Layer $l $n) $n))) ($reg (scr-region $s $o)) ($row (scr-row $s $o)))
         (At $l (scr-first $z 1) $reg $row)))
(= (scr-space $look) (let $sp (collapse (match &self (LookSpace $look $k) $k)) (scr-first $sp flat)))

; ---------- the shared resource-state fragment: how a screen's data is loading, failed, refused or stale
; A screen that loads one resource declares it once, with the orders it may take from a base:
;   (Resource <screen> <base> ((noun "roles") (waiting "Loading roles") (unsupported "…") (forbidden "…")
;                             (failed "Could not load roles") (retry retry)))
; and the page states ONE standard set of facts (screens/resourceFacts.ts): the value resource (loading, ready,
; unsupported, forbidden or failed), the flags resource.stale (a refresh failed; the last data stays) and
; resource.empty, and the data key resource.error (why the last read failed). These rules add the standard parts:
;
;   piece          order    shows when                      drawn as (unless (part <piece> <block> <props>) says)
;   waiting        base+0   (is resource loading)           waiting: (waiting T), else "Loading <noun>"
;   unsupported    base+1   (is resource unsupported)       empty "Not available here": (unsupported body) [unsupported-icon]
;   forbidden      base+2   (is resource forbidden)         empty "Admins only": (forbidden body)
;   failed         base+3   (is resource failed)            notice "<failed>: <error>" (or "Could not load <noun>: …"),
;                                                           or (failed-title T): empty T with the error under it
;   retry          base+4   as failed                       Try again, sending (retry <intent>)
;   stale          base+5   ready and (on resource.stale)   notice "Could not refresh: <error> Showing the last loaded
;                                                           data." (with retry), or (stale T)
;   stale-reason   base+6   as stale                        (stale-reason label): a Reason row with the error
;   stale-retry    base+7   as stale                        Retry, sending (retry <intent>)
;
; A piece the declaration does not ask for is not drawn and takes no order. A screen without a forbidden piece shows
; its failed pieces when forbidden too. Texts are joined at draw time from (words "…" (bind resource.error) …).
(ResourcePiece waiting 0)
(ResourcePiece unsupported 1)
(ResourcePiece forbidden 2)
(ResourcePiece failed 3)
(ResourcePiece retry 4)
(ResourcePiece stale 5)
(ResourcePiece stale-reason 6)
(ResourcePiece stale-retry 7)
; the options a declaration may give
(ResourceOption noun)
(ResourceOption waiting)
(ResourceOption unsupported)
(ResourceOption unsupported-icon)
(ResourceOption forbidden)
(ResourceOption failed)
(ResourceOption failed-title)
(ResourceOption retry)
(ResourceOption stale)
(ResourceOption stale-reason)
; the blocks and tones the standard pieces are drawn with, kept as data (a block or tone name is never written into a
; rule's body, where a library word such as empty or warn could run)
(ResourceShape loading waiting)
(ResourceShape state empty)
(ResourceShape alert notice)
(ResourceShape press actions)
(ResourceShape rows facts)
(ResourceTone failing bad)
(ResourceTone stale warn)
(= (scr-res-shape $k) (let $b (collapse (match &self (ResourceShape $k $x) $x)) (car-atom $b)))
(= (scr-res-tone $k) (let $t (collapse (match &self (ResourceTone $k $x) $x)) (car-atom $t)))

; an option's value in ((key value) …), or none
(= (scr-opt $os $k)
   (if (== $os ()) none
       (let* (($h (car-atom $os)) ($t (cdr-atom $os)) ($hk (car-atom $h)))
             (if (and (== $hk $k) (== (size-atom $h) 2)) (let $r (cdr-atom $h) (car-atom $r)) (scr-opt $t $k)))))
; a whole piece the declaration draws its own way: (part <piece> <block> <props>), as (Piece block props), or none
(= (scr-res-override $os $piece)
   (if (== $os ()) none
       (let* (($h (car-atom $os)) ($t (cdr-atom $os)))
             (if (== (size-atom $h) 4)
                 (let* (($k (index-atom $h 0)) ($p (index-atom $h 1)) ($b (index-atom $h 2)) ($props (index-atom $h 3)))
                       (if (and (== $k part) (== $p $piece)) (Piece $b $props) (scr-res-override $t $piece)))
                 (scr-res-override $t $piece)))))

; each piece as the declaration asks for it, or none
(= (scr-res-piece $piece $os)
   (let $o (scr-res-override $os $piece) (if (== $o none) (scr-res-default $piece $os) $o)))
(= (scr-res-default waiting $os)
   (let* (($w (scr-opt $os waiting)) ($n (scr-opt $os noun)) ($b (scr-res-shape loading)))
         (if (== $w none)
             (if (== $n none) none (Piece $b ((label (words "Loading " $n)))))
             (Piece $b ((label $w))))))
(= (scr-res-default unsupported $os)
   (let* (($u (scr-opt $os unsupported)) ($i (scr-opt $os unsupported-icon)) ($b (scr-res-shape state)))
         (if (== $u none) none
             (if (== $i none)
                 (Piece $b ((title "Not available here") (body $u)))
                 (Piece $b ((icon $i) (title "Not available here") (body $u)))))))
(= (scr-res-default forbidden $os)
   (let* (($f (scr-opt $os forbidden)) ($b (scr-res-shape state)))
         (if (== $f none) none (Piece $b ((title "Admins only") (body $f))))))
(= (scr-res-default failed $os)
   (let* (($l (scr-opt $os failed)) ($ft (scr-opt $os failed-title)) ($n (scr-opt $os noun))
          ($alert (scr-res-shape alert)) ($state (scr-res-shape state)) ($tone (scr-res-tone failing)))
         (if (== $ft none)
             (if (== $l none)
                 (if (== $n none) none (Piece $alert ((tone $tone) (text (words "Could not load " $n ": " (bind resource.error))))))
                 (Piece $alert ((tone $tone) (text (words $l ": " (bind resource.error))))))
             (Piece $state ((title $ft) (body (bind resource.error)))))))
(= (scr-res-default retry $os)
   (let* (($i (scr-opt $os retry)) ($b (scr-res-shape press)))
         (if (== $i none) none
             (if (== (scr-res-piece failed $os) none) none (Piece $b ((items ((action "Try again" $i)))))))))
(= (scr-res-default stale $os)
   (let* (($st (scr-opt $os stale)) ($i (scr-opt $os retry)) ($b (scr-res-shape alert)) ($tone (scr-res-tone stale)))
         (if (== $st none)
             (if (== $i none) none
                 (Piece $b ((tone $tone) (text (words "Could not refresh: " (bind resource.error) " Showing the last loaded data.")))))
             (Piece $b ((tone $tone) (text $st))))))
(= (scr-res-default stale-reason $os)
   (let* (($l (scr-opt $os stale-reason)) ($b (scr-res-shape rows)))
         (if (== $l none) none (Piece $b ((label $l) (rows ((row "Reason" (bind resource.error)))))))))
(= (scr-res-default stale-retry $os)
   (let* (($i (scr-opt $os retry)) ($b (scr-res-shape press)))
         (if (== $i none) none
             (if (== (scr-res-piece stale $os) none) none (Piece $b ((items ((action "Retry" $i)))))))))

; when each piece shows, from the page's standard facts
(= (scr-res-failing $os)
   (if (scr-holds (is resource failed)) True
       (if (scr-holds (is resource forbidden)) (== (scr-res-piece forbidden $os) none) False)))
(= (scr-res-stale) (if (scr-holds (is resource ready)) (scr-holds (on resource.stale)) False))
(= (scr-res-holds waiting $os) (scr-holds (is resource loading)))
(= (scr-res-holds unsupported $os) (scr-holds (is resource unsupported)))
(= (scr-res-holds forbidden $os) (scr-holds (is resource forbidden)))
(= (scr-res-holds failed $os) (scr-res-failing $os))
(= (scr-res-holds retry $os) (scr-res-failing $os))
(= (scr-res-holds stale $os) (scr-res-stale))
(= (scr-res-holds stale-reason $os) (scr-res-stale))
(= (scr-res-holds stale-retry $os) (scr-res-stale))

; the pieces a screen's declaration draws now, as Drawn parts
(= (scr-res-draw $s $look $o (Piece $b $p))
   (let* (($u (scr-block $look $b)) ($at (scr-at $s $o (scr-role-of-block $b)))) (Drawn $o $u $p $at)))
(= (scr-res-one $s $look $base $os $piece $off)
   (let $pc (scr-res-piece $piece $os)
        (if (== $pc none) (empty)
            (if (scr-res-holds $piece $os) (scr-res-draw $s $look (+ $base $off) $pc) (empty)))))
(= (scr-res-drawn $s $look)
   (collapse (match &self (Resource $s $base $os)
                    (match &self (ResourcePiece $piece $off) (scr-res-one $s $look $base $os $piece $off)))))
; the orders a screen's declaration takes (one per piece it asks for)
(= (scr-res-orders $s)
   (collapse (match &self (Resource $s $base $os)
                    (match &self (ResourcePiece $piece $off)
                           (if (== (scr-res-piece $piece $os) none) (empty) (+ $base $off))))))

; a part's props are data: typed so they are carried as written, never evaluated (a key such as max, min or empty
; names a library function, and would otherwise run and drop the part)
(: Drawn (-> Atom Atom Atom Atom Atom))
; ---------- composing a screen for a look, from the facts in the space now
(= (scr-compose $s $look)
   (let* (($named (collapse (match &self (Part $s $o $b $p)
                     (if (scr-shown $s $o)
                         (let* (($u (scr-block $look $b)) ($at (scr-at $s $o (scr-role-of-block $b)))) (Drawn $o $u $p $at))
                         (empty)))))
          ($roled (collapse (match &self (RolePart $s $o $r $p)
                     (if (scr-shown $s $o)
                         (let* (($u (scr-for-role $look $r)) ($at (scr-at $s $o $r))) (Drawn $o $u $p $at))
                         (empty)))))
          ($res (scr-res-drawn $s $look))
          ($space (scr-space $look)))
         (Composed $s $look $named $roled $res $space)))

(= (scr-title $s) (let $t (collapse (match &self (Screen $s $title) $title)) (scr-first $t none)))
(= (scr-screens) (collapse (match &self (Screen $s $t) $s)))
(= (scr-blocks) (collapse (match &self (Block $b $r) $b)))
; every look a screen rule names (the build checks each is a real experience)
(= (scr-looks) (let* (($a (collapse (match &self (LookPrefers $l $r $b) $l))) ($b (collapse (match &self (LookSpace $l2 $k) $l2)))) (Looks $a $b)))
; every island a screen places, as (screen name) (the build checks each page offers it)
(= (scr-islands) (collapse (match &self (Part $s $o island $p) ($s $p))))

; every part order a screen has: its own parts, then the ones its resource declaration takes
(= (scr-orders $s)
   (let* (($a (collapse (match &self (Part $s $o $b $p) $o))) ($r (collapse (match &self (RolePart $s $o2 $r2 $p2) $o2)))
          ($f (scr-res-orders $s)))
         (Orders $a $r $f)))

; ---------- guards: each must answer () for the build to pass
; a part naming a block nothing draws and nothing wants
(= (scr-unknown-blocks)
   (collapse (match &self (Part $s $o $b $p)
                    (if (== (collapse (match &self (Block $b $r) $r)) ())
                        (if (== (collapse (match &self (Wants $b $r2) $r2)) ()) ($s $o $b) (empty))
                        (empty)))))
; a role with no default block
(= (scr-roles-without-default)
   (collapse (match &self (Block $b $r) (if (== (collapse (match &self (Prefer $r $x 1) $x)) ()) $r (empty)))))
; a look preferring a block that does not play that role
(= (scr-bad-look-prefs)
   (collapse (match &self (LookPrefers $l $r $b)
                    (if (== (collapse (match &self (Block $b $r) $b)) ()) ($l $r $b) (empty)))))
; a condition on a part the screen does not have
(= (scr-orphan-conditions)
   (collapse (match &self (When $s $o $c)
                    (if (and (== (collapse (match &self (Part $s $o $b $p) $o)) ())
                             (== (collapse (match &self (RolePart $s $o $r $p2) $o)) ()))
                        ($s $o) (empty)))))
; a depth naming a layer that does not exist
(= (scr-bad-depths)
   (collapse (match &self (Depth $s $o $l) (if (== (collapse (match &self (Layer $l $n) $n)) ()) ($s $o $l) (empty)))))
; a condition the rules do not know (a typo, or a library word such as not, which would run instead of match)
(: scr-known-cond (-> Expression Bool))
(= (scr-known-cond (has $x)) True)
(= (scr-known-cond (none $x)) True)
(= (scr-known-cond (on $x)) True)
(= (scr-known-cond (off $x)) True)
(= (scr-known-cond (is $k $v)) True)
(= (scr-known-cond (any $cs)) True)
(= (scr-known-cond (none-of $cs)) True)
(= (scr-bad-conditions)
   (collapse (match &self (When $s $o $c) (if (== (scr-known-cond $c) True) (empty) ($s $o)))))
; a region other than main or aside
(= (scr-bad-regions)
   (collapse (match &self (Region $s $o $r) (if (or (== $r main) (== $r aside)) (empty) ($s $o $r)))))
; a part on a screen nobody declared
(= (scr-undeclared-screens)
   (collapse (match &self (Part $s $o $b $p) (if (== (scr-title $s) none) $s (empty)))))
; a resource declaration that cannot draw as declared: on a screen nobody declared, declared twice, an option the
; fragment does not know (or a (part …) for a piece it does not have), or a piece whose order a part of the screen
; already has
(= (scr-res-known $h)
   (let* (($n (size-atom $h)) ($k (car-atom $h)))
         (if (== $n 2)
             (if (== (collapse (match &self (ResourceOption $k) $k)) ()) False True)
             (if (and (== $n 4) (== $k part))
                 (let $p (index-atom $h 1) (if (== (collapse (match &self (ResourcePiece $p $o) $o)) ()) False True))
                 False))))
(= (scr-res-unknown $os)
   (if (== $os ()) ()
       (let* (($h (car-atom $os)) ($t (cdr-atom $os)) ($rest (scr-res-unknown $t)))
             (if (scr-res-known $h) $rest (cons-atom $h $rest)))))
(= (scr-res-clash $s $o)
   (if (and (== (collapse (match &self (Part $s $o $b $p) $o)) ()) (== (collapse (match &self (RolePart $s $o $r $p2) $o)) ()))
       (empty) ($s $o clash)))
(= (scr-bad-resources)
   (let* (($undeclared (collapse (match &self (Resource $s $b $os) (if (== (scr-title $s) none) ($s undeclared) (empty)))))
          ($twice (collapse (match &self (Resource $s $b $os)
                                   (if (== (size-atom (collapse (match &self (Resource $s $b2 $os2) $b2))) 1) (empty) ($s twice)))))
          ($options (collapse (match &self (Resource $s $b $os) (let $u (scr-res-unknown $os) (if (== $u ()) (empty) ($s $u))))))
          ($clashes (collapse (match &self (Resource $s $b $os)
                                     (match &self (ResourcePiece $piece $off)
                                            (if (== (scr-res-piece $piece $os) none) (empty) (let $o (+ $b $off) (scr-res-clash $s $o))))))))
         (Bad $undeclared $twice $options $clashes)))
