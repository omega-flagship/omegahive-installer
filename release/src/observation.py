"""General observation membrane for situated OmegaClaw bodies.

This module intentionally stays thin: it maps the agent's chosen observation target
onto the appropriate sense/app organ. It does not decide what the agent should care
about, mark conversations handled, or take actions.
"""

from __future__ import annotations

import re


def _norm(value):
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def _drop_prefix(text, *prefixes):
    raw = str(text or "").strip()
    lowered = raw.lower()
    for prefix in prefixes:
        prefix = prefix.lower().strip()
        if lowered == prefix:
            return ""
        if lowered.startswith(prefix + " "):
            return raw[len(prefix):].strip()
    return raw


def _unknown(target):
    return (
        "OBSERVE-UNKNOWN-TARGET "
        f"target={target!r} "
        "try: observe gameboy | observe house | observe house full | "
        "observe room Kitchen | observe device light.kitchen | observe glucose Patient | "
        "observe whatsapp | observe webcam | observe image IMAGE_ID | observe audio AUDIO_ID"
    )


def observe(target):
    """Route a general observation request to the relevant sense/app organ."""
    raw = str(target or "").strip().strip('"')
    normalized = _norm(raw)
    if not normalized:
        return _unknown(raw)

    if normalized in {"gameboy", "game boy", "gb", "pokemon", "pokemon yellow", "emulator", "game"}:
        import gameboy
        return gameboy.gb_observe()

    if normalized in {"house", "home", "home assistant", "ha"}:
        import home
        return home.observe_house()

    if normalized in {"house full", "full house", "home full", "full home", "devices", "all devices"}:
        import home
        return home.observe_house_full()

    if normalized in {"house affordances", "home affordances", "affordances", "house skills", "home skills"}:
        import home
        return home.observe_house_affordances()

    if normalized.startswith("room ") or normalized.startswith("area "):
        import home
        room = _drop_prefix(raw, "room", "area")
        return home.observe_room(room)

    if normalized.startswith("device ") or normalized.startswith("entity "):
        import home
        device = _drop_prefix(raw, "device", "entity")
        return home.observe_device(device)


    if normalized.startswith("glucose ") or normalized.startswith("blood sugar ") or normalized.startswith("libre "):
        import glucose
        person = _drop_prefix(raw, "glucose", "blood sugar", "libre")
        if not person:
            return _unknown(raw)
        return glucose.observe_glucose(person)

    if normalized in {"glucose", "blood sugar", "libre", "diabetes"}:
        return _unknown(raw)

    if normalized in {"whatsapp", "wa", "inbox", "messages", "chats"}:
        import whatsapp
        return whatsapp.inbox()

    if normalized in {"webcam", "camera", "sight", "vision", "room camera"}:
        import webcam
        return webcam.inspect_webcam("What is visible right now? Describe only what the camera can actually see.")

    if normalized.startswith("image "):
        import vision
        image_id = _drop_prefix(raw, "image")
        return vision.observe_image(image_id)

    if normalized.startswith("audio ") or normalized.startswith("sound "):
        import audio
        audio_id = _drop_prefix(raw, "audio", "sound")
        return audio.observe_audio(audio_id)

    return _unknown(raw)
