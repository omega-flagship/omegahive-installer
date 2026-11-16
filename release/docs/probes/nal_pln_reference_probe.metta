; Reference probe for docs/reference-lib-nal.md and docs/reference-lib-pln.md.
; Run: copy this file next to lib_nal.metta and lib_pln.metta (the repo root), then
;   PATH=$HOME/swipl-patched/bin:$PATH sh "$PETTA_PATH/run.sh" nal_pln_reference_probe.metta
; Loads lib_nal and lib_pln only (not PeTTa lib_nars), so it shows this repo's own rules.
; Recorded output (PeTTa ae66fa8, SWI-Prolog 10.1.14, 2026-10-10) is in nal_pln_reference_probe.out.
!(import! &self lib_nal)
!(import! &self lib_pln)
; NAL shapes
!(|- ((--> a b) (stv 1.0 0.9)) ((--> a c) (stv 1.0 0.9)))
!(|- ((--> a c) (stv 1.0 0.9)) ((--> b c) (stv 1.0 0.9)))
; revision chain of 3 and 5 sources at 0.45
!(Truth_Revision (stv 1.0 0.45) (stv 1.0 0.45))
!(Truth_Revision (Truth_Revision (stv 1.0 0.45) (stv 1.0 0.45)) (stv 1.0 0.45))
!(Truth_Revision (Truth_Revision (Truth_Revision (Truth_Revision (stv 1.0 0.45) (stv 1.0 0.45)) (stv 1.0 0.45)) (stv 1.0 0.45)) (stv 1.0 0.45))
; multi-hop deduction
!(Truth_Deduction (stv 1.0 0.9) (stv 1.0 0.9))
!(Truth_Deduction (Truth_Deduction (stv 1.0 0.9) (stv 1.0 0.9)) (stv 1.0 0.9))
!(Truth_Deduction (Truth_Deduction (Truth_Deduction (stv 1.0 0.9) (stv 1.0 0.9)) (stv 1.0 0.9)) (stv 1.0 0.9))
!(Truth_Deduction (Truth_Deduction (Truth_Deduction (Truth_Deduction (stv 1.0 0.9) (stv 1.0 0.9)) (stv 1.0 0.9)) (stv 1.0 0.9)) (stv 1.0 0.9))
; induction pair revision
!(Truth_Revision (stv 1.0 0.42) (stv 1.0 0.42))
; conditional abduction
!(|- ((--> x y) (stv 1.0 0.9)) ((==> (--> w z) (--> x y)) (stv 0.9 0.9)))
; conjunctive antecedent
!(|- ((--> p q) (stv 1.0 0.9)) ((==> (∧ (--> p q) (--> r s)) (--> t u)) (stv 1.0 0.9)))
; implication chaining
!(|- ((==> A B) (stv 1.0 0.9)) ((==> B C) (stv 1.0 0.9)))
; two-premise decomposition
!(|- ((--> s m) (stv 1.0 0.9)) ((--> (∩ s p) m) (stv 0.0 0.9)))
; revision of wolf example and self-revision
!(|- ((--> wolf animal) (stv 1.0 0.45)) ((--> wolf animal) (stv 1.0 0.45)))
; PLN
!(|~ ((Implication (Inheritance $1 (IntSet Feathered)) (Inheritance $1 Bird)) (stv 1.0 0.9)) ((Inheritance Pingu (IntSet Feathered)) (stv 1.0 0.9)))
!(|~ ((Inheritance bird flyer) (stv 1.0 0.9)) ((Inheritance robin flyer) (stv 1.0 0.9)))
!(Truth__ModusPonens (stv 0.8 0.9) (stv 0.9 0.9))
!(Truth__Revision (stv 1.0 0.45) (stv 1.0 0.45))
!(Truth__Revision (stv 1.0 1.0) (stv 1.0 0.5))
