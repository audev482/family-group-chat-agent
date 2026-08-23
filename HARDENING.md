# Hardening the butler host

Written for the case where the box is on a public VPC rather than behind a home
router. Two boundaries matter, and they are easy to confuse:

| | Contains | Enforced by |
| --- | --- | --- |
| **Outer** | the butler *process* | systemd confinement in the unit file |
| **Inner** | what the *model* can do through its tools | bubblewrap + Landlock, in the kernel |

The inner one is the one that matters more, and it is the one people forget. Read
[the last section](#what-this-does-not-fix) before deciding this is enough.

## Least privilege, concretely

**No capabilities.** `CapabilityBoundingSet=` is empty. The butler binds no
privileged port, owns no device and changes no system state, so a kernel bug in
something it calls cannot be escalated through a capability it never needed.

**Read-only filesystem** except `$DSH_HOME` and the workspace (`ProtectSystem=strict`,
`ProtectHome=true`, `ReadWritePaths=`). `UMask=0077` so nothing it writes is
world-readable.

**Two syscall filters.** `@system-service` as the baseline, then
`~@privileged ~@resources ~@obsolete ~@cpu-emulation` removed on top.

**Other processes are invisible.** `ProtectProc=invisible` and `ProcSubset=pid`, so a
co-tenant's `/proc/<pid>/environ` — and therefore its credentials — cannot be read.

**Three address families**, `AF_INET AF_INET6 AF_UNIX`. `AF_NETLINK` is deliberately
absent; it is the usual route to interface and routing enumeration.

**Ceilings**: `MemoryMax=2G`, `TasksMax=512`, so a runaway loop cannot take the
machine with it.

### What is deliberately *not* locked down

`RestrictNamespaces=user pid mnt` permits three namespaces, and `PrivateUsers` is
unset. This looks like a gap and is the opposite.

Bubblewrap confines the agent's own shell by creating exactly those namespaces.
Denying them would disable the inner sandbox in order to harden the outer one — a
straight downgrade, because the inner boundary is what stands between an instruction
arriving in an email and this process's credentials. `SystemCallFilter` includes
`@sandbox` for the same reason.

`MemoryDenyWriteExecute=false` because Node's JIT needs writable-executable pages.
Stated rather than omitted, so its absence does not read as an oversight.

## The credential file is root-only

`/etc/dsh-butler/butler.env` is `0400 root:root`. The butler account cannot read it.

This works because systemd reads `EnvironmentFile=` as root during unit setup and
only then drops privileges — so the service starts normally while the account its
tools run as cannot `cat` the file. The deploy asserts this by actually attempting
the read as the butler user and requiring it to fail.

## The firewall is default-deny inbound

The butler **listens on nothing**. No web app in its profile, no API, no webhook: it
reaches Discord, Nextcloud, Yahoo and the model provider by opening outbound
connections, and every reply arrives on a connection it started. So its inbound
attack surface is already none, and the firewall's job is only to make that true of
the host.

`input` and `forward` default to `drop`. Established and related flows are accepted,
loopback is accepted, and ICMP is accepted — dropping ICMP breaks path-MTU discovery,
which then breaks TLS to some hosts in a way that takes a long time to diagnose.

**Set `admin_cidrs`.** Left empty, SSH is open to the internet and the play warns
about it every run. On a public VPC that is the difference between a keypair being the
only thing between the world and a shell on the box holding the family's mail
credentials, and the port not being reachable at all:

```yaml
admin_cidrs: ["203.0.113.4/32"]
```

### Why egress is not filtered

Because an IP allowlist here would be theatre. Discord, Yahoo and the model API all
sit behind CDNs whose address ranges change without notice, so the list would either
break the butler on a Tuesday or be broad enough to allow everything anyway.

If you need real egress control, the honest mechanism is an outbound proxy that
filters on SNI, with the butler's `HTTPS_PROXY` pointed at it and the firewall
dropping direct egress. That is a real piece of infrastructure, not a config line, so
it is not pretended at here.

## Patching

`unattended-upgrades` is enabled. A host that faces the public internet and runs a
model over untrusted input should not be a month behind on kernel patches.

## The deploy proves it, rather than asserting it

Hardening that silently failed is worse than none, because it is believed. Three
checks run at the end of every deploy and fail it:

1. **`systemd-analyze security dsh-butler`** must report an exposure level below 4.0.
   An unhardened unit scores about 9.6, so this catches a directive that did not apply
   — a typo, or a systemd too old to know it.
2. **Bubblewrap must still be able to create its namespaces**, run as the butler user
   under the real unit confinement. This is the check that matters most, because
   `SystemCallFilter` and `RestrictNamespaces` are exactly the kind of change that
   disables the inner sandbox with no visible error: shell calls would just start
   returning `SANDBOX_UNAVAILABLE`, which is safe and looks like nothing.
3. **The butler must fail to read its own credential file.**

## What this does not fix

Being direct about the residual risk, because it is the part that decides whether a
public VPC is acceptable.

**The butler reads email, so untrusted text reaches the model.** That is the whole
threat model: a message can contain instructions, and the model may act on them. The
mail tools mark that content as coming from outside the household and the persona is
told not to follow instructions found in it, but that is mitigation, not a boundary.
The kernel sandbox is the boundary, and it is why `danger-full-access` must never be
set on this host.

**A successful injection still gets whatever the sandbox allows.** Inside
`workspace-write` that is: read anything readable on the filesystem, write within the
workspace, and **make arbitrary outbound network connections**. Reading plus egress is
sufficient to exfiltrate anything the butler can read. The sandbox constrains damage
to the host; it does not constrain what leaves it. Egress filtering via a proxy is
the only thing that would, which is the strongest argument for building one.

**The agent can reach the family's data by design.** Its calendar, chores, mail and
ledger tools are the product. An injection does not need to escape the sandbox to
send an email or delete a chore — it just uses the tools. Nothing at the host level
addresses this; it is bounded by what plugins you install.

**The trust model documented elsewhere in this project assumes a walled Discord
channel.** `ARCHITECTURE.md` says the trust boundary is the channel wall, and there
are no authorization gates between family members — deliberately, at the household's
request. That is reasonable in a house. On a public VPC it means anyone who gets into
that Discord channel has the butler's full capability, so **the channel's own access
control becomes the security perimeter**, and it is not something this host can
enforce.

**Single-tenant assumptions.** One user, one profile, one ledger. Running two
households on one box would need per-tenant uids and separate `$DSH_HOME` roots, and
none of that is here.

### If this were mine on a public VPC

In rough order of value:

1. Put it on a private subnet and reach it through a bastion or Tailscale rather than
   opening port 22 at all. `admin_cidrs` is the cheap version of this.
2. Build the SNI-filtering egress proxy. It is the only control that turns a
   successful prompt injection from a data-exfiltration event into a failed one.
3. Review the tool surface. `expenses_export` is useful *because* the harness ships
   shell and filesystem tools — that capability and the injection risk are the same
   capability. If the analysis workflow does not earn its keep, removing those base
   rows removes the largest part of the risk.
4. Consider whether the butler needs to read mail at all. It is the only untrusted
   input path in the whole system.
