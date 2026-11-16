; Thin calls to the hive: it searches and fetches on the host (hive/core/webtools.py). The mind never reaches the internet.
(= (web-search $msg)
   (py-call (hive_web.search $msg)))

(= (web-fetch $url)
   (py-call (hive_web.fetch $url)))

(= (search $msg)
   (web-search $msg))
