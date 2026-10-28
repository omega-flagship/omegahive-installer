!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

; Smoke test for the exact live-loop command execution wrapper.
; This protects against regressions where a skill works directly but fails when
; passed through helper.balance_parentheses -> sread -> command-results -> reduce.

!(add-atom &persistent (SandboxLoopTransform "omega" "old-one" "0.4"))
!(add-atom &persistent (SandboxLoopTransform "omega" "old-two" "0.4"))

!(println! (space-count "persistent" "(SandboxLoopTransform \"omega\" $note $conf)"))

!(println! (py-eval "__import__('helper').__file__"))
!(println! (py-call (helper.balance_parentheses "space-transform \"persistent (SandboxLoopTransform \\\"omega\\\" $note $conf) events (SandboxLoopMerged \\\"omega\\\" \\\"old-one+old-two\\\" \\\"0.8\\\") smoke-loop-wrapper\"")))

!(println!
  (let* (($raw "space-transform \"persistent (SandboxLoopTransform \\\"omega\\\" $note $conf) events (SandboxLoopMerged \\\"omega\\\" \\\"old-one+old-two\\\" \\\"0.8\\\") smoke-loop-wrapper\"")
         ($response (py-call (helper.balance_parentheses $raw)))
         ($sexpr (catch (sread $response))))
        (RESULTS: (command-results $sexpr)))

!(println! (space-count "persistent" "(SandboxLoopTransform \"omega\" $note $conf)"))
!(println! (space-find "events" "(SandboxLoopMerged \"omega\" \"old-one+old-two\" \"0.8\")"))
