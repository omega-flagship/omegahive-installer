; Purpose: bind hive collaboration and task skills to their authenticated Python membrane.
(= (hive-publish $statement $f $c)
   (py-call (hive_commons.publish (repr $statement) $f $c)))

(= (hive-query $pattern)
   (py-call (hive_commons.query (repr $pattern))))

(= (hive-belief $statement)
   (py-call (hive_commons.belief (repr $statement))))

(= (hive-goals)
   (py-call (hive_commons.goals)))

(= (hive-goal-history $query $offset)
   (py-call (hive_commons.goal_history $query $offset)))

(= (hive-goal-continue $id $instruction)
   (py-call (hive_commons.goal_continue $id $instruction)))

(= (hive-goal-output $id $offset)
   (py-call (hive_commons.goal_output $id $offset)))

(= (hive-goal-claim $id)
   (py-call (hive_commons.goal_claim $id)))

(= (hive-goal-done $id $result)
   (py-call (hive_commons.goal_finish $id "done" $result)))

(= (hive-goal-fail $id $reason)
   (py-call (hive_commons.goal_finish $id "failed" $reason)))

(= (hive-goal-create $parent $title)
   (py-call (hive_commons.goal_create $parent $title)))

(= (hive-goal-get $id)
   (py-call (hive_commons.goal_get $id)))

(= (hive-goal-propose $id $text)
   (py-call (hive_commons.goal_propose $id $text)))

(= (hive-goal-cancel-ack $id)
   (py-call (hive_commons.goal_cancel_ack $id)))

(= (hive-goal-heartbeat $id)
   (py-call (hive_commons.goal_heartbeat $id)))

; ---- building software: a mind asks Create, whose code minds build it once its person starts it ----

(= (hive-create $sentence)
   (py-call (hive_commons.create $sentence)))

; ---- timed sharing: show spaces and work to other dots for a while ----

(= (hive-shares)
   (py-call (hive_commons.shares)))

(= (hive-share-request $owner $space $minutes $reason)
   (py-call (hive_commons.share_request $owner $space $minutes $reason)))

(= (hive-share-grant $id)
   (py-call (hive_commons.share_grant $id)))

(= (hive-share-deny $id $reason)
   (py-call (hive_commons.share_deny $id $reason)))

(= (hive-share-offer $dot $space $minutes)
   (py-call (hive_commons.share_offer $dot $space $minutes)))

(= (hive-shared $id $filter)
   (py-call (hive_commons.shared $id $filter)))

(= (hive-lifecycle-start $lease)
   (py-call (hive_commons.lifecycle_start $lease)))

(= (hive-lifecycle-stop $lease)
   (py-call (hive_commons.lifecycle_stop $lease)))

(= (hive-lifecycle-status $lease)
   (py-call (hive_commons.lifecycle_status $lease)))

(= (hive-request $json)
   (py-call (hive_commons.request $json)))

(= (hive-artifact-create $json)
   (py-call (hive_commons.artifact_create $json)))

(= (hive-revision $id $json)
   (py-call (hive_commons.revision $id $json)))

(= (hive-revision-part $id $n $text)
   (py-call (hive_commons.revision_part $id $n $text)))

(= (hive-revision-read $id $n)
   (py-call (hive_commons.revision_read $id $n)))

(= (hive-finding $json)
   (py-call (hive_commons.finding $json)))

(= (hive-report-problem $json)
   (py-call (hive_commons.report_problem $json)))

(= (hive-review-complete $id $json)
   (py-call (hive_commons.review_complete $id $json)))

(= (hive-asset-put $path $name)
   (py-call (hive_commons.asset_put $path $name)))

(= (hive-asset-get $sha $where)
   (py-call (hive_commons.asset_get $sha $where)))

(= (hive-asset-list $cursor)
   (py-call (hive_commons.asset_list $cursor)))

(= (hive-review-receipts $digest)
   (py-call (hive_commons.review_receipts $digest)))

(= (hive-goal-review $id $decision $notes)
   (py-call (hive_commons.goal_review $id $decision $notes)))

(= (hive-rooms)
   (py-call (hive_commons.rooms)))

(= (hive-room-post $id $text)
   (py-call (hive_commons.room_post $id $text)))

