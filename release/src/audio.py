import json
import os
import pathlib
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
INBOX = ROOT / "memory" / "inbox"
OBSERVATION_LOG = ROOT / "memory" / "audio_observations.jsonl"
AUDIO_EXTS = {".mp3", ".ogg", ".opus", ".m4a", ".wav", ".webm", ".flac", ".aac"}
DEFAULT_MODEL = os.environ.get("OMEGACLAW_AUDIO_MODEL", "tiny")

_MODEL = None


def _candidate_files():
    if not INBOX.exists():
        return []
    return sorted(
        [path for path in INBOX.rglob("*") if path.is_file() and path.suffix.lower() in AUDIO_EXTS],
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )


def _resolve_audio(audio_id):
    raw = str(audio_id or "").strip().strip('"')
    if not raw or raw.lower() in {"latest", "recent"}:
        files = _candidate_files()
        if not files:
            raise FileNotFoundError("no inbox audio files found")
        return files[0]

    path = pathlib.Path(raw).expanduser()
    if path.is_file():
        return path

    files = _candidate_files()
    matches = [
        item for item in files
        if raw == item.name or raw == item.stem or raw in str(item)
    ]
    if len(matches) == 1:
        return matches[0]
    if matches:
        names = ", ".join(item.name for item in matches[:8])
        raise ValueError(f"ambiguous audio id; matches {names}")
    raise FileNotFoundError(f"unknown audio id {raw}")


def _ensure_ffmpeg_path():
    try:
        import imageio_ffmpeg
    except Exception:
        return
    ffmpeg = pathlib.Path(imageio_ffmpeg.get_ffmpeg_exe())
    if not ffmpeg.exists():
        return
    bin_dir = ROOT / "memory" / ".audio-bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    link = bin_dir / "ffmpeg"
    if not link.exists():
        try:
            link.symlink_to(ffmpeg)
        except FileExistsError:
            pass
    os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"


def _load_model():
    global _MODEL
    if _MODEL is None:
        _ensure_ffmpeg_path()
        import whisper
        _MODEL = whisper.load_model(DEFAULT_MODEL)
    return _MODEL


def _classify(transcript, segments):
    if transcript.strip():
        return "speech_or_song"
    if segments:
        return "non_speech_audio"
    return "silence_or_unknown"


def _duration_seconds(segments):
    try:
        return round(max(float(segment.get("end", 0.0)) for segment in segments), 2)
    except Exception:
        return 0.0


def _append_observation(record):
    OBSERVATION_LOG.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        **record,
    }
    with OBSERVATION_LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def inspect_audio(audio_id, question=""):
    try:
        path = _resolve_audio(audio_id)
        model = _load_model()
        result = model.transcribe(str(path), fp16=False, verbose=False)
        segments = result.get("segments") or []
        transcript = " ".join(str(result.get("text") or "").split())
        record = {
            "kind": "audio_observation",
            "provider": "local",
            "model": f"whisper-{DEFAULT_MODEL}",
            "audio": str(path),
            "question": str(question or ""),
            "audio_kind": _classify(transcript, segments),
            "language": result.get("language") or "unknown",
            "duration_seconds": _duration_seconds(segments),
            "transcript": transcript,
            "segment_count": len(segments),
        }
        _append_observation(record)
        return "AUDIO-OBSERVATION " + json.dumps(record, ensure_ascii=False)
    except Exception as exc:
        record = {
            "kind": "audio_observation_failed",
            "provider": "local",
            "model": f"whisper-{DEFAULT_MODEL}",
            "audio": str(audio_id),
            "question": str(question or ""),
            "error": str(exc),
        }
        _append_observation(record)
        return f"AUDIO-OBSERVATION-FAILED {type(exc).__name__}: {exc}"


def observe_audio(audio_id):
    return inspect_audio(audio_id, "")


def recent_audio_observations(limit=10):
    try:
        limit = max(1, min(int(limit), 50))
    except Exception:
        limit = 10
    if not OBSERVATION_LOG.exists():
        return "AUDIO-OBSERVATIONS none"
    lines = OBSERVATION_LOG.read_text(encoding="utf-8", errors="replace").splitlines()[-limit:]
    return "AUDIO-OBSERVATIONS " + " | ".join(lines)
