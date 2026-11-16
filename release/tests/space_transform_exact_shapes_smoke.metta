!(import! &self (library lib_import))
!(import_prolog_functions_from_file ./repos/OmegaClaw-Core/hive/runtime/register.pl (register-hive-core))
!(register-hive-core)
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

; Checks the exact cleanup shapes the agent struggled with after the loop-wrapper
; quote normalization fix. These atoms are sandbox-only.

!(add-atom &persistent (PersistentObservation test test-trace-symbol patch-test assimilate-persistent-works 0.5))
!(add-atom &persistent (PersistentObservation "test" "test-trace-string" "patch-test" "assimilate-persistent-works" "0.5"))
!(add-atom &persistent (PersistentNote omega phase1-search-practice lesson-one 0.8))

!(println! (space-count "persistent" "(PersistentObservation test $trace $kind $note $conf)"))
!(println! (space-count "persistent" "(PersistentObservation \"test\" $trace $kind $note $conf)"))
!(println! (space-count "persistent" "(PersistentObservation $who $trace $kind $note $conf)"))
!(println! (space-count "persistent" "(PersistentNote omega phase1-search-practice $note $conf)"))

!(println!
  (let* (($raw "space-transform \"persistent\" \"(PersistentObservation test $trace $kind $note $conf)\" \"events\" \"(EventNote omega symbol-test-debris-cleaned assimilate-test-moved 0.9)\" \"remove-symbol-test-debris\"")
         ($response (py-call (hive_helpers.balance_parentheses $raw)))
         ($sexpr (catch (sread $response))))
        (RESULTS: (command-results $sexpr)))

!(println!
  (let* (($raw "space-transform \"persistent\" \"(PersistentObservation \\\"test\\\" $trace $kind $note $conf)\" \"events\" \"(EventNote omega string-test-debris-cleaned assimilate-test-moved 0.9)\" \"remove-string-test-debris\"")
         ($response (py-call (hive_helpers.balance_parentheses $raw)))
         ($sexpr (catch (sread $response))))
        (RESULTS: (command-results $sexpr)))

!(println!
  (let* (($raw "space-transform \"persistent\" \"(PersistentNote omega phase1-search-practice $note $conf)\" \"events\" \"(EventNote omega practice-debris-archived search-lessons-moved 0.9)\" \"practice-debris-cleanup\"")
         ($response (py-call (hive_helpers.balance_parentheses $raw)))
         ($sexpr (catch (sread $response))))
        (RESULTS: (command-results $sexpr)))

!(println! (space-count "persistent" "(PersistentObservation $who $trace $kind $note $conf)"))
!(println! (space-count "persistent" "(PersistentNote omega phase1-search-practice $note $conf)"))
!(println! (space-find "events" "(EventNote omega symbol-test-debris-cleaned assimilate-test-moved 0.9)"))
!(println! (space-find "events" "(EventNote omega string-test-debris-cleaned assimilate-test-moved 0.9)"))
!(println! (space-find "events" "(EventNote omega practice-debris-archived search-lessons-moved 0.9)"))
