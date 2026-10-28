; Symbolic skill affordance registry.
;
; This is an inspectable skill directory in AtomSpace form. It answers
; "what should I use for this?" with MeTTa atoms rather than a hidden Python
; router. Runtime skills remain normal skills; this organ only exposes compact
; guidance for attention, context economy, and module discovery.

!(bind! &skills (new-space))
!(register-space "skills" &skills affordance)
!(register-space-alias skills "skills")
!(bind! &skill_triggers (new-space))
!(register-space "skill-triggers" &skill_triggers memory)
!(register-space-alias skill-triggers "skill-triggers")
!(register-space-persistence "skill-triggers" (memory-file "skill-triggers.metta") runtime-state)

; Registry schema:
; (Skill "name")
; (SkillTopic "name" "topic")
; (SkillArg "name" index "type" "arg-name")
; (SituationFeature "situation" "feature")
; (PreferredWhen "skill" "feature" confidence "why")
; (Risk "skill" "risk")
; (Effect "skill" "effect")
; (SkillCardLine "skill" "human-readable compact line")
; (SkillTrigger "skill" "signal" confidence "why")
; (CandidateSkillTrigger "skill" "signal" confidence "why")
; (SkillAlias "alias-topic" "canonical-topic" confidence "why")
; (CandidateSkillAlias "alias-topic" "canonical-topic" confidence "why")
; (SkillRecall "signal" "skill" confidence "why" "compact card line")

(= (skill-topic-cards $space $topic)
   (collapse (match $space (SkillTopic $skill $topic)
                    (SkillCard $topic $skill))))

(= (skill-topic-cards-normalized $space $topic)
   (list_to_set (append (skill-topic-cards $space $topic)
                        (skill-topic-cards $space (repr $topic)))))

(= (query-skill-space $topic)
   (list_to_set (append (append (skill-topic-cards-normalized &skills $topic)
                                (skill-topic-cards-normalized &self $topic))
                        (append (append (skill-topic-cards-via-alias-normalized &skills $topic)
                                        (skill-topic-cards-via-alias-normalized &skill_triggers $topic))
                                (skill-topic-cards-via-alias-normalized &self $topic)))))

(= (skill-topic-cards-via-alias $space $topic)
   (list_to_set
     (append (collapse (match $space (SkillAlias $topic $canonical $confidence $why)
                              (match &skills (SkillTopic $skill $canonical)
                                     (SkillCard $canonical $skill))))
             (collapse (match $space (SkillAlias $topic $canonical $confidence $why)
                              (match &self (SkillTopic $skill $canonical)
                                     (SkillCard $canonical $skill)))))))

(= (skill-topic-cards-via-alias-normalized $space $topic)
   (list_to_set (append (skill-topic-cards-via-alias $space $topic)
                        (skill-topic-cards-via-alias $space (repr $topic)))))

(= (skill-choices $space $situation)
   (collapse (match $space (SituationFeature $situation $feature)
                    (match $space (PreferredWhen $skill $feature $confidence $why)
                           (SkillChoice $situation $skill $confidence $why)))))

(= (skill-choices-normalized $space $situation)
   (list_to_set (append (skill-choices $space $situation)
                        (skill-choices $space (repr $situation)))))

(= (choose-skill-for $situation)
   (list_to_set (append (skill-choices-normalized &skills $situation)
                        (skill-choices-normalized &self $situation))))

(= (skill-args-normalized $space $skill)
   (let $symbol (repr $skill)
        (append (collapse (match $space (SkillArg $skill $index $type $name)
                                 (SkillCardArg $skill $index $type $name)))
                (collapse (match $space (SkillArg $symbol $index $type $name)
                                 (SkillCardArg $symbol $index $type $name))))))

(= (skill-risks-normalized $space $skill)
   (let $symbol (repr $skill)
        (append (collapse (match $space (Risk $skill $risk)
                                 (SkillRisk $skill $risk)))
                (collapse (match $space (Risk $symbol $risk)
                                 (SkillRisk $symbol $risk))))))

