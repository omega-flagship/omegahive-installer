# Restarting an installed Mac hive

This change proposes an installer-owned restart implementation for the Mac Studio prerequisite discussed on [#392](https://github.com/omega-flagship/omegahive/pull/392#issuecomment-6939862167). It needs Jon's acceptance before entering a tester build.

Run the installed launcher's `safe-restart` command:

```sh
"$HOME/OmegaHive/app/install/macos/omegahive.sh" safe-restart
```

The command checks this hive's installed commit, database and registered launchd job. It refuses while an update holds the updater's lock or any managed mind is not fully asleep. Deleted minds and external modules do not block a host restart. An unreadable input or a missing or ambiguous job refuses without restarting.

To approve restarting while minds are awake, the owner sets `ALLOW_AWAKE` to the exact full commit in this hive's `app/RELEASE_COMMIT` for that invocation. A different value refuses. The exception does not bypass the update lock, database checks or job checks.

The command holds a SQLite write transaction from the asleep check until `launchctl kickstart -k -p` starts the replacement. Current mind-start paths must write their starting state before starting a driver, so a concurrent wake cannot pass that check. A busy database refuses before restarting. The owner exception also takes this fence.

Launchd replaces only this hive's process and owns the replacement even if ending the old job also ends the requester. Code and update jobs keep their own lifetimes. There is no automatic retry after an error.

Mac startup names the delivered `safe-restart.py` through `HIVE_SAFE_RESTART_PATH` unless the owner supplied another path. Studio verifies its exact digest. A missing or changed file keeps sessions off. The existing adopted host-script digest still works for installations using that host path.

The pinned Studio release already contains its maker template. Linux and WSL do not use the Mac restart prerequisite: the existing non-Mac guard returns true, so this missing Mac script does not keep their Studio sessions off. Their other Studio prerequisites still apply.
