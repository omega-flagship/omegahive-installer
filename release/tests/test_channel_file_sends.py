# Purpose: pins that a file a mind sends through WhatsApp or Telegram comes only from its files/ or memory/outbox/
# folder, opened there without following a link and handed over as its bytes, never as a path the WhatsApp bridge would
# place against its own folder, where its session lives, and never the mind's token, .env, sessions or memory
# (omega-flagship/omegahive#304).
"""The hive's gate checks a file skill's path against the mind's folder. Each adapter now opens that same file itself,
from the mind's folder (its working directory) one name at a time with O_NOFOLLOW, and sends its bytes, so what is sent
is what was checked: the WhatsApp bridge, which runs in its own folder beside its session, gets data and refuses a path,
and Telegram uploads the bytes it read. A send reads only from files/, what the mind shares, and memory/outbox/, what
its generators make, since the mind's folder also holds its hive token, .env and auth/ sessions, which an approved send
would otherwise carry out, and no "Always" answer may reach them. Each case runs on both copies of each adapter."""
import base64
import importlib.util
import inspect
import os
import pathlib
import shutil
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
ADAPTERS = {"whatsapp": ("channels/whatsapp.py", "modules/channel_whatsapp/src/whatsapp.py"),
            "telegram": ("channels/telegram.py", "modules/channel_telegram/src/telegram.py")}
BRIDGES = ("channels/whatsapp_bridge/bridge.mjs", "modules/channel_whatsapp/src/whatsapp_bridge/bridge.mjs")
ONLY = "only files in this mind's files/ or memory/outbox/ folder"


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def open_descriptors():
    """This process's open descriptors, from /proc/self/fd on Linux or /dev/fd elsewhere."""
    return sorted(os.listdir("/proc/self/fd" if os.path.isdir("/proc/self/fd") else "/dev/fd"))


class FileSendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.mind, self.bridge, self.elsewhere = self.tmp / "mind", self.tmp / "whatsapp_bridge", self.tmp / "elsewhere"
        for folder in (self.mind / "files", self.mind / "memory" / "outbox" / "images", self.bridge / "auth", self.elsewhere):
            folder.mkdir(parents=True)
        # what the hive keeps in a mind's folder beside what it shares (hive/supervisor/workspace.py writes token)
        self.write(self.mind / "token", b"hive-token-of-this-mind")
        self.write(self.mind / ".env", b"OPENAI_API_KEY=not-for-sending")
        self.write(self.mind / "auth" / "creds.json", b'{"mine": true}')
        self.write(self.mind / "memory" / "inbox" / "telegram" / "from_a_person.jpg", b"their photo")
        self.write(self.mind / "memory" / "history.metta", b"(a belief)")
        self.write(self.bridge / "auth" / "creds.json", b'{"FAKE-SESSION": true}')   # what the bridge would have read
        self.secret = self.write(self.elsewhere / "secret.txt", b"not this mind's")
        cwd = os.getcwd()
        os.chdir(self.mind)                                     # a hive runs each mind, and its adapters, in its folder
        self.addCleanup(os.chdir, cwd)
        self.sent = []

    def write(self, path, data=b"photo"):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def adapters(self):
        """Each copy of each adapter, its sending captured: WhatsApp's request to the bridge, Telegram's upload."""
        for kind, paths in ADAPTERS.items():
            for n, path in enumerate(paths):
                module = load(path, f"{kind}_copy_{n}")
                if kind == "whatsapp":
                    module._json_request = lambda method, route, body=None, timeout=10: self.sent.append(body) or {"ok": True}
                    send = module.send_file
                else:
                    module._connected, module._chat_id, module._api_base = True, "42", "https://telegram.invalid/bot"

                    def upload(method, fields, file_field, name, data, timeout=60, _sent=self.sent):
                        _sent.append({"fileName": name, "data": base64.b64encode(data).decode()})
                    module._api_multipart = upload
                    send = module.send_file
                yield f"{kind} {path}", module, send

    def assert_refused(self, path, why):
        for name, _, send in self.adapters():
            with self.subTest(adapter=name, path=str(path)):
                self.sent.clear()
                before = open_descriptors()
                result = send(str(path))
                self.assertIn("FAILED", result)
                self.assertIn(why, result)
                self.assertEqual(self.sent, [])                 # nothing went to the bridge or to Telegram
                self.assertEqual(open_descriptors(), before)    # and nothing it opened stayed open

    def test_a_shared_file_and_a_made_picture_are_sent_as_bytes_and_never_a_path(self):
        self.write(self.mind / "files" / "report.pdf", b"%PDF shared")
        picture = self.write(self.mind / "memory" / "outbox" / "images" / "1700000000_a_cat.jpg", b"made picture")
        # a relative path, and the absolute one IMAGE-GENERATED hands the mind
        for path, data in (("files/report.pdf", b"%PDF shared"), (str(picture), b"made picture")):
            for name, _, send in self.adapters():
                with self.subTest(adapter=name, path=path):
                    self.sent.clear()
                    self.assertIn("SUCCESS", send(path))
                    self.assertEqual(len(self.sent), 1)
                    self.assertNotIn("path", self.sent[0])
                    self.assertEqual(self.sent[0]["fileName"], pathlib.PurePath(path).name)
                    self.assertEqual(base64.b64decode(self.sent[0]["data"]), data)

    def test_the_minds_token_env_sessions_and_memory_are_never_sent(self):
        for path in ("token", ".env", "auth/creds.json", "memory/inbox/telegram/from_a_person.jpg", "memory/history.metta",
                     str(self.mind / "token"), "files", "memory/outbox", "files/../token", "memory/outbox/../../.env"):
            self.assert_refused(path, ONLY)

    def test_a_link_at_the_file_or_a_folder_fails_to_open(self):
        (self.mind / "files" / "photo.png").symlink_to(self.secret)
        self.assert_refused("files/photo.png", "without following a link")
        (self.mind / "files" / "docs").symlink_to(self.elsewhere)
        self.assert_refused("files/docs/secret.txt", "without following a link")
        (self.mind / "memory" / "outbox" / "images" / "made.jpg").symlink_to(self.mind / "token")
        self.assert_refused("memory/outbox/images/made.jpg", "without following a link")

    def test_a_link_in_place_of_a_sendable_folder_fails_to_open(self):
        shutil.rmtree(self.mind / "files")
        (self.mind / "files").symlink_to(self.mind)            # files/token would then be the mind's own token
        self.assert_refused("files/token", "without following a link")
        shutil.rmtree(self.mind / "memory" / "outbox")
        (self.mind / "memory" / "outbox").symlink_to(self.elsewhere)
        self.assert_refused("memory/outbox/secret.txt", "without following a link")

    def test_a_link_swapped_in_while_the_file_is_opened_fails_to_open(self):
        folder = self.write(self.mind / "files" / "docs" / "note.txt").parent
        real_open = os.open

        def opening(path, flags, mode=0o777, *, dir_fd=None):
            if path == "docs" and not folder.is_symlink():    # the swap lands between the gate's check and this open
                folder.rename(folder.with_name("docs.moved"))
                folder.symlink_to(self.elsewhere)
            return real_open(path, flags, mode, dir_fd=dir_fd)
        for name, _, send in self.adapters():
            with self.subTest(adapter=name):
                self.sent.clear()
                if folder.is_symlink():
                    folder.unlink()
                    folder.with_name("docs.moved").rename(folder)
                with patch.object(os, "open", opening):
                    result = send("files/docs/note.txt")
                self.assertIn("without following a link", result)
                self.assertEqual(self.sent, [])

    def test_a_file_outside_the_minds_folder_is_refused(self):
        self.assert_refused(self.secret, ONLY)
        self.assert_refused("../elsewhere/secret.txt", ONLY)
        self.assert_refused(self.mind, ONLY)

    def test_a_folder_a_hard_link_a_fifo_and_an_oversized_file_are_refused_unread(self):
        (self.mind / "files" / "album").mkdir()
        self.assert_refused("files/album", "not a regular file")      # its descriptor closed, never left open
        os.link(self.secret, self.mind / "files" / "linked.txt")
        self.assert_refused("files/linked.txt", "a hard link")
        os.mkfifo(self.mind / "files" / "pipe")
        self.assert_refused("files/pipe", "not a regular file")        # refused at once, never waiting for a writer
        _, module, _ = next(self.adapters())
        with open(self.mind / "files" / "big.bin", "wb") as handle:
            handle.truncate(module.MAX_FILE_BYTES + 1)                  # sparse: no disk is used for it
        self.assert_refused("files/big.bin", "over 100 MB")

    def test_a_missing_file_is_said_plainly(self):
        self.assert_refused("files/nothing.png", "no such file in this mind's folder")

    def test_every_copy_keeps_one_open_word_for_word(self):
        sources = {name: (inspect.getsource(module._own_file), module.SENDABLE) for name, module, _ in self.adapters()}
        self.assertEqual(len(set(sources.values())), 1, sorted(sources))

    def test_each_bridge_sends_the_data_it_is_given_and_refuses_a_path(self):
        """The bridge can't run here without a WhatsApp session, so its handler is read: it takes data, refuses path,
        and gives Baileys the bytes, never a file name to open."""
        for path in BRIDGES:
            source = (ROOT / path).read_text()
            handler = source[source.index("url.pathname === '/send-file'"):source.index("url.pathname === '/reply-to-message'")]
            with self.subTest(bridge=path):
                self.assertIn("if (body.path !== undefined) return sendJson(res, 400", handler)
                self.assertIn("const data = Buffer.from(body.data, 'base64')", handler)
                self.assertNotIn("url:", handler)
                self.assertNotIn("fs.", handler)


if __name__ == "__main__":
    unittest.main()
