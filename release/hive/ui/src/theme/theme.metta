; The theme's rules (light-token round R1, Surface). MeTTa decides what every look must satisfy and what happens when it
; doesn't; the browser only measures (contrast in OKLCH/WCAG) and draws. gen-theme-rules.py runs this in PeTTa and writes
; theme.rules.json, which the test and the running app read. Any look a person makes is held to the same rules.

; ── roles: what each colour token is for ────────────────────────────────────────────────────────────────────────────
(role ink text)
(role ink-2 text)
(role ink-3 text)
(role ink-4 text)             ; the faintest text allowed
(role ink-5 decoration)       ; rules, dots, disabled glyphs: never text
(role control edge)           ; the edge of anything you operate
(role accent edge)
(role accent-2 focus)         ; focus rings
(role good signal)
(role warn signal)
(role bad signal)
(role primary-ink text-on-accent)

; ── what each kind is read against, and how strongly it must stand out (WCAG 2.2: 1.4.3 text, 1.4.11 non-text) ─────
(against text void)
(against text abyss)
(against edge void)
(against edge abyss)
(against focus void)
(against focus abyss)
(against signal void)
(against signal abyss)
(against text-on-accent accent)
(floor text 4.5)
(floor text-on-accent 4.5)
(floor edge 3)
(floor focus 3)
(floor signal 3)

; ── which colours may be see-through: surfaces and dividers only; everything the rules read is solid #rrggbb ──────────
(translucent line)
(translucent line-2)
(translucent glass)
(translucent glass-2)

; ── derived tokens: what a look never has to declare ───────────────────────────────────────────────────────────────
(derive tint ink)             ; "a little of the foreground" follows the look's own ink: white haze on dark, ink on paper
(derive shade black)          ; scrims and shadows stay black in every scheme

; ── when a look falls short ──────────────────────────────────────────────────────────────────────────────────────────
(repair text lightness-nearest)                 ; the smallest OKLCH lightness change that passes: away from the surface first, then toward it
(repair text-on-accent lightness-nearest)
(repair edge lightness-nearest)
(repair focus lightness-nearest)
(repair signal lightness-nearest)
(give-up-after 0.35)                             ; more than this much lightness change means the look is refused, with the reason

; ── the rules ────────────────────────────────────────────────────────────────────────────────────────────────────────
(= (floor-of $k) (match &self (floor $k $f) $f))
(= (repair-of $k) (match &self (repair $k $how) $how))
(= (checks-for $t) (match &self (role $t $k) (match &self (against $k $s) (check $t $s (floor-of $k) (repair-of $k)))))
(= (derived $t) (match &self (derive $t $from) $from))
