(= (send-web-control $msg)
   (if (!= $msg (get-state &lastsend))
       (progn (change-state! &lastsend $msg)
              (let $safemsg (string-replace $msg "
" "\n")
                   (py-call (router.send_web_control $safemsg)))) _))

(= (send-web-control-base64 $payload)
   (py-call (router.send_web_control_base64 $payload)))
