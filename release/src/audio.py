"""Purpose: the audio sense: transcribe audio a mind received or fetched with a local Whisper model, and log each
observation in the mind's memory folder; audio files only, and only from that memory folder or the files folder its
fetched hive assets land in, so minds sharing one checkout never transcribe each other's recordings."""
import json
import os
import pathlib
import shutil
import stat
import tempfile
import time

# Under the mind's working directory, the folder the hive saves the assets a mind fetches into
# (modules/hive/src/hive_commons.py FILES_DIR).
FILES_DIR = "files"
# The most a sense reads of one file, checked before a byte is read: the hive's own cap on a file a mind moves
# (modules/hive/src/hive_commons.py MAX_ASSET_BYTES, HIVE_ASSET_MAX_BYTES's default).
MAX_BYTES = 100 * 1024 * 1024
AUDIO_EXTS = {".mp3", ".ogg", ".opus", ".m4a", ".wav", ".webm", ".flac", ".aac"}
DEFAULT_MODEL = os.environ.get("OMEGACLAW_AUDIO_MODEL", "tiny")

_MODEL = None


def memory_dir():
    """The mind's memory folder, where its received media and this sense's log live: OMEGACLAW_MEMORY_DIR when a hive
    runs the mind (each mind's own, hive/supervisor/workspace.py), else the memory folder of the checkout this file runs
    from (the nearest folder above it holding modules/), as channel_hive reads it.
    It is the path as named, never resolved: a mind could put a link in its place, and _open_root opens it without
    following one."""
    here = pathlib.Path(__file__).resolve()
    checkout = next((folder for folder in here.parents if (folder / "modules").is_dir()), here.parents[1])
    return pathlib.Path(os.path.abspath(os.environ.get("OMEGACLAW_MEMORY_DIR") or checkout / "memory"))


def _candidate_files():
    inbox = memory_dir() / "inbox"
    if not inbox.exists():
        return []
    return sorted(
        [path for path in inbox.rglob("*") if path.is_file() and path.suffix.lower() in AUDIO_EXTS],
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )


def _observable_roots():
    """Where a mind's own audio can be, as paths named, never resolved: its memory folder, where the channels write it,
    and the files folder under its working directory, where the hive saves the assets it fetches. A mind writes its own
    folder, so either could be a link it put there to any folder it can read; _open_root opens each without following
    one (omega-flagship/omegahive#249 review). Never the checkout or the rest of the working directory, which minds can
    share."""
    return [memory_dir(), pathlib.Path(os.getcwd()) / FILES_DIR]


def _audio_file(path):
    """path as named, when it names an audio file under one of _observable_roots that opens there without following a
    link; refused otherwise, so a mind can't have any recording it can merely read transcribed. _audio_copy reads it."""
    given = pathlib.Path(os.path.abspath(os.path.expanduser(str(path))))
    if given.suffix.lower() not in AUDIO_EXTS:
        raise PermissionError(f"not an audio file ({', '.join(sorted(AUDIO_EXTS))}): {path}")
    os.close(_open_inside(given, _observable_roots()))
    return given


def _open_root(root):
    """A descriptor for the folder root, reached without following a link anywhere a mind could have put one: from its
    working directory, its own folder, one name at a time with O_NOFOLLOW when root lies under it, else by its name
    with O_NOFOLLOW on the last, the one part of such a path a mind writes. The vision and audio senses keep this
    function word for word."""
    cloexec = getattr(os, "O_CLOEXEC", 0)
    folder_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | cloexec
    rel = os.path.relpath(root, os.getcwd())
    if rel == os.pardir or rel.startswith(os.pardir + os.sep):
        return os.open(root, folder_flags)
    folder = os.open(os.curdir, os.O_RDONLY | os.O_DIRECTORY | cloexec)
    try:
        for part in pathlib.PurePath(rel).parts:
            if part != os.curdir:
                inner = os.open(part, folder_flags, dir_fd=folder)
                os.close(folder)
                folder = inner
    except BaseException:
        os.close(folder)
        raise
    return folder


