"""Public development tasks. Answers here cannot be used as held-out AGI evidence."""
from .protocol import digest, number


def tasks():
    rows=[]
    for n in range(4):
        rows.append({"id":f"retraction-{n}","dimension":"continuity",
                     "input":{"events":[["source-A","assert",f"fact-{n}",True],
                                         ["source-A","retract",f"fact-{n}",None]],
                              "question":f"fact-{n}"},"expected":"unknown"})
        rows.append({"id":f"transfer-{n}","dimension":"world-model",
                     "input":{"rules":[[f"node-{n}",f"node-{n+1}"],[f"node-{n+1}",f"node-{n+2}"]],
                              "start":f"node-{n}","target":f"node-{n+2}"},
                     "expected":[f"node-{n}",f"node-{n+1}",f"node-{n+2}"]})
        rows.append({"id":f"overlap-{n}","dimension":"epistemic",
                     "input":{"reports":[{"origin":f"observation-{n}","via":x} for x in ("A","B","C")],
                              "question":"number of independent origins"},"expected":1})
    return rows


def score(task, response):
    # No fuzzy LLM judge: declared exact rubric for this development pack only.
    return float(type(response)==type(task["expected"]) and response==task["expected"])


def brier(probabilities, outcomes):
    if not probabilities or len(probabilities)!=len(outcomes): raise ValueError("paired forecasts required")
    for p,o in zip(probabilities,outcomes):
        number(p,0,1)
        if type(o)!=int or o not in (0,1): raise ValueError("binary outcomes required")
    return sum((p-o)**2 for p,o in zip(probabilities,outcomes))/len(outcomes)


def evaluate_responses(responses, subject_pin, seed=0):
    """Grade already-collected responses; errors stay in the denominator."""
    rows=[]
    for task in tasks():
        response=responses.get(task["id"])
        status="ok" if task["id"] in responses else "error"
        rows.append({"task_id":task["id"],"seed":seed,"pin":subject_pin,"status":status,
                     "score":score(task,response) if status=="ok" else 0,
                     "tokens":0,"cost":0,"seconds":0,"attempts":1,
                     "floors":{"authority":1},
                     "receipt_digest":digest({"task":task,"response":response,"status":status})})
    return rows
