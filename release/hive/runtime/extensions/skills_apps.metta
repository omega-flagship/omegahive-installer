; Purpose: expose app actions as quoted, authority-none data through the host boundary.
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./hive/runtime/extensions/helper_apps.py))))

(= (app-act $json)
   (sread (py-call (helper_apps.call "app-act" $json))))

(= (app-resume $json)
   (sread (py-call (helper_apps.call "app-resume" $json))))
