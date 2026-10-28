(= (initBodyContainerOrgan)
   (BodyContainerOrganReady (body-container-status)))

(= (body-container-status)
   (py-call (body_container.body_container_status)))

(= (body-container-self)
   (py-call (body_container.body_container_self)))

(= (body-container-launcher)
   (py-call (body_container.body_container_launcher)))

(= (body-container-last-trace)
   (py-call (body_container.body_container_last_trace)))
