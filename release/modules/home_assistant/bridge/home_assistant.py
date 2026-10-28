import json
import os
import pathlib
import re
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[3]
ACTION_LOG = ROOT / "memory" / "runtime" / "home_assistant" / "actions.jsonl"
CONFIG_FILE = ROOT / "memory" / "home_assistant.json"


def _trace_enabled():
    return os.environ.get("OMEGACLAW_HA_TRACE", "").strip().lower() in {"1", "true", "yes", "on"}


def _config():
    base_url = os.environ.get("HOME_ASSISTANT_URL") or os.environ.get("HA_URL") or ""
    token = os.environ.get("HOME_ASSISTANT_TOKEN") or os.environ.get("HA_TOKEN") or ""
    if (not base_url or not token) and CONFIG_FILE.exists():
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            base_url = base_url or data.get("url", "")
            token = token or data.get("token", "")
        except Exception:
            pass
    base_url = base_url.strip().rstrip("/")
    token = token.strip()
    if not base_url or not token:
        raise RuntimeError("Home Assistant is not configured; set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN")
    return base_url, token


def _request(method, path, payload=None, timeout=10):
    base_url, token = _config()
    url = base_url + path
    data = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            if not body:
                return None
            return json.loads(body)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Home Assistant HTTP {exc.code}: {detail[:300]}")


def _states():
    states = _request("GET", "/api/states")
    return states if isinstance(states, list) else []


def _template(template):
    return _request("POST", "/api/template", payload={"template": template})


def _area_entities(area):
    area = str(area or "").strip()
    if not area:
        return []
    area_slugs = _area_slug_variants(area)
    areas = _areas()
    candidates = [area]
    for item in areas:
        candidate_slugs = _area_slug_variants(item["id"]) | _area_slug_variants(item["name"])
        if not candidate_slugs.isdisjoint(area_slugs) or any(
            candidate.startswith(query) or query.startswith(candidate)
            for candidate in candidate_slugs
            for query in area_slugs
        ):
            candidates.append(item["id"])
            candidates.append(item["name"])

    for candidate in dict.fromkeys(candidates):
        area_literal = json.dumps(candidate)
        template = "{{ area_entities(" + area_literal + ") | list | to_json }}"
        result = _template(template)
        entities = []
        if isinstance(result, list):
            entities = [item for item in result if isinstance(item, str)]
        elif isinstance(result, str):
            try:
                parsed = json.loads(result)
                if isinstance(parsed, list):
                    entities = [item for item in parsed if isinstance(item, str)]
            except Exception:
                entities = []
        if entities:
            return entities
    return []


def _areas():
    template = (
        "{% set ns = namespace(items=[]) %}"
        "{% for area_id in areas() | list %}"
        "{% set ns.items = ns.items + [{'id': area_id, 'name': area_name(area_id) or area_id}] %}"
        "{% endfor %}"
        "{{ ns.items | to_json }}"
    )
    result = _template(template)
    if isinstance(result, list):
        return [
            {"id": str(item.get("id")), "name": str(item.get("name") or item.get("id"))}
            for item in result
            if isinstance(item, dict) and str(item.get("id", "")).strip()
        ]
    if isinstance(result, str):
        try:
            parsed = json.loads(result)
            if isinstance(parsed, list):
                return [
                    {"id": str(item.get("id")), "name": str(item.get("name") or item.get("id"))}
                    for item in parsed
                    if isinstance(item, dict) and str(item.get("id", "")).strip()
                ]
        except Exception:
            return []
    return []


def _friendly_name(state):
    attrs = state.get("attributes") or {}
    return attrs.get("friendly_name") or state.get("entity_id", "")


def _slug(value):
    return re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")


def _area_slug_variants(value):
    slug = _slug(value)
    variants = {slug} if slug else set()
    for suffix in ("-room", "-area", "-zone"):
        if slug.endswith(suffix):
            variants.add(slug[: -len(suffix)])
    return {item for item in variants if item}