(= (skill-effects-normalized $space $skill)
   (let $symbol (repr $skill)
        (append (collapse (match $space (Effect $skill $effect)
                                 (SkillEffect $skill $effect)))
                (collapse (match $space (Effect $symbol $effect)
                                 (SkillEffect $symbol $effect))))))

(= (explain-skill $skill)
   (list_to_set
     (append (append (append (skill-args-normalized &skills $skill)
                             (skill-risks-normalized &skills $skill))
                     (skill-effects-normalized &skills $skill))
             (append (append (skill-args-normalized &self $skill)
                             (skill-risks-normalized &self $skill))
                     (skill-effects-normalized &self $skill)))))

(= (skill-card-lines-normalized $space $skill)
   (let $symbol (repr $skill)
        (append (collapse (match $space (SkillCardLine $skill $line)
                                 (SkillCardLine $skill $line)))
                (collapse (match $space (SkillCardLine $symbol $line)
                                 (SkillCardLine $symbol $line))))))

(= (skill-card $skill)
   (list_to_set (append (skill-card-lines-normalized &skills $skill)
                        (skill-card-lines-normalized &self $skill))))

(= (skill-trigger-suggestions $space $signal)
   (collapse (match $space (SkillTrigger $skill $signal $confidence $why)
                    (AttentionSkillSuggestion $signal $skill $confidence $why))))

(= (skill-trigger-suggestions-normalized $space $signal)
   (let $symbol (repr $signal)
        (list_to_set (append (skill-trigger-suggestions $space $signal)
                             (skill-trigger-suggestions $space $symbol)))))

(= (skill-suggestions-for $signal)
   (list_to_set (append (append (skill-trigger-suggestions-normalized &skills $signal)
                                (skill-trigger-suggestions-normalized &skill_triggers $signal))
                        (skill-trigger-suggestions-normalized &self $signal))))

(= (skill-recall-card-lines $space $signal)
   (collapse (match $space (SkillTrigger $skill $signal $confidence $why)
                     (match $space (SkillCardLine $skill $line)
                            (SkillRecall $signal $skill $confidence $why $line)))))

(= (skill-recall-card-lines-normalized $space $signal)
    (let $symbol (repr $signal)
         (list_to_set (append (skill-recall-card-lines $space $signal)
                              (skill-recall-card-lines $space $symbol)))))

(= (skill-recall-card-lines-with-cards $trigger-space $card-space $signal)
   (collapse (match $trigger-space (SkillTrigger $skill $signal $confidence $why)
                    (match $card-space (SkillCardLine $skill $line)
                           (SkillRecall $signal $skill $confidence $why $line)))))

(= (skill-recall-card-lines-with-cards-normalized $trigger-space $card-space $signal)
   (let $symbol (repr $signal)
        (list_to_set (append (skill-recall-card-lines-with-cards $trigger-space $card-space $signal)
                             (skill-recall-card-lines-with-cards $trigger-space $card-space $symbol)))))

(= (skill-recall-cards-for-signal $signal)
   (list_to_set (append (append (skill-recall-card-lines-normalized &skills $signal)
                                (skill-recall-card-lines-normalized &self $signal))
                        (append (skill-recall-card-lines-with-cards-normalized &skill_triggers &skills $signal)
                                (skill-recall-card-lines-with-cards-normalized &skill_triggers &self $signal)))))

; One clause: a separate (skill-recall-cards-for-signals ()) case would also
; match the general clause, so every recursion level would fork and the loop
; would re-run its LLM call once per duplicate result.
(= (skill-recall-cards-for-signals $signals)
   (if (== $signals ())
       ()
       (append (skill-recall-cards-for-signal (car-atom $signals))
               (skill-recall-cards-for-signals (cdr-atom $signals)))))

(= (skill-recall $msgnew $msg)
   (if $msgnew
       (let* (($signals (car-atom (collapse (sread (py-call (helper.input_skill_signals_expr (string-safe $msg)))))))
              ($cards (list_to_set (skill-recall-cards-for-signals $signals))))
             (repr $cards))
       ""))

(= (skill-trigger-candidates)
   (list_to_set (append (collapse (match &skill_triggers (CandidateSkillTrigger $skill $signal $confidence $why)
                                         (CandidateSkillTrigger $skill $signal $confidence $why)))
                        (collapse (match &self (CandidateSkillTrigger $skill $signal $confidence $why)
                                         (CandidateSkillTrigger $skill $signal $confidence $why))))))

