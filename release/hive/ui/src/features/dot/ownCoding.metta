; A mind's own coding, in its settings (screens/lib_screens.metta composes it). Jon on omega-flagship/omegahive#395:
; "a mind's own coding should be a per-mind setting, off by default, that its owner can switch on, for example for a
; self-modifying Iter". Off, the mind builds software only through Create and asks a person before each shell command;
; on, it writes and runs its own code. Only its owner switches it (the host refuses anyone else: own_coding_owner_only).
;
; Facts the page states each time: (on coding.on) while its own coding is on; (on coding.owner) unless the host says
; this person may not switch it.

(Screen own-coding "Its own coding")
(Part own-coding 10 line ((title "Its own coding")))
(Part own-coding 20 paragraph ((text (words (bind coding.name) " builds software through Create, and asks a person before each shell command it runs."))))
(When own-coding 20 (off coding.on))
(Part own-coding 21 paragraph ((text (words (bind coding.name) " writes and runs its own code without Create, as a self-modifying Iter does."))))
(When own-coding 21 (on coding.on))
(Part own-coding 30 toggles ((source coding.choice) (label label) (checked on) (action own-coding)
  (aria "Let {coding.name} write and run its own code")))
(When own-coding 30 (on coding.owner))
(Part own-coding 31 note ((text "Only its owner can change this.")))
(When own-coding 31 (off coding.owner))
