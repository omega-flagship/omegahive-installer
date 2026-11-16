; Smoke test for hive/spaces/lib_learn.metta: flow runs as evidence, counted
; with SNARS's prior weight W = 2, and GoalChainer's track promotion over them.
; lib_learn imports nothing, so it loads alone.

!(import! &self ../hive/spaces/lib_learn)

(= (approx $a $b)
   (and (< (- $a $b) 0.0001) (< (- $b $a) 0.0001)))

(= (record-is $record $done $failed $open $f $c $cut $verdict)
   (let (Track (Runs $d $x $o) (stv $rf $rc) $rcut $rverdict) $record
        (and (and (and (== $d $done) (== $x $failed)) (and (== $o $open) (approx $rf $f)))
             (and (approx $rc $c) (and (== $rcut $cut) (== $rverdict $verdict))))))

; ---- runs as evidence ------------------------------------------------------------

; r done and s failed runs give f = r/(r+s) and c = (r+s)/(r+s+2).
!(let (stv $f $c) (hive-track-truth 3 1)
      (if (and (approx $f 0.75) (approx $c 0.6667))
          (println! HIVE-LEARN-COUNTS-OK)
          (println! FAILED-HIVE-LEARN-COUNTS)))

; No trials is no evidence.
!(if (== (hive-track-truth 0 0) (stv 0.5 0.0))
     (println! HIVE-LEARN-NO-EVIDENCE-OK)
     (println! FAILED-HIVE-LEARN-NO-EVIDENCE))

!(if (and (hive-run-open? (Run "r1" running)) (hive-run-open? (Run "r2" blocked)))
     (println! HIVE-LEARN-UNFINISHED-RUNS-OPEN-OK)
     (println! FAILED-HIVE-LEARN-UNFINISHED-RUNS-OPEN))

!(if (or (hive-run-trial? (Run "r1" cancelled)) (hive-run-open? (Run "r1" cancelled)))
     (println! FAILED-HIVE-LEARN-CANCELLED-RUN-COUNTED)
     (println! HIVE-LEARN-CANCELLED-RUN-NO-TRIAL-OK))

; ---- the cut ---------------------------------------------------------------------

; b = f*c clears THETA: Holds; b + u short of it: Fails; between: Undecided.
!(if (and (== (hive-track-cut (stv 1.0 0.75) 0.5) Holds)
          (and (== (hive-track-cut (stv 0.25 0.8) 0.5) Fails)
               (== (hive-track-cut (stv 0.5 0.0) 0.5) Undecided)))
     (println! HIVE-LEARN-CUT-OK)
     (println! FAILED-HIVE-LEARN-CUT))

; ---- the record ------------------------------------------------------------------

; GoalChainer's example promotion, (Trials 3) (Threshold 0.5): three done runs
; give b = 3/5 = 0.6, so the routine is established.
!(if (record-is (hive-track-record (Trials 3) (Threshold 0.5)
                                   ((Run "r1" done) (Run "r2" done) (Run "r3" done)))
                3 0 0 1.0 0.6 Holds Established)
     (println! HIVE-LEARN-ESTABLISHED-OK)
     (println! FAILED-HIVE-LEARN-ESTABLISHED))

; Three done and one failed give b = 3/6 = 0.5, not above 0.5: undecided, as in
; GoalChainer.
!(if (record-is (hive-track-record (Trials 3) (Threshold 0.5)
                                   ((Run "r1" done) (Run "r2" failed) (Run "r3" done) (Run "r4" done)))
                3 1 0 0.75 0.6667 Undecided NotEstablished)
     (println! HIVE-LEARN-THREE-AND-ONE-UNDECIDED-OK)
     (println! FAILED-HIVE-LEARN-THREE-AND-ONE-UNDECIDED))

; A fourth done run carries it through the failure: b = 4/7.
!(if (record-is (hive-track-record (Trials 3) (Threshold 0.5)
                                   ((Run "r1" done) (Run "r2" failed) (Run "r3" done) (Run "r4" done)
                                    (Run "r5" done)))
                4 1 0 0.8 0.7143 Holds Established)
     (println! HIVE-LEARN-ESTABLISHED-THROUGH-A-FAILURE-OK)
     (println! FAILED-HIVE-LEARN-ESTABLISHED-THROUGH-A-FAILURE))

; Two trials are fewer than N = 3.
!(if (record-is (hive-track-record (Trials 3) (Threshold 0.5)
                                   ((Run "r1" done) (Run "r2" done)))
                2 0 0 1.0 0.5 Undecided NotEstablished)
     (println! HIVE-LEARN-TOO-FEW-TRIALS-OK)
     (println! FAILED-HIVE-LEARN-TOO-FEW-TRIALS))

; A run still running leaves the record incomplete.
!(if (record-is (hive-track-record (Trials 3) (Threshold 0.5)
                                   ((Run "r1" done) (Run "r2" done) (Run "r3" done) (Run "r4" running)))
                3 0 1 1.0 0.6 Holds NotEstablished)
     (println! HIVE-LEARN-OPEN-RUN-BLOCKS-OK)
     (println! FAILED-HIVE-LEARN-OPEN-RUN-BLOCKS))

; A cancelled run neither counts nor blocks.
!(if (record-is (hive-track-record (Trials 3) (Threshold 0.5)
                                   ((Run "r1" done) (Run "r2" cancelled) (Run "r3" done) (Run "r4" done)))
                3 0 0 1.0 0.6 Holds Established)
     (println! HIVE-LEARN-CANCELLED-IGNORED-OK)
     (println! FAILED-HIVE-LEARN-CANCELLED-IGNORED))

; Mostly failures fail the record: b + u = (1 + 2)/(1 + 4 + 2) = 3/7 < 0.5.
!(if (record-is (hive-track-record (Trials 3) (Threshold 0.5)
                                   ((Run "r1" failed) (Run "r2" failed) (Run "r3" done) (Run "r4" failed)
                                    (Run "r5" failed)))
                1 4 0 0.2 0.7143 Fails NotEstablished)
     (println! HIVE-LEARN-FAILING-ROUTINE-OK)
     (println! FAILED-HIVE-LEARN-FAILING-ROUTINE))

; No runs: no evidence, undecided, not established.
!(if (record-is (hive-track-record (Trials 3) (Threshold 0.5) ()) 0 0 0 0.5 0.0 Undecided NotEstablished)
     (println! HIVE-LEARN-NO-RUNS-OK)
     (println! FAILED-HIVE-LEARN-NO-RUNS))

; ---- the hive's bar --------------------------------------------------------------

; Fewer trials, a lower threshold, or a threshold of 1 is refused.
!(if (and (== (car-atom (hive-track-record (Trials 1) (Threshold 0.5) ())) Error)
          (and (== (car-atom (hive-track-record (Trials 3) (Threshold 0.4) ())) Error)
               (== (car-atom (hive-track-record (Trials 3) (Threshold 1.0) ())) Error)))
     (println! HIVE-LEARN-BAR-REFUSED-OK)
     (println! FAILED-HIVE-LEARN-BAR-REFUSED))

; A stricter bar is taken: four done runs at (Trials 4) (Threshold 0.6).
!(if (record-is (hive-track-record (Trials 4) (Threshold 0.6)
                                   ((Run "r1" done) (Run "r2" done) (Run "r3" done) (Run "r4" done)))
                4 0 0 1.0 0.6667 Holds Established)
     (println! HIVE-LEARN-STRICTER-BAR-OK)
     (println! FAILED-HIVE-LEARN-STRICTER-BAR))
