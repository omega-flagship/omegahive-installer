import hashlib
import json
import os
import pathlib
import time
import urllib.error
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parents[1]
MEMORY = ROOT / "memory"
CONFIG_FILE = MEMORY / "librelinkup.json"
CACHE_FILE = MEMORY / "librelinkup_cache.json"
TRACE_LOG = MEMORY / "glucose_observations.jsonl"
WATCH_FILE = MEMORY / "glucose_watches.json"
DEFAULT_WATCH_POLL_SECONDS = 300
RATE_LIMIT_BACKOFF_SECONDS = 1800
MAX_ERROR_BACKOFF_SECONDS = 3600

DEFAULT_BASES = [
    "https://api-eu2.libreview.io",
    "https://api-eu.libreview.io",
    "https://api.libreview.io",
]

TREND_NAMES = {
    1: "rising-quickly",
    2: "rising",
    3: "flat",
    4: "falling",
    5: "falling-quickly",
}


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _now_ts():
    return time.time()


def _iso_from_ts(ts):
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(float(ts)))
    except Exception:
        return _now()


def _read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(path, data, mode=0o600):
    MEMORY.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp-{os.getpid()}")
    tmp.write_text(json.dumps(data, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)
    try:
        os.chmod(path, mode)
    except Exception:
        pass


def _config():
    data = _read_json(CONFIG_FILE, {})
    username = (
        os.environ.get("LIBRE_LINK_UP_USERNAME")
        or os.environ.get("LIBRELINKUP_USERNAME")
        or os.environ.get("LIBREVIEW_USERNAME")
        or data.get("username")
        or data.get("email")
        or ""
    )
    password = (
        os.environ.get("LIBRE_LINK_UP_PASSWORD")
        or os.environ.get("LIBRELINKUP_PASSWORD")
        or os.environ.get("LIBREVIEW_PASSWORD")
        or data.get("password")
        or ""
    )
    base_url = (
        os.environ.get("LIBRE_LINK_UP_URL")
        or os.environ.get("LIBRELINKUP_URL")
        or data.get("url")
        or data.get("base_url")
        or ""
    )
    version = (
        os.environ.get("LIBRE_LINK_UP_VERSION")
        or os.environ.get("LIBRELINKUP_VERSION")
        or data.get("version")
        or "4.16.0"
    )
    unit = (
        os.environ.get("LIBRE_GLUCOSE_UNIT")
        or os.environ.get("LIBRELINKUP_UNIT")
        or data.get("unit")
        or "mmol/L"
    )
    connections = data.get("connections") if isinstance(data.get("connections"), dict) else {}
    bases = [base_url.strip().rstrip("/")] if base_url else list(DEFAULT_BASES)
    bases = [item for item in bases if item]
    return {
        "username": str(username).strip(),
        "password": str(password),
        "bases": bases,
        "version": str(version).strip(),
        "unit": _normalize_unit(unit),
        "connections": connections,
    }


def _normalize_unit(value):
    raw = str(value or "").strip().lower().replace(" ", "")
    if raw in {"mmol", "mmol/l", "mmoll", "mmolperliter"}:
        return "mmol/L"
    return "mg/dL"


def _headers(config, token=None, account_id=None):
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "product": "llu.android",
        "version": config["version"],
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if account_id:
        headers["Account-ID"] = account_id
    return headers


def _request(base, method, path, config, payload=None, token=None, account_id=None, timeout=15):
    url = base.rstrip("/") + path
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers=_headers(config, token=token, account_id=account_id),
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            text = response.read().decode("utf-8", errors="replace")
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"LibreLinkUp HTTP {exc.code}: {detail[:400]}")


def _cache_valid(cache):
    try:
        expires = int(cache.get("expires") or 0)
    except Exception:
        expires = 0
    return bool(cache.get("token") and cache.get("account_id") and cache.get("base_url") and expires > time.time() + 300)


