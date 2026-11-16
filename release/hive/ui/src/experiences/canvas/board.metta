; Purpose: where everything sits on the Canvas look's board: each swarm's island with its minds as cards and its tasks as
; stickies, the islands packed in shelves, the Decisions lane beside them (or across the top of a tall screen), and the
; empty board. Loaded into the arrangement space (screens/arrange/arrangeSpace.ts) with screens/arrange/lib_arrange.metta;
; the Canvas look states its swarms, minds, tasks and decisions in its own order for one call of board-compose and draws
; the answer.
;
; Stated by the look for one call:
;   (BoardAspect a)                       the board's width over its height
;   (BoardIslands ((Isle id swarm (mind ...) (active task ...) (done task ...) total) ...))
;                                         every island in the look's order; swarm is yes, or no for the unassigned minds;
;                                         active tasks in the order the look keeps them (stuck, waiting, in review, in
;                                         progress, open, then failed), done tasks newest first, and how many tasks it
;                                         has in all (cancelled ones too), so the ones it leaves off are counted
;   (BoardDecisions (decision ...))       the pending decisions, most urgent first
;   (BoardOpen mind)                      the mind whose chat card is open, if one is
;
; Answered: (CanvasArranged mode (IslandBox id x y w h cols (task ...) hidden) ... items lane bounds empty focus)
;   mode     column (the Decisions lane to the right) or row (a strip across the top)
;   items    ((BoardItem kind id island x y w h) ...): island, mind, goal, add, lane and decision
;   empty    the empty board's rectangle, or none
;   focus    the part of the lane the camera frames when the person goes to Decisions: its head and the first three
;   the open mind's chat card is an item of kind chat, at the mind's card and the chat's own size

; ---------- the board's sizes (px at 100%): a card is a mind's KindSize, a sticky a task's
(= (bd-card-w) (index-atom (arr-size mind) 0))
(= (bd-card-h) (index-atom (arr-size mind) 1))
(= (bd-sticky-w) (index-atom (arr-size task) 0))
(= (bd-sticky-h) (index-atom (arr-size task) 1))
(= (bd-gap) 20)
(= (bd-pad) 36)
(= (bd-head) 136)
(= (bd-sticky-gap) 18)
(= (bd-goals-inset) 44)
(= (bd-least-island) 520)
(= (bd-island-gap) 150)
(= (bd-lane-w) 316)
(= (bd-lane-head) 132)
(= (bd-decision-h) 236)
(= (bd-decision-gap) 22)
(= (bd-empty-w) 640)
(= (bd-empty-h) 380)
; an island shows up to this many active tasks, and fills an island of fewer than this many with done ones
(= (bd-active-shown) 8)
(= (bd-filled) 3)

; ---------- which tasks an island shows: the first active ones, then done ones to fill an island with fewer than three;
; the rest are counted
(= (bd-shown $active $done)
   (arr-join (arr-take $active (bd-active-shown))
             (arr-take $done (arr-larger 0 (- (bd-filled) (arr-smaller (size-atom $active) (bd-filled)))))))

; i mod n for counts MeTTa may hold as fractions (its ceiling and floor answer 2.0, and % takes whole numbers only)
(= (bd-mod $i $n) (- $i (* $n (floor-math (arr-div $i $n)))))

; ---------- one island's size, from its minds and the tasks it shows
(= (bd-cols $n) (if (<= $n 1) 1 (if (<= $n 4) 2 3)))
(= (bd-rows $n $cols) (ceil-math (arr-div $n $cols)))
(= (bd-cards-h $n $cols) (- (* (bd-rows $n $cols) (+ (bd-card-h) (bd-gap))) (bd-gap)))
(= (bd-cards-w $cols) (- (* $cols (+ (bd-card-w) (bd-gap))) (bd-gap)))
(= (bd-per-col $cardsh) (arr-larger 2 (floor-math (arr-div (+ $cardsh (bd-sticky-gap)) (+ (bd-sticky-h) (bd-sticky-gap))))))
(= (bd-gcols $slots $cardsh) (if (== $slots 0) 0 (if (<= $slots (bd-per-col $cardsh)) 1 2)))
(= (bd-goals-h $slots $gcols)
   (if (== $gcols 0) 0 (let $rows (ceil-math (arr-div $slots $gcols)) (- (* $rows (+ (bd-sticky-h) (bd-sticky-gap))) (bd-sticky-gap)))))
