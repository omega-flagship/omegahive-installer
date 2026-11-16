#!/usr/bin/env python3
"""Purpose: the vision and audio senses read only images and audio in a mind's own folders or the hive's checkout, so
a mind can't send the vision provider, or have transcribed, a file it can merely read."""
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


class SensePathTests(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.mind, self.elsewhere = self.tmp / "mind", self.tmp / "elsewhere"
        self.mind.mkdir()
        self.elsewhere.mkdir()
        cwd = os.getcwd()
        os.chdir(self.mind)                                     # a mind runs in its own folder
        self.addCleanup(os.chdir, cwd)
        if ROOT in self.elsewhere.parents:
            self.skipTest("the temporary folder is inside the checkout, so it can't stand for a folder outside it")

    def write(self, path, data):
        path.write_bytes(data)
        return path

    def test_an_image_in_the_minds_folder_is_sent_with_the_type_its_bytes_show(self):
        image = self.write(self.mind / "photo.jpg", PNG)
        self.assertTrue(vision._image_data_url(image).startswith("data:image/png;base64,"))

    def test_each_image_format_is_recognised_by_its_bytes(self):
        for mime, data in (("image/png", PNG), ("image/jpeg", b"\xff\xd8\xff\xe0" + b"\x00" * 8),
                           ("image/gif", b"GIF87a" + b"\x00" * 8), ("image/gif", b"GIF89a" + b"\x00" * 8),
                           ("image/webp", b"RIFF\x24\x00\x00\x00WEBPVP8 ")):
            self.assertEqual(vision._image_bytes(self.write(self.mind / "image", data))[1], mime)

    def test_the_memory_folder_counts_as_the_minds(self):
        memory = self.elsewhere / "memory"
        memory.mkdir()
        image = self.write(memory / "received.png", PNG)
        with patch.dict(os.environ, {"OMEGACLAW_MEMORY_DIR": str(memory)}):
            self.assertEqual(vision._image_bytes(image)[1], "image/png")

    def test_an_image_outside_the_minds_folders_and_the_checkout_is_refused(self):
        with patch.dict(os.environ, {"OMEGACLAW_MEMORY_DIR": str(self.mind)}):
            with self.assertRaises(PermissionError):
                vision._image_bytes(self.write(self.elsewhere / "photo.png", PNG))

    def test_a_symlink_from_the_minds_folder_to_a_file_outside_is_refused(self):
        target = self.write(self.elsewhere / "id_ed25519", PNG)
        (self.mind / "innocent.png").symlink_to(target)
        with self.assertRaises(PermissionError):
            vision._image_bytes(self.mind / "innocent.png")

    def test_a_file_that_is_not_an_image_is_refused_even_in_the_minds_folder(self):
        with self.assertRaises(PermissionError):
            vision._image_bytes(self.write(self.mind / "notes.png", b"invented_token=0000"))

    def test_observe_image_reports_a_refusal_and_sends_nothing(self):
        outside = self.write(self.elsewhere / "photo.png", PNG)
        with patch.object(vision.urllib.request, "urlopen") as urlopen, \
                patch.object(vision, "OBSERVATION_LOG", self.tmp / "observations.jsonl"), \
                patch.dict(os.environ, {"OPENROUTER_API_KEY": "invented-key"}):
            result = vision.observe_image(str(outside))
        self.assertTrue(result.startswith("IMAGE-OBSERVATION-FAILED"), result)
        urlopen.assert_not_called()

    def test_audio_is_transcribed_only_from_the_minds_folders_and_only_audio(self):
        inside = self.write(self.mind / "note.ogg", b"OggS")
        self.assertEqual(audio._audio_file(inside), inside)
        for refused in (self.write(self.elsewhere / "note.ogg", b"OggS"), self.write(self.mind / "note.txt", b"text")):
            with self.assertRaises(PermissionError):
                audio._audio_file(refused)

    def test_both_copies_of_each_sense_find_the_same_checkout(self):
        for name in ("vision", "audio"):
            src, module = ROOT / "src" / f"{name}.py", ROOT / "modules" / f"sense_{name}" / "src" / f"{name}.py"
            self.assertEqual(src.read_bytes(), module.read_bytes(), name)
        self.assertEqual(vision._observable_roots()[0], ROOT)


if __name__ == "__main__":
    unittest.main()