def _login(config, force=False):
    if not config["username"] or not config["password"]:
        raise RuntimeError("LibreLinkUp is not configured; set credentials in memory/librelinkup.json or LIBRE_LINK_UP_USERNAME/PASSWORD")
    cache = _read_json(CACHE_FILE, {})
    if not force and _cache_valid(cache):
        return cache
    last_error = None
    for base in config["bases"]:
        try:
            response = _request(
                base,
                "POST",
                "/llu/auth/login",
                config,
                payload={"email": config["username"], "password": config["password"]},
            )
            data = response.get("data") or {}
            ticket = data.get("authTicket") or data.get("ticket") or response.get("ticket") or {}
            user = data.get("user") or {}
            token = ticket.get("token")
            user_id = user.get("id")
            if not token or not user_id:
                raise RuntimeError("login response did not include token and user id")
            cache = {
                "base_url": base,
                "token": token,
                "expires": int(ticket.get("expires") or (time.time() + 3600)),
                "account_id": hashlib.sha256(str(user_id).encode("utf-8")).hexdigest(),
                "user_id_hash": hashlib.sha256(str(user_id).encode("utf-8")).hexdigest()[:12],
                "updated": _now(),
            }
            _write_json(CACHE_FILE, cache)
            return cache
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"LibreLinkUp login failed: {last_error}")


def _connections(config, force_login=False):
    session = _login(config, force=force_login)
    try:
        response = _request(
            session["base_url"],
            "GET",
            "/llu/connections",
            config,
            token=session["token"],
            account_id=session["account_id"],
        )
    except Exception:
        if force_login:
            raise
        session = _login(config, force=True)
        response = _request(
            session["base_url"],
            "GET",
            "/llu/connections",
            config,
            token=session["token"],
            account_id=session["account_id"],
        )
    data = response.get("data")
    return data if isinstance(data, list) else []


def _person_key(value):
    return str(value or "").strip().lower().replace(" ", "-")


def _connection_for_person(config, person, connections=None):
    person_raw = str(person or "").strip()
    person_key = _person_key(person_raw)
    configured = config.get("connections", {}).get(person_raw) or config.get("connections", {}).get(person_key)
    connections = connections if connections is not None else _connections(config)
    if configured:
        for item in connections:
            if str(item.get("patientId") or item.get("id") or "") == str(configured):
                return item
    if len(connections) == 1:
        return connections[0]
    for item in connections:
        full_name = f"{item.get('firstName','')} {item.get('lastName','')}".strip()
        candidates = {
            _person_key(full_name),
            _person_key(item.get("firstName")),
            _person_key(item.get("patientId")),
            _person_key(item.get("id")),
        }
        if person_key in candidates:
            return item
    names = [f"{c.get('firstName','')} {c.get('lastName','')}".strip() or c.get("patientId") for c in connections]
    raise RuntimeError(f"no LibreLinkUp connection matched {person_raw}; available={names}")


def _graph(config, connection):
    session = _login(config)
    patient_id = connection.get("patientId") or connection.get("id")
    if not patient_id:
        raise RuntimeError("LibreLinkUp connection has no patient id")
    try:
        response = _request(
            session["base_url"],
            "GET",
            f"/llu/connections/{patient_id}/graph",
            config,
            token=session["token"],
            account_id=session["account_id"],
        )
    except Exception:
        session = _login(config, force=True)
        response = _request(
            session["base_url"],
            "GET",
            f"/llu/connections/{patient_id}/graph",
            config,
            token=session["token"],
            account_id=session["account_id"],
        )
    return response


def _unit(item, connection=None, config=None):
    if config and config.get("unit"):
        return _normalize_unit(config.get("unit"))
    units = item.get("GlucoseUnits")
    uom = connection.get("uom") if isinstance(connection, dict) else None
    if str(units) == "2" or str(uom) == "2":
        return "mmol/L"
    return "mg/dL"


def _value(item, connection=None, config=None):
    unit = _unit(item, connection, config)
    raw_mgdl = item.get("ValueInMgPerDl")
    raw = raw_mgdl if raw_mgdl is not None else item.get("Value")
    try:
        value = float(raw)
    except Exception:
        return ""
    if unit == "mmol/L":
        if raw_mgdl is not None or value > 40:
            value = value / 18.0
    elif unit == "mg/dL" and raw_mgdl is None and value < 40:
        value = value * 18.0
    return round(value, 1) if unit == "mmol/L" else int(round(value))


def _trend(item):
    arrow = item.get("TrendArrow")
    try:
        arrow = int(arrow)
    except Exception:
        return str(item.get("TrendMessage") or "unknown")
    return TREND_NAMES.get(arrow, f"trend-{arrow}")


