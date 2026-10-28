import json
import os
import pathlib
from datetime import datetime, timezone


ROOT = pathlib.Path(__file__).resolve().parents[1]
MEMORY = pathlib.Path(os.environ.get("OMEGACLAW_MEMORY_DIR", ROOT / "memory"))
LEDGER = MEMORY / "cost_ledger.jsonl"
BUDGET = MEMORY / "energy_budget.json"


def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _money(value):
    try:
        return round(float(value), 8)
    except Exception:
        return 0.0


def _usage_dict(usage):
    if usage is None:
        return {}
    if hasattr(usage, "model_dump"):
        return usage.model_dump()
    if isinstance(usage, dict):
        return dict(usage)
    return {}


def _nested_get(data, *path):
    cur = data
    for part in path:
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def log_provider_call(provider, model, kind, usage, prompt_chars=0, completion_chars=0):
    data = _usage_dict(usage)
    prompt_tokens = data.get("prompt_tokens")
    completion_tokens = data.get("completion_tokens")
    total_tokens = data.get("total_tokens")
    cost = data.get("cost")
    confidence = "provider-usage"

    if cost is None:
        cost = _nested_get(data, "cost_details", "upstream_inference_cost")
    if cost is None:
        # Very rough fallback: useful for visibility, not accounting.
        est_tokens = total_tokens or int((int(prompt_chars or 0) + int(completion_chars or 0)) / 4)
        total_tokens = total_tokens or est_tokens
        cost = 0.0
        confidence = "usage-no-cost"

    event = {
        "time": _iso(_now()),
        "provider": str(provider),
        "model": str(model),
        "kind": str(kind),
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "cost_usd": _money(cost),
        "confidence": confidence,
    }
    MEMORY.mkdir(parents=True, exist_ok=True)
    with LEDGER.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
    return event


def _iter_events():
    if not LEDGER.exists():
        return
    with LEDGER.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except Exception:
                continue


def _parse_time(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def set_energy_budget(amount, currency="USD", period="monthly"):
    period = str(period).lower()
    amount = _money(amount)
    if period == "daily":
        budget = {"daily_target": amount, "weekly_target": amount * 7.0, "monthly_target": amount * 30.0}
    elif period == "weekly":
        budget = {"daily_target": amount / 7.0, "weekly_target": amount, "monthly_target": amount * 30.0 / 7.0}
    else:
        budget = {"daily_target": amount / 30.0, "weekly_target": amount * 7.0 / 30.0, "monthly_target": amount}
    budget.update({
        "amount": amount,
        "currency": str(currency).upper(),
        "period": period,
        "updated": _iso(_now()),
    })
    MEMORY.mkdir(parents=True, exist_ok=True)
    BUDGET.write_text(json.dumps(budget, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    return f"ENERGY-BUDGET-SET {budget['amount']} {budget['currency']} {budget['period']}"


def set_energy_targets(daily, weekly, monthly, currency="USD"):
    targets = {
        "daily_target": _money(daily),
        "weekly_target": _money(weekly),
        "monthly_target": _money(monthly),
        "currency": str(currency).upper(),
        "period": "targets",
        "updated": _iso(_now()),
    }
    targets["amount"] = targets["monthly_target"]
    MEMORY.mkdir(parents=True, exist_ok=True)
    BUDGET.write_text(json.dumps(targets, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    return (
        f"ENERGY-TARGETS-SET currency={targets['currency']} "
        f"daily={targets['daily_target']:.6f} "
        f"weekly={targets['weekly_target']:.6f} "
        f"monthly={targets['monthly_target']:.6f}"
    )


def energy_status():
    now = _now()
    month_prefix = now.strftime("%Y-%m")
    day_prefix = now.strftime("%Y-%m-%d")
    week_prefix = f"{now.isocalendar().year}-W{now.isocalendar().week:02d}"
    spent_month = 0.0
    spent_week = 0.0
    spent_today = 0.0
    last = None
    calls_today = 0

    for event in _iter_events() or ():
        ts = str(event.get("time") or "")
        cost = _money(event.get("cost_usd"))
        if ts.startswith(month_prefix):
            spent_month += cost
        parsed = _parse_time(ts)
        if parsed and f"{parsed.isocalendar().year}-W{parsed.isocalendar().week:02d}" == week_prefix:
            spent_week += cost
        if ts.startswith(day_prefix):
            spent_today += cost
            calls_today += 1
        last = event

    budget = _read_json(BUDGET, {"currency": "USD", "period": "unset"})
    daily_target = _money(budget.get("daily_target"))
    weekly_target = _money(budget.get("weekly_target"))
    monthly_budget = _money(budget.get("monthly_target", budget.get("amount", 0.0)))
    day = max(1, now.day)
    if not daily_target and monthly_budget:
        daily_target = monthly_budget / 30.0
    if not weekly_target and monthly_budget:
        weekly_target = monthly_budget * 7.0 / 30.0
    month_target_to_date = daily_target * day
    pace_delta = month_target_to_date - spent_month if monthly_budget else 0.0
    day_delta = daily_target - spent_today if daily_target else 0.0
    week_delta = weekly_target - spent_week if weekly_target else 0.0
    runway_days = ((monthly_budget - spent_month) / max(spent_today, 1e-9)) if monthly_budget and spent_today else None

    last_cost = _money(last.get("cost_usd")) if last else 0.0
    last_model = last.get("model") if last else "none"
    runway = "unknown" if runway_days is None else f"{runway_days:.1f}"
    return (
        f"ENERGY-STATUS currency={budget.get('currency', 'USD')} "
        f"daily_target={daily_target:.6f} weekly_target={weekly_target:.6f} monthly_target={monthly_budget:.6f} "
        f"spent_today={spent_today:.6f} spent_week={spent_week:.6f} spent_month={spent_month:.6f} "
        f"day_delta={day_delta:.6f} week_delta={week_delta:.6f} pace_delta={pace_delta:.6f} "
        f"calls_today={calls_today} "
        f"last_call={last_cost:.8f} last_model={last_model} runway_days={runway}"
    )


def cost_last_call():
    last = None
    for event in _iter_events() or ():
        last = event
    if not last:
        return "NO-COST-CALLS"
    return json.dumps(last, ensure_ascii=False, sort_keys=True)
