"""r2.12.1 native mind-control client. Host owns admission, identity, budgets and lifecycle.

Writes require caller-retained operation IDs. No automatic retry, polling, replacement spawn,
local scheduler or authority cache is introduced. Request acceptance is not observed completion.
"""
from __future__ import annotations
import math
import json
import re
from datetime import datetime
import httpx

MCP_TOOLS = {"templates": "hive_mind_templates", "spawn": "hive_mind_spawn",
             "prompt": "hive_mind_prompt", "control": "hive_mind_control", "status": "hive_mind_status"}
CONTROLS = frozenset({"interrupt", "stop", "pause", "resume", "retire"})
MODES = frozenset({"deliver", "bounded", "ongoing"})
STATES = frozenset({"starting", "running", "paused", "stop_requested", "stopped", "retired", "unknown"})
DELIVERY = frozenset({"accepted", "pending", "delivered", "acknowledged"})

class MindControlError(RuntimeError):
    def __init__(self, status, code, message, details=None):
        super().__init__(message)
        self.status, self.code, self.details = status, code, details or {}

class MindProtocolError(RuntimeError):
    """Unusable response; never infer successful delivery or termination from it."""


def _reference(value, name):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]+', value):
        raise ValueError(f'{name} must be a nonempty path-safe reference')
    return value

def _operation(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{8,120}', value):
        raise ValueError('operation_id must match the r2.12 8-120 character grammar')
    return value

def _text(value, name):
    if not isinstance(value, str) or not value:
        raise ValueError(f'{name} must be nonempty text')
    return value

def _prompt_text(value, name):
    value = _text(value, name)
    try:
        count = len(value.encode('utf-8'))
    except UnicodeEncodeError:
        raise ValueError(f'{name} must be valid UTF-8 text') from None
    if count > 8192:
        raise ValueError(f'{name} must contain 1-8192 bytes of UTF-8 text')
    return value


def _money(value):
    try: finite = isinstance(value, (int, float)) and math.isfinite(value)
    except OverflowError: finite = False
    if isinstance(value, bool) or not finite or value < 0:
        raise ValueError('allocation_usd must be finite and nonnegative')
    return value

def _allocation(value):
    value = _money(value)
    if not 0 < value <= 100: raise ValueError('allocation_usd must be greater than zero and at most 100')
    return value

def _limits(mode, limits):
    if mode != 'bounded':
        if limits is not None: raise ValueError('lifecycle_limits must be null outside bounded mode')
        return None
    if not isinstance(limits, dict) or set(limits) - {'until', 'max_iterations', 'idle_minutes'}:
        raise ValueError('bounded lifecycle requires the r2.12 limits object')
    if not any(v is not None for v in limits.values()):
        raise ValueError('bounded lifecycle requires at least one limit')
    for key in ('max_iterations', 'idle_minutes'):
        value = limits.get(key)
        ceiling = 10000 if key == 'max_iterations' else 10080
        if value is not None and (type(value) is not int or not 1 <= value <= ceiling):
            raise ValueError(f'{key} must be a positive integer or null')
    until = limits.get('until')
    if until is not None:
        if not isinstance(until, str): raise ValueError('until must be an ISO-8601 timestamp')
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})', until): raise ValueError('until must be RFC 3339 with an explicit offset')
        try: parsed = datetime.fromisoformat(until.replace('Z', '+00:00').replace('z', '+00:00'))
        except ValueError: raise ValueError('until must be an ISO-8601 timestamp') from None
        if parsed.tzinfo is None: raise ValueError('until must name a timezone')
    return dict(limits)


def _canonical_body(body):
    """One deterministic JSON value/order for initial dispatch and exact recovery."""
    return json.loads(json.dumps(body, ensure_ascii=False, allow_nan=False,
                                 sort_keys=True, separators=(",", ":")))


def _write_contract(kind, child_id=None):
    if kind not in ("spawn", "prompt", "control"):
        raise ValueError("unsupported retained write contract")
    result = {"version": 1, "kind": kind}
    if kind != "spawn":
        result["child_id"] = _reference(child_id, "child_id")
    elif child_id is not None:
        raise ValueError("spawn contract has no child reference")
    return result


def _same_origin_relative_path(path):
    if (not isinstance(path, str) or not path.isascii() or len(path) > 4096
            or not path.startswith("/") or path.startswith("//")
            or any(c in path for c in ("\\", "?", "#", "%"))
            or any(ord(c) < 33 or ord(c) == 127 for c in path)
            or any(part in ("", ".", "..") for part in path.split("/")[1:])):
        raise ValueError("retained path must be an unescaped same-origin absolute path")
    return path


