(= (initAgentverseOrgan)
   (progn (register-space "agentverse" &agentverse memory)
          (register-space-alias agentverse "agentverse")
          (register-space-persistence "agentverse" (memory-file "agentverse.metta") runtime-state)
          (load-runtime-space "agentverse")
          (AgentverseOrganReady (agentverse-status))))

(= (agentverse-status)
   (py-call (agentverse_bridge.agentverse_status)))

(= (agentverse-listener-status)
   (py-call (agentverse_bridge.agentverse_listener_status)))

(= (agentverse-listener-start)
   (py-call (agentverse_bridge.agentverse_start_listener)))

(= (agentverse-listener-stop)
   (py-call (agentverse_bridge.agentverse_stop_listener)))

(= (agentverse-discover $query $limit)
   (let* (($bundle (py-call (agentverse_bridge.agentverse_discover_atoms $query $limit)))
          ($atom (sread $bundle)))
         (progn (add-atom &agentverse $atom)
                (trace-atom "write" "agentverse" $atom "agentverse-discover")
                $atom)))

(= (agentverse-discover $query)
   (agentverse-discover $query 5))

(= (agentverse-remote-agents)
   (repr (collapse (match &agentverse (RemoteAgent $name $address $schema $capability)
                          (RemoteAgent $name $address $schema $capability)))))

(= (agentverse-register-agent $name $address $schema $capability)
   (let $same (collapse (match &agentverse (RemoteAgent $name $address $schema $capability)
                               (RemoteAgentAlreadyRegistered $name $schema $capability)))
        (if (== $same ())
            (progn (collapse (match &agentverse (RemoteAgent $name $old-address $old-schema $old-capability)
                                    (remove-atom &agentverse (RemoteAgent $name $old-address $old-schema $old-capability))))
                   (add-atom &agentverse (RemoteAgent $name $address $schema $capability))
                   (trace-atom "write" "agentverse" (RemoteAgent $name $address $schema $capability) "agentverse-register-agent")
                   (py-call (agentverse_bridge.agentverse_record_agent $name $address $schema $capability))
                   (RemoteAgentRegistered $name $schema $capability))
            (car-atom $same))))

(= (agentverse-call $name $payload)
   (let $matches (collapse (match &agentverse (RemoteAgent $name $address $schema $capability)
                                  (RemoteAgentCall $address $schema $capability)))
        (if (== $matches ())
            (AgentverseError "unknown remote agent" $name)
            (let* (($entry (car-atom $matches))
                   ($rest1 (cdr-atom $entry))
                   ($address (car-atom $rest1))
                   ($schema (car-atom (cdr-atom $rest1))))
                  (py-call (agentverse_bridge.agentverse_call $address $schema $payload))))))

(= (agentverse-ask $destination $schema $payload)
   (py-call (agentverse_bridge.agentverse_ask $destination $schema $payload)))

(= (agentverse-trace)
   (py-call (agentverse_bridge.agentverse_trace)))

(= (agentverse-inbox)
   (py-call (agentverse_bridge.agentverse_inbox)))
