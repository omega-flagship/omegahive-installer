; Purpose: arrange what a mind or a person shows on the hive's stage: what is in view, where it sits and how big it is.
; The page states this moment's atoms for one call of arr-compose (screens/arrange/arrangeSpace.ts) and removes them
; before the call returns, so an arrangement is a function of what is stated. Every decision is made here; the page
; only draws the answer.
;
; Stated by the page for one call:
;   (Stage w h)                    the stage's size in px
;   (Item key source stored)       something that can be shown: source artifact, mind, task, decision, message or part
;                                  (a part of the open page's composed screen); for an artifact, stored is its stored
;                                  kind (free text on the hive), for a part its block's role, otherwise none
;   (ItemShape key w h)            the item's own shape, w wide by h high in any unit (a picture's pixels), once the
;                                  page knows it: shown, the item takes its kind's area in that shape
;   (Relates key task)             the item belongs to the task (the mind that showed it, the task's holder, the task)
;   (Ranked task ((key n) ...))    the items with interest in the task, n times in view with it, highest first
;   (Shares dir (kinds ...) (shares ...))   the shares a person last dragged a split of these kinds to
;   (Log (statement ...))          what was said, newest first: (Show k t) (Recall k) (Compare a b t) (PutAway k) (Clear)
;   (Episode n)                    the newest statement's number, echoed in Seen so the page credits interest once
;   (Dragging group i at)          a divider in the person's hand: the i-th divider of the group named by its first
;                                  item, at that fraction of the group's length
;
; Answered: (Arranged mode task placed dividers tray (Seen n keys) unknown)
;   mode      home, focus, side or compare
;   placed    ((Placed key kind role x y w h) ...): role shown, or beside for an item in a strip beside what is shown
;   dividers  ((Divider group i dir x y w h lo hi kinds shares offset room) ...): lo and hi bound the divider, as
;             fractions of the group's length; kinds and shares are what a drag of it teaches; a pointer at p along the
;             group's direction puts the divider at (p - offset) / room, the `at` a drag states
;   tray      the shown items put away, newest first, that a press brings back
;   unknown   keys the log names that the page does not have
;
; A word in data is never a function's name (min, max, first, empty and not are library functions and would run).

; ---------- kinds: the size each is drawn at when shown, and the least it is drawn at (px at 100%)
(KindSize image 640 480)
(KindSize text 560 400)
(KindSize view 720 520)
(KindSize artifact 420 300)
(KindSize mind 268 184)
(KindSize task 204 156)
(KindSize decision 276 236)
(KindSize message 440 180)
(KindSize chat 404 548)
(KindSize part 360 240)
(KindLeast image 200 150)
(KindLeast text 220 140)
(KindLeast view 280 200)
(KindLeast artifact 180 120)
(KindLeast mind 180 124)
(KindLeast task 150 116)
(KindLeast decision 200 170)
(KindLeast message 200 90)
(KindLeast chat 320 360)
(KindLeast part 200 120)

; an artifact's stored kind to the kind it is drawn as; any other stored kind is drawn as artifact
(KindOf image image)
(KindOf photo image)
(KindOf picture image)
(KindOf diagram image)
(KindOf svg image)
(KindOf note text)
(KindOf text text)
(KindOf plan text)
(KindOf description text)
(KindOf document text)
(KindOf view view)

; ---------- the stage's spacing (px): the margin round its edge and the gap between tiles
(= (arr-margin) 24)
(= (arr-gap) 12)

; ---------- list helpers. A grounded list operation does not evaluate its arguments, so each is wrapped in an
; equation whose arguments MeTTa evaluates first (a let costs about 0.3 ms in MeTTaScript; a call far less).
(= (arr-one $xs $d) (if (== $xs ()) $d (car-atom $xs)))
(= (arr-cons $h $t) (cons-atom $h $t))
(= (arr-rest $xs) (cdr-atom $xs))
(= (arr-some $xs) (if (== $xs ()) False True))
(= (arr-leaf $c) (== (get-metatype $c) Symbol))
; a quotient as a fraction: on two whole numbers MeTTaScript's / divides whole (7 / 2 is 3)
(= (arr-div $a $b) (/ (* 1.0 $a) $b))
(= (arr-in $x $xs) (if (== $xs ()) False (if (== $x (car-atom $xs)) True (arr-in $x (cdr-atom $xs)))))
(= (arr-join $xs $ys) (if (== $xs ()) $ys (arr-cons (car-atom $xs) (arr-join (cdr-atom $xs) $ys))))
(= (arr-minus $xs $ys) (if (== $xs ()) () (arr-keep-unless (car-atom $xs) (arr-minus (cdr-atom $xs) $ys) $ys)))
(= (arr-keep-unless $x $rest $ys) (if (arr-in $x $ys) $rest (arr-cons $x $rest)))
(= (arr-reverse $xs) (arr-reverse-onto $xs ()))
(= (arr-reverse-onto $xs $acc) (if (== $xs ()) $acc (arr-reverse-onto (cdr-atom $xs) (arr-cons (car-atom $xs) $acc))))
(= (arr-sum $xs) (if (== $xs ()) 0 (+ (car-atom $xs) (arr-sum (cdr-atom $xs)))))
(= (arr-take $xs $n) (if (or (== $xs ()) (< $n 1)) () (arr-cons (car-atom $xs) (arr-take (cdr-atom $xs) (- $n 1)))))
(= (arr-smaller $a $b) (if (< $a $b) $a $b))
(= (arr-larger $a $b) (if (> $a $b) $a $b))
(= (arr-clamp $v $lo $hi) (arr-larger $lo (arr-smaller $v $hi)))

; ---------- items
(= (arr-known $k) (if (== (collapse (match &self (Item $k $s $x) $s)) ()) False True))
(= (arr-only-known $ks) (if (== $ks ()) () (arr-keep-if-known (car-atom $ks) (arr-only-known (cdr-atom $ks)))))
(= (arr-keep-if-known $k $rest) (if (arr-known $k) (arr-cons $k $rest) $rest))
(= (arr-kind $k) (arr-one (collapse (match &self (Item $k $s $x) (arr-drawn $s $x))) none))
(= (arr-drawn artifact $x) (arr-one (collapse (match &self (KindOf $x $d) $d)) artifact))
(= (arr-drawn mind $x) mind)
(= (arr-drawn task $x) task)
(= (arr-drawn decision $x) decision)
(= (arr-drawn message $x) message)
(= (arr-drawn part $x) part)
(= (arr-size $kind) (arr-one (collapse (match &self (KindSize $kind $w $h) ($w $h))) (420 300)))
(= (arr-least $kind) (arr-one (collapse (match &self (KindLeast $kind $w $h) ($w $h))) (180 120)))

; ---------- what the log asks for: walking from the newest statement back to the newest Show, Compare or Clear.
; (View how task anchored recalled gone): anchored is what the anchor named; recalled, oldest first, what was recalled
; after it; gone, what was put away after it. An older Recall or PutAway is undone by a newer one of the same item.
(= (arr-view $log) (arr-walk $log () ()))
(= (arr-walk $log $r $g) (if (== $log ()) (View clear none () $r $g) (arr-step (car-atom $log) (cdr-atom $log) $r $g)))
(= (arr-step (Show $k $t) $rest $r $g) (View show $t ($k) $r $g))
(= (arr-step (Compare $a $b $t) $rest $r $g) (View compare $t ($a $b) $r $g))
(= (arr-step (Clear) $rest $r $g) (View clear none () $r $g))
(= (arr-step (Recall $k) $rest $r $g) (arr-walk $rest (arr-recall $k $r $g) $g))
(= (arr-step (PutAway $k) $rest $r $g) (arr-walk $rest $r (arr-cons $k $g)))
(= (arr-recall $k $r $g) (if (arr-in $k $g) $r (if (arr-in $k $r) $r (arr-cons $k $r))))

; every key the log names since the stage last emptied (its newest Clear), newest first, each once
(= (arr-named $log) (arr-dedupe (arr-named-all $log) ()))
(= (arr-named-all $log) (if (== $log ()) () (arr-named-from (car-atom $log) (cdr-atom $log))))
(= (arr-named-from $s $rest) (if (== $s (Clear)) () (arr-join (arr-keys-of $s) (arr-named-all $rest))))
(= (arr-keys-of (Show $k $t)) ($k))
(= (arr-keys-of (Compare $a $b $t)) ($a $b))
(= (arr-keys-of (Recall $k)) ($k))
(= (arr-keys-of (PutAway $k)) ($k))
(= (arr-keys-of (Clear)) ())
(= (arr-dedupe $xs $seen) (if (== $xs ()) () (arr-dedupe-step (car-atom $xs) (cdr-atom $xs) $seen)))
(= (arr-dedupe-step $x $rest $seen) (if (arr-in $x $seen) (arr-dedupe $rest $seen) (arr-cons $x (arr-dedupe $rest (arr-cons $x $seen)))))

; ---------- composing: the page's one call
(= (arr-compose) (arr-from-log (arr-one (collapse (match &self (Log $l) $l)) ())))
(= (arr-from-log $log) (arr-from-view (arr-view $log) (arr-named $log)))
(= (arr-from-view (View $how $t $anchored $r $g) $named)
   (arr-arrange $how $t (arr-only-known (arr-minus $anchored $g)) (arr-only-known (arr-minus $r $anchored)) $g $named))
(= (arr-stage) (arr-one (collapse (match &self (Stage $w $h) ($w $h))) (1280 800)))
(= (arr-episode) (arr-one (collapse (match &self (Episode $n) $n)) 0))

; the view's items, and how they are arranged: nothing; one shown alone; a compared pair; or side by side
(= (arr-arrange $how $t $anchored $recalled $gone $named)
   (arr-by-count $how $t (arr-join $anchored $recalled) $anchored $recalled $gone $named))
(= (arr-by-count $how $t $items $anchored $recalled $gone $named)
   (if (== $items ()) (arr-home $named)
       (if (== (cdr-atom $items) ()) (arr-focus $t (car-atom $items) $gone $named (arr-stage))
           (if (and (== $how compare) (and (== $recalled ()) (== (size-atom $anchored) 2)))
               (arr-lay-root compare $t (Group column $anchored) $named (arr-stage))
               (arr-lay-root side $t (arr-side-root $how $anchored $recalled (arr-along-stage (arr-stage))) $named (arr-stage))))))
; side by side: the anchor first (a compared pair stays one column within the row), then each recalled item, along the
; stage's longer side, as a tiling window manager splits a tall screen top to bottom (i3's default orientation auto)
(= (arr-side-root $how $anchored $recalled $dir)
   (if (and (== $how compare) (== (size-atom $anchored) 2))
       (Group $dir (arr-cons (Group column $anchored) $recalled))
       (Group $dir (arr-join $anchored $recalled))))