def _resolve_entity(target, states=None):
    states = states or _states()
    raw = str(target or "").strip().strip('"')
    if not raw:
        raise ValueError("target is empty")
    raw_lower = raw.lower()
    raw_slug = _slug(raw)
    for state in states:
        entity_id = state.get("entity_id", "")
        if entity_id.lower() == raw_lower:
            return entity_id, state
    for state in states:
        name = _friendly_name(state)
        if name.lower() == raw_lower or _slug(name) == raw_slug:
            return state.get("entity_id", ""), state
    matches = [
        state for state in states
        if raw_lower in state.get("entity_id", "").lower()
        or raw_lower in _friendly_name(state).lower()
        or raw_slug in _slug(_friendly_name(state))
    ]
    if len(matches) == 1:
        return matches[0].get("entity_id", ""), matches[0]
    if matches:
        names = ", ".join(f"{item.get('entity_id')}:{_friendly_name(item)}" for item in matches[:8])
        raise ValueError(f"ambiguous target; matches {names}")
    raise ValueError(f"unknown house target {raw}")


def _append_log(record):
    record = {
        "trace_id": _trace_id(record),
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        **record,
    }
    if not _trace_enabled():
        return record
    ACTION_LOG.parent.mkdir(parents=True, exist_ok=True)
    with ACTION_LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return record


def _trace_id(record):
    raw = json.dumps(record, sort_keys=True, ensure_ascii=False) + str(time.time_ns())
    return "ha-" + str(abs(hash(raw)) % 10_000_000_000)


def _brief_state(state):
    attrs = state.get("attributes") or {}
    useful = {}
    for key in (
        "friendly_name",
        "brightness",
        "brightness_pct",
        "color_mode",
        "supported_color_modes",
        "color_temp_kelvin",
        "min_color_temp_kelvin",
        "max_color_temp_kelvin",
        "rgb_color",
        "hs_color",
        "temperature",
        "current_temperature",
        "unit_of_measurement",
        "supported_features",
    ):
        if key in attrs:
            useful[key] = attrs[key]
    return {
        "entity_id": state.get("entity_id"),
        "name": _friendly_name(state),
        "domain": state.get("entity_id", "").split(".", 1)[0],
        "state": state.get("state"),
        "attributes": useful,
        "changed": state.get("last_changed"),
        "updated": state.get("last_updated"),
    }


def _compact_state(state):
    attrs = (state or {}).get("attributes") or {}
    result = {
        "entity_id": (state or {}).get("entity_id"),
        "name": _friendly_name(state or {}),
        "domain": (state or {}).get("entity_id", "").split(".", 1)[0],
        "state": (state or {}).get("state"),
    }
    for key in ("brightness", "color_temp_kelvin", "rgb_color", "source", "volume_level"):
        if key in attrs:
            result[key] = attrs[key]
    return {key: value for key, value in result.items() if value not in (None, "", [])}


def _action_summary(record):
    changed = 0
    before = record.get("before")
    after = record.get("after")
    if isinstance(before, list) and isinstance(after, list):
        before_by_id = {item.get("entity_id"): item for item in before if isinstance(item, dict)}
        for item in after:
            if isinstance(item, dict) and item != before_by_id.get(item.get("entity_id")):
                changed += 1
    elif isinstance(before, dict) and isinstance(after, dict):
        changed = 1 if before != after else 0
    entities = record.get("entities")
    entity_count = len(entities) if isinstance(entities, list) else 1 if record.get("target") else 0
    return {
        "trace_id": record.get("trace_id"),
        "kind": record.get("kind"),
        "affordance": record.get("affordance"),
        "target": record.get("target"),
        "service": record.get("service"),
        "entity_count": entity_count,
        "changed_count": changed,
    }


def observe_house():
    try:
        states = _states()
        domains = {}
        examples = []
        for state in states:
            entity_id = state.get("entity_id", "")
            domain = entity_id.split(".", 1)[0] if "." in entity_id else "unknown"
            domains[domain] = domains.get(domain, 0) + 1
            if domain in {"light", "switch", "scene", "sensor", "climate", "media_player", "cover", "lock"}:
                examples.append(_compact_state(state))
        interesting = [
            item for item in examples
            if item.get("domain") in {"light", "media_player", "climate", "cover", "lock"}
            and item.get("state") not in {"off", "unavailable", "unknown"}
        ]
        payload = {
            "domains": domains,
            "active_count": len(interesting),
            "active_sample": interesting[:16],
            "omitted_active": max(0, len(interesting) - 16),
            "detail_hint": "use observe-room room, observe-device entity, or observe-house-full for more",
        }
        return "HOUSE-OBSERVATION " + json.dumps(payload, ensure_ascii=False)
    except Exception as exc:
        return f"HOUSE-OBSERVATION-FAILED {exc}"


