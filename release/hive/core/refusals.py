# Purpose: one table of the refusals of a model call that a person must hear, each with what the person can do about it
# and the one sentence that says so, and the one way such a refusal is built.
"""Refusals a person hears, in one table.

Each row is a refusal code with its remedy, what the person can do about it, and one plain sentence for the person, in
the words they read wherever the refusal reaches them. A route raises these only through refused(), and every place
that passes a refusal on to a person tests spoken(), never a list of codes:

- the Ask (conductor.py) ends the turn with the sentence as its answer and puts the code and the remedy in done, so the
  page offers what helps and never words the refusal a second time;
- a browser turn's call through the mind gateway (mind_gateway.py) answers with the code and the sentence;
- a mind's own call (app.py's /llm/v1/chat/completions) is answered with it too, and the hive keeps it on the mind
  (Hive.note_model_refusal) until a call is answered: the mind's chat shows it, Health counts it, and the mind's next
  calls are refused here, with nothing sent, until its wait has passed or something it depends on changed.

Every refusal a provider answers is one of the provider_ rows (PROVIDER maps its status category), so no provider
refusal leaves a mind silent.

The remedies:

- wait: it passes by itself; retry_after, when the route knows it, is how many seconds until trying again can help;
- credit: the account that pays has run out: add credit to it, or use another key or model;
- key: the key was refused, or the route is for people with keys of their own: use another key;
- model: this model can't be used here: choose another model, or another way for the mind to think.

A sentence names no key, account or person, so it can go to anyone who reads the mind. Its slots ({limit}, {model},
{offered}, {provider}, {when}) are filled by the route that raises it, or by the row's defaults where the route leaves one
out: format() reads braces only in the sentence, never in what fills it.
"""
from __future__ import annotations

import dataclasses

WAIT, CREDIT, KEY, MODEL = "wait", "credit", "key", "model"
REMEDIES = (WAIT, CREDIT, KEY, MODEL)


@dataclasses.dataclass(frozen=True)
class Kind:
    remedy: str
    say: str
    # True when the refusal is a provider's answer, so asking again costs a call to it (and on a free model one of the
    # day's calls): a mind's calls then wait before asking again (Hive.model_refusal_holds). The hive's own refusals
    # (a day's free calls used up, a held $0 model) are answered at once, with nothing sent, however often it asks.
    upstream: bool = False
    # what the mind's panel says instead, when the sentence speaks to one person about their own standing ("You've used
    # today's free calls"): a refusal kept on a mind is read by everyone who can see it (Hive.note_model_refusal), while
    # the sentence itself still answers that person's own Ask or browser turn
    mind_say: str = ""
    # (slot, words) for a slot the route that raises the refusal may leave out: the free route's busy refusal names its
    # wait only when the endpoint asked for one, so a raise without it reads "in a moment"
    defaults: tuple = ()


KINDS = {
    # free inference (free_inference.py): the deploy's key, each person's calls a day and the hive's
    "free_inference_busy": Kind(WAIT, "Free inference is busy right now: more calls came in at once than its key takes. "
                                      "Try again {when}, or add a key of your own.", upstream=True,
                                defaults=(("when", "in a moment"),)),
    "free_inference_daily_cap": Kind(WAIT, "You've used today's {limit} free model calls, your minds' replies in rooms "
                                           "and their goals included. They come back at midnight UTC, or add a key of "
                                           "your own.",
                                     mind_say="This mind's person has used today's {limit} free model calls, its replies "
                                              "in rooms and its goals included. They come back at midnight UTC, or its "
                                              "person can add a key of their own."),
    "free_inference_hive_daily_cap": Kind(WAIT, "This hive has used all {limit} of its free model calls for today. They "
                                                "come back at midnight UTC, or add a key of your own."),
    "free_inference_off": Kind(MODEL, "Free inference isn't offered on this hive now. Choose another way for your mind "
                                      "to think."),
    "free_model_not_offered": Kind(MODEL, "This hive's free inference doesn't offer {model}.{offered}"),
    "free_inference_invited_only": Kind(KEY, "Free inference on this hive is for the people it invited. Add a key of your "
                                             "own for your mind to think.",
                                        mind_say="Free inference on this hive is for the people it invited, and this "
                                                 "mind's person isn't one of them. They can add a key of their own for it "
                                                 "to think."),
    "free_inference_person_only": Kind(MODEL, "Free inference is for a person's own use, and this call is for no one in "
                                              "particular."),
    # the endpoint refused the deploy's own key or account: nobody in the hive but its deploy can fix that
    "free_inference_key_refused": Kind(KEY, "Free inference can't answer on this hive right now: its provider refused the "
                                            "hive's key. Add a key of your own, or choose another way for your mind to "
                                            "think.", upstream=True),
    # a model provider's own refusal (gateway.upstream_refusal), one row per category of its status (PROVIDER below)
    "provider_no_credit": Kind(CREDIT, "{provider} says the account that pays for this mind has no credit left. Add "
                                       "credit there, or choose a free model or another key for this mind.", upstream=True),
    "provider_key_refused": Kind(KEY, "{provider} refused the key that pays for this mind: it may be wrong, disabled or "
                                      "at its own limit there. Check the key, or use another one.", upstream=True),
    "provider_busy": Kind(WAIT, "{provider} is taking no more calls to {model} for now, so this mind tries again {when}. "
                                "Choose another model to go on sooner.", upstream=True),
    "provider_unavailable": Kind(WAIT, "{provider} couldn't answer just now, so this mind tries again {when}.",
                                 upstream=True),
    "provider_request_refused": Kind(MODEL, "{provider} wouldn't take this mind's request for {model}. Choose another "
                                            "model for this mind.", upstream=True),
    # a model priced at $0 whose earlier call has an unknown outcome (Gateway.free_reserve)
    "free_model_unreconciled": Kind(MODEL, "{model} is paused because an earlier call to it ended without a clear answer, "
                                           "so the hive won't call it again until that call settles by itself, {when}. "
                                           "Choose another model to go on now.",
                                    defaults=(("when", "within the hour"),)),
}