(= (arr-along-stage ($w $h)) (if (>= $w $h) row column))

; the answer: the tray is every named, known item not placed (none at home, where the stage draws nothing)
(= (arr-answer $mode $t $placed $dividers $seen $named)
   (Arranged $mode $t $placed $dividers (arr-tray $mode $placed $named) (Seen (arr-episode) (arr-credit $t $seen))
             (arr-unknown $named)))
(= (arr-tray home $placed $named) ())
; at home the open page is in view again: its parts are credited with the newest task said, once for this statement, as
; anything in view with a task is
(= (arr-home $named) (arr-answer home (arr-newest-task (arr-one (collapse (match &self (Log $l) $l)) ())) () () (arr-page-parts) $named))
(= (arr-page-parts) (collapse (match &self (Item $k part $role) $k)))
(= (arr-newest-task $log) (if (== $log ()) none (arr-task-or-older (car-atom $log) (cdr-atom $log))))
(= (arr-task-or-older $s $rest) (arr-task-of $s (arr-newest-task $rest)))
(= (arr-task-of (Show $k $t) $older) (if (== $t none) $older $t))
(= (arr-task-of (Compare $a $b $t) $older) (if (== $t none) $older $t))
(= (arr-task-of (Recall $k) $older) $older)
(= (arr-task-of (PutAway $k) $older) $older)
(= (arr-task-of (Clear) $older) $older)
(= (arr-tray focus $placed $named) (arr-minus (arr-only-known $named) (arr-placed-keys $placed)))
(= (arr-tray side $placed $named) (arr-minus (arr-only-known $named) (arr-placed-keys $placed)))
(= (arr-tray compare $placed $named) (arr-minus (arr-only-known $named) (arr-placed-keys $placed)))
(= (arr-placed-keys $placed) (if (== $placed ()) () (arr-cons (arr-key-of (car-atom $placed)) (arr-placed-keys (cdr-atom $placed)))))
(= (arr-key-of (Placed $k $kind $role $x $y $w $h)) $k)
; interest is kept per task, so an arrangement without one credits nothing
(= (arr-credit $t $seen) (if (== $t none) () $seen))
(= (arr-unknown $named) (if (== $named ()) () (arr-unknown-step (car-atom $named) (arr-unknown (cdr-atom $named)))))
(= (arr-unknown-step $k $rest) (if (arr-known $k) $rest (arr-cons $k $rest)))

