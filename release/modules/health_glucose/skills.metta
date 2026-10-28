(= (glucose-app-status)
   (py-call (glucose.glucose_app_status)))

(= (observe-glucose $person)
   (py-call (glucose.observe_glucose $person)))

(= (glucose-history $person $count)
   (py-call (glucose.glucose_history $person $count)))

(= (set-glucose-watch $person $low $high $stale_minutes $channel $note)
   (py-call (glucose.set_glucose_watch $person $low $high $stale_minutes $channel $note)))

(= (glucose-watch-status $person)
   (py-call (glucose.glucose_watch_status $person)))

(= (clear-glucose-watch $person)
   (py-call (glucose.clear_glucose_watch $person)))

(= (glucose-rings $person)
   (py-call (glucose.glucose_rings $person)))