(= (skill-aliases-for-topic $space $topic)
   (collapse (match $space (SkillAlias $alias $topic $confidence $why)
                    (SkillAlias $alias $topic $confidence $why))))

(= (skill-aliases-for-topic-normalized $space $topic)
   (let $symbol (repr $topic)
        (list_to_set (append (skill-aliases-for-topic $space $topic)
                             (skill-aliases-for-topic $space $symbol)))))

(= (skill-alias-targets $space $alias)
   (collapse (match $space (SkillAlias $alias $canonical $confidence $why)
                    (SkillAliasTarget $alias $canonical $confidence $why))))

(= (skill-alias-targets-normalized $space $alias)
   (let $symbol (repr $alias)
        (list_to_set (append (skill-alias-targets $space $alias)
                             (skill-alias-targets $space $symbol)))))

(= (skill-aliases $topic)
   (list_to_set
     (append (append (skill-aliases-for-topic-normalized &skills $topic)
                     (skill-aliases-for-topic-normalized &skill_triggers $topic))
             (append (append (skill-aliases-for-topic-normalized &self $topic)
                             (skill-alias-targets-normalized &skills $topic))
                     (append (skill-alias-targets-normalized &skill_triggers $topic)
                             (skill-alias-targets-normalized &self $topic))))))

(= (skill-alias-candidates)
   (list_to_set (append (collapse (match &skill_triggers (CandidateSkillAlias $alias $topic $confidence $why)
                                         (CandidateSkillAlias $alias $topic $confidence $why)))
                        (collapse (match &self (CandidateSkillAlias $alias $topic $confidence $why)
                                         (CandidateSkillAlias $alias $topic $confidence $why))))))

(= (save-skill-trigger-space)
   (save-runtime-space "skill-triggers"))

(= (suggest-skill-trigger $skill $signal $confidence $reason)
   (progn (add-atom &skill_triggers (CandidateSkillTrigger $skill $signal $confidence $reason))
          (let $saved (save-skill-trigger-space)
               (CandidateSkillTriggerAdded $skill $signal $confidence $reason))))

(= (add-skill-trigger $skill $signal $confidence $reason)
   (progn (add-atom &skill_triggers (SkillTrigger $skill $signal $confidence $reason))
          (let $saved (save-skill-trigger-space)
               (SkillTriggerAdded $skill $signal $confidence $reason))))

(= (promote-skill-trigger $skill $signal $confidence $reason)
   (progn (collapse (match &skill_triggers (CandidateSkillTrigger $skill $signal $oldconfidence $oldreason)
                           (remove-atom &skill_triggers (CandidateSkillTrigger $skill $signal $oldconfidence $oldreason))))
          (add-atom &skill_triggers (SkillTrigger $skill $signal $confidence $reason))
          (let $saved (save-skill-trigger-space)
               (SkillTriggerPromoted $skill $signal $confidence $reason))))

(= (suggest-skill-alias $alias $topic $confidence $reason)
   (progn (add-atom &skill_triggers (CandidateSkillAlias $alias $topic $confidence $reason))
          (let $saved (save-skill-trigger-space)
               (CandidateSkillAliasAdded $alias $topic $confidence $reason))))

(= (add-skill-alias $alias $topic $confidence $reason)
   (progn (add-atom &skill_triggers (SkillAlias $alias $topic $confidence $reason))
          (let $saved (save-skill-trigger-space)
               (SkillAliasAdded $alias $topic $confidence $reason))))

(= (promote-skill-alias $alias $topic $confidence $reason)
   (progn (collapse (match &skill_triggers (CandidateSkillAlias $alias $topic $oldconfidence $oldreason)
                           (remove-atom &skill_triggers (CandidateSkillAlias $alias $topic $oldconfidence $oldreason))))
          (add-atom &skill_triggers (SkillAlias $alias $topic $confidence $reason))
          (let $saved (save-skill-trigger-space)
               (SkillAliasPromoted $alias $topic $confidence $reason))))
