# OmegaHive: deploying on a Linux server

This runbook installs the private release on a Linux server, such as the SingularityNET compute server. It has **not yet been run end to end on Linux**. Record anything that differs.

## Fixed locations

Everything lives in one place, run by one service account:

| What | Where |
|---|---|
| Service account | `omegahive` |
| Code | `/opt/omegahive/app` |
| Python environment | `/opt/omegahive/venv` |
| PeTTa | `/opt/omegahive/PeTTa` |
| SWI-Prolog | `/usr/local` (10.1.14, built by `deploy/setup_runtime.sh`) |
| Data | `/var/lib/omegahive` |
| Settings | `/etc/omegahive/hive.env` |

## 0. Requirements

- **Linux with Landlock and unprivileged user namespaces.** Ubuntu 22.04 (kernel 5.15) qualifies. Check both:
  ```
  cat /sys/kernel/security/lsm
  cat /proc/sys/kernel/unprivileged_userns_clone
  ```
  The first must list `landlock`. The second must print `1`. If the file doesn't exist, that's also fine.
  On Ubuntu 23.10 and later (including 24.04 and 26.04), AppArmor also restricts unprivileged user namespaces:
  `cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns` prints `1`. Leave it at `1` and load the mind launcher's
  profile, `deploy/apparmor/omegahive-mind-launcher`, before the hive starts; the file gives the two commands and how to
  check it. It grants `userns` to the launcher, and every mind the launcher starts inherits it, as every mind may
  create user namespaces on 22.04. It attaches to the launcher inside a release under `/opt/omegahive/releases`, so
  code kept in `/opt/omegahive/app` as a plain clone, as in section 2 below, needs its path added to the profile and
  the same ownership and modes as a release.
  Whoever can execute the launcher chooses what runs under the profile, so keep each release root-owned and closed to
  other accounts, for example `chown -R root:omegahive` and `chmod -R u+rwX,g+rX,o-rwx` on it. Without the profile,
  mind isolation fails at `/proc/self/setgroups` and the launcher's message says it runs unconfined. The launcher runs
  on the interpreter `HIVE_SANDBOX_PYTHON` names when the hive's environment sets it (an absolute path), else on the
  hive's own interpreter.
- **What isolation does.** Each mind runs in private user, network, process, IPC and mount namespaces. Landlock limits it to its own folder plus the runtime. Its only way out is a relay to the hive's own ports.
- **If either requirement is missing,** the hive still runs, but it refuses to start minds (fail closed).
- **Tested on the target server.** The isolation tests passed on the SingularityNET server (Ubuntu 22.04, kernel 5.15, Landlock ABI 1) as a normal user, with no root needed.
- **Not included:**
  - Atlas and OmegaTruth, which are private and stay on Jon's Mac.
  - Any data from the Mac hive. The server starts empty.

## 1. Packages

```
sudo apt-get update
sudo apt-get install -y git build-essential cmake ninja-build \
  libssl-dev libgmp-dev libedit-dev libpcre2-dev libyaml-dev zlib1g-dev libarchive-dev sqlite3 curl acl
```

Node.js 20 or newer is needed for the UI build. If the distro's node is older, install it from NodeSource.

Python 3.12 is installed per user with `uv`, which needs no root (see step 2). Ubuntu 22.04 ships Python 3.10.

## 2. Service account, code and runtime

1. Create the account and directories:
   ```
   sudo useradd --system --create-home --home-dir /opt/omegahive --shell /bin/bash omegahive
   sudo mkdir -p /var/lib/omegahive /etc/omegahive
   sudo chown omegahive:omegahive /var/lib/omegahive
   sudo chmod 700 /var/lib/omegahive
   ```
