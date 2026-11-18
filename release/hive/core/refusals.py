# Purpose: one table of the refusals of a model call that a person must hear, each with what the person can do about it
# and the one sentence that says so, and the one way such a refusal is built.
"""Refusals a person hears, in one table.

Each row is a refusal code with its remedy, what the person can do about it, and one plain sentence for the person, in
the words they read wherever the refusal reaches them. A route raises these only through refused(), and every place
that passes a refusal on to a person tests spoken(), never a list of codes:

- the Ask (conductor.py) ends the turn with the sentence as its answer and puts the code and the remedy in done, so the
  page offers what helps and never words the refusal a second time;
- a browser turn's call through the mind gateway (mind_gateway.py) answers with the code and the sentence.

The remedies:

- wait: it passes by itself; retry_after, when the route knows it, is how many seconds until trying again can help;
- credit: the account that pays has run out: add credit to it, or use another key or model;
- key: the key was refused, or the route is for people with keys of their own: use another key;
- model: this model can't be used here: choose another model, or another way for the mind to think.

A sentence names no key, account or person, so it can go to anyone who reads the mind. Its slots ({limit}, {model},
{offered}) are filled by the route that raises it: format() reads braces only in the sentence, never in what fills it.
"""
from __future__ import annotations

import dataclasses

WAIT, CREDIT, KEY, MODEL = "wait", "credit", "key", "model"
REMEDIES = (WAIT, CREDIT, KEY, MODEL)


@dataclasses.dataclass(frozen=True)
class Kind:
    remedy: str
    say: str


KINDS = {
    # free inference (free_inference.py): the deploy's key, each person's calls a day and the hive's
    "free_inference_busy": Kind(WAIT, "Free inference is busy right now: more calls came in at once than its key takes. "
                                      "Try again in a moment, or add a key of your own."),
    "free_inference_daily_cap": Kind(WAIT, "You've used today's {limit} free model calls, your minds' replies in rooms "
                                           "and their goals included. They come back at midnight UTC, or add a key of "
                                           "your own."),
    "free_inference_hive_daily_cap": Kind(WAIT, "This hive has used all {limit} of its free model calls for today. They "
                                                "come back at midnight UTC, or add a key of your own."),
    "free_inference_off": Kind(MODEL, "Free inference isn't offered on this hive now. Choose another way for your mind "
                                      "to think."),
    "free_model_not_offered": Kind(MODEL, "This hive's free inference doesn't offer {model}.{offered}"),
    "free_inference_invited_only": Kind(KEY, "Free inference on this hive is for the people it invited. Add a key of your "
                                             "own for your mind to think."),
    "free_inference_person_only": Kind(MODEL, "Free inference is for a person's own use, and this call is for no one in "
                                              "particular."),
}


def refused(code, status, retry_after=None, **slots):
    """The GatewayError for refusal `code`: HTTP `status`, the row's sentence with its slots filled as the message, and
    the row's remedy and `retry_after` (seconds, or None when no wait is known to help) on it.
    Example: refused("free_inference_daily_cap", 429, retry_after=3600, limit=200) says "You've used today's 200 free
    model calls, ..." with remedy wait."""
    from .gateway import GatewayError   # gateway raises through this module too, so it is imported when a refusal is made
    kind = KINDS[code]
    error = GatewayError(status, code, kind.say.format(**slots))
    error.remedy, error.retry_after = kind.remedy, retry_after
    return error


def spoken(error):
    """Whether `error` is a refusal from this table, so its message is written for the person and passes on unchanged."""
    return getattr(error, "remedy", None) in REMEDIES