; ---------- one item shown: in the centre at its kind's size, which gives way to the stage's bounds (a preferred size
; under a required bound, as in Cassowary), and the task's other items in strips beside it
(= (arr-focus $t $k $gone $named ($sw $sh))
   (arr-focus-at $t $k (arr-shown-size $k) (arr-candidates $t $k $gone) $named $sw $sh))
; the size an item is shown at: its kind's, or, once the page knows the item's own shape, the kind's area in that shape,
; so a tall picture is shown tall and a wide one wide, as X11's size hints give a window its own aspect
(= (arr-shown-size $k) (arr-in-shape (arr-size (arr-kind $k)) (collapse (match &self (ItemShape $k $w $h) ($w $h)))))
(= (arr-in-shape $size ()) $size)
(= (arr-in-shape ($kw $kh) (($w $h))) (arr-shaped (* $kw $kh) (arr-div $w $h)))
(= (arr-shaped $area $r) (let $fw (sqrt-math (* $area $r)) ($fw (arr-div $area $fw))))
(= (arr-focus-at $t $k ($fw $fh) $cands $named $sw $sh)
   (arr-focus-scaled $t $k $fw $fh $cands $named $sw $sh
     (arr-smaller 1 (arr-smaller (arr-div (arr-room-w $cands $sw $sh) $fw) (arr-div (arr-room-h $cands $sw $sh) $fh)))))