def observe_house_full():
    try:
        states = _states()
        domains = {}
        examples = []
        for state in states:
            entity_id = state.get("entity_id", "")
            domain = entity_id.split(".", 1)[0] if "." in entity_id else "unknown"
            domains[domain] = domains.get(domain, 0) + 1
            if domain in {"light", "switch", "scene", "sensor", "climate", "media_player", "cover", "lock"}:
                examples.append(_brief_state(state))
        payload = {"domains": domains, "examples": examples[:120]}
        return "HOUSE-FULL-OBSERVATION " + json.dumps(payload, ensure_ascii=False)
    except Exception as exc:
        return f"HOUSE-FULL-OBSERVATION-FAILED {exc}"


def observe_room(room):
    try:
        states = _states()
        state_by_id = {state.get("entity_id"): state for state in states}
        area_entity_ids = _area_entities(room)
        if area_entity_ids:
            matches = [
                _brief_state(state_by_id[entity_id])
                for entity_id in area_entity_ids
                if entity_id in state_by_id
            ]
            return "ROOM-OBSERVATION " + json.dumps({
                "room": str(room),
                "source": "home-assistant-area",
                "entity_count": len(matches),
                "entities": [_compact_state(item) for item in matches[:32]],
                "omitted_entities": max(0, len(matches) - 32),
            }, ensure_ascii=False)
        needle = str(room or "").lower()
        matches = [
            _brief_state(state) for state in states
            if needle in state.get("entity_id", "").lower()
            or needle in _friendly_name(state).lower()
        ]
        return "ROOM-OBSERVATION " + json.dumps({
            "room": str(room),
            "source": "name-match",
            "entity_count": len(matches),
            "entities": [_compact_state(item) for item in matches[:32]],
            "omitted_entities": max(0, len(matches) - 32),
        }, ensure_ascii=False)
    except Exception as exc:
        return f"ROOM-OBSERVATION-FAILED {exc}"


def observe_device(device):
    try:
        entity_id, _ = _resolve_entity(device)
        state = _request("GET", f"/api/states/{urllib.parse.quote(entity_id, safe='.')}")
        return "DEVICE-OBSERVATION " + json.dumps(_brief_state(state), ensure_ascii=False)
    except Exception as exc:
        return f"DEVICE-OBSERVATION-FAILED {exc}"


def observe_house_affordances():
    try:
        states = _states()
        state_by_id = {state.get("entity_id"): state for state in states}
        affordances = []
        for area in _areas():
            area_id = area["id"]
            area_name = area["name"]
            entity_ids = _area_entities(area_id)
            area_states = [state_by_id[entity_id] for entity_id in entity_ids if entity_id in state_by_id]
            controllable = [
                state for state in area_states
                if state.get("entity_id", "").split(".", 1)[0] in {"light", "switch", "media_player", "climate"}
            ]
            light_count = sum(1 for state in area_states if state.get("entity_id", "").startswith("light."))
            if controllable:
                affordances.append({
                    "target": area_name,
                    "id": area_id,
                    "name": area_name,
                    "domain": "area",
                    "state": f"{len(controllable)} controllable entities, {light_count} lights",
                    "affordances": _area_affordances(area_states),
                })
        for state in states:
            entity_id = state.get("entity_id", "")
            domain = entity_id.split(".", 1)[0] if "." in entity_id else ""
            name = _friendly_name(state)
            if domain in {"light", "switch", "scene", "media_player", "climate", "cover", "lock"}:
                affordances.append({
                    "target": entity_id,
                    "name": name,
                    "domain": domain,
                    "state": state.get("state"),
                    "affordances": _light_affordances(state) if domain == "light" else _domain_affordances(domain),
                })
        return "HOUSE-AFFORDANCES " + json.dumps({"affordances": affordances[:120]}, ensure_ascii=False)
    except Exception as exc:
        return f"HOUSE-AFFORDANCES-FAILED {exc}"


