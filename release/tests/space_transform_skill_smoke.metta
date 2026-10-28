!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library lib_spaces))
!(import! &self (library OmegaClaw-Core ./src/helper.py))
!(import! &self (library OmegaClaw-Core ./src/skills))

; Smoke test for the real space-transform organ.
; This file deliberately binds temporary spaces so it never mutates the agent's
; live memory when run through tests/run_metta_smokes.py.

!(bind! &persistent (new-space))
!(bind! &events (new-space))
!(bind! &agenda (new-space))
!(bind! &beliefs (new-space))
!(bind! &world (new-space))
!(bind! &attention (new-space))
!(bind! &assume (new-space))
!(register-default-runtime-spaces)

!(add-atom &persistent (SandboxSkillTransformV2 "omega" "old-one" "0.4"))
!(add-atom &persistent (SandboxSkillTransformV2 "omega" "old-two" "0.4"))
!(println! (space-count "persistent" "(SandboxSkillTransformV2 \"omega\" $note $conf)"))
!(println! (space-transform "persistent | (SandboxSkillTransformV2 \"omega\" $note $conf) | events | (SandboxSkillMergedV2 \"omega\" \"old-one+old-two\" \"0.8\") | smoke merge duplicate sandbox atoms"))
!(println! (space-count persistent "(SandboxSkillTransformV2 \"omega\" $note $conf)"))
!(println! (space-find "events" "(SandboxSkillMergedV2 \"omega\" \"old-one+old-two\" \"0.8\")"))
!(println! (space-find events "(Event \"omega\" \"space-transform\" $reason \"0.9\")"))

!(add-atom &persistent (SandboxSkillTransformV3 "omega" "old-one" "0.4"))
!(add-atom &persistent (SandboxSkillTransformV3 "omega" "old-two" "0.4"))
!(println! (space-count "persistent" "(SandboxSkillTransformV3 \"omega\" $note $conf)"))
!(println! (space-transform "persistent" "(SandboxSkillTransformV3 \"omega\" $note $conf)" "events" "(SandboxSkillMergedV3 \"omega\" \"old-one+old-two\" \"0.8\")" "smoke five arg merge duplicate sandbox atoms"))
!(println! (space-count persistent "(SandboxSkillTransformV3 \"omega\" $note $conf)"))
!(println! (space-find "events" "(SandboxSkillMergedV3 \"omega\" \"old-one+old-two\" \"0.8\")"))

!(add-atom &persistent (SandboxSkillBadV2 "omega" "safe-survivor" "0.9"))
!(println! (space-count "persistent" "(SandboxSkillBadV2 \"omega\" $note $conf)"))
!(println! (space-transform "persistent | (SandboxSkillBadV2 | events | (SandboxBadMergedV2 \"omega\" \"summary\" \"0.9\") | bad split atom"))
!(println! (space-count persistent "(SandboxSkillBadV2 \"omega\" $note $conf)"))
!(println! (space-find events "(SandboxBadMergedV2 \"omega\" \"summary\" \"0.9\")"))
!(println! (space-transform "nowhere | (SandboxSkillBadV2 \"omega\" $note $conf) | events | (SandboxBadMergedV2 \"omega\" \"summary2\" \"0.9\") | bad source space"))
!(println! (space-count persistent "(SandboxSkillBadV2 \"omega\" $note $conf)"))
!(println! (space-find events "(SandboxBadMergedV2 \"omega\" \"summary2\" \"0.9\")"))

!(println! (space-count persistent "(SandboxSkillBadV2"))
!(println! (space-find events "(SandboxBadMergedV2"))
!(println! (retire-persistent-expression "(SandboxSkillBadV2" "bad retire syntax"))
!(println! (space-count persistent "(SandboxSkillBadV2 \"omega\" $note $conf)"))
