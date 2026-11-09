; How each look draws a role, where it differs from the default. A look made of rooms and light (Cosmos, Flux, Canvas)
; shows a collection as cards; the paper and desk looks keep the list.
(LookPrefers cosmos collection cards)
(LookPrefers flux collection cards)
(LookPrefers canvas collection cards)

; Looks that draw in a 3D space place each part at its layer's depth (lib_screens.metta: Layer, RoleDepth); the rest
; are flat and show a layer as elevation.
(LookSpace cosmos 3d)
(LookSpace flux 3d)

; The code editor's ink (features/code/Editor.tsx draws it; MeTTa chooses it). A look may name its own; otherwise the
; surface it is worn on decides: code on a light surface is written in paper ink (dark words), on a dark surface in
; night ink (light words). The page states the surface it is on (the chrome's scheme); nothing else is assumed.
(SchemeCodeInk light paper)
(SchemeCodeInk dark night)
(= (scr-code-ink $look $scheme)
   (let $own (collapse (match &self (LookCodeInk $look $i) $i))
        (if (== $own ())
            (let $by (collapse (match &self (SchemeCodeInk $scheme $j) $j)) (scr-first $by night))
            (car-atom $own))))
