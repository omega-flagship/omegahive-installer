!(import! &self (library lib_import))
!(import! &self (library lib_spaces))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")

!(bind! &persistent (new-space))
!(bind! &agenda (new-space))
!(bind! &beliefs (new-space))
!(bind! &world (new-space))
!(bind! &events (new-space))
!(bind! &activity (new-space))
!(bind! &merge_smoke_space (new-space))

!(import! &self (library OmegaClaw-Core ./src/skills))
!(register-space "merge-smoke-space" &merge_smoke_space memory)

!(add-atom &merge_smoke_space (PersistentNote "merge-smoke" "one" "0.8"))
!(add-atom &merge_smoke_space (PersistentNote "merge-smoke" "two" "0.8"))
!(add-atom &merge_smoke_space (PersistentNote "merge-smoke-keep" "other" "0.8"))

!(if (== (eval (space-count "merge-smoke-space" "(PersistentNote \"merge-smoke\" $note \"0.8\")")) 2)
     (println! SPACE-MERGE-BEFORE-COUNT-OK)
     (println! FAILED-SPACE-MERGE-BEFORE-COUNT))

!(eval (space-merge-atoms "merge-smoke-space" "(PersistentNote \"merge-smoke\" $note \"0.8\")" "(PersistentNote \"merge-smoke\" \"merged\" \"0.9\")" "smoke merge reviewed duplicate notes"))

!(if (== (eval (space-count "merge-smoke-space" "(PersistentNote \"merge-smoke\" $note $conf)")) 1)
     (println! SPACE-MERGE-AFTER-COUNT-OK)
     (println! FAILED-SPACE-MERGE-AFTER-COUNT))

!(if (== (eval (space-find "merge-smoke-space" "(PersistentNote \"merge-smoke\" \"merged\" \"0.9\")")) true)
     (println! SPACE-MERGE-REPLACEMENT-OK)
     (println! FAILED-SPACE-MERGE-REPLACEMENT))

!(if (== (eval (space-count "merge-smoke-space" "(PersistentNote \"merge-smoke-keep\" $note $conf)")) 1)
     (println! SPACE-MERGE-SURVIVOR-OK)
     (println! FAILED-SPACE-MERGE-SURVIVOR))
