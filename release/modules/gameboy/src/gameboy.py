"""PyBoy membrane for OmegaClaw's Game Boy simulation organ."""

from __future__ import annotations

import atexit
import hashlib
import json
import os
import pathlib
import re
import site
import sys
import time


CORE_ROOT = pathlib.Path(__file__).resolve().parents[3]
STATE_DIR = CORE_ROOT / "memory" / "runtime" / "gameboy"
ROM_DIR = pathlib.Path(os.environ.get("OMEGACLAW_GAMEBOY_ROM_DIR", STATE_DIR / "roms"))
SCREENSHOT_DIR = STATE_DIR / "screens"
SAVE_DIR = STATE_DIR / "states"
TRACE_FILE = STATE_DIR / "trace.jsonl"
DEFAULT_GAME = "pokemon-yellow"
DEFAULT_FRAMES = 30
MAX_FRAMES = 600
ALLOWED_BUTTONS = {"a", "b", "start", "select", "up", "down", "left", "right"}

for _site_path in (site.getusersitepackages(),):
    if _site_path and _site_path not in sys.path:
        sys.path.insert(0, _site_path)

_pyboy = None
_loaded_game = None
_loaded_rom = None


def _ensure_dirs() -> None:
    for path in (STATE_DIR, ROM_DIR, SCREENSHOT_DIR, SAVE_DIR):
        pathlib.Path(path).mkdir(parents=True, exist_ok=True)


