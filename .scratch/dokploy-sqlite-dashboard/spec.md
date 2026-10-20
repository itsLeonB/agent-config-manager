# Spec 0001 — Containerized dashboard on Dokploy, with SQLite-backed storage

Status: ready-for-agent

## Problem Statement

The dashboard only exists while I remember to start it. It runs as `bun run dev` from a
terminal, and the data it renders only exists after I remember to run `node scan.cjs` in a
second terminal. Nothing survives a reboot, nothing refreshes on its own, and the "missing"
comments I write on mismatched plugins live in one browser's `localStorage` — they vanish
when I switch browsers or clear site data. Config that drives the scan (`skipPaths`, the env
tool list, the projects root) can only be changed by hand-editing JSON files and re-running a
CLI, so it is effectively frozen.

## Solution

The dashboard becomes a container image I deploy once into my locally-run Dokploy instance,
reachable at `acm.localhost`. Dokploy starts it at boot and restarts it on failure, so the
dashboard is simply always there.

Inside the container the scanner runs on a schedule by itself, so the data is current without
me running anything. A rescan button in the UI forces a scan on demand. All state — scan
snapshots, cloud snapshots, settings, and the missing-counterpart comments — moves into one
SQLite file on the host's disk. A new settings page in the dashboard edits the scan config
instead of me editing JSON by hand, and comments become server-side, so they follow me to any
browser.

## Ticket Breakdown

One spec, two tickets, cut in this order. Phase 1 is independently deployable and verifiable,
so it ships first and phase 2 builds on a working container.

- **Phase 1 — Container and autostart**: image, Dokploy deployment, scan at start and on an
  interval, rescan button with its origin guard, atomic snapshot write, published port and the
  `acm.localhost` route.
- **Phase 2 — SQLite store and settings**: single store module, snapshot blob plus comment and
  config tables, settings page, server-side comments, cloud file ingestion, retirement of the
  local JSON file.

## User Stories

### Deployment and startup

1. As the machine's owner, I want to deploy the dashboard as a single Docker image into Dokploy,
   so that I do not install Bun, Node, or anything else on the host to run it.
2. As the machine's owner, I want Dokploy to start the dashboard automatically when the machine
   boots, so that I never think about starting it.
3. As the machine's owner, I want the dashboard to come back automatically after a crash,
   so that a failed process does not silently leave me with a dead page.
4. As the machine's owner, I want the dashboard reachable at `acm.localhost`, so that the URL
   is memorable and does not depend on a port number.
5. As the machine's owner, I want the container port also published on the host, so that I
   still have a way in when Traefik or Dokploy misbehaves.
6. As the machine's owner, I want the dashboard to inventory *this* machine's Claude
   configuration, so that the data describes the machine I actually work on.
7. As the machine's owner, I want to redeploy by pushing a commit, so that updating the
   dashboard is the same motion as updating any other repo.
8. As the machine's owner, I want the container to read my home directory and nothing else,
   so that the dashboard never has write access to my workstation's config.
9. As the machine's owner, I want one env value (`HOST_HOME`) to be the only host-specific
   setting, so that pointing the same image at a second machine is a config change, not a
   rebuild.
10. As the machine's owner, I want the image to start cleanly with an empty database, so that
    a fresh machine needs no manual seeding step.

### Scanning

11. As the machine's owner, I want a scan to run automatically when the container starts,
    so that the first page load has data even after a reboot.
12. As the machine's owner, I want scans to repeat on an interval, so that newly installed
    plugins and skills show up without me doing anything.
13. As the machine's owner, I want the interval configurable, so that a fast-moving setup day
    and a quiet month can both have a sensible cadence.
14. As the machine's owner, I want the interval change to take effect without a redeploy,
    so that tuning it does not mean a container restart.
15. As the machine's owner, I want a rescan button in the dashboard, so that I can see the
    effect of a config change immediately instead of waiting for the next tick.
