!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core lib_omegaclaw))
!(import! &self (car-atom (collapse (library OmegaClaw-Core lib_omegaclaw_body))))

!(println! (eval (video-config-status)))
!(println! (eval (body-status)))
