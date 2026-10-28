"""Disposable native child. Reads one host-constructed request, never a service."""
import json
import re
from pathlib import Path
import sys

def main():
    request_path=Path("request.json")
    if request_path.stat().st_size>32768: raise ValueError("request-bytes-limit")
    request = json.loads(request_path.read_text())
    petta = Path(request['petta']); sys.path[:0] = [str(petta / 'python'), str(Path(__file__).parent)]
    from tools import FENCES, admit, render_call
    admit(request["schema"],request["skill"],request["arguments"])
    code="!"+render_call(request["schema"], request["skill"], request["arguments"])
    from petta import PeTTa
    import janus_swi as janus
    interpreter = PeTTa(petta_path=str(petta))
    supported = janus.query_once('use_module(library(time)), current_predicate(call_with_time_limit/2), current_predicate(call_with_inference_limit/3)')
    if not supported.get('truth'): raise RuntimeError('both native fences required')
    alias = Path.cwd() / 'omegahive-tools'; alias.symlink_to(request['root'])
    janus.query_once('asserta(library_path(Base))', {'Base': str(alias)})
    def guarded(predicate, value):
        query = FENCES.replace('Goal', 'run_metta_helper(false, Predicate, Value, Results)')
        result = janus.query_once(query, {'Seconds': request['seconds'], 'Steps': request['steps'],
                                       'Predicate': predicate, 'Value': value})
        limit = 'time' if result.get('Timed') == 'true' else 'inferences' if result.get('Fuel') == 'inference_limit_exceeded' else None
        return limit, [] if limit else result.get('Results', [])
    limit, imports = guarded('load_metta_file', request['entry'])
    expected_imports = len(re.findall(r'^!\(import! &self ', Path(request['entry']).read_text(), re.M))
    if not limit and (expected_imports == 0 or len(imports) != expected_imports or any(x != 'true' for x in imports)):
        raise RuntimeError('native library import failed')
    if not limit: limit, results = guarded('process_metta_string', code)
    else: results = []
    # No answer or partial answer survives either fence.
    result = {'kind': 'ToolLimitExceeded' if limit else 'ToolResult', 'limit': limit,
              'results': [] if limit else results, 'authority': 'none',
              'step_unit': 'SWI-Prolog inferences', 'library_imports': imports,
              'credential_environment': False, 'provider_calls': 0}
    alias.unlink()
    result['temporary_files_after'] = [p.name for p in Path.cwd().iterdir()]
    encoded = json.dumps(result)
    if len(encoded.encode()) > 16384: raise RuntimeError('output-bytes-limit')
    Path("result.json").write_text(encoded)

if __name__ == '__main__': main()