2. Fetch the code and set up the runtime, as the service account:
   ```
   sudo -iu omegahive bash -lc '
     git clone <PRIVATE_REPO_URL> /opt/omegahive/app &&
     curl -LsSf https://astral.sh/uv/install.sh | sh &&
     ~/.local/bin/uv python install 3.12 &&
     ~/.local/bin/uv venv --python 3.12 --seed /opt/omegahive/venv &&
     /opt/omegahive/venv/bin/pip install -r /opt/omegahive/app/requirements.txt -r /opt/omegahive/app/hive/requirements.txt'
   ```
3. Build the runtime, as root:
   ```
   sudo /opt/omegahive/app/deploy/setup_runtime.sh
   ```
   This builds SWI-Prolog 10.1.14 from `swipl-devel` (tag `V10.1.14`; the main `swipl` repository has no such tag) against the hive's Python 3.12 and installs it into `/usr/local`. It then installs PeTTa at the reviewed pin `ae66fa8` and `janus_swi` 1.5.3. The build takes 10 to 20 minutes.
4. **What the script proves.** It stops with an error unless each of these holds exactly:
   - `janus_swi` returns `X = 2` for `X is 1+1` (Python→Prolog);
   - `library(janus)` returns `42` from Python's `operator.add(20, 22)` (Prolog→Python; PeTTa loads this on every MeTTa run);
   - SWI-Prolog reports version 10.1.14;
   - a small MeTTa program run through PeTTa prints exactly `42` as its last line.

   **How it keeps root separate from other accounts:**
   - The download and build run as a throwaway account, `omegahive-build`, in a fresh `mktemp` folder. It is created for this run and joins no group. It gets only pass-through access to `/opt/omegahive`, through an ACL that is removed afterwards.
   - Before root installs anything, all of its processes are killed and the account is deleted. Root then takes ownership of the tree.
   - Root keeps its logs and check files in root-only `mktemp` folders, never inside the build.
   - Root never runs the hive's Python. The service account reports its prefix, and root only checks that the path is correct.
   - Remaining exposure: uv installs Python per user, so the interpreter and venv sit in the service account's home and are writable by it. Only the service's own processes load them.

   SWI-Prolog's Python package searches for "Python", not "Python3". Without the `-DPython_` flags it quietly builds without janus, so the script checks for janus explicitly. The script also registers uv's `lib` folder with the loader (`/etc/ld.so.conf.d/omegahive-python.conf`).

   A warning, "Could not find platform dependent libraries <exec_prefix>", is harmless. Do not set `PYTHONHOME` for the service.

## 3. Build the UI

```
sudo -iu omegahive bash -lc 'cd /opt/omegahive/app/hive/ui && npm ci && npm run build'
```

## 4. Settings

1. Install the template:
   ```
   sudo cp /opt/omegahive/app/deploy/hive.env.example /etc/omegahive/hive.env
   sudo chown root:omegahive /etc/omegahive/hive.env
   sudo chmod 640 /etc/omegahive/hive.env
   sudoedit /etc/omegahive/hive.env
   ```
2. In that file, fill in:
   - the public URLs and the Google redirect, for this server's address;
   - `HIVE_ADMIN_EMAILS`;
   - optionally `HIVE_MEMBER_EMAILS`: these Google accounts may sign in as members without an invitation (see
     hive/API.md, Auth); removing an address later keeps the person until an admin disables them;
   - optionally `HIVE_SIGNIN_DOMAINS` (e.g. `singularitynet.io`): verified Google Workspace accounts of exactly that
     domain may sign in as members without an invitation (see hive/API.md, Auth); leave empty for invite only;
   - the Google client ID and secret;
   - or, before Google is set up, `HIVE_PUBLIC_PASSWORD=1` so members can sign in from outside with a password an
     admin makes on the People page (shown once; see hive/API.md, Auth, "Member passwords"). Once the Google client
     is filled in, members sign in with Google from outside and their passwords work only on this machine, except
     test accounts while `HIVE_PUBLIC_PASSWORD=1` stays set (below);
   - optionally the model key.

   Keep comments on their own lines; systemd reads this file.