; the room the focused item may take: all of the stage inside its margin, less two strips when there are items for
; them, each strip as wide (or, on a tall stage, as tall) as the smallest of those items may be drawn
(= (arr-room-w $cands $sw $sh)
   (if (and (>= $sw $sh) (arr-some $cands)) (- $sw (* 2 (+ (arr-margin) (+ (arr-strip-for row $cands) (arr-gap))))) (- $sw (* 2 (arr-margin)))))
(= (arr-room-h $cands $sw $sh)
   (if (and (< $sw $sh) (arr-some $cands)) (- $sh (* 2 (+ (arr-margin) (+ (arr-strip-for column $cands) (arr-gap))))) (- $sh (* 2 (arr-margin)))))
(= (arr-strip-for $dir $cands) (arr-min-of (arr-least-lens $dir $cands)))
(= (arr-min-of $xs) (if (== (arr-rest $xs) ()) (car-atom $xs) (arr-smaller (car-atom $xs) (arr-min-of (cdr-atom $xs)))))
(= (arr-focus-scaled $t $k $fw0 $fh0 $cands $named $sw $sh $s)
   (arr-focus-placed $t $k (* $fw0 $s) (* $fh0 $s) $cands $named $sw $sh))
(= (arr-focus-placed $t $k $fw $fh $cands $named $sw $sh)
   (arr-with-strips $t (Placed $k (arr-kind $k) shown (arr-div (- $sw $fw) 2) (arr-div (- $sh $fh) 2) $fw $fh) $cands $named $sw $sh))