(= (bd-goals-w $gcols) (if (== $gcols 0) 0 (+ (bd-goals-inset) (- (* $gcols (+ (bd-sticky-w) (bd-sticky-gap))) (bd-sticky-gap)))))

; (Sized id swarm members shown hidden cols cardsh slots gcols w h): an island measured
(= (bd-size (Isle $id $swarm $members $active $done $total))
   (bd-size-with $id $swarm $members (if (== $swarm yes) (bd-shown $active $done) ())
                 (- $total (size-atom (if (== $swarm yes) (bd-shown $active $done) ())))
                 (arr-larger 1 (size-atom $members))))
(= (bd-size-with $id $swarm $members $shown $hidden $n)
   (bd-size-cols $id $swarm $members $shown $hidden (bd-cols $n) (bd-cards-h $n (bd-cols $n))
                 (if (== $swarm yes) (+ (size-atom $shown) 1) 0)))
(= (bd-size-cols $id $swarm $members $shown $hidden $cols $cardsh $slots)
   (bd-sized $id $swarm $members $shown $hidden $cols $cardsh $slots (bd-gcols $slots $cardsh)))
(= (bd-sized $id $swarm $members $shown $hidden $cols $cardsh $slots $gcols)
   (Sized $id $swarm $members $shown $hidden $cols $cardsh $slots $gcols
          (arr-larger (+ (* 2 (bd-pad)) (+ (bd-cards-w $cols) (bd-goals-w $gcols))) (bd-least-island))
          (+ (bd-head) (+ (arr-larger $cardsh (bd-goals-h $slots $gcols)) (bd-pad)))))
(= (bd-sizes $isles) (if (== $isles ()) () (arr-cons (bd-size (car-atom $isles)) (bd-sizes (cdr-atom $isles)))))

; ---------- shelf packing: rows no wider than the target, which follows the board's shape
(= (bd-area $sized) (if (== $sized ()) 0 (+ (bd-area-of (car-atom $sized)) (bd-area (cdr-atom $sized)))))
(= (bd-area-of (Sized $id $s $m $sh $hd $c $ch $sl $gc $w $h)) (* $w $h))
(= (bd-widest $sized) (if (== $sized ()) 0 (arr-larger (bd-w-of (car-atom $sized)) (bd-widest (cdr-atom $sized)))))
(= (bd-w-of (Sized $id $s $m $sh $hd $c $ch $sl $gc $w $h)) $w)
(= (bd-portrait $aspect) (< $aspect 0.85))
(= (bd-target $sized $aspect)
   (arr-larger (bd-widest $sized)
               (* (sqrt-math (* (bd-area $sized) (arr-larger 0.3 $aspect))) (if (bd-portrait $aspect) 1.05 1.2))))
; (Shelved placed right bottom): each island at its place, the right-most edge, the bottom of the last row
(= (bd-shelve $sized $target) (bd-shelf $sized $target 0 0 0 0))
(= (bd-shelf $sized $target $cx $cy $rowh $right)
   (if (== $sized ()) (Shelved () $right (+ $cy $rowh))
       (bd-shelf-one (car-atom $sized) (cdr-atom $sized) $target $cx $cy $rowh $right)))
(= (bd-shelf-one (Sized $id $s $m $sh $hd $c $ch $sl $gc $w $h) $rest $target $cx $cy $rowh $right)
   (if (and (> $cx 0) (> (+ $cx $w) $target))
       (bd-shelf-one (Sized $id $s $m $sh $hd $c $ch $sl $gc $w $h) $rest $target 0 (+ $cy (+ $rowh (bd-island-gap))) 0 $right)
       (bd-shelf-add (At (Sized $id $s $m $sh $hd $c $ch $sl $gc $w $h) $cx $cy)
                     (bd-shelf $rest $target (+ $cx (+ $w (bd-island-gap))) $cy (arr-larger $rowh $h) (arr-larger $right (+ $cx $w))))))
(= (bd-shelf-add $at (Shelved $placed $right $bottom)) (Shelved (arr-cons $at $placed) $right $bottom))

