; Purpose: compose what a mind offers to build in Create for the person reading its chat, and the presses that start it.
; What a mind offers to build (its chat, Chat.tsx): a mind asked to build software (an app, a page, a game, a script)
; doesn't build it itself; it offers the build to its person (hive/core/create_offers.py), who starts it in Create, where
; it is planned and each piece checked, or sets it aside. Declared as atoms that screens/lib_screens.metta composes for
; the look being worn; each offer is composed as its own small screen, stacked as cards.
;
; Facts the page states each time (createOffer.ts): (count offers.open), this person's open offers from this mind, and
; (on offers.failed) when a press didn't go through.

(Screen mind-create-offers "What this mind offers to build in Create")
; each open offer, newest first, its own composed card
(Part mind-create-offers 10 stack ((source offers.rows) (frame card) (label "Offers to build in Create")))
(When mind-create-offers 10 (has offers.open))
; a press that didn't go through, in plain words
(Part mind-create-offers 20 notice ((tone bad) (text (bind offers.alert))))
(When mind-create-offers 20 (on offers.failed))

(Screen mind-create-offer "An offer to build in Create")
; what the mind would build, in the words it was asked
(Part mind-create-offer 10 notice ((tone info) (text (words (bind offer.mind) " can build this in Create: " (bind offer.sentence)))))
; nothing is built until the person starts it
(Part mind-create-offer 11 note ((text "Create plans it and checks each piece as it builds. Nothing is built until you start it.")))
(Part mind-create-offer 20 buttons ((items ((button "Start in Create" start-offer ((variant primary) (aria "Start building {offer.sentence} in Create")))
  (button "Not now" dismiss-offer ((variant ghost) (aria "Not now: set {offer.sentence} aside")))))))
