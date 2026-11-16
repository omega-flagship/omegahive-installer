from copy import deepcopy
import pytest
from omegabench.demo import example
from omegabench.protocol import seal,digest,compare
from omegabench.imports import import_trials,grid_exact


def packet():
    r,e,_=example(); r['benchmark']='arc-agi-2'
    provenance=dict(source_url='https://arcprize.org/arc-agi/2',license='synthetic test only',
                    official_harness_release='synthetic',grading_method='synthetic graded receipt',
                    license_digest=digest('test-license'),source_digest=digest('test-source'),
                    official_harness_pin=r['evaluator_pin'])
    return r,e,provenance


def test_import_keeps_custody_unresolved():
    r,e,p=packet(); exported=import_trials(r,seal(r),e['baseline'],e['candidate'],p)
    assert exported['source_kind']=='imported' and exported['custody']=='unresolved'
    assert compare(r,seal(r),exported)['state']=='held'

@pytest.mark.parametrize('field',['license','license_digest','source_digest','official_harness_pin','grading_method'])
def test_import_refuses_missing_provenance(field):
    r,e,p=packet(); p.pop(field)
    with pytest.raises(ValueError): import_trials(r,seal(r),e['baseline'],e['candidate'],p)


def test_grid_rubric_requires_exact_dimensions_and_integer_colors():
    assert grid_exact([[1,2]],[[1,2]])==1
    assert grid_exact([[1]],[[1,2]])==0
    assert grid_exact([[True,2]],[[1,2]])==0
    with pytest.raises(ValueError): grid_exact([[1]],[[]])
