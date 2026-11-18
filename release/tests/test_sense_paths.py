#!/usr/bin/env python3
"""Purpose: a mind's media lives in its memory folder: the channels, the webcam and the generators write it there, and
the vision and audio senses read only that folder and the files folder its fetched hive assets land in, so minds
sharing one checkout never observe each other's media and a mind can't send the vision provider, or have transcribed,
a file it can merely read, even by swapping a link in after a file was checked."""
import base64
import importlib.util
import inspect
import json
import os
import pathlib
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import audio  # noqa: E402
import vision  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
# Each writer's copies, by the name they are loaded under: the checkout's own and the module's.
COPIES = {
    "telegram": ("channels/telegram.py", "modules/channel_telegram/src/telegram.py"),
    "webcam": ("src/webcam.py", "modules/sense_webcam/src/webcam.py"),
    "imagegen": ("src/imagegen.py", "modules/media_imagegen/src/imagegen.py"),
    "videogen": ("src/videogen.py", "modules/media_videogen/src/videogen.py"),
}
BRIDGES = ("channels/whatsapp_bridge/bridge.mjs", "modules/channel_whatsapp/src/whatsapp_bridge/bridge.mjs")


def load(path, name):
    """The module at path, loaded under name, so two copies of one writer can be checked side by side."""
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SensePathTests(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.mind, self.elsewhere = self.tmp / "mind", self.tmp / "elsewhere"
        self.memory = self.mind / "memory"
        for folder in (self.memory, self.elsewhere):
            folder.mkdir(parents=True)
        cwd = os.getcwd()
        os.chdir(self.mind)                                     # a hive runs each mind in its own folder
        self.addCleanup(os.chdir, cwd)
        hive = patch.dict(os.environ, {"OMEGACLAW_MEMORY_DIR": str(self.memory)})   # and gives it its memory folder
        hive.start()
        self.addCleanup(hive.stop)
        if ROOT in self.tmp.parents:
            self.skipTest("the temporary folder is inside the checkout, so it can't stand for a folder outside it")

    def write(self, path, data=PNG):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def swap_on_open(self, name, swapped, target, nth=1):
        """Puts a link to target in place of swapped just before a sense's nth open of name: a swap landing between a check
        and the open, as a concurrent writer's would (the review's probe read outside after such a swap)."""
        real_open, seen = os.open, []

        def opening(path, flags, mode=0o777, *, dir_fd=None):
            if path == name:
                seen.append(path)
                if len(seen) == nth:
                    swapped.rename(swapped.with_name(swapped.name + ".moved"))
                    swapped.symlink_to(target)
            return real_open(path, flags, mode, dir_fd=dir_fd)
        return patch.object(os, "open", opening)

    def checkout(self):
        """A second checkout holding a copy of the vision sense, standing for the one every mind of a hive shares."""
        checkout = self.tmp / "checkout"
        self.write(checkout / "modules" / "sense_vision" / "src" / "vision.py", (ROOT / "src" / "vision.py").read_bytes())
        return checkout, load(checkout / "modules" / "sense_vision" / "src" / "vision.py", "vision_in_shared_checkout")

    def test_an_image_in_the_memory_folder_is_sent_with_the_type_its_bytes_show(self):
        image = self.write(self.memory / "inbox" / "telegram" / "photo.jpg")
        self.assertTrue(vision._image_data_url(image).startswith("data:image/png;base64,"))

    def test_each_image_format_is_recognised_by_its_bytes(self):
        for mime, data in (("image/png", PNG), ("image/jpeg", b"\xff\xd8\xff\xe0" + b"\x00" * 8),
                           ("image/gif", b"GIF87a" + b"\x00" * 8), ("image/gif", b"GIF89a" + b"\x00" * 8),
                           ("image/webp", b"RIFF\x24\x00\x00\x00WEBPVP8 ")):
            self.assertEqual(vision._image_bytes(self.write(self.memory / "image", data))[1], mime)

    def test_a_hive_asset_the_mind_fetched_is_accepted(self):
        # hive_commons saves a fetched asset as files/assets/<sha> under the mind's working directory
        asset = self.write(self.mind / "files" / "assets" / ("ab" * 32))
        self.assertEqual(vision._image_bytes(pathlib.Path("files/assets") / ("ab" * 32))[0], PNG)
        self.assertEqual(vision._image_bytes(asset)[1], "image/png")

    def test_the_working_directory_outside_its_files_folder_is_refused(self):
        for path in (self.write(self.mind / "photo.png"), self.write(self.mind / "repos" / "photo.png")):
            with self.assertRaises(PermissionError):
                vision._image_bytes(path)

    def test_the_shared_checkout_is_refused_when_a_hive_gives_the_mind_its_own_memory_folder(self):
        checkout, shared = self.checkout()
        for other in (checkout / "memory" / "inbox" / "telegram" / "another_minds.png",
                      checkout / "modules" / "media_imagegen" / "memory" / "outbox" / "images" / "made.png",
                      checkout / "photo.png"):
            with self.subTest(path=other.relative_to(checkout)), self.assertRaises(PermissionError):
                shared._image_bytes(self.write(other))
        self.assertEqual(shared._image_bytes(self.write(self.memory / "inbox" / "own.png"))[1], "image/png")

    def test_without_a_hive_the_checkouts_memory_folder_is_the_minds(self):
        checkout, shared = self.checkout()
        with patch.dict(os.environ):
            del os.environ["OMEGACLAW_MEMORY_DIR"]
            self.assertEqual(shared.memory_dir(), checkout / "memory")
            received = self.write(checkout / "memory" / "inbox" / "telegram" / "photo.png")
            self.assertEqual(shared._image_bytes(received)[1], "image/png")
            with self.assertRaises(PermissionError):
                shared._image_bytes(self.write(checkout / "photo.png"))

    def test_an_image_outside_every_folder_of_the_mind_is_refused(self):
        with self.assertRaises(PermissionError):
            vision._image_bytes(self.write(self.elsewhere / "photo.png"))

    def test_a_symlink_from_the_memory_folder_to_a_file_outside_is_refused(self):
        target = self.write(self.elsewhere / "id_ed25519")
        (self.memory / "innocent.png").symlink_to(target)
        with self.assertRaises(PermissionError):
            vision._image_bytes(self.memory / "innocent.png")

    def test_a_file_that_is_not_an_image_is_refused_even_in_the_memory_folder(self):
        with self.assertRaises(PermissionError):
            vision._image_bytes(self.write(self.memory / "notes.png", b"invented_token=0000"))

    def test_a_link_swapped_in_for_a_checked_image_is_never_read(self):
        image = self.write(self.memory / "inbox" / "telegram" / "photo.png")
        private = self.write(self.elsewhere / "private.png", PNG + b"private")
        with self.swap_on_open("photo.png", image, private), self.assertRaises(PermissionError):
            vision._image_bytes(image)
        self.assertEqual(image.read_bytes(), private.read_bytes())   # by name, the swapped path now reads outside

    def test_a_link_swapped_in_for_a_checked_images_folder_is_never_read(self):
        image = self.write(self.memory / "inbox" / "telegram" / "photo.png")
        private = self.write(self.elsewhere / "telegram" / "photo.png", PNG + b"private")
        with self.swap_on_open("telegram", image.parent, private.parent), self.assertRaises(PermissionError):
            vision._image_bytes(image)
        self.assertEqual(image.read_bytes(), private.read_bytes())

    def test_a_fifo_in_place_of_an_image_is_refused_without_waiting_for_a_writer(self):
        fifo = self.memory / "inbox" / "telegram" / "photo.png"
        fifo.parent.mkdir(parents=True)
        os.mkfifo(fifo)
        with self.assertRaises(PermissionError):
            vision._image_bytes(fifo)

    def test_a_link_the_mind_put_in_place_of_its_files_folder_is_refused(self):
        other = self.write(self.elsewhere / "assets" / "other-minds.png", PNG + b"another mind's")
        (self.mind / "files").symlink_to(other.parent)
        with self.assertRaises(PermissionError):
            vision._image_bytes(self.mind / "files" / "other-minds.png")

    def test_a_link_the_mind_put_in_place_of_its_memory_folder_is_refused(self):
        other = self.write(self.elsewhere / "memory" / "inbox" / "telegram" / "photo.png", PNG + b"another mind's")
        self.memory.rmdir()
        self.memory.symlink_to(self.elsewhere / "memory")
        for path in (self.memory / "inbox" / "telegram" / "photo.png", other):
            with self.subTest(path=path), self.assertRaises(PermissionError):
                vision._image_bytes(path)
        with self.assertRaises(PermissionError):
            vision._image_bytes(vision._resolve_image("latest"))

    def test_the_files_folder_swapped_for_a_link_during_the_open_is_refused(self):
        image = self.write(self.mind / "files" / "assets" / "photo.png")
        other = self.write(self.elsewhere / "assets" / "photo.png", PNG + b"another mind's")
        with self.swap_on_open("files", self.mind / "files", other.parent.parent), self.assertRaises(PermissionError):
            vision._image_bytes(image)
        self.assertEqual(image.read_bytes(), other.read_bytes())   # by name, the swapped path now reads outside

    def test_a_hard_link_into_the_memory_folder_is_refused(self):
        private = self.write(self.elsewhere / "private.png", PNG + b"private")
        linked = self.memory / "inbox" / "telegram" / "photo.png"
        linked.parent.mkdir(parents=True)
        os.link(private, linked)
        with self.assertRaises(PermissionError):
            vision._image_bytes(linked)

    def test_a_file_over_the_cap_is_refused_before_a_byte_is_read(self):
        big = self.memory / "inbox" / "telegram" / "big.png"
        big.parent.mkdir(parents=True)
        with big.open("wb") as handle:
            handle.write(PNG)
            handle.truncate(vision.MAX_BYTES + 1)   # sparse: no disk is used for it
        with patch.object(os, "fdopen", side_effect=AssertionError("read")), self.assertRaises(PermissionError):
            vision._image_bytes(big)

    def test_a_path_climbing_out_of_the_memory_folder_is_refused(self):
        self.write(self.elsewhere / "photo.png")
        with self.assertRaises(PermissionError):
            vision._image_bytes(self.memory / ".." / ".." / "elsewhere" / "photo.png")

    def test_vision_and_audio_open_a_checked_file_the_same_way(self):
        for name in ("_open_root", "_open_inside"):
            self.assertEqual(inspect.getsource(getattr(vision, name)), inspect.getsource(getattr(audio, name)), name)
        self.assertEqual(vision.MAX_BYTES, audio.MAX_BYTES)

    def test_observe_image_reports_a_refusal_sends_nothing_and_logs_it_in_the_memory_folder(self):
        outside = self.write(self.elsewhere / "photo.png")
        with patch.object(vision.urllib.request, "urlopen") as urlopen, \
                patch.dict(os.environ, {"OPENROUTER_API_KEY": "invented-key"}):
            result = vision.observe_image(str(outside))
        self.assertTrue(result.startswith("IMAGE-OBSERVATION-FAILED"), result)
        urlopen.assert_not_called()
        [line] = (self.memory / "media_observations.jsonl").read_text().splitlines()
        self.assertEqual(json.loads(line)["kind"], "image_observation_failed")
        self.assertIn("image_observation_failed", vision.recent_media_observations(1))

    def test_latest_is_the_newest_image_in_the_memory_folders_inbox(self):
        older = self.write(self.memory / "inbox" / "telegram" / "older.png")
        newer = self.write(self.memory / "inbox" / "webcam" / "newer.png")
        os.utime(older, (1, 1))
        self.assertEqual(vision._resolve_image("latest"), newer)

    def test_audio_is_transcribed_only_from_the_minds_folders_and_only_audio(self):
        for inside in (self.write(self.memory / "inbox" / "telegram" / "note.ogg", b"OggS"),
                       self.write(self.mind / "files" / "assets" / "note.ogg", b"OggS")):
            self.assertEqual(audio._audio_file(inside), inside)
        for refused in (self.write(self.elsewhere / "note.ogg", b"OggS"), self.write(self.mind / "note.ogg", b"OggS"),
                        self.write(self.memory / "note.txt", b"text")):
            with self.subTest(path=refused), self.assertRaises(PermissionError):
                audio._audio_file(refused)

    def test_whisper_reads_a_private_copy_of_the_checked_audio_removed_after(self):
        note = self.write(self.memory / "inbox" / "telegram" / "note.ogg", b"OggS checked")
        heard = []

        class Whisper:
            def transcribe(self, name, **options):
                heard.append((pathlib.Path(name).parent, pathlib.Path(name).read_bytes()))
                return {"text": "hello", "segments": [], "language": "en"}
        with patch.object(audio, "_load_model", return_value=Whisper()):
            result = audio.inspect_audio(str(note))
        self.assertTrue(result.startswith("AUDIO-OBSERVATION "), result)
        self.assertEqual(heard, [(self.memory / ".audio-tmp", b"OggS checked")])
        self.assertEqual(list((self.memory / ".audio-tmp").iterdir()), [])
        self.assertEqual(json.loads(result.removeprefix("AUDIO-OBSERVATION "))["audio"], str(note))

    def test_a_link_swapped_in_for_checked_audio_is_never_copied(self):
        note = self.write(self.memory / "inbox" / "telegram" / "note.ogg", b"OggS checked")
        private = self.write(self.elsewhere / "call.ogg", b"OggS private")
        # the second open of its name is the copy's own, after _audio_file's check
        with self.swap_on_open("note.ogg", note, private, nth=2), self.assertRaises(PermissionError):
            audio._audio_copy(note)
        self.assertEqual(list((self.memory / ".audio-tmp").iterdir()), [])

    def test_the_telegram_channel_keeps_received_files_in_the_memory_folder(self):
        for n, path in enumerate(COPIES["telegram"]):
            telegram = load(ROOT / path, f"telegram_copy_{n}")
            self.assertEqual(telegram._inbox_dir(), self.memory / "inbox" / "telegram", path)

    def test_a_webcam_capture_lands_in_the_memory_folder_where_vision_reads_it(self):
        frame = {"ok": True, "camera": "BRIO", "image_base64": base64.b64encode(PNG).decode("ascii")}
        for n, path in enumerate(COPIES["webcam"]):
            webcam = load(ROOT / path, f"webcam_copy_{n}")
            with patch.object(webcam, "_request_json", return_value=frame):
                result = webcam.capture_webcam()
            image = pathlib.Path(json.loads(result.removeprefix("WEBCAM-CAPTURE "))["image"])
            self.assertEqual(image.parent, self.memory / "inbox" / "webcam", path)
            self.assertEqual(vision._image_bytes(image)[1], "image/png")
            self.assertIn("webcam_capture", webcam.recent_webcam_observations(1))

    def test_generated_images_and_videos_are_kept_in_the_memory_folder(self):
        for name, kind, data in (("imagegen", "images", PNG), ("videogen", "videos", b"\x00\x00\x00\x18ftypmp42")):
            for n, path in enumerate(COPIES[name]):
                generator = load(ROOT / path, f"{name}_copy_{n}")
                fields = dict(part.split("=", 1) for part in generator._write_bytes("a quiet garden", data).split()[1:])
                made = pathlib.Path(fields["path"])
                self.assertEqual(made.parent, self.memory / "outbox" / kind, path)
                self.assertEqual(fields["artifact_id"], f"outbox:{kind}/{made.name}")
                if kind == "images":
                    self.assertEqual(vision._image_bytes(made)[1], "image/png")

    def test_the_whatsapp_bridge_keeps_received_files_in_the_memory_folder(self):
        # the bridge starts a WhatsApp session when imported, so its path lines are checked as the bridge tests do
        for path in BRIDGES:
            source = (ROOT / path).read_text(encoding="utf-8")
            with self.subTest(path=path):
                self.assertIn("const memoryDir = process.env.OMEGACLAW_MEMORY_DIR || "
                              "path.join(checkoutDir(__dirname), 'memory')", source)
                self.assertIn("const inboxDir = path.join(memoryDir, 'inbox', `whatsapp_${authLabel}`)", source)

    def test_each_sense_and_its_module_copy_are_identical_and_find_the_same_memory_folder(self):
        for src, module in (("src/vision.py", "modules/sense_vision/src/vision.py"),
                            ("src/audio.py", "modules/sense_audio/src/audio.py"),
                            COPIES["webcam"], COPIES["videogen"]):
            self.assertEqual((ROOT / src).read_bytes(), (ROOT / module).read_bytes(), src)
        with patch.dict(os.environ):
            del os.environ["OMEGACLAW_MEMORY_DIR"]
            for n, path in enumerate(("src/vision.py", "modules/sense_vision/src/vision.py")):
                self.assertEqual(load(ROOT / path, f"vision_copy_{n}").memory_dir(), ROOT / "memory", path)


if __name__ == "__main__":
    unittest.main()