16. As the machine's owner, I want the rescan button to show that it is working, so that I do
    not click it repeatedly wondering whether anything happened.
17. As the machine's owner, I want the page to update itself after a rescan, so that I do not
    have to reload manually.
18. As the machine's owner, I want a failed scan to leave the previous snapshot intact, so that
    a transient error never blanks the dashboard.
19. As the machine's owner, I want to see when the current snapshot was taken, so that I can
    judge whether stale-looking data is actually stale.
20. As the machine's owner, I want a scan that runs at the same moment as a page read to never
    produce a half-written snapshot, so that the dashboard never falsely claims the database
    is missing.

### Storage

21. As the machine's owner, I want all state in one SQLite file on the host, so that backing up
    or inspecting the dashboard's data is copying one file.
22. As the machine's owner, I want no new runtime dependency for SQLite, so that the image
    stays small and needs no native build step.
23. As the machine's owner, I want scan snapshots kept as snapshots rather than hand-picked
    fields, so that adding a new scanned detail never requires a schema migration.
24. As the machine's owner, I want past snapshots retained, so that a future "what changed
    since yesterday" view is possible without re-architecting.
25. As the machine's owner, I want the dashboard's rendering to keep working exactly as it does
    now, so that moving storage does not change what I see.
26. As the machine's owner, I want the cloud snapshot to still be produced by the existing
    `/refresh-cloud` agent command, so that I do not relearn that workflow.
27. As the machine's owner, I want the cloud snapshot picked up automatically once
    `/refresh-cloud` writes it, so that I never have to remember a second step.
28. As the machine's owner, I want the transitional JSON files gone once SQLite is in place,
    so that there is exactly one source of truth and no ambiguity about which is stale.

### Settings

29. As the machine's owner, I want a settings page in the dashboard, so that changing scan
    behaviour does not mean opening an editor and a shell.
30. As the machine's owner, I want to edit the projects root, so that scanning a directory other
    than `~/Projects` is a field, not a CLI argument.
31. As the machine's owner, I want to add and remove skip paths in the UI, so that noisy
    directories can be excluded without hand-editing JSON.
32. As the machine's owner, I want to set the scan interval in the UI, so that cadence is one
    visible number rather than an env var I have to remember.
33. As the machine's owner, I want to add, edit and remove environment tools in the UI, so that
    tracking a new CLI is a form entry, not a code or file change.
34. As the machine's owner, I want invalid settings rejected in the field that is wrong, so that
    I know what to fix without guessing.
35. As the machine's owner, I want a settings save to confirm success, so that I am not left
    wondering whether the click registered.
36. As the machine's owner, I want saving settings to be an explicit action, so that a
    half-typed skip path never reaches the scanner.
37. As the machine's owner, I want an unconfigured install to behave sensibly, so that the app
    works before I visit settings at all.

### Comments

38. As the machine's owner, I want my "why is this missing" comments stored server-side, so that
    they survive a browser change and a cache clear.
39. As the machine's owner, I want comments attached to the same mismatched item as today, so
    that nothing about the existing dashboard's behaviour changes.
40. As the machine's owner, I want a comment I edit to overwrite the previous one, so that there
    is one current explanation per item rather than a history I have to read through.

### Safety

41. As the machine's owner, I want the dashboard reachable only from this machine, so that my
    configuration inventory is not on my network.
42. As the machine's owner, I want settings writes rejected when they do not come from the
    dashboard's own origin, so that a random web page cannot reconfigure my scanner.
43. As the machine's owner, I want it understood and documented that the env tool check command
    is executed as a shell command, so that the "trusted local tool" assumption is explicit
    rather than assumed.
44. As the machine's owner, I want a wrong deploy to be recoverable by redeploying the previous
    commit, so that a bad change costs a click rather than a data loss.

## Implementation Decisions

