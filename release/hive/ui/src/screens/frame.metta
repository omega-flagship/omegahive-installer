; Purpose: the frame every look wears around its screens, declared as atoms (lib_screens.metta composes it): what a
; look's frame shows in its own regions, whatever page or sheet is open. usage is the place each look shows usage:
; classic's top bar after Spend, and each other look's equivalent in its frame. A feature declares its parts here, in
; its own .metta file, with (Region frame <order> usage); shell/UsageRegion.tsx draws that region in every look's frame,
; so a part declared once shows in every look, each drawing its role its own way (looks.metta).
; Facts the frame states each time it composes: whatever its parts' features state (allowance.metta: allowance.mine,
; allowance.hive).

(Screen frame "The frame every look wears")