def _open_inside(path, roots):
    """A file descriptor for path, opened only when it is a regular file under one of roots. The path is placed against
    each root as named (os.path.abspath, never resolved) or as the root's real folder, then opened from the root's
    descriptor (_open_root) one name at a time with O_NOFOLLOW, as the standard library's shutil.rmtree walks against a
    link swapped in mid-walk: a link anywhere from the mind's own folder down, put there before the open or during it,
    fails to open instead of reaching outside. A FIFO or device, a file with a second hard link (its other name could
    be anywhere) and one over MAX_BYTES are refused unread. The vision and audio senses keep this function word for
    word. Cost: one open per folder between the mind's folder and the file."""
    given = os.path.abspath(os.path.expanduser(str(path)))
    rel = None
    for root in roots:
        for form in (str(root), os.path.realpath(root)):
            candidate = os.path.relpath(given, form)
            if candidate not in (os.curdir, os.pardir) and not candidate.startswith(os.pardir + os.sep):
                rel = candidate
                break
        if rel is not None:
            break
    if rel is None:
        raise PermissionError(f"only files in this mind's memory folder or its files folder can be observed: {path}")
    *folders, name = pathlib.PurePath(rel).parts
    nofollow = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    try:
        folder = _open_root(root)
    except OSError as exc:
        raise PermissionError(f"{path} can't be opened without following a link ({exc.strerror}), so it is not read") from exc
    try:
        for part in folders:
            inner = os.open(part, nofollow | os.O_DIRECTORY, dir_fd=folder)
            os.close(folder)
            folder = inner
        opened = os.open(name, nofollow | os.O_NONBLOCK, dir_fd=folder)
    except OSError as exc:
        raise PermissionError(f"{path} can't be opened without following a link ({exc.strerror}), so it is not read") from exc
    finally:
        os.close(folder)
    info = os.fstat(opened)
    reason = ("not a regular file" if not stat.S_ISREG(info.st_mode) else
              "a file with a second name elsewhere (a hard link)" if info.st_nlink != 1 else
              f"over {MAX_BYTES // (1024 * 1024)} MB" if info.st_size > MAX_BYTES else None)
    if reason:
        os.close(opened)
        raise PermissionError(f"{reason}: {path}")
    return opened

def _audio_copy(path):
    """(path checked, a private copy of its audio) once _audio_file has checked path, the copy read through
    _open_inside's descriptor: Whisper opens what it is given by name, through ffmpeg, so it reads this copy of the file
    that was checked, never a name a link can be swapped onto. The copy is made in the mind's memory folder, the one
    folder a sandboxed mind writes, and the caller removes it."""
    real = _audio_file(path)
    scratch = memory_dir() / ".audio-tmp"
    scratch.mkdir(parents=True, exist_ok=True)
    handle, copy = tempfile.mkstemp(suffix=real.suffix.lower(), dir=scratch)
    try:
        with os.fdopen(handle, "wb") as target, os.fdopen(_open_inside(real, _observable_roots()), "rb") as source:
            shutil.copyfileobj(source, target)
    except BaseException:
        os.unlink(copy)
        raise
    return real, pathlib.Path(copy)


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
    bin_dir = memory_dir() / ".audio-bin"
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


def _observation_log():
    return memory_dir() / "audio_observations.jsonl"


def _append_observation(record):
    log = _observation_log()
    log.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        **record,
    }
    with log.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def inspect_audio(audio_id, question=""):
    try:
        path, copy = _audio_copy(_resolve_audio(audio_id))
        try:
            model = _load_model()
            result = model.transcribe(str(copy), fp16=False, verbose=False)
        finally:
            copy.unlink(missing_ok=True)
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
    log = _observation_log()
    if not log.exists():
        return "AUDIO-OBSERVATIONS none"
    lines = log.read_text(encoding="utf-8", errors="replace").splitlines()[-limit:]
    return "AUDIO-OBSERVATIONS " + " | ".join(lines)
