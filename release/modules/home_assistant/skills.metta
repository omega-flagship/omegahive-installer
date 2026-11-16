; Home Assistant MeTTa skill implementations.

(= (observe-house)
   (py-call (home_assistant.observe_house)))

(= (observe-house-full)
   (py-call (home_assistant.observe_house_full)))

(= (observe-room $room)
   (py-call (home_assistant.observe_room $room)))

(= (observe-device $target)
   (py-call (home_assistant.observe_device $target)))

(= (observe-house-affordances)
   (py-call (home_assistant.observe_house_affordances)))

(= (use-house-affordance $affordance $target $context)
   (py-call (home_assistant.use_house_affordance $affordance $target $context)))

(= (record-house-outcome $action $outcome $note)
   (py-call (home_assistant.record_house_outcome $action $outcome $note)))

(= (house-action-log $count)
   (py-call (home_assistant.house_action_log $count)))
