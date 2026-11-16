"""Sealed paired comparisons. This validates supplied evidence, never authenticates it."""
import hashlib
import json
import math
import random
import statistics

SCHEMA = "omegabench/2"

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()

def pin(value):
    return isinstance(value, str) and len(value)==64 and all(c in "0123456789abcdef" for c in value)

def number(value, low=None, high=None):
    if isinstance(value, bool) or not isinstance(value, (int,float)) or not math.isfinite(value):
        raise ValueError("finite numeric measurement required")
    if low is not None and value < low or high is not None and value > high:
        raise ValueError("measurement outside declared range")
    return value

def seal(r):
    if not isinstance(r,dict):
        raise ValueError("registration must be an object")
    allowed={"schema","baseline_pin","candidate_pin","evaluator_pin","dataset_pin","environment_pin",
             "benchmark","release","split","rubric","stop_rule","review_owner","alignment_owner",
             "custody","task_ids","task_families","seeds","limits","min_gain","floors"}
    if set(r)-allowed:
        raise ValueError("unknown registration fields cannot carry authority or execution")
    if r.get("schema") != SCHEMA:
        raise ValueError("unsupported registration schema")
    for k in ("baseline_pin", "candidate_pin", "evaluator_pin", "dataset_pin", "environment_pin"):
        if not pin(r.get(k)):
            raise ValueError(f"missing sha256 {k}")
    if r["baseline_pin"] == r["candidate_pin"]:
        raise ValueError("distinct baseline and candidate required")
    for k in ("benchmark", "release", "split", "rubric", "stop_rule", "review_owner", "alignment_owner"):
        if not isinstance(r.get(k), str) or not r[k].strip():
            raise ValueError(f"missing {k}")
    if r["review_owner"] == r["alignment_owner"]:
        raise ValueError("separate method and alignment owners required")
    if r.get("custody") not in ("public-development", "heldout-independent"):
        raise ValueError("declare evaluation custody")
    tasks = r.get("task_ids")
    if not isinstance(tasks,list) or not tasks or len(tasks)>10000 or any(not isinstance(t,str) or not t for t in tasks) or len(set(tasks))!=len(tasks):
        raise ValueError("unique task denominator required")
    families=r.get("task_families")
    if not isinstance(families,dict) or set(families)!=set(tasks) or any(not isinstance(v,str) or not v for v in families.values()):
        raise ValueError("declare one generation family per task")
    seeds=r.get("seeds")
    if not isinstance(seeds,list) or not seeds or len(seeds)>100 or any(type(s)!=int for s in seeds) or len(set(seeds))!=len(seeds):
        raise ValueError("unique integer seeds required")
    if len(tasks)*len(seeds)>100000:
        raise ValueError("evaluation exceeds comparison limit")
    limits=r.get("limits",{})
    if set(limits)!={"cost", "seconds", "attempts", "tokens"}:
        raise ValueError("cost, tokens, seconds and attempts limits required per arm")
    for k,v in limits.items():
        number(v, 1 if k=="attempts" else 0)
    number(r.get("min_gain"),0,1)
    floors=r.get("floors")
    if not isinstance(floors,dict) or not floors:
        raise ValueError("protected floors required")
    for k,v in floors.items():
        if not isinstance(k,str) or not k: raise ValueError("invalid floor name")
        number(v,0,1)
    return digest(r)

