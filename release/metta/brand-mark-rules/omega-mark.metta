; The Omega living mark, as MeTTa: the source of truth for how the mark behaves in any UI.
; The shape never changes. The ENVIRONMENT (a look, app or hive) sets its material; the ACTION (what is happening) sets
; how it changes. Renderers (WebGL in the hive, Blender for stills, anything else) only draw what these rules decide.

; ── environments: material, side colour, and the material's own way of taking over (flood rises, notes slap on,
;    paint is brushed on, metal is forged, glass crystallises, plants sprout, cake pours, blocks build, stars ignite) ─────────────────────────────────
(environment cosmos       glass-universe   "#6a5ad0" stars)
(environment classic      glass-aurora     "#7a6ae0" aurora)
(environment flux         liquid-glass     "#c050c0" flood)
(environment construct    phosphor-mesh    "#1e8a3a" scan)
(environment still        ink-lacquer      "#0d0b09" ink)
(environment canvas       sticky-paper     "#2b48e0" notes)
(environment littleworld    teal-enamel      "#14504a" paint)
(environment professional blue-anodised    "#1d3c8f" forge)
(environment brand        teal-glass       "#14705f" crystal)
(environment hyperon      logic-and-mind   "#8a6a20" swarm)
(environment atomspace    living-hypergraph "#5a4ac0" swarm)
(environment glitch       vr-glitch        "#2a6aa0" glitch)
(environment bush         living-topiary   "#1f3a14" grow)
(environment cake         celebration-cake "#3a2214" drip)
(environment voxel        block-build      "#3a2a6a" build)
(environment puppy        puppy-fur        "#9a6630" grow)     ; the finale: a cute puppy Omega
(environment balloon      foil-balloon     "#5a3ac0" inflate)  ; ...that becomes a comedy balloon Omega
(environment neonfur      neon-fur         "#ff2bd6" grow)     ; the finale: neon fur, under the Cosmos sky

; ── living: every material is alive while it holds, in its own way ──────────────────────────────────────────────
(living glass-universe    galaxy-turns)     ; the galaxy drifts, stars are born and die, a glint crosses the glass
(living glass-aurora      aurora-flows)     ; aurora ribbons rise and ripple
(living liquid-glass      liquid-swirls)    ; the liquid swirls, the iridescence shifts
(living phosphor-mesh     scan-sweeps)      ; a scan line sweeps, the phosphor flickers
(living ink-lacquer       sheen-glides)     ; calm: a slow sheen glides over the lacquer
(living sticky-paper      ink-traces)       ; a pen light runs along the keyline
(living teal-enamel       sun-sheen)        ; sunlight moves over the enamel
(living blue-anodised     metal-sweep)      ; a studio highlight sweeps the metal
(living teal-glass        caustic-shimmer)  ; caustics shimmer through the glass
(living logic-and-mind    thoughts-travel)  ; signals travel the logic lattice and the neurons
(living living-hypergraph graph-pulses)     ; nodes pulse, links carry light, new atoms swarm in
(living vr-glitch         glitch-flickers)  ; bursts of glitch: tears, colour split, flicker
(living living-topiary    leaves-rustle)    ; wind in the leaves, dappled sun, petals fall
(living celebration-cake  icing-glistens)   ; the icing glistens, sprinkles sparkle
(living block-build       blocks-pop)       ; blocks pop and glint, new blocks drop in
(living puppy-fur         fur-ruffles)      ; fur ruffles as it runs
(living foil-balloon      foil-shimmer)     ; light slides over the foil
(living neon-fur          neon-fur-flows)   ; a rainbow runs through the fibres, light races up each strand

; ── actions: real hive events, and the change each one makes ───────────────────────────────────────────────────
(action create  grow)      ; something new is being made: plants grow
(action wake    stars)     ; a mind wakes: stars ignite
(action rest    fade)      ; a mind rests: stars die down, the light dims
(action learn   swarm)     ; learning: graph lights swarm in
(action find    swarm)     ; a pattern is found: the match swarms in
(action think   aurora)    ; thinking: light ribbons drift through
(action error   glitch)    ; something failed: it glitches (words always say what failed)
(action build   build)     ; building: blocks assemble
(action write   ink)       ; writing: ink bleeds through
(action approve bloom)     ; a person approved: a soft bloom