def _append_trace(event: str, **data) -> None:
    _ensure_dirs()
    record = {"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event, **data}
    with TRACE_FILE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


def _trace_tail() -> str:
    try:
        lines = TRACE_FILE.read_text(encoding="utf-8").splitlines()[-8:]
    except FileNotFoundError:
        return "GAMEBOY-TRACE empty"
    return "\n".join(lines) if lines else "GAMEBOY-TRACE empty"


def _pyboy_import():
    try:
        from pyboy import PyBoy
        import pyboy as pyboy_module
        return PyBoy, pyboy_module, None
    except Exception as exc:
        return None, None, f"{type(exc).__name__}: {exc}"


def _demo_rom() -> pathlib.Path | None:
    _, pyboy_module, error = _pyboy_import()
    if error:
        return None
    candidate = pathlib.Path(pyboy_module.__file__).resolve().parent / "default_rom.gb"
    return candidate if candidate.exists() else None


def _rom_candidates(game: str) -> list[pathlib.Path]:
    safe = _safe_name(game)
    names = [safe, safe.replace("_", "-"), safe.replace("-", "_")]
    paths = []
    for name in names:
        for suffix in (".gb", ".gbc"):
            paths.append(ROM_DIR / f"{name}{suffix}")
    return paths


def _resolve_rom(game: str) -> tuple[pathlib.Path | None, str | None]:
    game = str(game or DEFAULT_GAME).strip() or DEFAULT_GAME
    if game == "demo":
        rom = _demo_rom()
        if rom:
            return rom, None
        return None, "PyBoy demo ROM not found"
    for path in _rom_candidates(game):
        if path.exists():
            return path, None
    wanted = _rom_candidates(game)[0]
    return None, f"ROM missing; place your private dump at {wanted}"


def _safe_name(name: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(name or "").strip().lower()).strip("-._")
    return safe or DEFAULT_GAME


def _require_loaded():
    if _pyboy is None:
        raise RuntimeError("no game loaded; use gb-load demo or gb-load pokemon-yellow")
    return _pyboy


def gb_status():
    PyBoy, _, error = _pyboy_import()
    _ensure_dirs()
    rom, rom_error = _resolve_rom(DEFAULT_GAME)
    pyboy_state = "available" if PyBoy else f"missing {error}"
    loaded = _loaded_game or "none"
    rom_state = str(rom) if rom else rom_error
    return f"GAMEBOY-STATUS pyboy={pyboy_state} loaded={loaded} rom_dir={ROM_DIR} default_rom={rom_state} buttons={','.join(sorted(ALLOWED_BUTTONS))}"


def gb_load(game=DEFAULT_GAME):
    global _pyboy, _loaded_game, _loaded_rom
    PyBoy, _, error = _pyboy_import()
    if error:
        return f"GAMEBOY-UNAVAILABLE {error}"
    rom, rom_error = _resolve_rom(game)
    if not rom:
        return f"GAMEBOY-ROM-MISSING {rom_error}"
    if _pyboy is not None:
        try:
            _pyboy.stop(save=False)
        except Exception:
            pass
    try:
        _pyboy = PyBoy(str(rom), window="null")
        _pyboy.set_emulation_speed(0)
        _loaded_game = str(game or DEFAULT_GAME).strip() or DEFAULT_GAME
        _loaded_rom = str(rom)
        _pyboy.tick(5)
        _append_trace("GameBoyLoaded", game=_loaded_game, rom=_loaded_rom, title=str(_pyboy.cartridge_title))
        return f"GAMEBOY-LOADED game={_loaded_game} title={_pyboy.cartridge_title} frame={_pyboy.frame_count} rom={rom}"
    except Exception as exc:
        _pyboy = None
        _loaded_game = None
        _loaded_rom = None
        _append_trace("GameBoyLoadFailed", game=str(game), error=str(exc))
        return f"GAMEBOY-LOAD-ERROR {type(exc).__name__}: {exc}"


def _parse_action(action: str) -> tuple[list[str], int]:
    text = str(action or "").strip().lower()
    if not text:
        return [], DEFAULT_FRAMES
    frames = DEFAULT_FRAMES
    frame_match = re.search(r"(?:frames?\s+|for\s+)(\d+)\b", text)
    if frame_match:
        frames = int(frame_match.group(1))
        text = text[:frame_match.start()] + text[frame_match.end():]
    else:
        parts = text.split()
        if parts and parts[-1].isdigit():
            frames = int(parts[-1])
            text = " ".join(parts[:-1])
    frames = max(1, min(MAX_FRAMES, frames))
    tokens = re.split(r"[,+\s]+", text)
    buttons = [token for token in tokens if token in ALLOWED_BUTTONS]
    unknown = [token for token in tokens if token and token not in ALLOWED_BUTTONS]
    if unknown:
        raise ValueError("unknown buttons: " + ",".join(unknown))
    return buttons, frames


def gb_step(action=""):
    try:
        pb = _require_loaded()
        buttons, frames = _parse_action(action)
        press_frames = min(8, frames)
        for button in buttons:
            pb.button_press(button)
        pb.tick(press_frames)
        for button in buttons:
            pb.button_release(button)
        remaining = frames - press_frames
        if remaining > 0:
            pb.tick(remaining)
        obs = _observation(save_screen=False)
        _append_trace("GameBoyActionTaken", game=_loaded_game, buttons=buttons, frames=frames, frame=pb.frame_count)
        return f"GAMEBOY-STEP buttons={','.join(buttons) if buttons else 'none'} frames={frames} {obs}"
    except Exception as exc:
        _append_trace("GameBoyActionFailed", action=str(action), error=str(exc))
        return f"GAMEBOY-STEP-ERROR {type(exc).__name__}: {exc}"


def gb_observe():
    try:
        obs = _observation(save_screen=True)
        _append_trace("GameBoyObserved", game=_loaded_game, observation=obs[:500])
        return obs
    except Exception as exc:
        return f"GAMEBOY-OBSERVE-ERROR {type(exc).__name__}: {exc}"


def _observation(save_screen: bool) -> str:
    pb = _require_loaded()
    image = pb.screen.image
    digest = _image_digest(image)
    path_text = ""
    if save_screen:
        path_text = f" screenshot={_save_screenshot(image)}"
    return f"GAMEBOY-OBSERVE game={_loaded_game} title={pb.cartridge_title} frame={pb.frame_count} screen_sha1={digest}{path_text}"


def _image_digest(image) -> str:
    return hashlib.sha1(image.tobytes()).hexdigest()[:16]


def _save_screenshot(image=None) -> pathlib.Path:
    pb = _require_loaded()
    _ensure_dirs()
    image = image or pb.screen.image
    path = SCREENSHOT_DIR / f"{_safe_name(_loaded_game)}-frame-{pb.frame_count}.png"
    image.save(path)
    _append_trace("GameBoyScreenshotSaved", game=_loaded_game, frame=pb.frame_count, path=str(path))
    return path


def gb_screenshot():
    try:
        path = _save_screenshot()
        return f"GAMEBOY-SCREENSHOT {path}"
    except Exception as exc:
        return f"GAMEBOY-SCREENSHOT-ERROR {type(exc).__name__}: {exc}"


def _state_path(name: str) -> pathlib.Path:
    return SAVE_DIR / f"{_safe_name(name)}.state"


def gb_save_state(name="slot1"):
    try:
        pb = _require_loaded()
        path = _state_path(name)
        _ensure_dirs()
        with path.open("wb") as handle:
            pb.save_state(handle)
        _append_trace("GameBoyStateSaved", game=_loaded_game, frame=pb.frame_count, path=str(path))
        return f"GAMEBOY-STATE-SAVED name={_safe_name(name)} frame={pb.frame_count} path={path}"
    except Exception as exc:
        return f"GAMEBOY-STATE-SAVE-ERROR {type(exc).__name__}: {exc}"


def gb_load_state(name="slot1"):
    try:
        pb = _require_loaded()
        path = _state_path(name)
        if not path.exists():
            return f"GAMEBOY-STATE-MISSING {path}"
        with path.open("rb") as handle:
            pb.load_state(handle)
        _append_trace("GameBoyStateLoaded", game=_loaded_game, frame=pb.frame_count, path=str(path))
        return f"GAMEBOY-STATE-LOADED name={_safe_name(name)} frame={pb.frame_count} path={path}"
    except Exception as exc:
        return f"GAMEBOY-STATE-LOAD-ERROR {type(exc).__name__}: {exc}"



def gb_stop():
    global _pyboy, _loaded_game, _loaded_rom
    if _pyboy is None:
        return "GAMEBOY-STOPPED loaded=none"
    game = _loaded_game
    try:
        _pyboy.stop(save=False)
    except TypeError:
        _pyboy.stop()
    except Exception as exc:
        _append_trace("GameBoyStopFailed", game=game, error=str(exc))
        return f"GAMEBOY-STOP-ERROR {type(exc).__name__}: {exc}"
    _append_trace("GameBoyStopped", game=game)
    _pyboy = None
    _loaded_game = None
    _loaded_rom = None
    return f"GAMEBOY-STOPPED game={game}"


atexit.register(gb_stop)


def gb_last_trace():
    return _trace_tail()
