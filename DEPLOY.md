# Deploying the butler

One butler, one Linux box, one command.

```bash
cp deploy/secrets.example.yml deploy/secrets.yml
$EDITOR deploy/secrets.yml          # five credentials
$EDITOR deploy/group_vars/all.yml   # who the family is, which server, which room
ansible-playbook -i deploy/inventory.ini deploy/butler.yml --ask-become-pass
```

The play runs **on the machine you are sitting at** — `inventory.ini` says
`ansible_connection=local`. Modelling one household server as a fleet would add an
inventory, an SSH path and a key to rotate, all to reach localhost.

Debian or Ubuntu. The play asserts this rather than guessing a package manager, and
tells you what to do instead if you are on something else.

**Putting this on a public VPC?** Read [HARDENING.md](HARDENING.md) first, and set
`admin_cidrs` before you run. The play locks the host down and proves it did, but the
residual risk — the butler reads email, so untrusted text reaches the model — is a
design property, not a configuration one.

## What it does

| | |
| --- | --- |
| Installs | Node 22, pnpm 11.7.0, and the `dsh` launcher, all pinned |
| Creates | a `butler` system account with no login shell |
| Copies | the workspace to `/opt/dsh-butler`, excluding `node_modules` and `lib` |
| Builds | all thirteen packages, as the butler user |
| Writes | `/etc/dsh-butler/butler.env`, root-owned, group-readable only |
| Assembles | the profile at `/var/lib/dsh-butler/profiles/butler` from all thirteen bundles |
| Installs | one systemd unit with `Restart=always` |
| Verifies | that the service is active and **not** restarting in a loop |

`node_modules` and `lib` are excluded from the copy deliberately: building on the host
is what avoids a developer laptop's native modules being carried onto a Linux server,
which fails in ways that take an evening to find.

## There is no crontab

The obvious way to make an agent do something every morning is cron, and this
deliberately does not. It looks like an omission, so it is worth stating.

The butler already schedules in-process. `dsh-briefing` and `dsh-planner` each own a
timer chain whose next run is computed from the family's own wall clock, with both
daylight-saving transitions covered by tests. What an in-process timer cannot survive
is the process dying — and on a single host that is systemd's job:

```ini
Restart=always
RestartSec=10s
StartLimitIntervalSec=0    # never stop trying
```

A cron entry would mean a second process model: a fresh `dsh` per run, with no view of
the live conversation in the room, its own credential path, its own log stream, and its
own copy of the bundle composition to keep in step with this play. Two artifacts where
one will do — and the second silently rots the first time somebody adds a plugin here
and forgets the crontab.

What holds the process open is the Discord gateway connection, not the timers; they are
`unref`'d on purpose, so the channel is what makes this a service.

## The secrets

Five are required, in `deploy/secrets.yml` (git-ignored; `ansible-vault encrypt` it if
you like). The play **refuses to run with any of them blank** rather than writing an
environment file that would fail later with a confusing error.

| | |
| --- | --- |
| `DEEPSEEK_API_KEY` | the model provider |
| `NEXTCLOUD_APP_PASSWORD` | Settings → Security → Devices & sessions |
| `YAHOO_APP_PASSWORD` | Account Security → Generate app password |
| `DISCORD_BOT_TOKEN` | Developer Portal → your application → Bot |
| `TRICOUNT_TOKEN` | the app → ⋯ → Share, the token from the link |

All five are app passwords or tokens, never an account password. Every plugin reaches
them by *reference* — the configuration names a credential, the provider reads the
environment, and the secret never appears in a config file, a log line or an event.
That indirection is also what lets a rotated password take effect on the next
operation rather than the next restart.

### One thing to do after the first run

The Tricount device identity. Leave `TRICOUNT_APP_ID` and `TRICOUNT_PUBLIC_KEY` blank
the first time; the butler mints an identity and reports it once:

```bash
journalctl -u dsh-butler | grep -A3 tricount/device
```

Copy both values into `secrets.yml` and re-run the play. Without this a new anonymous
user is registered on the ledger's host on **every restart** — the ledger still works,
which is exactly why this is worth doing deliberately rather than noticing in a year.

The play's closing message reminds you if it is still unset.

## Configuring the household

`deploy/group_vars/all.yml` is the whole of it, and it is safe to commit. It renders
into the profile's own patch layer, which is applied *after* every bundle layer — so it
overrides what each package ships without modifying any package, and a harness upgrade
brings its changes through untouched.

Three settings have no possible default and are asserted before anything is installed:

- `discord.channel_id` — the butler would have nowhere to speak
- `nextcloud.username` — an app password does not say whose account it is
- `mail.address` — the butler would not know which mailbox is the family's

Mail hosts and ports are **not** in the config: `preset: yahoo` supplies them, because a
typo in a port number is a connection failure with no obvious cause.

## Where things live

```
/opt/dsh-butler                      the source, rebuilt on each deploy
/etc/dsh-butler/butler.env           credentials, 0640 root:butler
/var/lib/dsh-butler                  $DSH_HOME — profiles, sessions, transcripts
/var/lib/dsh-butler/profiles/butler  the assembled profile and its patch layer
/var/lib/dsh-butler/workspace        the session cwd, where expense exports land
```

One root for all state, matching the harness's own design: a backup is one directory
and a teardown is one `rm -rf`.

That last path matters for `expenses_export` — it is where the CSV is written, and so
where the butler's own shell and filesystem tools find it when asked to chart something.

## Checking it worked

The play does more than start the service, because "started" only means systemd forked
it. A butler that crashes on a bad token is restarted forever and would look healthy
otherwise, so the play reads `NRestarts` and fails if it is climbing.

Then say hello in the Discord channel. If it answers, everything below it — the model,
the session store, the persona — is working.

```bash
systemctl status dsh-butler
journalctl -u dsh-butler -f
```

The events worth watching, none of which carry a secret or an amount:

| | |
| --- | --- |
| `discord/session` | `resumed: false` is expected only on a room's first ever message |
| `caldav/request` `mail/request` `tricount/request` | one per call, with timing |
| `tricount/device` | the identity to pin |

## Changing something

Re-run the play. It is idempotent: the copy uses rsync's itemised output to decide
whether anything moved, the build is skipped when nothing did, and the service restarts
only when the source, the credentials, the profile or the unit actually changed.

To add a plugin, add it to `deploy/group_vars/packages.yml` and re-run. The play asserts
that every package reached the profile's layer stack — a package whose manifest does not
declare `dsh.bundle.patch` installs as an ordinary dependency and contributes no plugin
rows, which would otherwise be present and silently inert.

## Rolling back

```bash
systemctl stop dsh-butler
git -C /path/to/checkout checkout <last-good>
ansible-playbook -i deploy/inventory.ini deploy/butler.yml --ask-become-pass
```

Nothing the butler has written is lost by doing this. The calendar, the chores, the
planning cycles and the ledger all live on Nextcloud and Tricount, not on the host —
which is the same property that lets the family edit any of it from their phones. The
only host-local state is the session transcripts under `$DSH_HOME`, and those are
append-only.

## Verified

The play passes `ansible-lint` at its `production` profile, `yamllint`, and
`ansible-playbook --syntax-check`. All three templates were rendered and checked: the
environment file parses as `KEY=VALUE`, the unit parses as an INI with `Restart=always`,
and every row id and configuration key in the generated profile patch was matched
against the actual schema of the package that owns it.