(= (hive-coffee-note $text)
   (py-call (hive_commons.coffee_note $text)))

(= (hive-health)
   (py-call (hive_commons.health)))

(= (hive-shared-body $id $part)
   (py-call (hive_commons.shared_body $id $part)))

(= (hive-shared-page $id $offset $filter)
   (py-call (hive_commons.shared_page $id $offset $filter)))

(= (hive-exhibit $to $minutes $text)
   (py-call (hive_commons.exhibit $to $minutes $text)))

(= (hive-exhibit-space $to $space $minutes $filter)
   (py-call (hive_commons.exhibit_space $to $space $minutes $filter)))

; the stage: show something on the screen of the person this turn answers, bring something back beside it, or compare two
(= (hive-show $thing)
   (py-call (hive_commons.stage_show $thing)))

(= (hive-recall $thing)
   (py-call (hive_commons.stage_recall $thing)))

(= (hive-compare $this $that)
   (py-call (hive_commons.stage_compare $this $that)))

; ---- loop hooks (declared in entry.metta; only act when commchannel=hive) ----

(= (hive-mode?)
   (== (commchannel) hive))

(= (hive-report-trace)
   (if (hive-mode?)
       (py-call (hive_commons.trace (get-state &cycle)
                                    (if (get-state &lastResponseMsgNew) (get-state &prevmsg) "")
                                    (get-state &lastResponseText)
                                    (repr (get-state &lastResponseResults))))
       hive-trace-off))

(= (hive-apply-ops $ops)
   (if (== $ops ())
       hive-control-done
       (progn (hive-apply-op (car-atom $ops))
              (hive-apply-ops (cdr-atom $ops)))))

(= (hive-apply-op (retire $space $text))
   (let* (($handle (space-handle $space))
          ($atom (sread $text)))
         (remove-atom $handle $atom)))

(= (hive-apply-op (reset))
   (collapse (match &self (SpaceRegistry $name $handle memory)
                    (remove-all-atoms $handle))))

(= (hive-run-control)
   (if (hive-mode?)
       (hive-apply-ops (sread (py-call (hive_commons.take_control))))
       hive-control-off))

(= (hive-plan-return $request $artifact $revision) (py-call (hive_commons.plan_return $request $artifact $revision)))

(= (hive-findings-read $artifact) (py-call (hive_commons.findings_read $artifact)))

(= (hive-plan-review-context $request $artifact $revision) (py-call (hive_commons.plan_review_context $request $artifact $revision)))

(= (hive-finding-response $finding $json) (py-call (hive_commons.finding_response $finding $json)))

(= (hive-finding-disposition $finding $json) (py-call (hive_commons.finding_disposition $finding $json)))

; S4 boot receipt, started once by the RuntimeOrgan in entry.metta after every module has been imported.
(= (hive-inventory-boot)
   (py-call (hive_commons.post_inventory (repr (collapse (match &self (Provides $m (Skill $s)) ($m $s))))
                                         (repr (collapse (match &self (Module $m) $m))))))

(= (hive-flows) (py-call (hive_commons.flows)))
(= (hive-flow-draft $json) (py-call (hive_commons.flow_draft $json)))
(= (hive-flow-revise $id $json) (py-call (hive_commons.flow_revise $id $json)))
(= (hive-flow-read $id $n) (py-call (hive_commons.flow_read $id $n)))

(= (hive-flow-drafts) (py-call (hive_commons.flow_drafts)))

(= (hive-flow-publish $json) (py-call (hive_commons.flow_publish $json)))

(= (hive-flow-run $name $json) (py-call (hive_commons.flow_run $name $json)))

(= (hive-flow-retire $name) (py-call (hive_commons.flow_retire $name)))

(= (hive-flow-run-get $id) (py-call (hive_commons.flow_run_get $id)))

(= (hive-flow-cancel $id) (py-call (hive_commons.flow_cancel $id)))

; ---- repository maps (repo-map/1): read-only, the same engine people use ----

(= (repo-query $request) (py-call (hive_commons.repo_query $request)))

; Calendar reads leave the hive: policy and the person's exact per-mind consent both apply.
(= (calendar-read $json) (py-call (hive_commons.calendar_read $json)))