**Deployment target.** A Dokploy *Application* service (not a Compose service): Dokploy builds
the repo's Dockerfile from GitHub, runs one replica on the existing Swarm, and supplies the
restart-on-boot behaviour. Compose was rejected because Dokploy requires its relative `files/`
mount convention, which fights the host-home bind mount. Auto-deploy on push is on.

**Runtime split.** Build stage uses Bun (`bun install`, production build). Runtime stage is a
slim Node image running the built server entrypoint. The scanner is spawned with the same
interpreter as the serving process, so dev (Bun) and prod (Node) both work without branching.

**Host access.** The host home directory is bind-mounted read-only at the *same absolute path*
inside the container, and the container's `HOME` is set to that path. Same-path mounting is the
decision that keeps every absolute path already stored in skip-path config and in snapshots
meaningful inside the container. One env value (`HOST_HOME`) feeds both the mount and `HOME`.

**Data location.** The repo's existing `database/` directory is bind-mounted read-write into the
container. It holds the SQLite file and remains the drop point for the cloud snapshot file,
because `/refresh-cloud` runs on the host with no knowledge of the database. A Docker-managed
named volume was rejected: it would hide the data from the host and break that drop point.

**Scan schedule.** One background loop in the container: scan once at start, then every
interval. The interval is resolved each tick from, in order: the stored config value, then
`SCAN_INTERVAL_MINUTES`, then a 15-minute default, floored at 1 minute so a zero or negative
value cannot spin the scanner.

**Rescan.** A POST server function spawns the scanner, waits for exit, and returns the new
snapshot's counts; the route's loader is invalidated so the page re-renders. Rejected
alternative: a background job with polling — it needs job state and adds nothing for a scan
that finishes in seconds.

**Storage shape.** One SQLite file, accessed through `node:sqlite` (built into the runtime,
verified working under both Bun and Node here — no dependency, no native build, no flag).
Snapshots are stored as blobs, not normalized tables:

```
snapshots(id INTEGER PRIMARY KEY, created_at TEXT, kind TEXT, data TEXT)
  kind: 'local' | 'cloud'
comments(key TEXT PRIMARY KEY, text TEXT, updated_at TEXT)
config(key TEXT PRIMARY KEY, value TEXT)   -- JSON-encoded
```

Blob storage is the decision that keeps the existing dashboard components, their props, and the
existing type definitions untouched: "latest snapshot" is the highest `id`, and history exists
for free. Normalized per-plugin/per-skill tables were rejected as a five-hour rewrite of every
dashboard component for a feature nobody asked for yet.

**Single store module.** All SQLite access sits behind one module with a small surface:
save/get latest snapshot by kind, read/write config, read/write comments, open by file path.
Nothing else in the app imports `node:sqlite`. This is the only new seam in the codebase.

**Config model.** Config lives in the database under four keys: projects root, scan interval,
skip paths (list), environment tools (list of id, name, check command, install command).
Environment variables supply defaults only; a stored value always wins. Settings are read at
scan time, so saving them takes effect on the next tick without a restart.

**Cloud ingestion.** `/refresh-cloud` is unchanged and keeps writing its JSON file into the
mounted data directory. The scanner's startup path and every tick check that file's modification
time and store a new cloud snapshot when it changed. Rejected alternatives: rewriting the slash
command to call an HTTP endpoint (new instructions to maintain for an agent-driven workflow),
and keeping the cloud file as a live read (splits truth across two storage mechanisms).

**Trust model.** The app is a single-user, loopback-only tool with no authentication. Because the
env tool check command is executed as a shell command by the scanner, every mutating server
function (rescan, save settings) validates that the request is same-origin before acting, so a
cross-site POST from an unrelated page cannot reconfigure the scanner.

**Settings page.** A new route holding all four config areas in one place, built in the existing
visual language rather than a new design system. Interaction rules taken from the local UI
guidance: visible labels, validation on blur rather than submit-only, an error summary that
receives focus when a save fails, explicit save with a pending state that disables the control,
and a distinct success state. Rejected alternatives: inline editing inside the existing
read-only dashboard components (touches all seven of them), and a raw JSON textarea (worst
ergonomics for noticing that you just enabled a shell command).