(= (arr-with-strips $t (Placed $k $kind $role $x $y $w $h) $cands $named $sw $sh)
   (arr-focus-answer $t (Placed $k $kind $role $x $y $w $h)
     (if (>= $sw $sh) (arr-side-strips $cands $x $w $sw $sh) (arr-top-strips $cands $y $h $sw $sh)) $named))
(= (arr-focus-answer $t $focus $strips $named)
   (arr-answer focus $t (arr-cons $focus $strips) () (arr-placed-keys (arr-cons $focus $strips)) $named))

; the strip candidates: the items with interest in the task, highest first, then the items related to it; never the
; focused item, one put away since the anchor, or one the page does not have. An item with neither is not drawn
; (Kersten and Murphy's Mylar: an element with no interest is filtered from view).
(= (arr-candidates $t $k $gone)
   (if (== $t none) ()
       (arr-only-known (arr-minus (arr-dedupe (arr-join (arr-ranked $t) (arr-related $t)) ()) (arr-cons $k $gone)))))
(= (arr-ranked $t) (arr-interested (arr-one (collapse (match &self (Ranked $t $l) $l)) ())))
(= (arr-interested $l) (if (== $l ()) () (arr-interested-step (car-atom $l) (arr-interested (cdr-atom $l)))))
(= (arr-interested-step ($k $n) $rest) (if (> $n 0) (arr-cons $k $rest) $rest))
(= (arr-related $t) (collapse (match &self (Relates $k $t) $k)))

; strips left and right of the focused item: each item goes in the shorter strip (masonry's rule), as wide as the strip
; and never wider than its kind's size, at its kind's aspect; an item that fits in neither, or would be drawn smaller
; than its kind's least size, is not drawn
(= (arr-side-strips $cands $fx $fw $sw $sh)
   (arr-side-fill $cands (- (- $fx (arr-gap)) (arr-margin)) (arr-margin) (+ (+ $fx $fw) (arr-gap)) (arr-margin) (arr-margin) $sh))
(= (arr-side-fill $cands $stripw $lx $rx $ly $ry $sh)
   (if (== $cands ()) ()
       (arr-side-one (car-atom $cands) (cdr-atom $cands) (arr-kind (car-atom $cands)) $stripw $lx $rx $ly $ry $sh)))
(= (arr-side-one $k $rest $kind $stripw $lx $rx $ly $ry $sh)
   (arr-side-thumb $k $rest $kind (arr-size $kind) (arr-least $kind) $stripw $lx $rx $ly $ry $sh))
(= (arr-side-thumb $k $rest $kind ($cw $ch) ($lw $lh) $stripw $lx $rx $ly $ry $sh)
   (arr-side-put $k $rest $kind (arr-smaller $stripw $cw) (arr-div (* (arr-smaller $stripw $cw) $ch) $cw) $lw $stripw $lx $rx $ly $ry $sh))
(= (arr-side-put $k $rest $kind $w $h $lw $stripw $lx $rx $ly $ry $sh)
   (if (or (< $w $lw) (> (+ (arr-smaller $ly $ry) $h) (- $sh (arr-margin))))
       (arr-side-fill $rest $stripw $lx $rx $ly $ry $sh)
       (if (<= $ly $ry)
           (arr-cons (Placed $k $kind beside $lx $ly $w $h) (arr-side-fill $rest $stripw $lx $rx (+ (+ $ly $h) (arr-gap)) $ry $sh))
           (arr-cons (Placed $k $kind beside $rx $ry $w $h) (arr-side-fill $rest $stripw $lx $rx $ly (+ (+ $ry $h) (arr-gap)) $sh)))))

; on a tall stage the strips run above and below, each item as tall as the strip at its kind's aspect
(= (arr-top-strips $cands $fy $fh $sw $sh)
   (arr-top-fill $cands (- (- $fy (arr-gap)) (arr-margin)) (arr-margin) (+ (+ $fy $fh) (arr-gap)) (arr-margin) (arr-margin) $sw))
(= (arr-top-fill $cands $striph $ty $by $tx $bx $sw)
   (if (== $cands ()) ()
       (arr-top-one (car-atom $cands) (cdr-atom $cands) (arr-kind (car-atom $cands)) $striph $ty $by $tx $bx $sw)))
(= (arr-top-one $k $rest $kind $striph $ty $by $tx $bx $sw)
   (arr-top-thumb $k $rest $kind (arr-size $kind) (arr-least $kind) $striph $ty $by $tx $bx $sw))
(= (arr-top-thumb $k $rest $kind ($cw $ch) ($lw $lh) $striph $ty $by $tx $bx $sw)
   (arr-top-put $k $rest $kind (arr-div (* (arr-smaller $striph $ch) $cw) $ch) (arr-smaller $striph $ch) $lh $striph $ty $by $tx $bx $sw))
(= (arr-top-put $k $rest $kind $w $h $lh $striph $ty $by $tx $bx $sw)
   (if (or (< $h $lh) (> (+ (arr-smaller $tx $bx) $w) (- $sw (arr-margin))))
       (arr-top-fill $rest $striph $ty $by $tx $bx $sw)
       (if (<= $tx $bx)
           (arr-cons (Placed $k $kind beside $tx $ty $w $h) (arr-top-fill $rest $striph $ty $by (+ (+ $tx $w) (arr-gap)) $bx $sw))
           (arr-cons (Placed $k $kind beside $bx $by $w $h) (arr-top-fill $rest $striph $ty $by $tx (+ (+ $bx $w) (arr-gap)) $sw)))))

; ---------- several items: a tree of row and column groups over the stage inside its margin (react-mosaic's split
; node: a direction, children, one share per child). A group's children start at equal shares (i3: 1 / children when
; no percent is set); the shares a person dragged a split of the same kinds to are used instead (one remembered layout
; per combination, as react-resizable-panels keeps per combination of panel ids), a pair read in either order.
(= (arr-lay-root $mode $t $root $named ($sw $sh))
   (arr-root-answer $mode $t (arr-lay $root (arr-margin) (arr-margin) (- $sw (* 2 (arr-margin))) (- $sh (* 2 (arr-margin)))) $named))
(= (arr-root-answer $mode $t (Laid $placed $dividers) $named)
   (arr-answer $mode $t $placed $dividers (arr-placed-keys $placed) $named))

; a leaf fills its cell; a group shares its length among its children, less the gaps between them. (One equation
; each, dispatching on the atom's metatype: a pattern $k would also match a group, and both equations would answer.)
(= (arr-lay $c $x $y $w $h)
   (if (arr-leaf $c) (Laid ((Placed $c (arr-kind $c) shown $x $y $w $h)) ()) (arr-lay-group-of $c $x $y $w $h)))
(= (arr-lay-group-of (Group $dir $children) $x $y $w $h)
   (arr-lay-group $dir $children (arr-group-id $children) (arr-kinds $children) $x $y $w $h))
(= (arr-group-id $children) (arr-first-leaf (car-atom $children)))
(= (arr-first-leaf $c) (if (arr-leaf $c) $c (arr-first-leaf-of $c)))
(= (arr-first-leaf-of (Group $dir $cs)) (arr-first-leaf (car-atom $cs)))
(= (arr-kinds $cs) (if (== $cs ()) () (arr-cons (arr-kind-or-group (car-atom $cs)) (arr-kinds (cdr-atom $cs)))))
(= (arr-kind-or-group $c) (if (arr-leaf $c) (arr-kind $c) group))

(= (arr-lay-group $dir $cs $id $kinds $x $y $w $h)
   (arr-lay-shared $dir $cs $id $kinds (arr-dragged $id (arr-shares $dir $kinds (size-atom $cs)) (arr-leasts $dir $cs $w $h)) $x $y $w $h))
(= (arr-lay-shared $dir $cs $id $kinds $shares $x $y $w $h)
   (arr-lay-children $dir $cs $shares $id $kinds $shares (arr-leasts $dir $cs $w $h) 0 0 $x $y $w $h
     (- (arr-length $dir $w $h) (* (arr-gap) (- (size-atom $cs) 1)))))
(= (arr-length row $w $h) $w)
(= (arr-length column $w $h) $h)

; each child at its share of the room; the divider after it, in the gap, unless it is the last
(= (arr-lay-children $dir $cs $ss $id $kinds $all $leasts $i $before $x $y $w $h $room)
   (if (== $cs ()) (Laid () ())
       (arr-lay-child $dir (car-atom $cs) (cdr-atom $cs) (car-atom $ss) (cdr-atom $ss) $id $kinds $all $leasts $i $before $x $y $w $h $room)))
(= (arr-lay-child $dir $c $rest $s $ss $id $kinds $all $leasts $i $before $x $y $w $h $room)
   (arr-merge (arr-lay-cell $dir $c (* $room $s) $x $y $w $h)
              (arr-divider-after $dir $rest $id $kinds $all $leasts $i (+ $before $s) (* $room $s) $x $y $w $h $room)
              (arr-lay-children $dir $rest $ss $id $kinds $all $leasts (+ $i 1) (+ $before $s) (arr-next-x $dir $x (* $room $s)) (arr-next-y $dir $y (* $room $s)) $w $h $room)))
(= (arr-lay-cell row $c $len $x $y $w $h) (arr-lay $c $x $y $len $h))
(= (arr-lay-cell column $c $len $x $y $w $h) (arr-lay $c $x $y $w $len))
(= (arr-next-x row $x $len) (+ (+ $x $len) (arr-gap)))
(= (arr-next-x column $x $len) $x)
(= (arr-next-y row $y $len) $y)
(= (arr-next-y column $y $len) (+ (+ $y $len) (arr-gap)))
; the divider between child i and i+1 sits in the gap; it moves between the least each of the two may be drawn at.
; Its centre is at offset + room x (the shares up to it): offset is the group's start, the gaps before it and half its own
(= (arr-divider-after $dir $rest $id $kinds $all $leasts $i $upto $len $x $y $w $h $room)
   (if (== $rest ()) ()
       ((Divider $id $i $dir (arr-div-x $dir $x $len) (arr-div-y $dir $y $len) (arr-div-w $dir $w) (arr-div-h $dir $h)
                 (+ (- $upto (index-atom $all $i)) (index-atom $leasts $i))
                 (- (+ $upto (index-atom $all (+ $i 1))) (index-atom $leasts (+ $i 1)))
                 $kinds $all
                 (- (+ (arr-along $dir $x $y) (+ $len (arr-div (arr-gap) 2))) (* $room $upto)) $room))))
(= (arr-along row $x $y) $x)
(= (arr-along column $x $y) $y)
(= (arr-div-x row $x $len) (+ $x $len))
(= (arr-div-x column $x $len) $x)
(= (arr-div-y row $y $len) $y)
(= (arr-div-y column $y $len) (+ $y $len))
(= (arr-div-w row $w) (arr-gap))
(= (arr-div-w column $w) $w)
(= (arr-div-h row $h) $h)
(= (arr-div-h column $h) (arr-gap))
(= (arr-merge (Laid $p1 $d1) $d (Laid $p2 $d2)) (Laid (arr-join $p1 $p2) (arr-join $d1 (arr-join $d $d2))))

; the least share each child may take: its kind's least length over the group's room (a group child: the largest
; least of its own children, so a compared pair keeps both halves drawable)
(= (arr-leasts $dir $cs $w $h) (arr-leasts-of $dir $cs (- (arr-length $dir $w $h) (* (arr-gap) (- (size-atom $cs) 1)))))
(= (arr-leasts-of $dir $cs $room) (if (== $cs ()) () (arr-cons (arr-div (arr-least-len $dir (car-atom $cs)) $room) (arr-leasts-of $dir (cdr-atom $cs) $room))))
(= (arr-least-len $dir $c) (if (arr-leaf $c) (arr-least-dir $dir (arr-least (arr-kind $c))) (arr-group-least $dir $c)))
(= (arr-least-dir row ($w $h)) $w)
(= (arr-least-dir column ($w $h)) $h)
(= (arr-group-least $dir (Group $d $cs)) (arr-max-of (arr-least-lens $dir $cs)))
(= (arr-least-lens $dir $cs) (if (== $cs ()) () (arr-cons (arr-least-len $dir (car-atom $cs)) (arr-least-lens $dir (cdr-atom $cs)))))
(= (arr-max-of $xs) (if (== $xs ()) 0 (arr-larger (car-atom $xs) (arr-max-of (cdr-atom $xs)))))

; the shares: learned for these kinds, the pair reversed, or equal
(= (arr-shares $dir $kinds $n)
   (arr-one (collapse (match &self (Shares $dir $kinds $s) $s)) (arr-shares-reversed $dir $kinds $n)))
; a pattern is data, so the reversed kinds are computed before the match reads them
(= (arr-shares-reversed $dir $kinds $n) (if (== $n 2) (arr-shares-of-reversed $dir (arr-reverse $kinds)) (arr-equal $n)))
(= (arr-shares-of-reversed $dir $reversed) (arr-reverse (arr-one (collapse (match &self (Shares $dir $reversed $s) $s)) (arr-equal 2))))
(= (arr-equal $n) (arr-repeat (/ 1.0 $n) $n))
(= (arr-repeat $v $n) (if (< $n 1) () (arr-cons $v (arr-repeat $v (- $n 1)))))

; a divider in the person's hand moves share between its two neighbours only (i3's resize_neighboring_cons), never
; past either one's least
(= (arr-dragged $id $shares $leasts)
   (arr-one (collapse (match &self (Dragging $id $i $at) (arr-drag-shares $shares $leasts $i $at))) $shares))
(= (arr-drag-shares $shares $leasts $i $at)
   (arr-drag-pair $shares $i (arr-sum (arr-take $shares $i)) (+ (index-atom $shares $i) (index-atom $shares (+ $i 1)))
     (arr-clamp $at (+ (arr-sum (arr-take $shares $i)) (index-atom $leasts $i))
                (- (+ (arr-sum (arr-take $shares $i)) (+ (index-atom $shares $i) (index-atom $shares (+ $i 1)))) (index-atom $leasts (+ $i 1))))))
(= (arr-drag-pair $shares $i $before $pair $at) (arr-set-pair $shares $i 0 (- $at $before) (- $pair (- $at $before))))
(= (arr-set-pair $ss $i $j $a $b)
   (if (== $ss ()) ()
       (if (== $j $i) (arr-cons $a (arr-cons $b (arr-rest (arr-rest $ss))))
           (arr-cons (car-atom $ss) (arr-set-pair (cdr-atom $ss) $i (+ $j 1) $a $b)))))

; ---------- guards: each answers () when the vocabulary is whole
; a kind something is drawn as, with no size or no least size
(= (arr-kinds-without-size)
   (collapse (match &self (KindOf $s $k) (if (== (collapse (match &self (KindSize $k $w $h) $w)) ()) $k (empty)))))
(= (arr-kinds-without-least)
   (collapse (match &self (KindSize $k $w $h) (if (== (collapse (match &self (KindLeast $k $w2 $h2) $w2)) ()) $k (empty)))))
; a least size larger than the size it gives way from
(= (arr-least-above-size)
   (collapse (match &self (KindLeast $k $lw $lh)
                    (let $s (arr-size $k) (if (or (> $lw (index-atom $s 0)) (> $lh (index-atom $s 1))) $k (empty))))))
