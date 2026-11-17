; Purpose: what the Ask's thread composes in MeTTa (Jon on #65: MeTTa composes the screen, React only draws it): the way
; on from a request that ended before its answer.

; ---------- under a request that stopped before its answer (features/ask/Thread.tsx states these, from store/ask.ts
; endedEarly): Continue sends its own words as the person's next request, and the conversation the Ask carries
; (lib/askMemory) holds what the stopped request asked, said and did and why it stopped, so the mind carries on from there.
;   flags  ask.ended-early  the hive took the request and closed it before its answer (a stop, its time or steps running
;                           out, a fault on the hive's side), never a spending stop, which has its own way on
;          ask.latest       it is the thread's latest request, so carrying on continues it
;          ask.kept         it is still kept (store/ask.ts stoppedUntil: a day from its start, the hive's own window for
;                           what a turn may still hand over), so the conversation still holds what it did
(Screen ask-stopped "A request that stopped before it finished")
(Part ask-stopped 10 actions ((items ((action "Continue" continue)))))
(When ask-stopped 10 (on ask.ended-early))
(When ask-stopped 10 (on ask.latest))
(When ask-stopped 10 (on ask.kept))
