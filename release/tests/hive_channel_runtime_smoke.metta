; Boots the runtime with commchannel=hive and does one receive/send round trip
; through the channel router.  Driven by tests/test_channel_hive_runtime.py,
; which runs a fake agent hub and sets HIVE_WS_URL / HIVE_WS_TOKEN.

!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

!(initLoop)
!(initChannels)

; Python's empty string can come back as an empty atom, so test the length
; like the loop does instead of comparing with "".
(= (await-message $tries)
   (let $msg (receive)
        (if (or (> (string_length $msg) 0) (== $tries 0))
            $msg
            (progn (sleep 0.5) (await-message (- $tries 1))))))

!(println! (HIVE-RECEIVED (await-message 40)))
!(send "pong from the agent")
!(println! (HIVE-STATUS (channel-status)))
!(sleep 1)