; ---------- what sits in an island: its minds as cards in a grid, its tasks as stickies in one or two columns, and the
; add-a-task sticky after them
(= (bd-island-items (At (Sized $id $swarm $members $shown $hd $cols $cardsh $slots $gcols $w $h) $x $y) $dy)
   (arr-join ((BoardItem island $id $id $x (+ $y $dy) $w $h))
             (arr-join (bd-cards $members 0 $cols $id $x (+ $y $dy))
                       (if (== $swarm yes) (bd-stickies $shown $id $x (+ $y $dy) $cols $slots $gcols) ()))))
(= (bd-cards $members $i $cols $id $x $y)
   (if (== $members ()) ()
       (arr-cons (BoardItem mind (car-atom $members) $id
                            (+ $x (+ (bd-pad) (* (bd-mod $i $cols) (+ (bd-card-w) (bd-gap)))))
                            (+ $y (+ (bd-head) (* (floor-math (arr-div $i $cols)) (+ (bd-card-h) (bd-gap)))))
                            (bd-card-w) (bd-card-h))
                 (bd-cards (cdr-atom $members) (+ $i 1) $cols $id $x $y))))
(= (bd-stickies $shown $id $x $y $cols $slots $gcols)
   (bd-sticky-list (arr-join $shown (arr-cons add-sticky ())) 0 $id (+ $x (+ (bd-pad) (+ (bd-cards-w $cols) (bd-goals-inset)))) $y
                   (ceil-math (arr-div $slots $gcols))))
(= (bd-sticky-list $ts $i $id $gx $y $per)
   (if (== $ts ()) ()
       (arr-cons (bd-sticky (car-atom $ts) $id (+ $gx (* (floor-math (arr-div $i $per)) (+ (bd-sticky-w) (bd-sticky-gap))))
                            (+ $y (+ (bd-head) (* (bd-mod $i $per) (+ (bd-sticky-h) (bd-sticky-gap))))))
                 (bd-sticky-list (cdr-atom $ts) (+ $i 1) $id $gx $y $per))))
(= (bd-sticky $t $id $x $y) (if (== $t add-sticky) (BoardItem add $id $id $x $y (bd-sticky-w) (bd-sticky-h)) (BoardItem goal $t $id $x $y (bd-sticky-w) (bd-sticky-h))))

; ---------- the whole board
(= (board-compose)
   (bd-compose (arr-one (collapse (match &self (BoardIslands $l) $l)) ())
               (arr-one (collapse (match &self (BoardDecisions $l) $l)) ())
               (arr-one (collapse (match &self (BoardAspect $a) $a)) 1.6)))
(= (bd-compose $isles $decisions $aspect) (bd-packed (bd-sizes $isles) $decisions $aspect))
(= (bd-packed $sized $decisions $aspect) (bd-laid (bd-shelve $sized (bd-target $sized $aspect)) $sized $decisions $aspect))
(= (bd-laid (Shelved $placed $right $bottom) $sized $decisions $aspect)
   (if (bd-portrait $aspect)
       (bd-top-lane $placed (if (== $sized ()) (bd-empty-w) $right) (if (== $sized ()) (bd-empty-h) $bottom) (== $sized ()) $decisions)
       (bd-side-lane $placed (if (== $sized ()) (bd-empty-w) $right) (if (== $sized ()) (bd-empty-h) $bottom) (== $sized ()) $decisions)))

(= (bd-boxes $placed $dy) (if (== $placed ()) () (arr-cons (bd-box (car-atom $placed) $dy) (bd-boxes (cdr-atom $placed) $dy))))
(= (bd-box (At (Sized $id $swarm $members $shown $hidden $cols $cardsh $slots $gcols $w $h) $x $y) $dy)
   (IslandBox $id $x (+ $y $dy) $w $h $cols $shown $hidden))
(= (bd-items $placed $dy) (if (== $placed ()) () (arr-join (bd-island-items (car-atom $placed) $dy) (bd-items (cdr-atom $placed) $dy))))
(= (bd-rect $x $y $w $h) (Rect $x $y $w $h))

