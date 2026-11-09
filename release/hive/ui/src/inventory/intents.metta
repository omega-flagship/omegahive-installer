;; UI intents: the authored half of the UI inventory atomspace. This is the one place the hive's shared names live.
;; Home: hive/ui/src/inventory/intents.metta (loaded into the parts space at run time; the build guards read it too). Hand-edited, unlike ui_inventory.metta, which is generated from source.
;;
;; An intent's meaning is fixed; its words may vary by look (Start vs Go is fine).
;; Feature ids (registry.ts) are intents too: their feature label is the default phrase, so they need no atom here.
;; Schema:
;;   (intent $id $kind)            kind: menu | chooser | experience | action
;;   (says $look $intent $phrase)  look: an experience id, or default
;;   (retired $intent)             never reachable from any screen
;;   (replaced-by $intent $new)    where a retired intent's meaning went
;;   (entry-component $file)       components whose every control must be bound to an intent (menus, choosers)

;; ---------- experiences (the looks a person can choose)
(intent experience.classic experience)
(says default experience.classic "Classic")
(intent experience.professional experience)
(says default experience.professional "Professional")
(intent experience.cosmos experience)
(says default experience.cosmos "Cosmos")
(intent experience.construct experience)
(says default experience.construct "Construct")
(intent experience.still experience)
(says default experience.still "Still")
(intent experience.flux experience)
(says default experience.flux "Flux")
(intent experience.canvas experience)
(says default experience.canvas "Canvas")
(intent experience.little-world experience)
(says default experience.little-world "Little World")

;; OmegaTown is just the town in Little World (Jon, 2 Nov 2026). Saved choices resolve to Classic until Little World lands.
(intent experience.omegatown experience)
(says default experience.omegatown "OmegaTown")
(retired experience.omegatown)
(replaced-by experience.omegatown experience.classic)

;; ---------- the Ω menu and the experience chooser
(intent chrome.change-experience menu)
(says default chrome.change-experience "Change experience")
(says construct chrome.change-experience "experience")
(says cosmos chrome.change-experience "Jump to another world")
(says still chrome.change-experience "Another way to see this")
(says canvas chrome.change-experience "Switch canvas")

;; "Change UI" (feature hive.changeui): the UI as a thing you swap. That meaning is retired; you change your experience.
(retired hive.changeui)
(replaced-by hive.changeui chrome.change-experience)

;; Ω-menu entries that are features use the feature id as their intent (its label is the default phrase); a look may reword.
(says construct decide.stopall "stop --all")
(says construct watch.lab "lab")
(says default watch.lab "Lab · tests & benchmarks")
(says default decide.stopall "Stop all minds…")
(says default hive.help "Help & shortcuts")

;; Ω-menu entries with no feature of their own
(intent chrome.inbox menu)
(says default chrome.inbox "Inbox")
(says construct chrome.inbox "inbox")
(intent chrome.replay-tour menu)
(says default chrome.replay-tour "Replay the tour")

;; ---------- the shell's states: the Ω, the one Ask, the apps, Pro and power (Ask-and-apps contract R1, 3 Nov 2026)
;; Every look's rest and awake parts bind to these through (UiIntent part intent) in the parts space (lib_ui.metta);
;; a look's own words come from say-for, never from component strings.
(intent shell.omega action)
(says default shell.omega "Omega")
(intent shell.question action)
(says default shell.question "What do you want me to be?")
(intent ask.field action)
(says default ask.field "Ask")
(says construct ask.field "command")
(intent apps.open action)
(says default apps.open "Your apps")
(says construct apps.open "apps")
(intent shell.apps action)
(says default shell.apps "Your apps")
(says construct shell.apps "apps")
(intent apps.more action)
(says default apps.more "More apps")
(says construct apps.more "apps --all")
(intent shell.pro action)
(says default shell.pro "Pro")
(says cosmos shell.pro "Fly out")
(says construct shell.pro ":pro")
(says canvas shell.pro "Zoom out")
(says still shell.pro "Show everything")
(intent shell.back action)
(says default shell.back "Back")
(says cosmos shell.back "Fly back in")
(says construct shell.back ":back")
(says canvas shell.back "Zoom in")
(intent shell.power action)
(says default shell.power "Rest")
(says construct shell.power "sleep")

;; ---------- where every control must carry an intent (this round: shared chrome and experience names)
(entry-component "shell/Hud.tsx")
(entry-component "shell/ChangeUi.tsx")
(entry-component "shell/LookSection.tsx")
(entry-component "experiences/registry.ts")

;; ---------- queries: one engine, read by the build, by minds and by the Ask
(= (first-or $xs $else) (if (== $xs ()) $else (car-atom $xs)))
(= (default-phrase $i) (first-or (collapse (match &self (says default $i $p) $p)) (first-or (collapse (match &self (feature $i $p $g) $p)) (no-phrase $i))))
;; what this look says for an intent: its own words, else the default (named say-for: `phrase` is a Prolog builtin in PeTTa)
(= (say-for $look $i) (first-or (collapse (match &self (says $look $i $p) $p)) (default-phrase $i)))
(= (is-retired $i) (not (== (collapse (match &self (retired $i) $i)) ())))
(= (is-bound $c) (not (== (collapse (match &self (bound $c $i) $i)) ())))
;; guards: each must be empty for the build to pass
(= (no-default) (match &self (intent $i $k) (let $d (default-phrase $i) (if (== $d (no-phrase $i)) $i (empty)))))
(= (reachable-retired) (match &self (bound $c $i) (if (is-retired $i) ($c $i) (empty))))
(= (unbound-entry) (match &self (control $c $s $comp $k $l) (if (== (collapse (match &self (entry-component $comp) $comp)) ()) (empty) (if (is-bound $c) (empty) ($c $l)))))

;; A phrase may be read only for a declared, non-retired intent (native words and the candidate inspector share this query).
(= (ui-intent-known $i) (collapse (match &self (intent $i $k) (if (is-retired $i) (empty) $i))))