def _observation(person, item, connection, config=None, source="LibreLinkUp"):
    timestamp = str(item.get("Timestamp") or item.get("FactoryTimestamp") or "")
    return {
        "person": str(person),
        "timestamp": timestamp,
        "value": _value(item, connection, config),
        "unit": _unit(item, connection, config),
        "trend": _trend(item),
        "is_high": bool(item.get("isHigh")),
        "is_low": bool(item.get("isLow")),
        "source": source,
    }


def _append_trace(event):
    MEMORY.mkdir(parents=True, exist_ok=True)
    event = dict(event)
    event["observed_at"] = _now()
    with TRACE_LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
    try:
        os.chmod(TRACE_LOG, 0o600)
    except Exception:
        pass


def _update_cache(**updates):
    cache = _read_json(CACHE_FILE, {})
    cache.update(updates)
    _write_json(CACHE_FILE, cache)
    return cache


def _app_states(cache):
    states = cache.get("app_state")
    if not isinstance(states, dict):
        states = {}
        cache["app_state"] = states
    return states


def _app_state(cache, person):
    states = _app_states(cache)
    key = str(person)
    state = states.get(key)
    if not isinstance(state, dict):
        state = {}
        states[key] = state
    return state


def _watch_poll_seconds(watch):
    try:
        explicit = int(float(watch.get("poll_seconds")))
    except Exception:
        explicit = 0
    if explicit > 0:
        return max(60, min(explicit, 3600))
    try:
        stale_seconds = int(float(watch.get("stale_minutes"))) * 60
    except Exception:
        stale_seconds = 0
    if stale_seconds > 0:
        return max(60, min(DEFAULT_WATCH_POLL_SECONDS, stale_seconds // 2 or DEFAULT_WATCH_POLL_SECONDS))
    return DEFAULT_WATCH_POLL_SECONDS


def _classify_error(exc):
    text = str(exc)
    if "HTTP 429" in text or "HTTP 430" in text or "Error 1015" in text or "rate limit" in text.lower() or "rate_limited" in text:
        return "rate_limited"
    if "login failed" in text:
        return "login_failed"
    return "error"


def _backoff_seconds(kind, previous_count=0):
    try:
        previous_count = int(previous_count)
    except Exception:
        previous_count = 0
    if kind == "rate_limited":
        return RATE_LIMIT_BACKOFF_SECONDS
    return min(300 * max(1, 2 ** min(previous_count, 3)), MAX_ERROR_BACKOFF_SECONDS)


def _last_good_from_state(state):
    obs = state.get("last_good_observation")
    return obs if isinstance(obs, dict) else None


def _format_app_notice(person, state):
    kind = state.get("last_error_kind") or "error"
    backoff_until = state.get("backoff_until")
    backoff_text = _iso_from_ts(backoff_until) if backoff_until else "unknown"
    obs = _last_good_from_state(state)
    if obs:
        last_good = f"last_good={obs.get('value')} {obs.get('unit')} trend={obs.get('trend')} timestamp={obs.get('timestamp')}"
    else:
        last_good = "last_good=none"
    return f"GLUCOSE_APP_NOTICE person={person} kind={kind} backoff_until={backoff_text} {last_good}"


def _format_obs(obs):
    return (
        f"(GlucoseObservation {json.dumps(str(obs['person']))} \"{obs['timestamp']}\" "
        f"{json.dumps(str(obs['value']))} \"{obs['unit']}\" "
        f"\"{obs['trend']}\" high={str(obs['is_high']).lower()} "
        f"low={str(obs['is_low']).lower()} source=\"{obs['source']}\")"
    )


def glucose_app_status():
    config = _config()
    configured = bool(config["username"] and config["password"])
    cache = _read_json(CACHE_FILE, {})
    redacted_user = ""
    if config["username"]:
        name = config["username"]
        redacted_user = name[:2] + "***" + name[-4:] if len(name) > 6 else "***"
    try:
        connections = _connections(config) if configured else []
        names = [f"{c.get('firstName','')} {c.get('lastName','')}".strip() or str(c.get("patientId")) for c in connections]
        return (
            f"GLUCOSE-APP-STATUS configured={configured} user={redacted_user} "
            f"base={cache.get('base_url','unknown')} connections={len(connections)} names={json.dumps(names, ensure_ascii=False)}"
        )
    except Exception as exc:
        return f"GLUCOSE-APP-STATUS configured={configured} user={redacted_user} error={type(exc).__name__}: {exc}"


def observe_glucose(person):
    try:
        config = _config()
        connection = _connection_for_person(config, person)
        response = _graph(config, connection)
        data = response.get("data") or {}
        graph_connection = data.get("connection") or connection
        item = graph_connection.get("glucoseMeasurement") or graph_connection.get("glucoseItem")
        if not isinstance(item, dict):
            raise RuntimeError("LibreLinkUp graph response had no current glucose measurement")
        obs = _observation(person, item, graph_connection, config)
        _append_trace({"kind": "glucose_observation", "observation": obs})
        return _format_obs(obs)
    except Exception as exc:
        _append_trace({"kind": "glucose_observation_failed", "person": str(person), "error": f"{type(exc).__name__}: {exc}"})
        return f"GLUCOSE-OBSERVATION-ERROR {type(exc).__name__}: {exc}"


def glucose_history(person, limit=12):
    try:
        limit = max(1, min(int(limit), 96))
    except Exception:
        limit = 12
    try:
        config = _config()
        connection = _connection_for_person(config, person)
        response = _graph(config, connection)
        data = response.get("data") or {}
        graph_connection = data.get("connection") or connection
        graph = data.get("graphData") if isinstance(data.get("graphData"), list) else []
        observations = [_observation(person, item, graph_connection, config) for item in graph[-limit:] if isinstance(item, dict)]
        _append_trace({"kind": "glucose_history", "person": str(person), "count": len(observations), "observations": observations})
        return "(" + " ".join(_format_obs(obs) for obs in observations) + ")"
    except Exception as exc:
        _append_trace({"kind": "glucose_history_failed", "person": str(person), "error": f"{type(exc).__name__}: {exc}"})
        return f"GLUCOSE-HISTORY-ERROR {type(exc).__name__}: {exc}"


def set_glucose_watch(person, low, high, stale_minutes, channel, note):
    watches = _read_json(WATCH_FILE, {})
    key = str(person).strip()
    watches[key] = {
        "person": key,
        "low": float(low),
        "high": float(high),
        "stale_minutes": int(float(stale_minutes)),
        "channel": str(channel),
        "note": str(note),
        "poll_seconds": DEFAULT_WATCH_POLL_SECONDS,
        "updated": _now(),
    }
    _write_json(WATCH_FILE, watches)
    return f"GLUCOSE-WATCH-SET person={key} low={low} high={high} stale_minutes={stale_minutes} channel={channel}"


def glucose_watch_status(person=""):
    watches = _read_json(WATCH_FILE, {})
    cache = _read_json(CACHE_FILE, {})
    states = _app_states(cache)
    key = str(person or "").strip()
    if key:
        return json.dumps(
            {"watch": watches.get(key, {}), "app_state": states.get(key, {})},
            ensure_ascii=False,
            sort_keys=True,
        )
    return json.dumps({"watches": watches, "app_state": states}, ensure_ascii=False, sort_keys=True)


def clear_glucose_watch(person):
    watches = _read_json(WATCH_FILE, {})
    key = str(person).strip()
    existed = key in watches
    watches.pop(key, None)
    _write_json(WATCH_FILE, watches)
    cache = _read_json(CACHE_FILE, {})
    states = _app_states(cache)
    states.pop(key, None)
    _write_json(CACHE_FILE, cache)
    return f"GLUCOSE-WATCH-CLEARED person={key} existed={str(existed).lower()}"


def glucose_rings(person):
    watches = _read_json(WATCH_FILE, {})
    key = str(person).strip()
    watch = watches.get(key)
    if not watch:
        return f"GLUCOSE-RINGS person={key} none no-watch-configured"
    obs_text = observe_glucose(key)
    if obs_text.startswith("GLUCOSE-OBSERVATION-ERROR"):
        return f"GLUCOSE-RINGS person={key} error={obs_text}"
    # Read the exact latest trace instead of reparsing the display string.
    latest = None
    try:
        for line in TRACE_LOG.read_text(encoding="utf-8").splitlines()[::-1]:
            event = json.loads(line)
            obs = event.get("observation") or {}
            if event.get("kind") == "glucose_observation" and obs.get("person") == key:
                latest = obs
                break
    except Exception:
        latest = None
    if not latest:
        return f"GLUCOSE-RINGS person={key} none no-current-observation"
    try:
        value = float(latest["value"])
        low = float(watch["low"])
        high = float(watch["high"])
    except Exception as exc:
        return f"GLUCOSE-RINGS person={key} error={type(exc).__name__}: {exc}"
    rings = []
    if value <= low:
        rings.append(
            f"(GlucoseRing {json.dumps(key)} low {json.dumps(str(latest['value']))} "
            f"\"{latest['unit']}\" \"{latest['timestamp']}\" {json.dumps(str(watch.get('note','')))} 0.95)"
        )
    if value >= high:
        rings.append(
            f"(GlucoseRing {json.dumps(key)} high {json.dumps(str(latest['value']))} "
            f"\"{latest['unit']}\" \"{latest['timestamp']}\" {json.dumps(str(watch.get('note','')))} 0.95)"
        )
    return "(" + " ".join(rings) + ")" if rings else f"GLUCOSE-RINGS person={key} none current={latest['value']} {latest['unit']}"


def _current_observation(config, person):
    connection = _connection_for_person(config, person)
    response = _graph(config, connection)
    data = response.get("data") or {}
    graph_connection = data.get("connection") or connection
    item = graph_connection.get("glucoseMeasurement") or graph_connection.get("glucoseItem")
    if not isinstance(item, dict):
        raise RuntimeError("LibreLinkUp graph response had no current glucose measurement")
    obs = _observation(person, item, graph_connection, config)
    _append_trace({"kind": "glucose_observation", "observation": obs})
    return obs


def _ring_candidates(person, watch, obs):
    rings = []
    try:
        value = float(obs["value"])
        low = float(watch["low"])
        high = float(watch["high"])
    except Exception:
        return rings
    if value <= low or obs.get("is_low"):
        rings.append({
            "person": str(person),
            "kind": "low",
            "value": obs["value"],
            "unit": obs["unit"],
            "timestamp": obs["timestamp"],
            "trend": obs["trend"],
            "note": watch.get("note", ""),
            "channel": watch.get("channel", ""),
            "confidence": "0.95",
        })
    if value >= high or obs.get("is_high"):
        rings.append({
            "person": str(person),
            "kind": "high",
            "value": obs["value"],
            "unit": obs["unit"],
            "timestamp": obs["timestamp"],
            "trend": obs["trend"],
            "note": watch.get("note", ""),
            "channel": watch.get("channel", ""),
            "confidence": "0.95",
        })
    return rings


def _stale_ring_candidate(person, watch, obs, cache):
    stale_minutes = watch.get("stale_minutes")
    try:
        stale_seconds = max(1, int(float(stale_minutes)) * 60)
    except Exception:
        return None
    seen = cache.get("seen_measurements") if isinstance(cache.get("seen_measurements"), dict) else {}
    timestamp = str(obs.get("timestamp") or "")
    now = time.time()
    current = seen.get(str(person)) if isinstance(seen.get(str(person)), dict) else {}
    if current.get("timestamp") != timestamp:
        seen[str(person)] = {"timestamp": timestamp, "first_seen": now}
        cache["seen_measurements"] = seen
        return None
    try:
        first_seen = float(current.get("first_seen") or now)
    except Exception:
        first_seen = now
    cache["seen_measurements"] = seen
    if now - first_seen < stale_seconds:
        return None
    return {
        "person": str(person),
        "kind": "stale",
        "value": obs["value"],
        "unit": obs["unit"],
        "timestamp": obs["timestamp"],
        "trend": obs["trend"],
        "note": watch.get("note", ""),
        "channel": watch.get("channel", ""),
        "confidence": "0.9",
    }


def _format_ring(ring):
    return (
        f"GLUCOSE_RING person={ring['person']} kind={ring['kind']} "
        f"value={ring['value']} unit={ring['unit']} trend={ring['trend']} "
        f"timestamp={ring['timestamp']} note={ring.get('note','')}"
    )


def pending_glucose_rings():
    """Return new glucose watch rings for router.receive without sending messages.

    This is a health-related interrupt surface: it wakes the agent's cognition with
    exact observed data, but leaves response choice to the agent.
    """
    watches = _read_json(WATCH_FILE, {})
    if not watches:
        return ""
    config = _config()
    cache = _read_json(CACHE_FILE, {})
    seen = cache.get("seen_rings") if isinstance(cache.get("seen_rings"), dict) else {}
    notices = []
    for person, watch in watches.items():
        person = str(person)
        state = _app_state(cache, person)
        now = _now_ts()
        try:
            backoff_until = float(state.get("backoff_until") or 0)
        except Exception:
            backoff_until = 0
        try:
            next_poll_at = float(state.get("next_poll_at") or 0)
        except Exception:
            next_poll_at = 0
        if backoff_until > now:
            notice_key = f"{person}|app-notice|{state.get('last_error_kind')}|{int(backoff_until)}"
            if seen.get(f"{person}:app") != notice_key:
                seen[f"{person}:app"] = notice_key
                notice = _format_app_notice(person, state)
                _append_trace({"kind": "glucose_app_notice", "person": person, "notice": notice, "state": state})
                notices.append(notice)
            obs = _last_good_from_state(state)
            if obs:
                stale_ring = _stale_ring_candidate(person, watch, obs, cache)
                if stale_ring:
                    key = f"{stale_ring['person']}|{stale_ring['kind']}|{stale_ring['value']}|{stale_ring['timestamp']}"
                    if seen.get(stale_ring["person"]) != key:
                        seen[stale_ring["person"]] = key
                        _append_trace({"kind": "glucose_ring", "ring": stale_ring, "source": "cached-during-backoff"})
                        notices.append(_format_ring(stale_ring))
            _append_trace({"kind": "glucose_poll_suppressed", "person": person, "reason": "backoff", "backoff_until": _iso_from_ts(backoff_until)})
            continue
        if next_poll_at > now:
            obs = _last_good_from_state(state)
            if obs:
                stale_ring = _stale_ring_candidate(person, watch, obs, cache)
                if stale_ring:
                    key = f"{stale_ring['person']}|{stale_ring['kind']}|{stale_ring['value']}|{stale_ring['timestamp']}"
                    if seen.get(stale_ring["person"]) != key:
                        seen[stale_ring["person"]] = key
                        _append_trace({"kind": "glucose_ring", "ring": stale_ring, "source": "cached-between-polls"})
                        notices.append(_format_ring(stale_ring))
            continue
        try:
            obs = _current_observation(config, person)
            state.update({
                "last_poll_at": now,
                "next_poll_at": now + _watch_poll_seconds(watch),
                "backoff_until": 0,
                "last_error_kind": "",
                "last_error": "",
                "error_count": 0,
                "last_good_observation": obs,
                "last_good_at": _now(),
            })
            rings = _ring_candidates(person, watch, obs)
            stale_ring = _stale_ring_candidate(person, watch, obs, cache)
            if stale_ring:
                rings.append(stale_ring)
            for ring in rings:
                key = f"{ring['person']}|{ring['kind']}|{ring['value']}|{ring['timestamp']}"
                if seen.get(ring["person"]) == key:
                    continue
                seen[ring["person"]] = key
                _append_trace({"kind": "glucose_ring", "ring": ring})
                notices.append(_format_ring(ring))
        except Exception as exc:
            kind = _classify_error(exc)
            error_count = int(state.get("error_count") or 0) + 1
            backoff_seconds = _backoff_seconds(kind, error_count - 1)
            backoff_until = now + backoff_seconds
            state.update({
                "last_poll_at": now,
                "next_poll_at": backoff_until,
                "backoff_until": backoff_until,
                "last_error_kind": kind,
                "last_error": f"{type(exc).__name__}: {exc}"[:500],
                "last_error_at": _now(),
                "error_count": error_count,
            })
            _append_trace({
                "kind": "glucose_poll_failed",
                "person": person,
                "error_kind": kind,
                "error": f"{type(exc).__name__}: {exc}",
                "backoff_until": _iso_from_ts(backoff_until),
            })
            key = f"{person}|app-notice|{kind}|{int(backoff_until)}"
            if seen.get(f"{person}:app") != key:
                seen[f"{person}:app"] = key
                notices.append(_format_app_notice(person, state))
    cache["seen_rings"] = seen
    cache["seen_measurements"] = cache.get("seen_measurements", {})
    _write_json(CACHE_FILE, cache)
    return " | ".join(notices[:5])