**Transition.** Phase 1 keeps the JSON output so the container can be proven before storage
changes. Phase 2 stops writing the local JSON file and deletes it; the database becomes the only
store. The scanner switches to a temp-file-then-rename write in phase 1, which also removes the
half-written-file read; in phase 2 that is replaced by a single transaction.

## Testing Decisions

A good test here asserts observable behaviour of one unit through its public surface — given
these inputs on disk, this snapshot comes out; given this stored config, this interval is used;
given this request shape, the guard allows or rejects. Tests must not assert internal structure,
call order, or private helpers, so they survive the phase-2 storage swap unchanged.

Two seams, no more:

1. **Snapshot assembly** — the existing exported function that turns a home directory and a
   projects root into a snapshot object. Prior art: the 11 existing tests in the scanner's test
   file already build temporary directories (`mkdtemp`) and call exported helpers directly; the
   new tests follow that exact style and extend it to the assembly function.
2. **Store module** — exercised against a temporary database file: save then read back a
   snapshot, newest-wins for each kind, config round-trip, comment upsert and overwrite,
   and a read issued during a write returning either the old or the new snapshot but never a
   corrupt one.

Two pure helpers get direct unit tests in the same runner, because they encode the two riskiest
small decisions: interval resolution (stored config beats env beats default; zero, negative and
non-numeric values fall back and are floored) and the same-origin guard (same-origin allowed;
cross-origin rejected; a request carrying neither origin nor a same-origin fetch indicator
rejected).

The test runner stays `node --test`; a `test` script is added to the package manifest. No new
test dependency.

Not tested automatically: the rescan and settings HTTP handlers, the settings page's DOM, and
the container. The repo has no HTTP or DOM harness, and building one costs more than it protects
for a single-user local tool. Those are covered by a smoke recipe: build the image, run it with
the two bind mounts, confirm the page returns 200, confirm a snapshot appears in the database on
first start, confirm the timestamp advances after one interval, and confirm a rescan from the
page changes it immediately.

## Out of Scope

- Scanning or aggregating configuration from more than one machine; this is a per-machine tool,
  and each machine gets its own container.
- Authentication, user accounts, TLS certificates, or exposure beyond loopback.
- Normalizing snapshots into relational tables, or any query across snapshots beyond "latest".
- A history or diff view in the UI, even though snapshots are retained to allow one later.
- Automating the claude.ai cloud scrape; `/refresh-cloud` remains a host-side agent step.
- Deploying to a remote or hosted server; Dokploy runs on the same machine being scanned.
- Live push updates, websockets, or scan progress streaming.
- Migrating the existing JSON config files into git-tracked defaults or any config export format.

## Further Notes

- Swarm ingress may refuse a `127.0.0.1`-only published port. The fallback is the Traefik route
  at `acm.localhost`, which is still loopback-only because that name resolves to `127.0.0.1` on
  this machine. Hosts entries are not strictly required (`*.localhost` resolves to loopback in
  Chrome and Firefox), but the Traefik host rule is.
- Traefik must have HTTPS disabled for this host rule; no certificate authority will issue for
  `.localhost`.
- Files written into the bind-mounted data directory by a root container end up root-owned. That
  is harmless while the container is the only writer, but a host-side scanner run against the
  same database would need `sudo`. Mitigation later if it annoys: run the service as a fixed uid.
- Backing up the database means copying the file, ideally while the container is stopped;
  restoring means putting it back and restarting.
- Rolling back past phase 2 loses the settings and comments accumulated in the database. Export
  or copy the file before reverting.
- The comments feature moves from `localStorage` to the database. Existing comments in a browser
  are not migrated — there are few, and the loss is acceptable for a one-time change.
