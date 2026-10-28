!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

!(println! (eval (nars-query "((Sentence ((==> (--> (× TestPerson TestFriend) friend) (==> (--> TestPerson ([] smokes)) (--> TestFriend ([] smokes)))) (stv 0.4 0.9)) (1)) (Sentence ((==> (--> TestFriend ([] smokes)) (--> TestFriend ([] cancerous))) (stv 0.6 0.9)) (2)) (Sentence ((--> (× TestPerson TestFriend) friend) (stv 1.0 0.9)) (3)) (Sentence ((--> TestPerson ([] smokes)) (stv 1.0 0.9)) (4)))" "(--> TestFriend ([] cancerous))")))
!(println! (eval (assimilate-event "audio | obs123 | profile-data | TestPerson shared a preference in a voice note | 0.95")))
!(println! (eval (assimilate-world "audio | obs123 | TestPerson | preference | warm-light | 0.95")))
!(println! (eval (assimilate-belief "audio | obs123 | test-profile | preference | warm-light | 0.95 | 0.9")))
!(println! (eval (assimilate-persistent "audio | obs123 | test-profile | exact chosen observations can become durable notes | 0.95")))