def _domain_affordances(domain):
    table = {
        "light": ["turn-on", "turn-off", "toggle", "dim-light", "ambient-light", "set-brightness", "set-brightness-percent", "set-brightness-raw", "set-color-temperature", "warm-light", "cool-light", "set-color"],
        "switch": ["turn-on", "turn-off", "toggle"],
        "scene": ["run-scene"],
        "media_player": ["turn-on", "turn-off", "toggle", "select-source"],
        "climate": ["turn-on", "turn-off"],
        "cover": ["open", "close", "stop"],
        "lock": ["lock", "unlock"],
    }
    return table.get(domain, ["observe"])


def _light_affordances(state):
    affordances = ["turn-on", "turn-off", "toggle", "dim-light", "ambient-light", "set-brightness", "set-brightness-percent", "set-brightness-raw"]
    attrs = state.get("attributes") or {}
    modes = set(attrs.get("supported_color_modes") or [])
    if "color_temp" in modes:
        affordances.extend(["set-color-temperature", "warm-light", "cool-light"])
    if modes.intersection({"rgb", "rgbw", "rgbww", "hs", "xy"}):
        affordances.append("set-color")
    return affordances


def _area_affordances(states):
    affordances = ["room-turn-on", "room-turn-off", "room-toggle"]
    lights = [state for state in states if state.get("entity_id", "").startswith("light.")]
    if lights:
        affordances.extend(["room-dim", "room-ambient", "room-set-brightness", "room-set-brightness-percent", "room-set-brightness-raw"])
    if any("set-color-temperature" in _light_affordances(state) for state in lights):
        affordances.extend(["room-set-color-temperature", "room-warm", "room-cool"])
    if any("set-color" in _light_affordances(state) for state in lights):
        affordances.append("room-set-color")
    return affordances


def _parse_percent(context, default=None):
    match = re.search(r"\b(\d{1,3})\b", str(context or ""))
    if not match:
        return default
    return max(0, min(100, int(match.group(1))))


def _parse_brightness_raw(context, default=None):
    match = re.search(r"\b(\d{1,3})\b", str(context or ""))
    if not match:
        return default
    return max(0, min(255, int(match.group(1))))


def _brightness_data(action, context, default_percent=70):
    if action in {"set-brightness-raw", "raw-brightness", "brightness-raw"}:
        value = _parse_brightness_raw(context)
        if value is None:
            raise ValueError("raw brightness context needs a 0-255 value")
        return {"brightness": value}
    if action in {"set-brightness-percent", "brightness-percent", "brightness-pct"}:
        value = _parse_percent(context)
        if value is None:
            raise ValueError("percent brightness context needs a 0-100 value")
        return {"brightness_pct": value}
    text = str(context or "").lower()
    if re.search(r"\b(raw|0-255|0 to 255|brightness value)\b", text):
        value = _parse_brightness_raw(context)
        if value is None:
            raise ValueError("raw brightness context needs a 0-255 value")
        return {"brightness": value}
    return {"brightness_pct": _parse_percent(context, default=default_percent)}


def _allows_brightness_turn_on(context):
    text = str(context or "").lower()
    return bool(re.search(r"\b(turn on|switch on|wake|enable|activate)\b", text))


def _parse_kelvin(context, default=None, state=None):
    text = str(context or "").lower()
    presets = {
        "candle": 2200,
        "cozy": 2400,
        "cosy": 2400,
        "warm": 2700,
        "soft": 3000,
        "neutral": 4000,
        "daylight": 5000,
        "bright": 5000,
        "cool": 6500,
    }
    kelvin = None
    match = re.search(r"\b([1-9]\d{3})\s*k?\b", text)
    if match:
        kelvin = int(match.group(1))
    else:
        for word, value in presets.items():
            if re.search(rf"\b{re.escape(word)}\b", text):
                kelvin = value
                break
    if kelvin is None:
        kelvin = default
    if kelvin is None:
        raise ValueError("color temperature context needs a kelvin value or words like warm, neutral, daylight, cool")

    attrs = (state or {}).get("attributes") or {}
    minimum = attrs.get("min_color_temp_kelvin")
    maximum = attrs.get("max_color_temp_kelvin")
    if isinstance(minimum, int):
        kelvin = max(minimum, kelvin)
    if isinstance(maximum, int):
        kelvin = min(maximum, kelvin)
    return kelvin


