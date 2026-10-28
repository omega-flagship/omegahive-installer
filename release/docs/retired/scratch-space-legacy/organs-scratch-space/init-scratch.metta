; Scratch space initialization
; Sets up default TTL configuration and ensures scratch space is ready

; Initialize scratch TTL registry on boot
(= (init-scratch)
   (progn
     (register-scratch-space)
     (register-scratch-ttl)
     (py-str "SCRATCH-SPACE-INITIALIZED: &scratch and &scratch-ttl ready")))

; Default TTL configuration
(= (scratch-ttl-default) 3)

; Initialize scratch space on load
!(init-scratch)

; Scratch space initialization marker
(ScratchSpaceInitialized)
