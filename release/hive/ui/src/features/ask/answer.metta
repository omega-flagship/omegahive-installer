; Purpose: compose what shows under an answer in the Ask's thread: where the answer came from, and the research it held back.
; Under each answer in the Ask's thread (features/ask/Thread.tsx AnswerRow), declared as atoms that
; screens/lib_screens.metta composes for the look being worn; MeTTa decides which parts show, the page states the facts.
;
; Facts the page states for each answer (answerFacts.ts):
;   (is answer.source model)     a model alone (the conductor answered: its tools hold no web search), the asker's own
;                                mind's or the Ask's; no value when the page can't know (nothing is said)
;   (on answer.wait)             this turn held back a research request because the Research swarm is asleep
;   (is answer.wait.phase checking|ready|working|sent|blocked|failed|closed)   how that request stands: being read (is a
;                                press able to send it?), not pressed and a press can send it, waking or sending, taken
;                                by the hive, the person may not wake the Research swarm (or it can't be woken) now, the
;                                wake or the send didn't go through (pressing again tries once more), or it can't be sent
;                                from here
;   (on answer.wait.awake)       the Research swarm's coordinator is awake or starting, so a press only sends
; The words are the page's (words.ts), in the data: answer.source.text and answer.wait.say.

(Screen ask-answer "Where an answer came from, and the research it waits on")
; where it came from: one quiet line, whenever the page knows
(Part ask-answer 10 note ((text (bind answer.source.text))))
(When ask-answer 10 (is answer.source model))
; the held-back research, once it is known that a press can't send it or something has happened to it (before the
; press, the answer above already says why it wasn't sent)
(Part ask-answer 20 note ((text (bind answer.wait.say))))
(When ask-answer 20 (on answer.wait))
(When ask-answer 20 (none-of ((is answer.wait.phase ready) (is answer.wait.phase checking))))
; one press wakes the Research swarm and sends the same request, offered only where it can go through (the check, or a
; wake or a send that didn't go through, which pressing again tries once more)
(Part ask-answer 21 buttons ((items ((button "Wake Research and send" wake-research ((variant ghost)))))))
(When ask-answer 21 (on answer.wait))
(When ask-answer 21 (any ((is answer.wait.phase ready) (is answer.wait.phase failed))))
(When ask-answer 21 (off answer.wait.awake))
; with the Research swarm awake already, the same press only sends
(Part ask-answer 22 buttons ((items ((button "Send the research" wake-research ((variant ghost)))))))
(When ask-answer 22 (on answer.wait))
(When ask-answer 22 (any ((is answer.wait.phase ready) (is answer.wait.phase failed))))
(When ask-answer 22 (on answer.wait.awake))
