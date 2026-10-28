!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

; Focused test for the five-argument space-transform overload only.

!(add-atom &persistent (PersistentNote omega five-arg-smoke lesson-one 0.8))

!(println! (space-count "persistent" "(PersistentNote omega five-arg-smoke $note $conf)"))
!(println! (space-transform "persistent" "(PersistentNote omega five-arg-smoke $note $conf)" "events" "(EventNote omega five-arg-smoke-archived lesson-moved 0.9)" "five-arg-smoke"))
!(println! (space-count "persistent" "(PersistentNote omega five-arg-smoke $note $conf)"))
!(println! (space-find "events" "(EventNote omega five-arg-smoke-archived lesson-moved 0.9)"))
!(println! (space-transform "persistent" "(PersistentNote omega five-arg-smoke $note $conf)" "events" "(EventNote omega five-arg-smoke-archived lesson-moved 0.9)" "five-arg-smoke-no-match"))
!(println!
  (let* (($raw "space-transform \"persistent\" \"(PersistentNote omega five-arg-smoke $note $conf)\" \"events\" \"(EventNote omega five-arg-smoke-archived lesson-moved 0.9)\" \"five-arg-smoke-no-match-wrapper\"")
         ($response (py-call (helper.balance_parentheses $raw)))
         ($sexpr (catch (sread $response))))
        (RESULTS: (command-results $sexpr)))
