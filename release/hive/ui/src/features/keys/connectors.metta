; The person's own connectors on the You page, declared as atoms (screens/lib_screens.metta composes them). The You page
; stacks one panel (profile-connectors), which reads the person's connectors and stacks each connector's card
; (profile-connector). A secret is never the page's data: a token or password goes from its hidden field straight to the
; hive with the Save press, and the hive answers only which fields are entered.
;
; Facts the page states each time:
;   profile-connectors: the standard resource facts for the connectors (screens/resourceFacts.ts: the value resource,
;                       resource.stale, the data resource.error); store.open store.warning; (count connectors.items)
;   profile-connector: connector.set connector.confirming connector.busy connector.restart; the value connector.id;
;                      connector.error; (count connector.minds)

(Screen profile-connectors "Your connectors")
(Part profile-connectors 10 section ((title "Your connectors")
  (body "Logins for the services your minds use. The hive keeps each one sealed and gives a mind yours only for the connectors you switch on for it.")))

; reading them: the shared fragment, orders 20 to 27
(Resource profile-connectors 20 ((waiting "Loading your connectors") (unsupported "This hive doesn't keep connectors yet.")
  (failed-title "Could not load your connectors") (stale "Could not refresh your connectors. Showing the last loaded ones.")
  (retry connectors-retry)))

; where the key that seals them lives, and when it protects less or doesn't answer
(Part profile-connectors 30 note ((text (bind store.where))))
(When profile-connectors 30 (is resource ready))
(When profile-connectors 30 (on store.open))
(Part profile-connectors 31 notice ((tone warn) (text (bind store.warning))))
(When profile-connectors 31 (is resource ready))
(When profile-connectors 31 (on store.warning))
(Part profile-connectors 32 notice ((tone bad) (text (words "The hive can't open connector logins right now: " (bind store.reason)))))
(When profile-connectors 32 (is resource ready))
(When profile-connectors 32 (off store.open))
(Part profile-connectors 40 stack ((source connectors.items) (frame card) (label "Connectors")))
(When profile-connectors 40 (is resource ready))
(When profile-connectors 40 (has connectors.items))

(Screen profile-connector "A connector")
; its name, whether it is connected, and what it does
(Part profile-connector 10 line ((title (bind connector.title)) (meta (bind connector.meta)) (badge "Connected") (tone good)))
(When profile-connector 10 (on connector.set))
(Part profile-connector 11 line ((title (bind connector.title)) (meta (bind connector.meta))))
(When profile-connector 11 (off connector.set))
(Part profile-connector 12 note ((text (bind connector.about))))

; entering a login for a connector the hive calls: the address or email in a field, the token or password hidden
(Part profile-connector 20 fields ((items ((field text "Address" form.url ((placeholder "http://homeassistant.local:8123")))))))
(When profile-connector 20 (is connector.id home_assistant))
(Part profile-connector 21 keyfield ((label "Long-lived access token") (placeholder "Paste the token") (submit "Save")
  (waiting "Saving…") (busy connector.busy) (action save-home-assistant)
  (help "Make one in Home Assistant under your profile, Security, Long-lived access tokens.")))
(When profile-connector 21 (is connector.id home_assistant))
(Part profile-connector 22 fields ((columns two) (items ((field text "Email" form.username ((placeholder "you@example.org")))
  (field select "Unit" form.unit ((source connector.units) (prompt "As LibreLinkUp says")))))))
(When profile-connector 22 (is connector.id librelinkup))
(Part profile-connector 23 keyfield ((label "LibreLinkUp password") (placeholder "Password") (submit "Save")
  (waiting "Saving…") (busy connector.busy) (action save-librelinkup)
  (help "The login of the LibreLinkUp app that follows the sensor.")))
(When profile-connector 23 (is connector.id librelinkup))

; which of the person's minds have it (a switch each); WhatsApp is on one at a time
(Part profile-connector 30 toggles ((source connector.minds) (label name) (checked on) (action install)
  (aria (words "Use " (bind connector.title) " in {name}"))))
(When profile-connector 30 (has connector.minds))
(Part profile-connector 31 note ((text "You have no Omega minds yet. Make one, then switch this on for it.")))
(When profile-connector 31 (none connector.minds))
(Part profile-connector 32 note ((text "On one of your minds at a time: switching it on for another moves it there.")))
(When profile-connector 32 (is connector.id whatsapp))
(Part profile-connector 33 notice ((tone info) (text (words "Takes effect when " (bind connector.restart_names) " next starts."))))
(When profile-connector 33 (on connector.restart))
(Part profile-connector 34 notice ((tone bad) (text (bind connector.error))))
(When profile-connector 34 (on connector.error))

; disconnecting: a second press, since it forgets the login or the pairing
(Part profile-connector 40 actions ((items ((action "Disconnect" ask-disconnect)))))
(When profile-connector 40 (on connector.set))
(When profile-connector 40 (off connector.confirming))
(Part profile-connector 41 confirm ((text (words "Forget your " (bind connector.title) " login and take it off your minds?"))
  (yes "Disconnect") (yes_action disconnect) (no "Keep") (no_action keep)))
(When profile-connector 41 (on connector.set))
(When profile-connector 41 (on connector.confirming))
