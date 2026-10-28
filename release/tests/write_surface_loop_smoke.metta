!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

; Smoke test the live loop shape:
; raw the agent command -> signature membrane -> sread -> command-results -> reduce.

!(println! (py-call (helper.signature_balance_parentheses "write-file /tmp/omega-write-loop-smoke.html \"<html><body><h1>Home: 🏠</h1>\n<p>中文 ok</p>\n<p>Quote: \\\"safe\\\"</p>\n<p>MeTTa: (PersistentNote \\\"omega\\\" \\\"x:y\\\" \\\"0.9\\\")</p></body></html>\"")))

!(println!
  (let* (($raw "write-file /tmp/omega-write-loop-smoke.html \"<html><body><h1>Home: 🏠</h1>\n<p>中文 ok</p>\n<p>Quote: \\\"safe\\\"</p>\n<p>MeTTa: (PersistentNote \\\"omega\\\" \\\"x:y\\\" \\\"0.9\\\")</p></body></html>\"")
         ($response (py-call (helper.signature_balance_parentheses $raw)))
         ($sexpr (catch (sread $response))))
        (RESULTS: (command-results $sexpr)))

!(println! (read-file "/tmp/omega-write-loop-smoke.html"))