def _parse_rgb(context):
    text = str(context or "").lower()
    named = {
        "red": [255, 0, 0],
        "orange": [255, 128, 0],
        "amber": [255, 191, 0],
        "yellow": [255, 255, 0],
        "green": [0, 255, 0],
        "cyan": [0, 255, 255],
        "aqua": [0, 255, 255],
        "blue": [0, 0, 255],
        "purple": [128, 0, 255],
        "violet": [128, 0, 255],
        "pink": [255, 64, 160],
        "magenta": [255, 0, 255],
        "white": [255, 255, 255],
    }
    rgb_match = re.search(r"\brgb\s*\(?\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*\)?", text)
    if rgb_match:
        return [max(0, min(255, int(value))) for value in rgb_match.groups()]
    for word, value in named.items():
        if re.search(rf"\b{re.escape(word)}\b", text):
            return value
    raise ValueError("color context needs a named color or rgb r g b values")


def _parse_source(context, state):
    raw = str(context or "").strip().strip('"')
    if not raw:
        raise ValueError("source context needs a source name")
    attrs = (state or {}).get("attributes") or {}
    sources = [str(source) for source in attrs.get("source_list") or []]
    if not sources:
        return raw
    raw_lower = raw.lower()
    raw_slug = _slug(raw)
    for source in sources:
        if source.lower() == raw_lower or _slug(source) == raw_slug:
            return source
    matches = [
        source for source in sources
        if raw_lower in source.lower() or raw_slug in _slug(source)
    ]
    if len(matches) == 1:
        return matches[0]
    if matches:
        raise ValueError(f"ambiguous source; matches {', '.join(matches[:8])}")
    raise ValueError(f"unknown source {raw}; available sources: {', '.join(sources[:20])}")


def _supports_color_temp(state):
    modes = set(((state or {}).get("attributes") or {}).get("supported_color_modes") or [])
    return "color_temp" in modes


def _supports_rgb(state):
    modes = set(((state or {}).get("attributes") or {}).get("supported_color_modes") or [])
    return bool(modes.intersection({"rgb", "rgbw", "rgbww", "hs", "xy"}))


def _service_for(affordance, entity_id, context, state=None):
    action = _slug(affordance)
    domain = entity_id.split(".", 1)[0]
    data = {"entity_id": entity_id}
    service_domain = domain
    service = None
    if action in {"turn-on", "on", "activate"}:
        service_domain, service = ("homeassistant", "turn_on")
    elif action in {"turn-off", "off", "deactivate"}:
        service_domain, service = ("homeassistant", "turn_off")
    elif action == "toggle":
        service_domain, service = ("homeassistant", "toggle")
    elif action in {"run-scene", "set-scene"}:
        service_domain, service = ("scene", "turn_on")
    elif action in {"dim-light", "ambient-light", "set-brightness", "set-brightness-percent", "brightness-percent", "brightness-pct", "set-brightness-raw", "raw-brightness", "brightness-raw"}:
        if domain != "light":
            raise ValueError(f"{action} requires a light target")
        if state is not None and state.get("state") == "off" and not _allows_brightness_turn_on(context):
            raise ValueError(f"{entity_id} is off; brightness changes would turn it on. Include turn on in context when that is intended")
        service_domain, service = ("light", "turn_on")
        default = 35 if action == "dim-light" else 70
        data.update(_brightness_data(action, context, default_percent=default))
    elif action in {"set-color-temperature", "set-colour-temperature", "color-temperature", "colour-temperature", "warm-light", "cool-light"}:
        if domain != "light":
            raise ValueError(f"{action} requires a light target")
        if state is not None and not _supports_color_temp(state):
            raise ValueError(f"{entity_id} does not support color temperature")
        service_domain, service = ("light", "turn_on")
        default = 2700 if action == "warm-light" else 6500 if action == "cool-light" else None
        data["color_temp_kelvin"] = _parse_kelvin(context, default=default, state=state)
    elif action in {"set-color", "set-colour", "color-light", "colour-light"}:
        if domain != "light":
            raise ValueError(f"{action} requires a light target")
        if state is not None and not _supports_rgb(state):
            raise ValueError(f"{entity_id} does not support color")
        service_domain, service = ("light", "turn_on")
        data["rgb_color"] = _parse_rgb(context)
    elif action in {"select-source", "set-source", "source", "input", "select-input", "set-input"}:
        if domain != "media_player":
            raise ValueError(f"{action} requires a media player target")
        service_domain, service = ("media_player", "select_source")
        data["source"] = _parse_source(context, state)
    elif action == "open":
        service_domain, service = ("cover", "open_cover")
    elif action == "close":
        service_domain, service = ("cover", "close_cover")
    elif action == "stop":
        service_domain, service = ("cover", "stop_cover")
    elif action == "lock":
        service_domain, service = ("lock", "lock")
    elif action == "unlock":
        service_domain, service = ("lock", "unlock")
    else:
        raise ValueError(f"unknown house affordance {affordance}")
    return service_domain, service, data