def _spawn_body(*, operation_id, request_id, team_id, template_id, initial_prompt,
                lifecycle_mode="deliver", lifecycle_limits=None, allocation_usd, model_id=None):
    if lifecycle_mode not in MODES:
        raise ValueError("unsupported phase-one lifecycle")
    return _canonical_body({"operation_id": _operation(operation_id),
        "request_id": _reference(request_id, "request_id"),
        "team_id": _reference(team_id, "team_id"),
        "template_id": _reference(template_id, "template_id"),
        "model_id": None if model_id is None else _text(model_id, "model_id"),
        "initial_prompt": _prompt_text(initial_prompt, "initial_prompt"),
        "lifecycle_mode": lifecycle_mode, "lifecycle_limits": _limits(lifecycle_mode, lifecycle_limits),
        "allocation_usd": _allocation(allocation_usd)})


def _prompt_body(*, operation_id, text, mode, expected_rev):
    if mode not in ("steer", "queued"):
        raise ValueError("prompt mode must be steer or queued")
    if type(expected_rev) is not int or expected_rev < 1:
        raise ValueError("expected_rev must be positive")
    return _canonical_body({"operation_id": _operation(operation_id),
        "text": _prompt_text(text, "text"), "mode": mode, "expected_rev": expected_rev})


def _control_body(*, operation_id, action):
    if action not in CONTROLS:
        raise ValueError("unsupported phase-one control")
    return _canonical_body({"operation_id": _operation(operation_id), "action": action})


def _spawn_response(body, result):
    if (any(result.get(k) != body[k] for k in ("request_id", "team_id", "template_id"))
            or any(not isinstance(result.get(k), str) or not result[k]
                   for k in ("child_id", "reservation_id", "model_id"))
            or type(result.get("prompt_rev")) is not int or result["prompt_rev"] != 1
            or result.get("state") != "starting"):
        raise MindProtocolError("spawn response identity/revision/state mismatch")
    if body["model_id"] is not None and result["model_id"] != body["model_id"]:
        raise MindProtocolError("spawn model override mismatch")
    return result


def _prompt_response(body, result):
    if (type(result.get("prompt_rev")) is not int
            or result["prompt_rev"] != body["expected_rev"] + 1
            or result.get("delivery") != "accepted"):
        raise MindProtocolError("prompt response revision/delivery mismatch")
    return result


def _control_response(body, result):
    if (result.get("action") != body["action"]
            or not isinstance(result.get("requested_at"), str)
            or result.get("observed") is not None or "observed" not in result):
        raise MindProtocolError("control response must be an unconfirmed request")
    return result


def validate_retained_request(method, path, body, contract):
    """Validate the captured contract; never select a method by parsing a path."""
    if method != "POST" or not isinstance(body, dict) or not isinstance(contract, dict):
        raise ValueError("invalid retained request envelope")
    _same_origin_relative_path(path)
    kind = contract.get("kind")
    expected_keys = {"version", "kind"} if kind == "spawn" else {"version", "kind", "child_id"}
    if set(contract) != expected_keys or type(contract.get("version")) is not int or contract["version"] != 1:
        raise ValueError("invalid retained write contract")
    try:
        if kind == "spawn":
            prepared = _spawn_body(**body)
            expected_path, status, validator = "/api/agent/minds", {201}, _spawn_response
        elif kind == "prompt":
            child = _reference(contract["child_id"], "child_id")
            prepared = _prompt_body(**body)
            expected_path, status, validator = "/api/agent/minds/" + child + "/prompt", {202}, _prompt_response
        elif kind == "control":
            child = _reference(contract["child_id"], "child_id")
            prepared = _control_body(**body)
            expected_path, status, validator = "/api/agent/minds/" + child + "/control", {202}, _control_response
        else:
            raise ValueError("unsupported retained write contract")
    except TypeError:
        raise ValueError("retained body does not match its original write contract") from None
    if path != expected_path or _canonical_body(body) != prepared:
        raise ValueError("retained request contract mismatch")
    return status, validator

