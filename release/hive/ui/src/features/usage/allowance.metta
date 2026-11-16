; Purpose: the battery meter, declared as atoms for the frame's usage region (screens/frame.metta; lib_screens.metta
; composes it): how much of the signed-in person's monthly allowance is left, and for an admin the hive cap, shown
; wherever each look shows usage, in classic's top bar after Spend and each other look's equivalent, on every page.
; Facts the frame states each time it composes (features/usage/allowance.ts: allowanceScreen): (on allowance.mine) when
; the person has a monthly allowance, and (on allowance.hive) when they are an admin of a hive with a cap. The data holds
; each battery's parts (dollars left, held and spent, the progress block's source) and its words ("$19 left", or "used
; up").

; the person's own allowance: what is left of it, at a glance
(RolePart frame 10 measure ((source allowance.mine.parts) (text (bind allowance.mine.left))))
(When frame 10 (on allowance.mine))
(Region frame 10 usage)
(Row frame 10 batteries)

; an admin's hive cap: on its own it needs no name; beside the person's own it says it is the hive's
(RolePart frame 20 measure ((source allowance.hive.parts) (text (bind allowance.hive.left))))
(When frame 20 (on allowance.hive))
(When frame 20 (off allowance.mine))
(Region frame 20 usage)
(Row frame 20 batteries)
(RolePart frame 21 measure ((source allowance.hive.parts) (text (words "hive " (bind allowance.hive.left)))))
(When frame 21 (on allowance.hive))
(When frame 21 (on allowance.mine))
(Region frame 21 usage)
(Row frame 21 batteries)