def _normalize_area_action(affordance):
    action = _slug(affordance)
    aliases = {
        "room-on": "turn-on",
        "room-turn-on": "turn-on",
        "area-on": "turn-on",
        "area-turn-on": "turn-on",
        "room-off": "turn-off",
        "room-turn-off": "turn-off",
        "area-off": "turn-off",
        "area-turn-off": "turn-off",
        "room-toggle": "toggle",
        "area-toggle": "toggle",
        "room-dim": "dim-light",
        "area-dim": "dim-light",
        "room-ambient": "ambient-light",
        "area-ambient": "ambient-light",
        "room-set-brightness": "set-brightness",
        "area-set-brightness": "set-brightness",
        "room-set-brightness-percent": "set-brightness-percent",
        "area-set-brightness-percent": "set-brightness-percent",
        "room-set-brightness-raw": "set-brightness-raw",
        "area-set-brightness-raw": "set-brightness-raw",
        "room-set-color-temperature": "set-color-temperature",
        "room-set-colour-temperature": "set-color-temperature",
        "area-set-color-temperature": "set-color-temperature",
        "area-set-colour-temperature": "set-color-temperature",
        "room-warm": "warm-light",
        "area-warm": "warm-light",
        "room-cool": "cool-light",
        "area-cool": "cool-light",
        "room-set-color": "set-color",
        "room-set-colour": "set-color",
        "area-set-color": "set-color",
        "area-set-colour": "set-color",
    }
    if action not in aliases:
        raise ValueError(
            f"{affordance} targets a whole area; use explicit room affordances like "
            "room-turn-on, room-turn-off, room-dim, room-warm, or room-set-color"
        )
    return aliases[action]


def _service_for_area(affordance, entity_ids, context):
    action = _normalize_area_action(affordance)
    state_by_id = {state.get("entity_id"): state for state in _states()}
    domains = {entity_id.split(".", 1)[0] for entity_id in entity_ids if "." in entity_id}
    lights = [entity_id for entity_id in entity_ids if entity_id.startswith("light.")]
    if action in {"turn-on", "on", "activate"}:
        service_domain, service = ("light", "turn_on")
        data = {"entity_id": lights}
    elif action in {"turn-off", "off", "deactivate"}:
        service_domain, service = ("light", "turn_off")
        data = {"entity_id": lights}
    elif action == "toggle":
        service_domain, service = ("light", "toggle")
        data = {"entity_id": lights}
    elif action in {"dim-light", "ambient-light", "set-brightness", "set-brightness-percent", "brightness-percent", "brightness-pct", "set-brightness-raw", "raw-brightness", "brightness-raw"}:
        service_domain, service = ("light", "turn_on")
        default = 35 if action == "dim-light" else 70
        data = {
            "entity_id": lights,
            **_brightness_data(action, context, default_percent=default),
        }
    elif action in {"set-color-temperature", "set-colour-temperature", "color-temperature", "colour-temperature", "warm-light", "cool-light"}:
        service_domain, service = ("light", "turn_on")
        capable = [entity_id for entity_id in lights if _supports_color_temp(state_by_id.get(entity_id))]
        default = 2700 if action == "warm-light" else 6500 if action == "cool-light" else None
        data = {
            "entity_id": capable,
            "color_temp_kelvin": _parse_kelvin(context, default=default),
        }
    elif action in {"set-color", "set-colour", "color-light", "colour-light"}:
        service_domain, service = ("light", "turn_on")
        data = {
            "entity_id": [entity_id for entity_id in lights if _supports_rgb(state_by_id.get(entity_id))],
            "rgb_color": _parse_rgb(context),
        }
    else:
        raise ValueError(f"{affordance} cannot be applied to a whole area")
    if not data["entity_id"]:
        raise ValueError(f"no {sorted(domains)} entities in area support {affordance}")
    return service_domain, service, data