class MindControlClient:
    """Coordinator bearer is sent only to the configured Hive; redirects are refused."""
    def __init__(self, hive_url, agent_token, *, transport=None, timeout=30, before_request=None):
        if not isinstance(agent_token, str) or not agent_token: raise ValueError('agent bearer required')
        url = httpx.URL(hive_url)
        if url.scheme not in ('http', 'https') or not url.host or url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
            raise ValueError('hive_url must be an HTTP(S) origin without credentials, query or fragment')
        self.before_request = before_request
        self._client = httpx.Client(base_url=url, headers={'Authorization': 'Bearer '+agent_token},
                                    transport=transport, timeout=timeout, follow_redirects=False)

    def close(self): self._client.close()
    def __enter__(self): return self
    def __exit__(self, *args): self.close()

    def _call(self, method, path, *, body=None, query=None, status, contract=None):
        if body is not None:
            body = _canonical_body(body)
        if method == "POST":
            expected_status, _ = validate_retained_request(method, path, body, contract)
            if status != expected_status or query is not None:
                raise ValueError("write status/query contract mismatch")
        if self.before_request is not None:
            self.before_request(method, path, body=body, query=query,
                                status=frozenset(status), contract=contract)
        response = self._client.request(method, path, json=body if body is not None else None, params=query)
        try: result = response.json()
        except ValueError: raise MindProtocolError('Hive returned non-JSON mind-control data') from None
        if not isinstance(result, dict): raise MindProtocolError('Hive mind-control response must be an object')
        if response.status_code not in status:
            error = result.get('error')
            if not isinstance(error, dict) or not isinstance(error.get('code'), str) or not isinstance(error.get('message'), str):
                raise MindProtocolError('Hive returned an invalid mind-control error')
            raise MindControlError(response.status_code, error['code'], error['message'],
                                   {k:v for k,v in error.items() if k not in ('code','message')})
        if 'error' in result: raise MindProtocolError('Hive returned an error inside a success response')
        return result

    def templates(self, team_id):
        result = self._call('GET', '/api/agent/minds/templates', query={'team_id': _reference(team_id, 'team_id')}, status={200})
        if not isinstance(result.get('templates'), list): raise MindProtocolError('templates list missing')
        for template in result['templates']:
            if not isinstance(template, dict) or template.get('harness') != 'native' or not all(isinstance(template.get(k),str) and template[k] for k in ('template_id','model_id')):
                raise MindProtocolError('invalid phase-one template identity')
            if 'role_id' not in template or (template['role_id'] is not None and (not isinstance(template['role_id'], str) or not template['role_id'])):
                raise MindProtocolError('invalid phase-one template role')
            try: _money(template.get('max_allocation_usd'))
            except ValueError: raise MindProtocolError('invalid template allocation ceiling') from None
            if not isinstance(template.get('controls'),list) or not isinstance(template.get('lifecycle_modes'),list) or not isinstance(template.get('overridable'),dict) or not isinstance(template['overridable'].get('model_id'),list):
                raise MindProtocolError('template capabilities missing')
        return result

    def spawn(self, *, operation_id, request_id, team_id, template_id, initial_prompt,
              lifecycle_mode='deliver', lifecycle_limits=None, allocation_usd, model_id=None):
        body = _spawn_body(operation_id=operation_id, request_id=request_id, team_id=team_id,
            template_id=template_id, initial_prompt=initial_prompt, lifecycle_mode=lifecycle_mode,
            lifecycle_limits=lifecycle_limits, allocation_usd=allocation_usd, model_id=model_id)
        result = self._call('POST', '/api/agent/minds', body=body, status={201},
                            contract=_write_contract('spawn'))
        return _spawn_response(body, result)

    def prompt(self, child_id, *, operation_id, text, mode, expected_rev):
        contract = _write_contract('prompt', child_id)
        body = _prompt_body(operation_id=operation_id, text=text, mode=mode, expected_rev=expected_rev)
        result = self._call('POST', '/api/agent/minds/' + contract['child_id'] + '/prompt',
                            body=body, status={202}, contract=contract)
        return _prompt_response(body, result)

    def control(self, child_id, *, operation_id, action):
        contract = _write_contract('control', child_id)
        body = _control_body(operation_id=operation_id, action=action)
        result = self._call('POST', '/api/agent/minds/' + contract['child_id'] + '/control',
                            body=body, status={202}, contract=contract)
        return _control_response(body, result)

    def replay_retained(self, method, path, body, contract):
        """One explicit same-origin replay of the retained triple; no route redispatch."""
        status, validator = validate_retained_request(method, path, body, contract)
        result = self._call(method, path, body=body, status=status, contract=contract)
        return validator(body, result)

    def status(self, *, child_id=None, team_id=None, request_id=None, cursor=None):
        selectors={k:v for k,v in {'child_id':child_id,'team_id':team_id,'request_id':request_id}.items() if v is not None}
        if len(selectors)!=1: raise ValueError('status requires exactly one selector')
        query={k:_reference(v,k) for k,v in selectors.items()}
        if cursor is not None: query['cursor']=_text(cursor,'cursor')
        result=self._call('GET','/api/agent/minds/status',query=query,status={200})
        children=result.get('children')
        if 'next_cursor' not in result or (result['next_cursor'] is not None and (not isinstance(result['next_cursor'],str) or not result['next_cursor'])):
            raise MindProtocolError('status next_cursor must be an opaque nonempty string or null')
        if not isinstance(children,list) or len(children)>100 or not isinstance(result.get('snapshot_at'),str):
            raise MindProtocolError('invalid bounded status snapshot')
        for child in children:
            if not isinstance(child,dict) or any(not isinstance(child.get(k),str) or not child[k] for k in ('child_id','controller_id','request_id','team_id','template_id','model_id')) or child.get('state') not in STATES or type(child.get('recovery_needed')) is not bool:
                raise MindProtocolError('invalid child identity/state')
            if child.get('lifecycle_mode') not in MODES or 'lifecycle_limits' not in child or 'paused_reason' not in child or child['paused_reason'] not in (None,'lease_expired','budget_exhausted','request_cancelled','limit_reached') or not isinstance(child.get('controls'),list) or not isinstance(child.get('progress'),dict) or not isinstance(child['progress'].get('results'),list):
                raise MindProtocolError('invalid lifecycle/progress status')
            reservation=child.get('reservation')
            if not isinstance(reservation,dict) or not isinstance(reservation.get('reservation_id'),str) or not reservation['reservation_id']:
                raise MindProtocolError('reservation identity missing')
            try:
                for field in ('allocated_usd','spent_usd','remaining_usd'): _money(reservation.get(field))
            except ValueError: raise MindProtocolError('invalid reservation amounts') from None
            if any(child.get(k)!=v for k,v in selectors.items()): raise MindProtocolError('status selector identity mismatch')
            if type(child.get('prompt_rev')) is not int or child['prompt_rev']<1 or not isinstance(child.get('prompts'),list):
                raise MindProtocolError('invalid prompt status')
            for prompt in child['prompts']:
                if not isinstance(prompt,dict) or prompt.get('delivery') not in DELIVERY or type(prompt.get('rev')) is not int or prompt['rev']<1 or prompt['rev']>child['prompt_rev'] or type(prompt.get('interrupted')) is not bool:
                    raise MindProtocolError('invalid prompt delivery state')
        return result


    def scan_team(self, team_id, *, controller_id, max_pages=20):
        """Explicit bounded reattachment observation; never restart, spawn or reserve.

        Each page is its own host observation, not a consistent team snapshot.
        A capped scan returns incomplete with the host cursor; callers must not
        interpret it as evidence that no other children exist. Errors return no
        partial report. controller_id is an expected identity, not authority.
        """
        team_id=_reference(team_id,'team_id')
        controller_id=_reference(controller_id,'controller_id')
        if type(max_pages) is not int or not 1<=max_pages<=100:
            raise ValueError('max_pages must be an integer from 1 to 100')
        children=[];pages=[];seen_children=set();seen_cursors=set();cursor=None
        for _ in range(max_pages):
            page=self.status(team_id=team_id,cursor=cursor)
            ids=[]
            for child in page['children']:
                if child['controller_id']!=controller_id:
                    raise MindProtocolError('reattachment controller identity mismatch')
                ident=child['child_id']
                if ident in seen_children:
                    raise MindProtocolError('repeated child across status selection')
                seen_children.add(ident);ids.append(ident);children.append(child)
            pages.append({'snapshot_at':page['snapshot_at'],'child_ids':ids})
            cursor=page['next_cursor']
            if cursor is None:
                break
            if cursor in seen_cursors:
                raise MindProtocolError('status pagination cursor repeated')
            seen_cursors.add(cursor)
        return {'team_id':team_id,'controller_id':controller_id,'children':children,
                'pages':pages,'complete':cursor is None,'next_cursor':cursor,
                'recovery_child_ids':[c['child_id'] for c in children
                                      if c['recovery_needed'] or c['state']=='unknown']}


    def request(self, request_id):
        """Read host-derived receiving goal and budget envelope; never create/reserve locally."""
        result=self._call('GET',f'/api/agent/requests/{_reference(request_id,"request_id")}',status={200})
        if any(not isinstance(result.get(k),str) or not result[k] for k in ('receiving_goal','to_swarm','state')):
            raise MindProtocolError('request receiving goal/swarm/state missing')
        budget=result.get('budget')
        if not isinstance(budget,dict) or not isinstance(budget.get('root'),str) or not budget['root']:
            raise MindProtocolError('request budget root missing')
        try:
            for field in ('limit_usd','allocated_usd'): _money(budget.get(field))
        except ValueError: raise MindProtocolError('invalid request budget amounts') from None
        return result
