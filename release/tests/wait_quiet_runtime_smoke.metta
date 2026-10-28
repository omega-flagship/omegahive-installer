; Boots the whole runtime with commchannel=hive and runs the real loop. Driven by tests/test_wait_quiet_runtime.py,
; which serves a fake agent hub and a fake model that only ever answers "wait <seconds>" and counts its calls.

!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core lib_omegaclaw))
!(omegaclaw)
