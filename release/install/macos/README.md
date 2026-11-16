# Omega hive for Mac

`Install OmegaHive.command` sets up your own Omega hive on a Mac and opens it in your default browser, signed in as
its owner. Everything goes in one folder of your home, `~/OmegaHive`, with no administrator password and no
questions, apart from the two things that let you find the hive and have it start when you log in: the Omega Hive app
in `~/Applications` and its login item in `~/Library/LaunchAgents`. In a release zip you double-click
`Install Omega.command`, which runs it. `install/windows/README.md` describes the Windows twin.

## What a double-click does

1. It sets up the hive's own toolchain inside `~/OmegaHive`: micromamba from conda-forge, Python 3.12, SWI-Prolog
   10.1.14, PeTTa, janus-swi and the hash-locked Python packages (`install/macos/pins.sh` and `install/macos/locks/`
   pin each one). Homebrew is neither needed nor used. On an arm64 Mac a release that carries the prebuilt
   SWI-Prolog bundle uses it as it is; otherwise SWI-Prolog is built from source, which needs Apple's Command Line
   Tools, and macOS offers to install them on a Mac without them.
2. It sets up Create's Code service and the Tools app when the release carries them.
3. It puts the Omega Hive app in `~/Applications` and the hive's login item in `~/Library/LaunchAgents`.
4. It starts the hive as a launchd job of your login session, so closing Terminal leaves it running, and opens it in
   your browser through a one-time sign-in link.

Run from a newer release, it refreshes the hive's code in place and keeps its data and settings. Run from the same
release, it only puts the app and the login item in place again, starts the hive and opens it.
`~/OmegaHive/app/install/macos/omegahive.sh` opens, starts, stops or reports on the hive afterwards (`open`, `start`,
`stop`, `status`), and `autostart` and `uninstall` below come from it too.

## Opening it, and when you log in

Open Omega Hive from your Applications folder, Launchpad or Spotlight, or keep it in the Dock. It starts the hive if
it isn't running and opens it in your browser, signed in. `Start OmegaHive.command` in `~/OmegaHive` does the same
from Terminal.

The hive starts again by itself when you log in or restart your Mac, so schedules, wakeups and Assist go on. The
login item only starts the hive, with no browser window and no update question. Your last choice wins over it:

- A hive you turn off in its own page (Turn off) starts and stays off, as you left it, and its page is there to turn
  it back on.
- A hive you stop with `omegahive.sh stop` stays stopped at login until you open Omega Hive again.
- To stop it starting at login at all, turn its switch off under Allow in the Background in System Settings,
  General, Login Items, or run `~/OmegaHive/app/install/macos/omegahive.sh autostart off`. `autostart on` turns it
  back on, and `autostart status` says which. A refresh keeps your choice.

The login item writes what it did to `~/OmegaHive/logs/login.log`.

## Removing it

Run `~/OmegaHive/app/install/macos/omegahive.sh uninstall` in Terminal. It stops the hive and every job it started,
removes the Omega Hive app and the login item, and then asks you to type the folder's path to delete `~/OmegaHive`
as well, with your minds, chats and keys. Press Return alone to keep the folder.

## Updates

Before the hive starts, and every hour while it runs, `install/macos/update.py` reads its release's update channel.
It offers a newer release only when a statement signed with an Ed25519 key that the hive's own release trusts says
so, and you choose Update or Not now. The zip's sha256 must match the signed statement before the zip is unpacked,
and the unpacked copy's tree digest must match it before anything from that copy runs. The channel's keys can be
replaced by the next keys its trust file names, so a lost or retired key does not strand a hive. An update you take
from the Omega Hive app or the hourly offer runs its installer in a Terminal window of its own, where you can follow
it.

## What is checked, and what is not

- A first install checks integrity, not authenticity. The `.sha256` file beside each prebuilt file comes inside the
  same zip, so it shows that the file arrived whole, not who made it. Download a release only from the releases page
  of [omega-flagship/omegahive-installer](https://github.com/omega-flagship/omegahive-installer/releases).
- The zip is not signed with an Apple Developer ID or notarised yet, so macOS asks before its first run (System
  Settings, Privacy & Security, Open Anyway). Apple signing and notarisation come before a public release.
- The installer clears macOS's quarantine from each folder it unpacks before anything runs from it. In the prebuilt
  SWI-Prolog bundle and the janus-swi package, it then signs again, ad hoc and on your Mac, every Mach-O file that
  fails `codesign --verify`, since Gatekeeper refuses a quarantined, ad hoc signed binary as damaged. An ad hoc
  signature says nothing about who made the file.
- The Omega Hive app is made on your Mac by `osacompile` from a short AppleScript and signed there ad hoc, so it
  carries no quarantine and opens without a warning. It runs `omegahive.sh` from your hive's folder.
- Updates after the first install are checked against the signed statement, as above, so an update's origin is
  checked even though the first install's is not.