3. In Google Cloud Console, add `https://YOUR.HOST/omegahive/api/auth/google/callback` to the OAuth client's redirect URIs.

### Member passwords before Google sign-in

On a non-J1 hive, an admin can use **People → Add a member with a password** while Google sign-in is not configured.
Give the member their email and the password shown once; the hive keeps only its salted scrypt hash. Resetting or
removing it ends that person's password sign-ins, and disabling them drops it. A password session always has member
authority, including after a role promotion. The operator uses the hive password with the email field empty.

Public member-password access additionally requires explicit `HIVE_PUBLIC_PASSWORD=1`. Once Google sign-in is
configured, public member-password login and earlier member-password sessions are refused, test accounts aside
(below); the same email continues with Google as the same person. The operator password login is refused from outside
whatever `HIVE_PUBLIC_PASSWORD` says, and the operator signs in with it on this machine only. No live setting is
changed by installing this code. J1 local-owner hives keep their one-time app sign-in and hide/refuse member passwords.

### Test accounts beside Google sign-in

A UI tester or an agent that drives a browser needs a password where people use Google. The hive has one test
account, and only its env file names it: keep `HIVE_PUBLIC_PASSWORD=1` set after filling in the Google client, set
`HIVE_TEST_ACCOUNT_EMAIL` and `HIVE_TEST_ACCOUNT_PASSWORD` (at least 10 characters, one line, no single quote, no
trailing backslash), and restart. The hive makes that member, or marks the member who has that email, with that
password. That account signs in from outside with its email and password, beside **Continue with Google** on the
sign-in card; everyone else is refused and continues with Google. People shows the mark but cannot set it.

- To change the password, change the variable and restart: the account's password sessions end.
- To end it, unset both variables (or give another address) and restart: nobody else keeps a mark.
- A former test account keeps its password. It no longer counts from outside, but it still works on the hive's own
  machine: remove it on People (Remove password) if it should not.
- Disabling the test account on People drops its mark with its password. Re-enabled, it is marked again, with the
  variable's password, at the next restart.
- A bad setting stops the hive at start with an error naming the variable, never the password. An admin's address
  and a disabled person are skipped (logged), never made the test account.
- Without `HIVE_PUBLIC_PASSWORD=1` no password works from outside, the test account's included.

### Free inference

To let people's minds think without a key of their own, put the deploy's inference key in `HIVE_FREE_INFERENCE_KEY` and,
unless it is a Singularity Compute key, the OpenAI-compatible endpoint it belongs to in `HIVE_FREE_INFERENCE_URL`
(https, or plain http to `127.0.0.1` for a stand-in; any other address turns free inference off rather than send the key
there). An ASI Cloud key needs `HIVE_FREE_INFERENCE_URL=https://inference.asicloud.cudos.org/v1`: without it the hive
sends the key to the default, Singularity Compute's endpoint. Then restart. First Light offers **Use free inference** to
everyone the hive invited: owners, members and guests. It names the model and says this hive's deploy provides it, and
one press moves the person's own mind onto the first model in `HIVE_FREE_INFERENCE_MODELS` (default
`minimax/minimax-m3.1-flash`). Only the listed models run on the key: a mind set to another one, or to one later taken
off the list, is refused before anything is sent.

Two limits bound it, each counted per UTC day before a call goes out:

- each person's `HIVE_FREE_INFERENCE_DAILY_CALLS` model calls (default 200). Everything their minds do counts toward
  them, the minds' replies in rooms and their work on goals too, so a mind busy with goals can use up its person's day;
- the whole hive's `HIVE_FREE_INFERENCE_HIVE_DAILY_CALLS` (default 2000), so many accounts can't multiply what the key
  spends.

Past either, a mind is refused in plain words until midnight UTC, or until its person adds a key of their own. 0 for
either turns free inference off. A call that ends before it is sent, refused or cancelled, doesn't count. The calls
are recorded with their tokens at no cost to the hive, so no limit on the Limits page counts them.

