!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

; Bad syntax experiment only. This checks that malformed surgery attempts fail closed.

(= (sandbox-space-handle events) &events)
(= (sandbox-space-handle persistent) &persistent)

(= (sandbox-general-transform $source $patternstr $target $replacementstr $reason)
   (let* (($source-space (sandbox-space-handle $source))
          ($target-space (sandbox-space-handle $target))
          ($pattern (sread $patternstr))
          ($replacement (sread $replacementstr)))
         (progn (collapse (match $source-space $pattern
                                  (remove-atom $source-space $pattern)))
                (add-atom $target-space $replacement)
                (add-atom &events (Event "test" "sandbox-general-transform" $reason "0.9"))
                (GeneralTransformed $source $target $pattern $replacement))))

!(add-atom &persistent (SandboxPersistentBad "omega" "safe-survivor" "0.9"))
!(println! (eval (space-count persistent "(SandboxPersistentBad \"omega\" $note $conf)")))

; Known bad shape: atom split as if copied through the command normalizer incorrectly.
!(println! (catch (eval (sandbox-general-transform persistent "(SandboxPersistentBad" events "(SandboxMergedBad \"omega\" \"summary\" \"0.9\")" "bad split atom"))))
!(println! (eval (space-count persistent "(SandboxPersistentBad \"omega\" $note $conf)")))
!(println! (eval (space-find events "(SandboxMergedBad \"omega\" \"summary\" \"0.9\")")))

; Known bad shape: missing closing paren.
!(println! (catch (eval (sandbox-general-transform persistent "(SandboxPersistentBad \"omega\" $note $conf" events "(SandboxMergedBad \"omega\" \"summary2\" \"0.9\")" "missing close paren"))))
!(println! (eval (space-count persistent "(SandboxPersistentBad \"omega\" $note $conf)")))
!(println! (eval (space-find events "(SandboxMergedBad \"omega\" \"summary2\" \"0.9\")")))

; Known bad shape: replacement is malformed but still a valid host string. Source atom must survive.
!(println! (catch (eval (sandbox-general-transform persistent "(SandboxPersistentBad \"omega\" $note $conf)" events "(SandboxMergedBad \"omega\" \"unterminated\"" "bad replacement"))))
!(println! (eval (space-count persistent "(SandboxPersistentBad \"omega\" $note $conf)")))
!(println! (eval (space-find events "(SandboxMergedBad \"omega\" \"unterminated\")")))

; Known bad shape: unknown source space. Should fail before mutation.
!(println! (catch (eval (sandbox-general-transform nowhere "(SandboxPersistentBad \"omega\" $note $conf)" events "(SandboxMergedBad \"omega\" \"summary3\" \"0.9\")" "bad source space"))))
!(println! (eval (space-count persistent "(SandboxPersistentBad \"omega\" $note $conf)")))
!(println! (eval (space-find events "(SandboxMergedBad \"omega\" \"summary3\" \"0.9\")")))
