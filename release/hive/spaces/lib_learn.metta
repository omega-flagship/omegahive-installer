; lib_learn: a routine's track record from its flow runs, so a routine that has
; proved itself can run instead of the AI.
;
; The rule is GoalChainer v2's (gc-track-promotion (Trials N) (Threshold THETA))
; over receipts.  A routine is one flow artifact at one revision, and each of its
; runs is (Run "<run id>" STATUS), STATUS being the run's flow_runs status.  A
; done run is one unit of evidence for the routine and a failed run one against
; it.  A cancelled or skipped run is no trial; any other status (running,
; blocked) is still open.
;
; The record's truth is computed afresh from those counts, as GoalChainer's
; track-record cut is: SNARS's opinion over evidence (r, s) with the prior weight
; W = 2 (Josang, Subjective Logic, Def 3.11; mettabase's lib/mettabase/snars/
; truth.metta), so f = r/(r+s) and c = (r+s)/(r+s+2).  Counting keeps the record
; independent of the order the runs came in, and its confidence keeps growing
; with every run.
;
; A record is established once no run is open (GoalChainer's complete record:
; every attempt has its outcome), at least N runs were trials, and the record's
; belief f*c = r/(r+s+2), the least the evidence allows, exceeds THETA.  It fails
; when even the most the evidence allows, f*c + (1 - c) = (r+2)/(r+s+2), falls
; short of THETA, and is undecided between: the cut SNARS's track-record makes
; on [b, b + u].
;
; The hive's bar is GoalChainer's own promotion, (Trials 3) (Threshold 0.5).  A
; caller may ask for more trials or a higher threshold, never less, so a routine
; can't lower its own bar, and a threshold of 1 is refused because the belief
; r/(r+s+2) never reaches it.
;
; Like lib_hive, this library imports nothing.

; ---- one run as evidence -----------------------------------------------------

(= (hive-run-status (Run $id $status)) $status)

(= (hive-run-done? $run) (== (hive-run-status $run) done))
(= (hive-run-trial? $run)
   (or (== (hive-run-status $run) done) (== (hive-run-status $run) failed)))
(= (hive-run-open? $run)
   (not (is-member (hive-run-status $run) (done failed cancelled skipped))))

; ---- the record ----------------------------------------------------------------

; SNARS's prior weight W: two units of evidence before a record leans either way.
(= (hive-track-weight) 2.0)

; The truth of DONE runs for and FAILED runs against.  No trials is no evidence,
; (stv 0.5 0.0).
(= (hive-track-truth $done $failed)
   (let $n (+ $done $failed)
        (if (== $n 0)
            (stv 0.5 0.0)
            (stv (/ (* 1.0 $done) $n) (/ (* 1.0 $n) (+ $n (hive-track-weight)))))))

; SNARS's cut on the interval [b, b + u] with b = f*c and u = 1 - c.
(= (hive-track-cut (stv $f $c) $theta)
   (let $b (* $f $c)
        (if (> $b $theta)
            Holds
            (if (< (+ $b (- 1 $c)) $theta) Fails Undecided))))

; The hive's bar: at least 3 trials, and a threshold from 0.5 up to but not
; including 1.
(= (hive-track-bar? $n $theta)
   (and (>= $n 3) (and (>= $theta 0.5) (< $theta 1))))

; (Track (Runs DONE FAILED OPEN) (stv F C) CUT VERDICT), VERDICT being
; Established or NotEstablished.
(= (hive-track-record (Trials $n) (Threshold $theta) $runs)
   (if (hive-track-bar? $n $theta)
       (let* (($trials (filter-atom $runs hive-run-trial?))
              ($done (size-atom (filter-atom $trials hive-run-done?)))
              ($failed (- (size-atom $trials) $done))
              ($open (size-atom (filter-atom $runs hive-run-open?)))
              ($tv (hive-track-truth $done $failed))
              ($cut (hive-track-cut $tv $theta)))
             (Track (Runs $done $failed $open) $tv $cut
                    (if (and (== $open 0) (and (>= (size-atom $trials) $n) (== $cut Holds)))
                        Established
                        NotEstablished)))
       (Error (hive-track-record (Trials $n) (Threshold $theta))
              "the hive's bar is at least (Trials 3) and a threshold from 0.5 up to but not including 1")))
