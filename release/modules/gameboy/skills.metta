(= (gb-status)
   (py-call (gameboy.gb_status)))

(= (gb-load $game)
   (py-call (gameboy.gb_load $game)))

(= (gb-observe)
   (py-call (gameboy.gb_observe)))

(= (gb-step $action)
   (py-call (gameboy.gb_step $action)))

(= (gb-screenshot)
   (py-call (gameboy.gb_screenshot)))

(= (gb-save-state $name)
   (py-call (gameboy.gb_save_state $name)))

(= (gb-load-state $name)
   (py-call (gameboy.gb_load_state $name)))

(= (gb-stop)
   (py-call (gameboy.gb_stop)))

(= (gb-last-trace)
   (py-call (gameboy.gb_last_trace)))
