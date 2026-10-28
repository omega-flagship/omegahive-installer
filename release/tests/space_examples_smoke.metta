!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

; Read-only bounded AtomSpace view. This should give the agent exact examples
; without dumping an entire cognitive space.

!(add-atom &persistent (SandboxExample "one" "0.4"))
!(add-atom &persistent (SandboxExample "two" "0.5"))
!(add-atom &persistent (SandboxExample "three" "0.6"))

!(println! (space-count "persistent" "(SandboxExample $name $conf)"))
!(println! (space-examples "persistent" "(SandboxExample $name $conf)" 2))
!(println! (space-examples "persistent" "(SandboxMissing $name $conf)" 5))
!(println! (space-examples "missing-space" "(SandboxExample $name $conf)" 2))
