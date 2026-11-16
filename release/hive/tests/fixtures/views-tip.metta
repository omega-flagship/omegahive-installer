; A tip calculator written the way a mind writes a view (hive/ui/src/features/views/lib_view.metta). The person types
; the bill and picks the tip; the tip, the total and each person's share are worked out from those.
(Screen tip "Tip calculator")
(Part tip 10 header ((title "Tip calculator") (body "Type the bill, pick a tip, and see what each person pays.")))
(Part tip 20 fields ((columns two)
                     (items ((field number "Bill" bill ((least 0) (step 0.01) (placeholder "0.00")))
                             (field number "People" people ((least 1) (step 1)))))))
(Part tip 30 segmented ((label "Tip") (bind pct) (options ((option "10" "10%") (option "15" "15%") (option "20" "20%")))))
(Part tip 40 facts ((label "What it comes to")
                    (rows ((row "Tip" (bind tip)) (row "Total" (bind total)) (row "Each pays" (bind each))))))
(When tip 40 (has bill))
(Part tip 50 note ((text "Type the bill to see the split.")))
(When tip 50 (none bill))
(Part tip 60 actions ((items ((action "Ask to book it" book)))))
(When tip 60 (has bill))

(Start bill "")
(Start people "2")
(Start pct "15")

(= (value rate) (/ (num (state pct)) 100))
(= (value tip) (fixed (* (num (state bill)) (value rate)) 2))
(= (value total) (fixed (* (num (state bill)) (+ 1 (value rate))) 2))
(= (value each)
   (if (> (num (state people)) 0)
       (fixed (/ (* (num (state bill)) (+ 1 (value rate))) (num (state people))) 2)
       ""))

(= (on book) ((say "Please book a table for " (state people) ". The bill comes to " (value total) " with the tip.")))
