; The Models and providers page, one provider's card on it, and one model in use, declared as atoms
; (screens/lib_screens.metta composes them). The page composes each provider and each model in use for its own facts,
; and the models screen stacks them.
;
; Facts the page states each time:
;   models: the standard resource facts for the providers (screens/resourceFacts.ts: the value resource)
;           (count providers.all) default.set default.known (count models.inuse)
;   models-provider: provider.connected provider.ready provider.needs_key provider.stored provider.replacing
;                    provider.confirming provider.catalogue
;   models-in-use: (count use.minds)

(Screen models "Models")

; ---------- the providers, each with its key
(Part models 10 section ((title "Providers") (body (bind providers.summary))))
(When models 10 (is resource ready))
(Part models 11 section ((title "Providers")))
(When models 11 (is resource loading))
; while the providers load (the shared fragment: order 12 only)
(Resource models 12 ((waiting "Loading providers")))
(Part models 13 stack ((source providers.all) (frame card) (label "Providers") (current (bind providers.focus))))
(When models 13 (has providers.all))
(Part models 14 note ((text "Keys live in the hive's data directory, readable only by the hive process. Minds call models through the gateway, which injects the key, meters tokens and enforces each mind's budget. Nothing a mind says can reveal a key.")))

; ---------- the model new minds start on
(Part models 20 section ((title "Default for new minds") (body (bind default.summary))))
(When models 20 (on default.known))
(Part models 21 section ((title "Default for new minds") (body "Pick what the create flow should suggest first. Saved in this browser.")))
(When models 21 (off default.known))
(Part models 22 actions ((items ((action "Clear" clear-default)))))
(When models 22 (on default.set))
; the model picker: search, filters, the catalogue, routing and connecting a provider inline. It is shared with the
; create flow, a mind's panel, swarms and roles, so the page draws it (an island).
(Part models 23 island ((name model-picker)))

; ---------- which models minds use now
(Part models 30 section ((title "In use")))
(When models 30 (has models.inuse))
(Part models 31 stack ((source models.inuse) (frame inset) (label "Models in use")))
(When models 31 (has models.inuse))

; ---------- next steps
(Part models 40 actions ((tone primary) (items ((action "Create a mind" create-mind)))))
(Part models 41 note ((text "Costs show on the Usage view as minds talk.")))

(Screen models-provider "A provider")
(Part models-provider 10 line ((title (bind provider.label)) (badge "Ready") (tone good)))
(When models-provider 10 (on provider.connected))
(When models-provider 10 (on provider.ready))
(Part models-provider 11 line ((title (bind provider.label)) (badge "Connected") (tone good)))
(When models-provider 11 (on provider.connected))
(When models-provider 11 (off provider.ready))
(Part models-provider 12 line ((title (bind provider.label)) (badge "Not connected") (tone info)))
(When models-provider 12 (off provider.connected))

; what it pays with, or how to connect it
(Part models-provider 20 note ((text (bind provider.key_line))))
(When models-provider 20 (on provider.connected))
(Part models-provider 21 note ((text (bind provider.invite))))
(When models-provider 21 (off provider.connected))
(When models-provider 21 (on provider.needs_key))
(Part models-provider 22 note ((text "Needs no key.")))
(When models-provider 22 (off provider.connected))
(When models-provider 22 (off provider.needs_key))

; pasting a key: to connect, or to replace the one it has
(Part models-provider 30 keyfield ((label (bind provider.key_label)) (placeholder (bind provider.placeholder))
  (submit "Connect") (waiting "Checking…") (busy provider.checking) (focus provider.focus) (action connect)
  (help (bind provider.help)) (link (bind provider.help_url)) (link_label "Open")))
(When models-provider 30 (off provider.connected))
(When models-provider 30 (on provider.needs_key))
(Part models-provider 31 keyfield ((label (bind provider.key_label)) (placeholder (bind provider.placeholder))
  (submit "Replace") (waiting "Checking…") (busy provider.checking) (focus provider.focus) (action connect)
  (cancel "Cancel") (cancel_action cancel-replace)
  (help (bind provider.help)) (link (bind provider.help_url)) (link_label "Open")))
(When models-provider 31 (on provider.connected))
(When models-provider 31 (on provider.needs_key))
(When models-provider 31 (on provider.replacing))

; replacing or removing the key it has (only a key stored in the hive can be removed here)
(Part models-provider 40 actions ((items ((action "Replace key" replace) (action "Remove" ask-remove)))))
(When models-provider 40 (on provider.connected))
(When models-provider 40 (on provider.needs_key))
(When models-provider 40 (off provider.replacing))
(When models-provider 40 (on provider.stored))
(When models-provider 40 (off provider.confirming))
(Part models-provider 41 actions ((items ((action "Replace key" replace)))))
(When models-provider 41 (on provider.connected))
(When models-provider 41 (on provider.needs_key))
(When models-provider 41 (off provider.replacing))
(When models-provider 41 (off provider.stored))
(Part models-provider 42 actions ((items ((action "Replace key" replace)))))
(When models-provider 42 (on provider.connected))
(When models-provider 42 (on provider.needs_key))
(When models-provider 42 (off provider.replacing))
(When models-provider 42 (on provider.stored))
(When models-provider 42 (on provider.confirming))
(Part models-provider 43 confirm ((text "Remove this key from the hive?") (yes "Remove key") (yes_action remove)
  (no "Keep") (no_action keep)))
(When models-provider 43 (on provider.connected))
(When models-provider 43 (on provider.needs_key))
(When models-provider 43 (off provider.replacing))
(When models-provider 43 (on provider.stored))
(When models-provider 43 (on provider.confirming))

; the catalogue a connected OpenRouter key brings
(Part models-provider 50 note ((text (bind provider.catalogue))))
(When models-provider 50 (on provider.catalogue))

(Screen models-in-use "A model in use")
(Part models-in-use 10 line ((title (bind use.name)) (meta (bind use.model))))
(Part models-in-use 20 orbs ((source use.minds) (open mind) (most 6) (aria "{name}, open model settings")
  (label "Minds on this model")))
(When models-in-use 20 (has use.minds))