Both limits are this hive's alone. Each hive counts only its own calls, so a key that several deploys share is bounded
across them only by its own limits at its provider. Set those limits too, as the last bound.

A key also has its own limit on calls a second at its provider, shared by every hive the key is in, so ask the provider
to raise it before many people use it at once. When the endpoint answers 429, the hive waits and tries the call again,
up to four times. It waits as long as the answer asks, up to 8 seconds each time, so up to about 32 seconds in all;
when the answer doesn't say, it waits a random time under 1, 2, 4 and then 8 seconds, under 15 seconds in all. An
answer asking for a longer wait isn't tried again. A call still refused ends in plain words, "Free inference is busy
right now", and counts toward no one's calls; an Ask turn ends with those words instead of failing.

Public visitors, anyone who signs in on a public hive without an invite, are left out: First Light doesn't offer
them free inference and their minds' calls on it are refused. Set `HIVE_FREE_INFERENCE_VISITORS=1` to include them.

The Ask answers as a person's own mind with that mind's model, so once their mind thinks with free inference their
Asks do too, counted in the same calls a day. The Ask's other turns use `HIVE_ASK_CONDUCTOR_MODEL`. On a hive with no
other model key, set it to a free model too (`HIVE_ASK_CONDUCTOR_MODEL=free/minimax/minimax-m3.1-flash`), and each such turn
counts against the calls of the person who asked.

The key stays in this file. No page, log line or answer shows any of it, to admins either, and nobody can assign it to
a mind or check it from the hive. To stop, unset it and restart: a mind left on free inference is then refused with
words saying so, until its person chooses another way for it to think.

Free inference is separate from `ASI_API_KEY`. A hive whose installer was given an ASI Cloud key has it there, and that
key is the hive owner's for ASI Cloud's own provider (`asicloud`). Its model `asi1-mini` costs $0: calls on it pass
the same spending checks as any priced model but use up none of a money limit, so only the key's limits at ASI Cloud
bound how many there are.

Install the pinned `xkcdpass==1.30.0` from `hive/requirements.txt` with the deployment's ordinary dependency step.
The packaged EFF long list must be present and readable at startup; the server refuses a missing or shortened list,
including on a J1 host, rather than substitute a system dictionary. Do not install it into the running hive by hand
as part of source review. Public guess counters are uniform for member and unknown emails and bounded in memory;
their state restarts with the process and can be uniformly evicted when full. See the API Auth section for details.

## 5. Mind isolation

Minds run in the OS sandbox unless `HIVE_MIND_SANDBOX=0` (`hive.env.example` sets `1`, which is the same). At start the
hive starts one test process through the sandbox and prints what it found, `[hive] mind sandbox: on (landlock)`, or
`mind sandbox: unavailable, so minds won't start: <why>`. On Ubuntu 23.10 and later the usual why is AppArmor's userns
restriction with the launcher's profile not loaded (section 0). Only the local driver runs minds in the sandbox, so with
`HIVE_DRIVER=docker` the line says it covers minds on the local driver only. Each mind starts through
`hive/supervisor/landlock.py`:

| Boundary | How it is enforced |
|---|---|
| Files | A private filesystem view: the mind sees ONLY the system runtime and runtime folders (read-only), a short literal list of loader/libc files from `/etc` (never `/etc` as a whole, where `hive.env` lives), a private `/tmp`, and its own folder (read-write). Nothing else on the server exists for it. Landlock adds the same rules on top. |
| Network | Its own network namespace, containing only loopback. `127.0.0.1` answers on the hive's port, through a relay to the hive, and on the ports in `HIVE_MIND_SANDBOX_PORTS` (`8724`, the Code service, when neither it nor `HIVE_PORT` is set; `hive.env.example` sets `HIVE_PORT`, so none). There is no route for anything else, TCP or UDP, so a channel that goes online from the mind itself, such as Telegram, doesn't work. |
| Processes | Its own pid, IPC and mount namespaces, with a private `/proc`. It cannot see, signal or trace hive processes. |
| Local sockets | A seccomp filter stops the mind creating addressable unix sockets (any `socket(AF_UNIX)`, datagram/seqpacket pairs, io_uring), so no local service on the server is reachable. Connected stream pairs, which Python uses internally, still work. |

