# dsh-caldav

Registers `ctx.caldav`: discovery, reads, and ETag-guarded writes against one or
more CalDAV servers. It is the transport half of the calendar and chore
capabilities — `dsh-calendar` and `dsh-chores` are built on it — and it is what
you want if you need to speak CalDAV to a server and nothing more.

Nothing in this package knows the word "family", and nothing above it knows the
protocol. That separation is the point: the seam speaks VEVENT and VTODO over
HTTP; meaning lives upstream. Nor does it really know "Nextcloud". The Nextcloud
Calendar and Tasks apps are themselves CalDAV clients, so speaking plain CalDAV
is exactly what makes a chore the butler creates a first-class task in the
Nextcloud UI, on phones, and in any other client. The only Nextcloud-shaped fact
here is that `davPath` defaults to `remote.php/dav`.

## Credentials, and why the auth header is not cached

Configuration carries `passwordRef`, a credential *reference* — a POSIX-style
environment-variable name, never the secret. A pasted password cannot
syntactically be a reference, so it fails loud at load. The password is resolved
through `ctx.credentials` inside each operation and dropped on return.

What the seam caches between operations is discovery: the principal and
calendar-home URLs plus the collection list, bounded by `discoveryTtlMs` (five
minutes by default). It deliberately does **not** cache the Basic authorization
header. A Basic header is `base64(user:password)`, so caching it would cache the
secret inside it and keep a rotated app password from taking effect until the TTL
lapsed. Instead the header is recomputed per operation from the freshly resolved
credential, which is what lets a rotation reach the very next request. A 401 or
403 mid-session drops the cached discovery so the next call logs in again.

## Reads, writes, and what survives them

Reads take an explicit `component`. This is not optional in practice: `tsdav`
defaults its `calendar-query` filter to `VEVENT`, so a VTODO read that omitted it
would silently return events rather than chores. The seam builds the correct
`VCALENDAR → component` filter for you.

Every write is a **read-modify-write of the original iCalendar text**. Only the
properties you asked to change are touched; everything else is re-serialized
untouched, so `VTIMEZONE` blocks, `VALARM` alarms, `RRULE` recurrences,
Nextcloud's `X-OC-*` extensions, and any property a future client adds all
survive an edit. Rebuilding an object from parsed fields would quietly delete
them. Writes are guarded by the ETag the object was read with; a 412 or 409 is
surfaced as a `conflict` telling the caller to re-read and re-apply. Instants are
written as UTC and whole days as `VALUE=DATE`, which keeps the seam free of a
shipped time-zone database while staying valid iCalendar.

## API surface

- `list()` — configured servers, names and URLs only, never secrets.
- `calendars(options?)` — collections on a server, with an optional component filter.
- `calendar(name, options?)` — resolve one collection by display name or URL.
- `objects(options)` — read VEVENTs or VTODOs from a collection, optionally within a time range; each record carries the ETag a later write needs.
- `create(options)` — create one object from iCalendar text, UID as the file name.
- `update(options)` — replace one object, guarded by its ETag.
- `remove(options)` — delete one object, guarded by its ETag.
- `probe(server?)` — sign in and report every collection and its components, for diagnosing a fresh install.

The module also re-exports the iCalendar helpers (`parseObject`, `readEvent`,
`readTodo`, `writeText`, `writeWhen`, `writeCategories`, `createObject`, `touch`)
that the meaning packages build on.

## SDKs and testing

`tsdav` and `ical.js` are optional peers, loaded lazily through the
`internals.loadSdk` seam. The package mounts, typechecks, and tests without them,
and a household that never configures a server never needs them; a missing
install is reported as an actionable message rather than a load-time crash. The
specs substitute that seam with a fake server, so the whole suite runs with no
network.

Every completed operation emits `caldav/request` carrying `{ server, operation,
durationMs, ok }` and no calendar content, so timing can be logged without
leaking what was read.

Failures carry a `CalDavError` with a stable `code` — including
`credential-unconfigured`, `discovery-failed`, `calendar-not-found`,
`calendar-ambiguous`, `component-unsupported`, `conflict`, and `sdk-missing` —
and never echo a credential value.

```yaml
- insert:
    - id: caldav
      name: 'dsh-caldav'
      config:
        defaultServer: home
        servers:
          home:
            baseUrl: 'https://fie.nl.tab.digital'
            username: 'your-nextcloud-username'
            passwordRef: 'NEXTCLOUD_APP_PASSWORD'
```

See the root README for install, the optional-peer list, and app-password setup.
