"""Purpose: pass trusted facts about a spending limit to the limit law (hive/spaces/lib_limits.metta) and return its
verdict on who may set or remove it."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from ..spaces import sexpr
from ..spaces.service import SpaceError


@dataclass(frozen=True)
class Target:
    """The mind or swarm a cap is on, as the host found it for the asker: ``seen`` when it exists and the asker may see
    it (Viewer.sees), with the person it records as its owner and the person it is the personal mind or swarm of."""
    seen: bool = False
    owner: str | None = None
    personal_of: str | None = None


@dataclass(frozen=True)
class Asker:
    """Kind "person", a signed-in person by principal and whether they are a hive admin, or kind "hive", the hive itself
    reading its own limits with nobody signed in."""
    kind: str
    id: str | None = None
    admin: bool = False


NO_TARGET = Target()      # every limit that is not a cap on a mind or a swarm
HIVE = Asker("hive")
Verdict = tuple[Literal["Granted"]] | tuple[Literal["Refused"], str]


def _identity(value: str | None) -> sexpr.Str:
    # Hex keeps identities equal exactly when they are and every character inert in PeTTa's string reader.
    return sexpr.Str(value.encode("utf-8", errors="surrogatepass").hex() if value else "")


def _word(value: str) -> sexpr.Str:
    # A word outside the atom grammar travels as an empty word, which the law refuses.
    return sexpr.Str(value if sexpr.SYMBOL.fullmatch(value) else "")


class LimitPolicy:
    """The limit law's verdicts. The law is loaded once when the hive's PeTTa starts and answers by its facts alone, so
    each distinct question is asked once: a listing that flags many minds costs one PeTTa call per owner it shows, not
    one per row. The questions are bounded by the hive's people times the owners they see."""

    def __init__(self, run: Callable[[str], list[str]]):
        self._run = run
        self._verdicts: dict[tuple[str, Target, Asker], Verdict] = {}

    def may(self, limit: str, target: Target, asker: Asker) -> Verdict:
        """Whether ``asker`` may set or remove a limit of kind ``limit`` (a scope's kind: agent, swarm, hive,
        every-mind, person or key) on ``target``, NO_TARGET for every kind but agent and swarm."""
        key = (limit, target, asker)
        if key not in self._verdicts:
            self._verdicts[key] = self._ask(limit, target, asker)
        return self._verdicts[key]

    def _ask(self, limit: str, target: Target, asker: Asker) -> Verdict:
        query = sexpr.render([
            "limit-decide",
            _word(limit),
            ["Target", target.seen is True, _identity(target.owner), _identity(target.personal_of)],
            ["By", _word(asker.kind), _identity(asker.id), asker.admin is True],
        ])
        results = self._run("!" + query)
        error = "the limit law must return exactly one (Granted) or (Refused reason)"
        if len(results) != 1:
            raise SpaceError(error)
        try:
            verdict = sexpr.parse(results[0])
        except sexpr.SexprError as exc:
            raise SpaceError(error) from exc
        if isinstance(verdict, list) and all(type(atom) is str for atom in verdict):
            if verdict == ["Granted"]:
                return ("Granted",)
            if len(verdict) == 2 and verdict[0] == "Refused":
                return ("Refused", verdict[1])
        raise SpaceError(error)
