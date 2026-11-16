!(import! &self (library lib_import))
!(import_prolog_functions_from_file ./repos/OmegaClaw-Core/hive/runtime/register.pl (register-hive-core))
!(register-hive-core)
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

; Smoke test the live loop shape:
; raw the agent command -> signature membrane -> sread -> command-results -> reduce.

!(println! (py-call (hive_helpers.signature_balance_parentheses "write-file /tmp/omega-write-loop-smoke.html \"<html><body><h1>Home: 🏠</h1>\n<p>中文 ok</p>\n<p>Quote: \\\"safe\\\"</p>\n<p>MeTTa: (PersistentNote \\\"omega\\\" \\\"x:y\\\" \\\"0.9\\\")</p></body></html>\"")))

!(println!
  (let* (($raw "write-file /tmp/omega-write-loop-smoke.html \"<html><body><h1>Home: 🏠</h1>\n<p>中文 ok</p>\n<p>Quote: \\\"safe\\\"</p>\n<p>MeTTa: (PersistentNote \\\"omega\\\" \\\"x:y\\\" \\\"0.9\\\")</p></body></html>\"")
         ($response (py-call (hive_helpers.signature_balance_parentheses $raw)))
         ($sexpr (catch (sread $response))))
        (RESULTS: (command-results $sexpr)))

!(println! (read-file "/tmp/omega-write-loop-smoke.html"))
