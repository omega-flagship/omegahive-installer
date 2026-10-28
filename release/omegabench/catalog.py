"""Benchmark registry. References are not installed datasets or measured results."""
INDUSTRY = [
 ("mmlu-pro", "Broad knowledge and reasoning", "https://github.com/TIGER-AI-Lab/MMLU-Pro"),
 ("hle", "Expert knowledge frontier", "https://arxiv.org/abs/2501.14249"),
 ("terminal-bench", "Complex terminal workflows", "https://www.tbench.ai/benchmarks"),
 ("arc-agi-2", "Abstraction and compositional transfer", "https://arcprize.org/arc-agi/2"),
 ("arc-agi-3", "Interactive discovery and skill acquisition efficiency", "https://arcprize.org/arc-agi/3"),
 ("swe-bench-verified", "Repository issue resolution", "https://www.swebench.com/SWE-bench/"),
 ("gaia", "General assistant tool use", "https://arxiv.org/abs/2311.12983"),
 ("osworld-v2", "Long horizon computer use", "https://github.com/xlang-ai/OSWorld-V2"),
 ("tau-bench", "Tool use, policy compliance and repeated reliability", "https://github.com/sierra-research/tau2-bench"),
]
NATIVE = [
 ("bench-core", "Performance and races"), ("bench-drift", "Runaway and failure containment"),
 ("bench-bias", "Invariance and source identity"), ("bench-epistemic", "Disciplined belief revision"),
 ("bench-ops", "Resource efficiency and recovery"), ("bench-swarm", "Swarm continuity"),
 ("tests-evolve", "Research protocol qualification"),
]
RESEARCH = [
 ("omega-causal", "Full/sham/severed admission and action", "causal"),
 ("omega-continuity", "Memory, correction, restart and model swap", "continuity"),
 ("omega-world-model", "Multi-horizon prediction and intervention transfer", "world-model"),
 ("omega-learning", "Fresh-task learning curves and forgetting", "learning"),
 ("omega-epistemic", "Calibration, abstention, overlap and retraction", "epistemic"),
 ("omega-repair", "Same-goal repair with independent quality", "agency"),
 ("omega-coordination", "Complementary swarms versus single mind", "coordination"),
 ("omega-beneficialness", "Consent, flourishing, authority and dissent", "beneficialness"),
 ("omega-recursion", "Efficiency of subsequent improvement cycles", "recursion"),
]

def catalogue():
    return ([dict(id=i, title=t, family="industry", source=u, state="import-only",
                  execution="official harness required; pin release, dataset, scorer and split",
                  measured=False) for i,t,u in INDUSTRY] +
            [dict(id=i, title=t, family="existing-hive", state="existing-suite",
                  execution="Hive Lab", measured=False) for i,t in NATIVE] +
            [dict(id=i, title=t, family="omega", dimension=d, state="research-contract",
                  execution="task and evaluator qualification required", measured=False)
             for i,t,d in RESEARCH])
