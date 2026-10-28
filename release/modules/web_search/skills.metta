(= (web-search $msg)
   (py-call (websearch.search $msg)))

(= (search $msg)
   (web-search $msg))