If isolation cannot be set up, the launcher exits with code 78 and the mind does not start. **Never set `HIVE_MIND_SANDBOX=0` on a shared server.**

To test isolation on a new server before running the hive (the short `--basetemp` keeps socket paths under the 108-byte limit):

```
sudo -iu omegahive bash -lc 'cd /opt/omegahive/app && /opt/omegahive/venv/bin/python -m pytest -q --basetemp=/tmp/ohsbx hive/tests/test_mind_sandbox_linux.py'
```

## 6. Run it

Create `/etc/systemd/system/omegahive.service`:

```
[Unit]
Description=OmegaHive
After=network.target

[Service]
User=omegahive
Group=omegahive
EnvironmentFile=/etc/omegahive/hive.env
Environment=PATH=/usr/local/bin:/opt/omegahive/venv/bin:/usr/bin:/bin
Environment=VIRTUAL_ENV=/opt/omegahive/venv
WorkingDirectory=/opt/omegahive/app
ExecStart=/opt/omegahive/venv/bin/python -m hive
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Start it:

```
sudo systemctl daemon-reload && sudo systemctl enable --now omegahive
```

Then set up nginx or Caddy to terminate TLS and proxy `/omegahive/` to `127.0.0.1:8700`, including websockets on `/omegahive/api/events`.
Keep the `/omegahive/` prefix on the way to the hive and send `X-Forwarded-For`: the hive treats a request as coming from
outside when it arrives under the prefix or carries a proxy's header, and a proxy that strips the prefix and adds no header
looks to the hive like a browser on its own machine. Caddy does both by default:

```
YOUR.HOST {
    reverse_proxy /omegahive/* 127.0.0.1:8700
}
```

With nginx, give `proxy_pass` no path, so the prefix reaches the hive, and set the headers yourself:

```
# in the http block
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

# in the server block for YOUR.HOST
location /omegahive/ {
    proxy_pass http://127.0.0.1:8700;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
}
```

## 7. Health checks

```
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8700/omegahive/
curl -s http://127.0.0.1:8700/omegahive/api/auth/methods
journalctl -u omegahive -n 50
```

- The first check should return `200`.
- The second should show `sso.enabled` as `true` once Google is configured.
- The log should contain no `Traceback`.

**Full test suite on the server.** Run it from a git checkout. Code tests need a real repository, so a `git archive` copy fails them.
```
sudo -iu omegahive bash -lc 'cd /opt/omegahive/app && /opt/omegahive/venv/bin/python -m pytest -q -p no:cacheprovider --basetemp=/tmp/ohsuite hive/tests'
```
One failure is expected: `test_every_relayed_route_exists_in_the_intended_service_release`, until the Code service release is installed.

Then sign in with Google as an admin email, and check **Profile**.

To check mind isolation, start one mind with a mock model:

```
ls /var/lib/omegahive/sandbox/
```

There should be a `*.landlock.json` profile, and the mind's log should not contain "mind isolation failed".

## 8. Back up and roll back

- **Back up:** `sudo systemctl stop omegahive`, copy `/var/lib/omegahive` whole, then start the service again.
- **Roll back:**
  ```
  sudo -iu omegahive bash -lc 'cd /opt/omegahive/app && git checkout <previous-commit> && cd hive/ui && npm ci && npm run build'
  sudo systemctl restart omegahive
  ```
  The data directory is not changed by a code rollback.
- **Remove:**
  ```
  sudo systemctl disable --now omegahive
  ```
  Then delete `/opt/omegahive`, and delete `/var/lib/omegahive` only after a backup.