; ── rules ───────────────────────────────────────────────────────────────────────────────────────────────────────
(= (material $env) (match &self (environment $env $m $e $s) $m))
(= (edge $env) (match &self (environment $env $m $e $s) $e))
(= (own-style $env) (match &self (environment $env $m $e $s) $s))
(= (action-style $act) (match &self (action $act $s) $s))

; how a move to a new environment looks: the new material literally takes over the old one in its own way (cake pours
; over, plants sprout through, blocks build, graphs thread in) and the old one reacts; the action, if any, plays as a burst
; on arrival. Under reduced motion every change is a plain crossfade.
(= (morph-style $env $act $motion) (if (== $motion reduced) crossfade (own-style $env)))
(= (arrival-burst $act $motion) (if (== $motion reduced) none (if (== $act none) none (action-style $act))))

; an action in place: the current material plays the action's effect; skipped under reduced motion
(= (in-place $act $motion) (if (== $motion reduced) none (action-style $act)))

; the one Omega you talk to: how it shows it is listening or speaking (decoration; captions always say it too)
(presence listening lean-in)     ; it leans toward you, its rim breathes
(presence speaking  voice-ripple) ; light ripples through its material with its voice
(= (shows $state reduced) none)
(= (shows $state full) (match &self (presence $state $how) $how))

; how the material lives while it holds; under reduced motion it holds still
(= (alive $env reduced) still)
(= (alive $env full) (let $m (material $env) (match &self (living $m $l) $l)))

; the Ask's own Omega: what your mind is doing, shown by its mark in the language of the look it is in. Some gestures are
; the same everywhere (listening, speaking, an approval, a failure); thinking plays in the environment's own way
; (a scan in Construct, stars in Cosmos, flow in Flux, ink in Canvas or Still, aurora in Classic...). Decoration only:
; the Ask's words always say what is happening.
(ask-activity typing     listening)   ; you are typing or talking to it: it leans in
(ask-activity thinking   native)      ; accepted, or a thinking step: the material's own way
(ask-activity answering  speaking)    ; its answer is arriving: light ripples with it
(ask-activity finding    swarm)       ; it opens or navigates to something
(ask-activity writing    ink)         ; it fills something in
(ask-activity making     grow)        ; something new is being made
(ask-activity building   build)       ; it builds or codes
(ask-activity waiting    listening)   ; it waits for your approval
(ask-activity approved   bloom)       ; you approved
(ask-activity failed     glitch)      ; refused or failed (the words say why)
(ask-activity changed    native)      ; it changed your look: the new material arrives in its own way
(ask-act navigate finding) (ask-act open finding) (ask-act scroll finding) (ask-act point thinking) (ask-act highlight thinking)
(ask-act fill writing) (ask-act look changed) (ask-act tour.step thinking)
(= (ask-shows $env $activity) (let $how (match &self (ask-activity $activity $h) $h) (if (== $how native) (own-style $env) $how)))
(= (ask-act-shows $env $act) (let $a (match &self (ask-act $act $x) $x) (ask-shows $env $a)))

; how each material BEHAVES while your mind works: a living thing in its own idiom, not a generic effect.
; a behaviour is a set of levers (living speed, wind, brightness, a tint, a piece event) held for a while
(behaviour gust        (speed 2.2) (wind 2.8) (gain 1.0)  (fx none)        (dur 1.8))   ; wind passes through
(behaviour still-pool  (speed 0.25) (wind 0.3) (gain 0.92) (fx none)       (dur 0))     ; goes still, waiting (held)
(behaviour spin-up     (speed 3.2) (wind 1.8) (gain 1.08) (fx none)        (dur 1.8))   ; the galaxy spins up
(behaviour whirlpool   (speed 3.0) (wind 2.8) (gain 1.05) (fx bubbles)     (dur 1.8))   ; the liquid whirls, bubbles rise
(behaviour ripple-fast (speed 2.8) (wind 2.0) (gain 1.1)  (fx none)        (dur 1.6))   ; aurora curtains ripple fast
(behaviour scan-race   (speed 4.0) (wind 1.0) (gain 1.12) (fx none)        (dur 1.4))   ; scan lines race
(behaviour ink-swirl   (speed 2.4) (wind 2.6) (gain 1.0)  (fx none)        (dur 1.8))   ; ink swirls in the lacquer
(behaviour flutter     (speed 2.6) (wind 1.8) (gain 1.04) (fx none)        (dur 1.4))   ; notes flutter
(behaviour sheen-race  (speed 3.2) (wind 1.0) (gain 1.1)  (fx none)        (dur 1.4))   ; light races over the surface
(behaviour flower-talk (speed 1.4) (wind 1.2) (gain 1.06) (fx flower-talk) (dur 0))     ; flowers open and close with the words
(behaviour pulsar      (speed 1.6) (wind 1.0) (gain 1.18) (fx none)        (dur 0))     ; it beats with the words
(behaviour sprout      (speed 1.4) (wind 1.4) (gain 1.05) (fx sprout)      (dur 1.6))   ; new shoots grow
(behaviour nova        (speed 2.0) (wind 1.2) (gain 1.35) (fx nova)        (dur 1.2))   ; a star is born
(behaviour bloom-burst (speed 1.6) (wind 1.6) (gain 1.15) (fx bloom)       (dur 2.0))   ; full bloom, petals burst
(behaviour wilt        (speed 0.5) (wind 0.4) (gain 0.8)  (fx wilt)        (dur 2.2))   ; it wilts, then recovers
(behaviour flicker-out (speed 0.6) (wind 0.6) (gain 0.6)  (fx none)        (dur 1.0))   ; its light flickers out, then back
(behaviour lean        (speed 0.8) (wind 0.8) (gain 1.04) (fx none)        (dur 0))     ; leans in to you (held)