def _fresh_states_for(entity_ids, attempts=3, delay=1.0):
    entity_ids = list(entity_ids)
    fresh = {}
    for attempt in range(attempts):
        if attempt:
            time.sleep(delay)
        fresh_states = {state.get("entity_id"): state for state in _states()}
        fresh = {entity_id: fresh_states[entity_id] for entity_id in entity_ids if entity_id in fresh_states}
        if len(fresh) == len(entity_ids):
            return fresh
    return fresh


def use_house_affordance(affordance, target, context=""):
    try:
        states = _states()
        area_entity_ids = _area_entities(target)
        if area_entity_ids:
            state_by_id = {state.get("entity_id"): state for state in states}
            service_domain, service, data = _service_for_area(affordance, area_entity_ids, context)
            acted_entities = data["entity_id"]
            before = [state_by_id[entity_id] for entity_id in acted_entities if entity_id in state_by_id]
            result = _request("POST", f"/api/services/{service_domain}/{service}", payload=data)
            time.sleep(1.5)
            fresh_states = _fresh_states_for(acted_entities)
            after = [fresh_states[entity_id] for entity_id in acted_entities if entity_id in fresh_states]
            record = {
                "kind": "house_area_affordance",
                "affordance": str(affordance),
                "target": str(target),
                "entities": acted_entities,
                "context": str(context or ""),
                "before": [_brief_state(state) for state in before],
                "after": [_brief_state(state) for state in after],
                "service": f"{service_domain}.{service}",
                "result_count": len(result) if isinstance(result, list) else None,
            }
            record = _append_log(record)
            return "HOUSE-AFFORDANCE-USED " + json.dumps(_action_summary(record), ensure_ascii=False)
        entity_id, before = _resolve_entity(target, states=states)
        service_domain, service, data = _service_for(affordance, entity_id, context, before)
        result = _request("POST", f"/api/services/{service_domain}/{service}", payload=data)
        after = None
        try:
            after = _request("GET", f"/api/states/{urllib.parse.quote(entity_id, safe='.')}")
        except Exception:
            after = None
        record = {
            "kind": "house_affordance",
            "affordance": str(affordance),
            "target": entity_id,
            "context": str(context or ""),
            "before": _brief_state(before),
            "after": _brief_state(after) if isinstance(after, dict) else None,
            "service": f"{service_domain}.{service}",
            "result_count": len(result) if isinstance(result, list) else None,
        }
        record = _append_log(record)
        return "HOUSE-AFFORDANCE-USED " + json.dumps(_action_summary(record), ensure_ascii=False)
    except Exception as exc:
        record = _append_log({
            "kind": "house_affordance_failed",
            "affordance": str(affordance),
            "target": str(target),
            "context": str(context or ""),
            "error": str(exc),
        })
        return f"HOUSE-AFFORDANCE-FAILED trace_id={record.get('trace_id')} {exc}"


def record_house_outcome(action, outcome, note=""):
    try:
        record = {
            "kind": "house_outcome",
            "action": str(action),
            "outcome": str(outcome),
            "note": str(note or ""),
        }
        record = _append_log(record)
        return "HOUSE-OUTCOME-RECORDED " + json.dumps({
            "trace_id": record.get("trace_id"),
            "action": record.get("action"),
            "outcome": record.get("outcome"),
        }, ensure_ascii=False)
    except Exception as exc:
        return f"HOUSE-OUTCOME-FAILED {exc}"


def house_action_log(limit=20):
    try:
        limit = max(1, min(int(limit), 100))
    except Exception:
        limit = 20
    if not ACTION_LOG.exists():
        return "HOUSE-ACTION-LOG none"
    lines = ACTION_LOG.read_text(encoding="utf-8", errors="replace").splitlines()[-limit:]
    return "HOUSE-ACTION-LOG " + " | ".join(lines)
