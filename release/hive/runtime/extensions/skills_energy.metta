(= (clamp $value $lo $hi)
   (min $hi (max $lo $value)))

(= (attention-status)
   (py-str ("ATTENTION runtime_cycle=" (get-state &cycle)
                     " practice_cycle=" (+ 1 (- (get-state &cycle) (get-state &practiceStartCycle)))
                     " practice_label=" (get-state &practiceLabel)
                     " loops=" (get-state &loops)
                     " mode=" (get-state &energyMode)
                     " max_new_input=" (get-state &maxNewInputLoops)
                     " max_wake=" (get-state &maxWakeLoops)
                     " sleep_interval=" (get-state &sleepInterval)
                     " wakeup_interval=" (get-state &wakeupInterval)
                     " next_wake_at=" (get-state &nextWakeAt))))

(= (cycle-status)
   (py-str ("CYCLE-STATUS runtime_cycle=" (get-state &cycle)
                         " practice_cycle=" (+ 1 (- (get-state &cycle) (get-state &practiceStartCycle)))
                         " practice_label=" (get-state &practiceLabel)
                         " practice_start_runtime_cycle=" (get-state &practiceStartCycle))))

(= (start-cycle-practice $label)
   (progn (collapse (change-state! &practiceStartCycle (get-state &cycle)))
          (collapse (change-state! &practiceLabel $label))
          (py-str ("CYCLE-PRACTICE-STARTED label=" $label
                                          " start_runtime_cycle=" (get-state &cycle)
                                          " practice_cycle=1"))))

(= (set-loop-energy $awake $wake $sleep_seconds $wakeup_seconds $reason)
   (let* (($awake2 (car-atom (collapse (clamp $awake 1 1000))))
          ($wake2 (car-atom (collapse (clamp $wake 1 20))))
          ($sleep2 (car-atom (collapse (clamp $sleep_seconds 3 3600))))
          ($wakeup2 (car-atom (collapse (clamp $wakeup_seconds 30 86400)))))
      (progn (collapse (change-state! &maxNewInputLoops $awake2))
             (collapse (change-state! &maxWakeLoops $wake2))
             (collapse (change-state! &sleepInterval $sleep2))
             (collapse (change-state! &wakeupInterval $wakeup2))
             (py-str (LOOP-ENERGY-SET awake-loops: $awake2
                                      wake-loops: $wake2
                                      sleep-seconds: $sleep2
                                      wakeup-seconds: $wakeup2
                                      reason: $reason)))))

(= (set-energy-mode $mode $reason)
   (if (or (== $mode "asleep")
           (or (== $mode "listening")
               (or (== $mode "warm")
                   (or (== $mode "focused")
                       (== $mode "creative")))))
       (progn (collapse (change-state! &energyMode $mode))
              (if (== $mode "asleep")
                  (set-loop-energy 1 1 10 600 $reason)
                  (if (== $mode "listening")
                      (set-loop-energy 5 2 3 300 $reason)
	                      (if (== $mode "warm")
	                          (set-loop-energy 12 8 3 300 $reason)
	                          (if (== $mode "focused")
	                              (set-loop-energy 30 20 3 300 $reason)
	                              (set-loop-energy 60 20 3 120 $reason))))))
       (py-str (ENERGY-MODE-SHAPE-WARNING mode: $mode expected: asleep/listening/warm/focused/creative raw-command-preserved-in-history no-energy-change-written reason: $reason))))

(= (sleep-for $seconds $reason)
   (let $seconds2 (car-atom (collapse (clamp $seconds 30 86400)))
      (progn (collapse (change-state! &loops 0))
             (collapse (change-state! &nextWakeAt (+ (get_time) $seconds2)))
             (py-str (SLEEPING-FOR seconds: $seconds2 reason: $reason)))))

(= (wake-for $loops $reason)
   (let $loops2 (car-atom (collapse (clamp $loops 1 1000)))
      (progn (collapse (change-state! &loops $loops2))
             (py-str (AWAKE-FOR loops: $loops2 reason: $reason)))))

(= (energy-status)
   (py-call (energy.energy_status)))

(= (cost-last-call)
   (py-call (energy.cost_last_call)))

(= (set-energy-budget $amount $currency $period)
   (py-call (energy.set_energy_budget $amount $currency $period)))

(= (set-energy-targets $daily $weekly $monthly $currency)
   (py-call (energy.set_energy_targets $daily $weekly $monthly $currency)))
