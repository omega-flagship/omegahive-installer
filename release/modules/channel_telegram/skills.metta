(= (TG_BOT_TOKEN) (empty))
(= (TG_CHAT_ID) (empty))
(= (TG_POLL_TIMEOUT) (empty))

(= (send-telegram $msg)
   (if (!= $msg (get-state &lastsend))
       (progn (change-state! &lastsend $msg)
              (let $safemsg (string-replace $msg "
" "\n")
                   (if (== (commchannel) multi)
                       (py-call (router.send_telegram $safemsg))
                       (py-call (telegram.send_message $safemsg))))) _))

(= (send-telegram-base64 $payload)
   (py-call (router.send_telegram_base64 $payload)))

(= (telegram-status)
   (py-call (telegram.status)))
