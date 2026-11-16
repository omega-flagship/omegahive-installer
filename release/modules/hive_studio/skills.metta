; Studio maker skills (J3 host R6.1): one py-call each into the REST bridge, src/hive_studio.py.

(= (hive-studio-context $session $execution)
   (py-call (hive_studio.context $session $execution)))

(= (hive-studio-publish $artifact $execution $parent $body)
   (py-call (hive_studio.publish $artifact $execution $parent $body)))

(= (hive-studio-done $session $n $execution $more)
   (py-call (hive_studio.done $session $n $execution $more)))