#: the longest wait a refusal names or holds a mind's calls for: a provider asking for more (a Retry-After of years) is
#: read as this (gateway.asked_wait), and a mind's back-off without one doubles up to it (Hive.note_model_refusal)
LONGEST_WAIT_S = 1800

#: a provider's status category (redact.provider_category, the hive's one table of them) to its row; every other
#: category (not_found, too_large, bad_request, provider_error) is a request this model won't take
PROVIDER = {"auth": "provider_key_refused", "billing": "provider_no_credit", "rate_limited": "provider_busy",
            "unavailable": "provider_unavailable", "timeout": "provider_unavailable"}


def provider_code(category, retry_after=None, free=False):
    """The row for a provider's refusal of `category`. An answer that says how long to wait is the provider asking for a
    wait, whatever its status (OpenRouter sends Retry-After on a 402 whose in-flight budget is settling), so it is busy.
    On the free route (free=True) the key and the account are the deploy's, so refusing either is the route's own row.
    Example: ("billing", None) -> provider_no_credit; ("billing", 12.0) -> provider_busy; ("bad_request", None) ->
    provider_request_refused; ("auth", None, free=True) -> free_inference_key_refused."""
    if retry_after is not None:
        return "provider_busy"
    if free and category in ("auth", "billing"):
        return "free_inference_key_refused"
    return PROVIDER.get(category, "provider_request_refused")


def when(seconds):
    """When a mind tries again, as words: None -> "shortly"; 20 -> "in 20 seconds"; 150 -> "in about 3 minutes";
    5400 -> "in about 2 hours"."""
    if seconds is None:
        return "shortly"
    seconds = max(1, round(seconds))
    if seconds < 60:
        return f"in {seconds} second{'s' if seconds != 1 else ''}"
    minutes = round(seconds / 60)
    if minutes < 60:
        return "in about a minute" if minutes == 1 else f"in about {minutes} minutes"
    hours = round(minutes / 60)
    return "in about an hour" if hours == 1 else f"in about {hours} hours"


def refused(code, status, retry_after=None, **slots):
    """The GatewayError for refusal `code`: HTTP `status`, the row's sentence with its slots filled as the message, and
    the row's remedy, `retry_after` (seconds, or None when no wait is known to help) and the words a mind's panel shows
    (`mind_say`: the row's own for a sentence that speaks to one person, else the message) on it.
    Example: refused("free_inference_daily_cap", 429, retry_after=3600, limit=200) says "You've used today's 200 free
    model calls, ..." with remedy wait."""
    from .gateway import GatewayError   # gateway raises through this module too, so it is imported when a refusal is made
    kind = KINDS[code]
    fill = {**dict(kind.defaults), **slots}
    error = GatewayError(status, code, kind.say.format(**fill))
    error.remedy, error.retry_after = kind.remedy, retry_after
    error.mind_say = kind.mind_say.format(**fill) if kind.mind_say else error.message
    return error


def upstream(code):
    """Whether refusal `code` was a provider's answer (Kind.upstream), so asking again costs a call to it."""
    kind = KINDS.get(code)
    return bool(kind and kind.upstream)


def again(kept, retry_after):
    """The refusal a mind's call met, raised again for its next call without asking the provider: `kept` is the hive's
    record of it (Hive.note_model_refusal: code, say, remedy), retry_after the seconds left of its wait. It answers 429
    with Retry-After whatever the provider's status was: the hive is holding the mind's calls for a while (RFC 6585
    section 4), so a caller waits and tries again rather than reading a 500 or a 402 as final."""
    from .gateway import GatewayError
    error = GatewayError(429, kept["code"], kept["say"])
    error.remedy, error.retry_after = kept["remedy"], max(1.0, retry_after)
    return error


def spoken(error):
    """Whether `error` is a refusal from this table, so its message is written for the person and passes on unchanged."""
    return getattr(error, "remedy", None) in REMEDIES