def validate_export(r, registration_pin, export):
    if not isinstance(export,dict):
        raise ValueError("export must be an object")
    if seal(r)!=registration_pin or export.get("registration_pin")!=registration_pin:
        raise ValueError("registration binding mismatch")
    for k in ("benchmark", "release", "split", "evaluator_pin", "dataset_pin", "environment_pin"):
        if export.get(k)!=r[k]: raise ValueError(f"export {k} mismatch")
    expected={(t,s) for t in r["task_ids"] for s in r["seeds"]}
    arms={}
    for arm in ("baseline", "candidate"):
        rows=export.get(arm)
        if not isinstance(rows,list) or len(rows)!=len(expected):
            raise ValueError("complete paired denominator required, including errors")
        indexed={}
        for row in rows:
            if not isinstance(row,dict): raise ValueError("invalid row")
            if type(row.get("seed"))!=int or not isinstance(row.get("task_id"),str): raise ValueError("invalid task coordinate")
            key=(row["task_id"],row["seed"])
            if key not in expected or key in indexed: raise ValueError("duplicate or unexpected task")
            if row.get("pin")!=r[arm+"_pin"]: raise ValueError("arm pin mismatch")
            if row.get("status") not in ("ok", "failed", "error", "timeout", "cancelled"):
                raise ValueError("invalid terminal state")
            number(row.get("score"),0,1)
            if row["status"]!="ok" and row["score"]!=0:
                raise ValueError("unsuccessful trials must score zero")
            for k in ("cost", "seconds", "attempts", "tokens"):
                number(row.get(k),0)
            if type(row["tokens"])!=int: raise ValueError("integer tokens required")
            if type(row["attempts"])!=int: raise ValueError("integer attempts required")
            if not pin(row.get("receipt_digest")): raise ValueError("source receipt digest required")
            f=row.get("floors",{})
            if set(f)!=set(r["floors"]): raise ValueError("all protected floors required")
            for v in f.values(): number(v,0,1)
            indexed[key]=row
        arms[arm]=indexed
    return arms

def compare(r, registration_pin, export):
    arms=validate_export(r,registration_pin,export)
    # Independent unit is task, not correlated repeated seeds.
    differences=[]
    for task in r["task_ids"]:
        differences.append(statistics.fmean(arms["candidate"][(task,s)]["score"]-arms["baseline"][(task,s)]["score"] for s in r["seeds"]))
    families={}
    for task,delta in zip(r["task_ids"],differences):
        families.setdefault(r["task_families"][task],[]).append(delta)
    units=list(families.values())
    rng=random.Random(0)
    boot=sorted(statistics.fmean(delta for cluster in rng.choices(units,k=len(units)) for delta in cluster) for _ in range(2000))
    interval=[boot[49],boot[1949]]
    summaries={}
    reasons=[]
    for arm,rows in arms.items():
        values=list(rows.values())
        summaries[arm]={"score":statistics.fmean(x["score"] for x in values),
                       "trials":len(values), "errors":sum(x["status"]!="ok" for x in values),
                       "terminal_counts":{s:sum(x["status"]==s for x in values) for s in ("ok","failed","error","timeout","cancelled")},
                       **{k:sum(x[k] for x in values) for k in r["limits"]},
                       "floors":{k:min(x["floors"][k] for x in values) for k in r["floors"]}}
        solved=sum(x["status"]=="ok" and x["score"]==1 for x in values)
        summaries[arm]["solved"]=solved
        summaries[arm]["cost_per_solved"]=summaries[arm]["cost"]/solved if solved else None
        summaries[arm]["tokens_per_solved"]=summaries[arm]["tokens"]/solved if solved else None
        for k,limit in r["limits"].items():
            if summaries[arm][k]>limit: reasons.append(f"{arm} exceeds {k} cap")
        for k,minimum in r["floors"].items():
            if summaries[arm]["floors"][k]<minimum: reasons.append(f"{arm} violates {k} floor")
    gain=statistics.fmean(differences)
    if gain<r["min_gain"]: reasons.append("mean gain below preregistered threshold")
    if len(units)<5: reasons.append("fewer than five independent task families; uncertainty unresolved")
    if interval[0]<=r["min_gain"]: reasons.append("gain interval does not exceed threshold")
    if r["custody"]!="heldout-independent": reasons.append("public development inputs")
    return {"schema":SCHEMA, "benchmark":r["benchmark"], "registration_pin":registration_pin,
            "export_digest":digest(export), "arms":summaries, "gain":gain,
            "task_cluster_bootstrap_95":interval, "independent_tasks":len(differences), "independent_units":len(units),
            "clustering":"generation-family; repeated seeds averaged within task",
            "state":"held" if reasons else "ready-for-independent-review", "reasons":reasons,
            "evidence_tier":"unverified-import", "receipt_custody":"unresolved",
            "adoption_authorized":False, "beneficialness":"unassessed",
            "live_improvement":"unproven", "recursive_improvement":"unproven", "agi":"unproven"}