(ask-behaviour living-topiary typing lean) (ask-behaviour living-topiary thinking gust) (ask-behaviour living-topiary answering flower-talk)
(ask-behaviour living-topiary making sprout) (ask-behaviour living-topiary waiting still-pool) (ask-behaviour living-topiary approved bloom-burst)
(ask-behaviour living-topiary failed wilt)
(ask-behaviour glass-universe typing lean) (ask-behaviour glass-universe thinking spin-up) (ask-behaviour glass-universe answering pulsar)
(ask-behaviour glass-universe making nova) (ask-behaviour glass-universe waiting still-pool) (ask-behaviour glass-universe approved nova)
(ask-behaviour glass-universe failed flicker-out)
(ask-behaviour glass-aurora thinking ripple-fast) (ask-behaviour glass-aurora answering pulsar) (ask-behaviour glass-aurora waiting still-pool) (ask-behaviour glass-aurora failed flicker-out)
(ask-behaviour liquid-glass thinking whirlpool) (ask-behaviour liquid-glass answering pulsar) (ask-behaviour liquid-glass waiting still-pool) (ask-behaviour liquid-glass making whirlpool)
(ask-behaviour phosphor-mesh thinking scan-race) (ask-behaviour phosphor-mesh answering pulsar) (ask-behaviour phosphor-mesh waiting still-pool) (ask-behaviour phosphor-mesh failed flicker-out)
(ask-behaviour ink-lacquer thinking ink-swirl) (ask-behaviour ink-lacquer waiting still-pool) (ask-behaviour ink-lacquer answering pulsar)
(ask-behaviour sticky-paper thinking flutter) (ask-behaviour sticky-paper waiting still-pool)
(ask-behaviour blue-anodised thinking sheen-race) (ask-behaviour teal-enamel thinking sheen-race) (ask-behaviour teal-glass thinking sheen-race)
(ask-behaviour blue-anodised waiting still-pool) (ask-behaviour teal-enamel waiting still-pool) (ask-behaviour teal-glass waiting still-pool)
(= (ask-behaves $env $activity) (let $m (material $env) (match &self (ask-behaviour $m $activity $b) $b)))

; the one easter egg: rewinding or fast-forwarding time anywhere shows a second clock at the time jumped to, beside the
; true clock, reading 1.21 GW (decoration only; the true time never changes)
(time-jump rewind)
(time-jump fast-forward)
(egg time-jump "1.21 GW")
(= (jump-reading $dir) (match &self (time-jump $dir) (match &self (egg time-jump $r) $r)))

; honesty: the mark's effects are decoration bound to real events, never the only signal
(= (sole-signal $anything) False)

; ── checks (run with PeTTa) ─────────────────────────────────────────────────────────────────────────────────────
!(material cosmos)
!(morph-style bush create full)
!(morph-style cake none full)
!(morph-style glitch error reduced)
!(arrival-burst create full)
!(in-place wake full)
!(in-place wake reduced)
!(alive bush full)
!(alive cosmos reduced)
!(shows speaking full)
!(jump-reading rewind)
!(ask-shows construct thinking)
!(ask-act-shows cosmos fill)
!(ask-behaves bush failed)
!(ask-behaves cosmos thinking)
!(sole-signal error)
