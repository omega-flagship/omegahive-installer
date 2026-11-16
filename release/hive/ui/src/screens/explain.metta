; Purpose: why a screen part is there: everything the space knows about one part, in one answer, for the Ask ("what is this?",
; "why is this showing?"). Read-only; it uses the same atoms the composer decides with (lib_screens.metta), so the
; explanation can never disagree with what was drawn.

; the block or role a part names, as declared
(= (scr-declared $s $o)
   (let* (($b (collapse (match &self (Part $s $o $blk $p) (block $blk))))
          ($r (collapse (match &self (RolePart $s $o $role $p2) (role $role)))))
         (scr-first $b (scr-first $r none))))

; its conditions, as declared
(= (scr-conditions $s $o) (collapse (match &self (When $s $o $c) $c)))

; its role: the one it names, else its block's role
(= (scr-role-of-declared (block $b)) (scr-role-of-block $b))
(= (scr-role-of-declared (role $r)) $r)
(= (scr-role-of-declared none) none)

; the words a person reads for a role (the Ask's answers use these, never the atom names)
(RoleWords heading "the page's heading")
(RoleWords group "a section heading")
(RoleWords filter "a way to narrow what is shown")
(RoleWords tags "a row of tags")
(RoleWords collection "a list of things")
(RoleWords details "facts about this thing")
(RoleWords choices "switches you can turn on or off")
(RoleWords message "a notice")
(RoleWords absence "what shows when there is nothing here")
(RoleWords commands "buttons")
(RoleWords embed "a panel drawn by the page itself")
(RoleWords summary "a summary of counts")
(RoleWords nest "a list where each item has its own parts")
(RoleWords title "a name with its status")
(RoleWords opener "a row that opens to show more")
(RoleWords excerpt "a command and what it printed")
(RoleWords secret "a value shown once")
(RoleWords pick "a choice of what to show")
(RoleWords entry "a field for a key")
(RoleWords crowd "the minds that use this")
(RoleWords setting "a choice that changes a record")
(RoleWords circle "the minds of a group, circling it")
(RoleWords prose "a paragraph of words")
(RoleWords form "fields to fill in")
(RoleWords naming "a field for changing a name")
(RoleWords measure "a bar showing how far along it is")
(RoleWords utterance "words someone said, as they said them")
(RoleWords collapsed "something put away to its mark, which opens it again")
(RoleWords figure "a picture, such as one of your screen")
(= (scr-role-words $r) (let $w (collapse (match &self (RoleWords $r $x) $x)) (scr-first $w "a part of this page")))

; ---------- the shared resource states (lib_screens.metta Resource): composed, not declared, so explained from the
; screen's Resource declaration. A piece the declaration does not ask for is not there, and explains as nothing. What
; each needs is said of the declaration's own resource: (state v) is (is <name> v), (flag f) is (on <name>.f), so a piece
; of an unnamed declaration needs (is resource loading) or (on resource.stale), and one of (name limits) (is limits …).
(ResourcePieceSays waiting absence "what shows while this page loads" (state loading))
(ResourcePieceSays unsupported absence "what shows when this hive does not offer this" (state unsupported))
(ResourcePieceSays forbidden absence "what shows when only an admin may see this" (state forbidden))
(ResourcePieceSays failed message "what shows when this could not be read" (state failed))
(ResourcePieceSays retry commands "a button to try reading it again" (state failed))
(ResourcePieceSays stale message "a note that the last data is shown because a refresh failed" (flag stale))
(ResourcePieceSays stale-reason details "why the refresh failed" (flag stale))
(ResourcePieceSays stale-retry commands "a button to try the refresh again" (flag stale))
(= (scr-res-cond $os (state $v)) (let $n (scr-res-name $os) (is $n $v)))
(= (scr-res-cond $os (flag $f)) (let $k (scr-res-key $os $f) (on $k)))

; the piece at an order, with the declaration it belongs to, as (At piece options), or none
(= (scr-res-piece-at $s $o)
   (let $hits (collapse (match &self (Resource $s $base $os)
                               (match &self (ResourcePiece $p $n)
                                      (if (== (+ $base $n) $o)
                                          (if (scr-res-drawable (scr-res-piece $p $os)) (At $p $os) (empty))
                                          (empty)))))
        (scr-first $hits none)))

(= (scr-explain-resource $s $o (At $p $os))
   (let $says (collapse (match &self (ResourcePieceSays $p $role $words $when) (Says $role $words $when)))
        (scr-explain-resource-says $s $o $p $os (car-atom $says))))
(= (scr-explain-resource-says $s $o $p $os (Says $role $words $when))
   (let* (($cond (scr-res-cond $os $when)) ($layer (scr-layer $s $o $role)))
         (Why $s $o (resource $p) $role $words ($cond) main none $layer)))

; one answer: (Why screen order declared role words conditions region row layer)
(= (scr-explain $s $o)
   (let $d (scr-declared $s $o)
        (if (== $d none)
            (let $p (scr-res-piece-at $s $o)
                 (if (== $p none) (scr-explain-declared $s $o $d) (scr-explain-resource $s $o $p)))
            (scr-explain-declared $s $o $d))))

(= (scr-explain-declared $s $o $d)
   (let* (($role (scr-role-of-declared $d))
          ($words (scr-role-words $role))
          ($cs (scr-conditions $s $o))
          ($reg (scr-region $s $o))
          ($row (scr-row $s $o))
          ($layer (scr-layer $s $o $role)))
         (Why $s $o $d $role $words $cs $reg $row $layer)))

; every role a block plays has words (the build checks this)
(= (scr-roles-without-words)
   (collapse (match &self (Block $b $r) (if (== (collapse (match &self (RoleWords $r $w) $w)) ()) $r (empty)))))
