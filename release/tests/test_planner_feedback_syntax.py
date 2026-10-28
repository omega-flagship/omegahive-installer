"""Planner skill commands retain full JSON through the native syntax membrane."""
import json
import pathlib
import sys
import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'src'))
sys.path.insert(0, str(ROOT/'tests'))
import helper_command_parser as parser  # noqa: E402
import helper_metta_syntax as metta  # noqa: E402
from module_loader_test_utils import enabled_module_loader  # noqa: E402


@pytest.mark.parametrize('command,payload', [
    ('hive-finding-response', {'revision':2,'stance':'addressed','note':'Claim only; room remains unknown'}),
    ('hive-finding-disposition', {'request_id':'rq_second','revision':2,'verdict':'still-open','applicability':'applies'}),
])
def test_feedback_json_is_a_single_complete_argument(command, payload):
    body = json.dumps(payload)
    with enabled_module_loader(parser, 'hive'):
        result = parser.signature_balance_parentheses(command + ' fi_one ' + body)
    escaped = json.dumps(body)[1:-1]
    assert result == f'(({command} "fi_one" "{escaped}"))'
    assert metta.test_metta_expression(result) == 'METTA-SYNTAX-OK'


def test_native_read_and_return_have_typed_revision():
    with enabled_module_loader(parser, 'hive'):
        for command in ('hive-plan-return', 'hive-plan-review-context'):
            assert parser.signature_balance_parentheses(command+' rq_one ar_one 2') == f'(({command} "rq_one" "ar_one" 2))'
            assert 'syntax-error' in parser.signature_balance_parentheses(command+' rq_one ar_one later')
        assert parser.signature_balance_parentheses('hive-findings-read ar_one') == '((hive-findings-read "ar_one"))'
