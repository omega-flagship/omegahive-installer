!(bind! &reminders (new-space))

(= (reminder-add $name $when $note)
   (progn (add-atom &reminders (Reminder $name $when $note active))
          (add-atom &events (ReminderTrace $name "added" $when $note))
          (py-str ("REMINDER-ADDED " $name " " $when))))

(= (reminder-list)
   (repr (get-atoms &reminders)))

(= (reminder-cancel $name $reason)
   (progn (add-atom &reminders (ReminderCancelled $name $reason))
          (add-atom &events (ReminderTrace $name "cancelled" $reason))
          (py-str ("REMINDER-CANCELLED " $name))))

(= (reminder-due)
   (repr (get-atoms &reminders)))
