"""Offline import boundary for externally graded industry task receipts."""
from .catalog import INDUSTRY
from .protocol import digest, pin, validate_export


def import_trials(registration, registration_pin, baseline, candidate, provenance):
    """No downloading, scoring by an LLM, harness launch or implicit licence grant."""
    if registration['benchmark'] not in {i for i,_,_ in INDUSTRY}:
        raise ValueError('industry benchmark required')
    for key in ('source_url','license','official_harness_release','grading_method'):
        if not isinstance(provenance.get(key),str) or not provenance[key].strip():
            raise ValueError(f'missing import provenance {key}')
    for key in ('license_digest','source_digest','official_harness_pin'):
        if not pin(provenance.get(key)): raise ValueError(f'missing provenance pin {key}')
    if provenance['official_harness_pin']!=registration['evaluator_pin']:
        raise ValueError('official scorer must match registration')
    export={k:registration[k] for k in ('benchmark','release','split','dataset_pin','evaluator_pin','environment_pin')}
    export.update(registration_pin=registration_pin,baseline=baseline,candidate=candidate,
                  provenance=provenance,source_kind='imported',custody='unresolved')
    validate_export(registration,registration_pin,export)
    return export


def grid_exact(prediction, expected):
    """ARC-style grid rubric only; not an official ARC leaderboard scorer."""
    def valid(grid):
        return isinstance(grid,list) and bool(grid) and all(isinstance(row,list) and bool(row) and len(row)==len(grid[0]) and all(type(c)==int and 0<=c<=9 for c in row) for row in grid)
    if not valid(expected): raise ValueError('invalid target grid')
    return float(valid(prediction) and prediction==expected)