; the Decisions lane to the right of the islands
(= (bd-side-lane $placed $right $contenth $empty $decisions)
   (bd-side-lane-at $placed $empty $decisions (+ $right (+ (bd-island-gap) 20))
     (arr-larger (arr-larger $contenth (+ (bd-lane-head) (+ (* (arr-larger 1 (size-atom $decisions)) (+ (bd-decision-h) (bd-decision-gap))) 24))) 520)))
(= (bd-side-lane-at $placed $empty $decisions $lanex $laneh)
   (CanvasArranged column (bd-boxes $placed 0)
          (arr-join (bd-with-chat (bd-items $placed 0))
                    (arr-cons (BoardItem lane decisions decisions $lanex 0 (bd-lane-w) $laneh)
                              (bd-side-decisions $decisions 0 (+ $lanex 20))))
          (bd-rect $lanex 0 (bd-lane-w) $laneh)
          (bd-rect 0 0 (+ $lanex (bd-lane-w)) $laneh)
          (if $empty (bd-rect 0 0 (bd-empty-w) (bd-empty-h)) none)
          (bd-rect $lanex 0 (bd-lane-w)
                   (arr-smaller $laneh (+ (bd-lane-head) (* (arr-larger 1 (arr-smaller 3 (size-atom $decisions))) (+ (bd-decision-h) (bd-decision-gap))))))))
(= (bd-side-decisions $ds $i $x)
   (if (== $ds ()) ()
       (arr-cons (BoardItem decision (car-atom $ds) decisions $x (+ (bd-lane-head) (* $i (+ (bd-decision-h) (bd-decision-gap)))) (- (bd-lane-w) 40) (bd-decision-h))
                 (bd-side-decisions (cdr-atom $ds) (+ $i 1) $x))))

; on a tall board the lane is a strip across the top, and the islands sit below it
(= (bd-top-lane $placed $right $contenth $empty $decisions)
   (bd-top-lane-at $placed $right $contenth $empty $decisions
     (arr-larger $right (+ 40 (+ (* (arr-larger 1 (size-atom $decisions)) (- (bd-lane-w) 40)) (* (- (arr-larger 1 (size-atom $decisions)) 1) (bd-decision-gap)))))
     (+ (bd-lane-head) (+ (bd-decision-h) 36))))
(= (bd-top-lane-at $placed $right $contenth $empty $decisions $lanew $laneh)
   (CanvasArranged row (bd-boxes $placed (+ $laneh (bd-island-gap)))
          (arr-join (bd-with-chat (bd-items $placed (+ $laneh (bd-island-gap))))
                    (arr-cons (BoardItem lane decisions decisions 0 0 $lanew $laneh)
                              (bd-top-decisions $decisions 0)))
          (bd-rect 0 0 $lanew $laneh)
          (bd-rect 0 0 (arr-larger $lanew $right) (+ (+ $laneh (bd-island-gap)) $contenth))
          (if $empty (bd-rect 0 (+ $laneh (bd-island-gap)) (bd-empty-w) (bd-empty-h)) none)
          (bd-rect 0 10 (arr-smaller $lanew (+ (bd-lane-w) 10)) (- $laneh 10))))
(= (bd-top-decisions $ds $i)
   (if (== $ds ()) ()
       (arr-cons (BoardItem decision (car-atom $ds) decisions (+ 20 (* $i (+ (- (bd-lane-w) 40) (bd-decision-gap)))) (bd-lane-head) (- (bd-lane-w) 40) (bd-decision-h))
                 (bd-top-decisions (cdr-atom $ds) (+ $i 1)))))

; ---------- the open mind's chat card: at its card, at the chat's own size
(= (bd-with-chat $items) (bd-chat-for (arr-one (collapse (match &self (BoardOpen $m) $m)) none) $items $items))
(= (bd-chat-for $open $all $items)
   (if (== $open none) $all
       (if (== $items ()) $all
           (bd-chat-step $open $all (car-atom $items) (cdr-atom $items)))))
(= (bd-chat-step $open $all (BoardItem $kind $id $isle $x $y $w $h) $rest)
   (if (and (== $kind mind) (== $id $open))
       (arr-join $all ((BoardItem chat $id $isle $x $y (index-atom (arr-size chat) 0) (index-atom (arr-size chat) 1))))
       (bd-chat-for $open $all $rest)))
