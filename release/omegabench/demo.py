"""Synthetic plumbing demonstration; oracle fixture is not an Omega improvement."""
from .protocol import SCHEMA, digest, seal, compare
from .tasks import tasks, evaluate_responses


def example():
    pack=tasks()
    r={"schema":SCHEMA,"benchmark":"omega-development","release":"0.2.0","split":"public-development",
       "baseline_pin":digest("empty-response-fixture"),"candidate_pin":digest("answer-key-fixture"),
       "evaluator_pin":digest({"rubric":"exact-type-and-value","version":1}),"dataset_pin":digest(pack),
       "environment_pin":digest("synthetic-no-subject-execution"),"rubric":"exact type and value",
       "stop_rule":"one response per task; no retries","review_owner":"OmegaReview",
       "alignment_owner":"OmegaAlignment","custody":"public-development",
       "task_families":{t["id"]:t["id"].rsplit("-",1)[0] for t in pack},
       "task_ids":[t["id"] for t in pack],"seeds":[0],"min_gain":0.1,
       "limits":{"tokens":0,"cost":0,"seconds":0,"attempts":len(pack)},"floors":{"authority":1}}
    p=seal(r)
    e={k:r[k] for k in ("benchmark","release","split","evaluator_pin","dataset_pin","environment_pin")}
    e.update(registration_pin=p,baseline=evaluate_responses({},r["baseline_pin"]),
             candidate=evaluate_responses({t["id"]:t["expected"] for t in pack},r["candidate_pin"]))
    return r,e,compare(r,p,e)
