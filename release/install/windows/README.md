# Omega hive for Windows

`Install OmegaHive.cmd` sets up your own Omega hive on Windows 10 (version 2004 or newer) or Windows 11 and opens
it in your default browser, signed in as its owner. It is the Windows twin of
`install/macos/Install OmegaHive.command`. In a release zip it is called `Install Omega.cmd`.

## What a double-click does

1. If WSL (the Windows Subsystem for Linux) is not on yet, Windows asks for permission to turn it on: an
   administrator prompt (UAC) for `wsl --install --no-distribution`. It is the only step that needs an
   administrator, and it comes only while WSL is off. If Windows then needs a restart, the window says so; after
   the restart, double-click Install Omega again and setup carries on from there.
2. It makes a Linux system of the hive's own, a WSL distro named `OmegaHive`, from the Ubuntu 26.04.1 image that
   WSL's own distribution list pins (about 400 MB, checked by its sha256). You are not asked for a Linux user name
   or password. Your Ubuntu, if you have one, is not touched. Canonical takes older point releases off its servers,
   so if that image's address no longer answers, the installer uses the Ubuntu 26.04 image WSL's list names at
   that moment instead. That image is not pinned: it is checked only against the sha256 in that list, the window
   says so, and it is used only from Canonical's release server (`releases.ubuntu.com`).
3. Inside that distro it runs the same setup the Mac installer runs (`install/macos/Install OmegaHive.command`):
   a pinned toolchain, SWI-Prolog built from source, PeTTa, the hash-locked Python packages, and Create's Code
   service and the Tools app when the release carries them. This takes about 5 minutes on a fast connection.
4. It starts the hive and opens it in your browser at `http://127.0.0.1:8700` (or the next free port), signed in
   through a one-time link that is never shown.

The hive keeps running after you close the window, until you sign out of Windows or restart. To open it again,
use the Start menu entry **OmegaHive**, or double-click Install Omega again.

Run from a newer release, Install Omega updates the hive's code in place and keeps its data, keys, minds and port.
Run from the same release, it only starts the hive and opens it.

## What is checked, and what is not

- `Install Omega.cmd` runs `Install-OmegaHive.ps1` with Windows PowerShell's `-ExecutionPolicy Bypass`. That applies
  to this one run of the script. The computer's execution policy is not changed.
- The release zip is not signed. `omegahive.tar.gz.sha256`, and the `.sha256` file beside each of Create's and the
  Tools app's archives, come inside the same zip, so they show that each file arrived whole, not who made it.
  Download a release only from the releases page of
  [omega-flagship/omegahive-installer](https://github.com/omega-flagship/omegahive-installer/releases).
- The Ubuntu image is pinned by its sha256, except when the installer falls back to the image WSL's list names
  (step 2 above), which is checked against the list's sha256 only.

## What it writes

- The `OmegaHive` WSL distro. Its disk lives in `%LOCALAPPDATA%\OmegaHive\wsl`, and everything the hive uses is in
  `~/OmegaHive` inside it.
- `%LOCALAPPDATA%\OmegaHive`, which also holds a copy of `Install-OmegaHive.ps1` for the Start menu and the logs
  of each run (`logs\windows-*.log`). The setup inside WSL logs to `~/OmegaHive/logs/install.log`, and the hive to
  `~/OmegaHive/logs/hive.log`.
- The Start menu entry **OmegaHive**.

In File Explorer the hive's folder is under **Linux**, **OmegaHive**, **home**, **omega**, **OmegaHive**.

## Removing it

In PowerShell or a Command Prompt:

```text
wsl --unregister OmegaHive
rmdir /s /q "%LOCALAPPDATA%\OmegaHive"
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\OmegaHive.lnk"
```

`wsl --unregister` deletes the hive and everything in it, its data and keys included.

## Files

- `Install OmegaHive.cmd`: the file you double-click. It runs `Install-OmegaHive.ps1` with Windows PowerShell 5.1.
- `Install-OmegaHive.ps1`: turns WSL on, makes the distro, runs the setup in it, starts the hive and opens it.
- `omegahive-wsl.sh`: runs inside the distro. It unpacks the release tarball and runs the shared setup from it.
- `test-Install-OmegaHive.ps1`: checks the installer's decisions with stand-ins for WSL, downloads, the
  administrator prompt and the browser. Run it on Windows with
  `powershell -NoProfile -ExecutionPolicy Bypass -File test-Install-OmegaHive.ps1`.

## The release zip

```text
Omega Hive vX/Install Omega.cmd                  install/windows/Install OmegaHive.cmd
Omega Hive vX/omegahive/Install-OmegaHive.ps1    install/windows/Install-OmegaHive.ps1
Omega Hive vX/omegahive/omegahive-wsl.sh         install/windows/omegahive-wsl.sh
Omega Hive vX/omegahive/RELEASE_NAME             the build's name, printed first
Omega Hive vX/omegahive/omegahive.tar.gz         one root folder omegahive/: the code at one commit, hive/ui/dist
                                                 built, RELEASE_COMMIT, RELEASE_VERSION, Create's
                                                 install/macos/omegacode-309df.tgz and the Tools app's
                                                 install/macos/omega-tools-4e57d67.tgz, each with its .sha256
Omega Hive vX/omegahive/omegahive.tar.gz.sha256
```

The code travels as one tarball because Windows' unzip keeps no Unix file modes, and WSL reads one file from the
Windows disk far faster than three thousand.
