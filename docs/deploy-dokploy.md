# Deploy to Dokploy (`acm.localhost`)

The dashboard runs as one Dokploy **Application** built from this repo's `Dockerfile`, on the
local Docker Swarm, reachable at `http://acm.localhost` through the Dokploy Traefik instance,
with the container port also published on the host as a fallback route.

Everything below that can be checked without clicking was run on this machine; the local proof
is pasted in [Local proof](#local-proof). The clicking itself is the
[operator checklist](#operator-checklist).

## What gets deployed

- Image: this repo's `Dockerfile` — Bun builds (`bun run build`), `node:22-slim` serves
  (`node tools/entrypoint.mjs`).
- The entrypoint starts `scan.cjs --loop` and the HTTP server together. One scan runs at start,
  then every interval. If the scanner dies the process exits so the container is restarted
  instead of serving silently stale data.
- No machine-specific path is in the image (checked: `grep -rl /home/leon /app` is empty). The
  host home is supplied at run time as `HOST_HOME` + a bind mount.

## Values

This machine's real values. Only `HOST_HOME` and the mount source change on a second machine.

| Setting | Value |
| --- | --- |
| Dokploy version | v0.30.8 (`dokploy/dokploy:v0.30.8`), Swarm already active |
| Service type | **Application** (not Compose — Compose forces Dokploy's relative `files/` mount convention on the host-home bind) |
| Source | GitHub, `itsLeonB/agent-config-manager`, branch `main` |
| Build type | Dockerfile, path `Dockerfile` |
| Replicas | 1 |
| Container port | `3000` (already `EXPOSE`d and `PORT=3000` in the image) |
| Published host port | `127.0.0.1:3100:3000` → fallback URL `http://localhost:3100` (not 3000: Dokploy's own UI already binds host 3000) |
| Domain | `acm.localhost`, internal port `3000`, HTTPS **off** |
| Traefik entrypoint | `web` (port 80) only |
| `HOST_HOME` | `/home/leon` |
| `PUBLIC_ORIGIN` | `http://acm.localhost` (required: without it the origin guard rejects rescan and settings writes behind the proxy) |
| Home mount | `/home/leon` → `/home/leon`, read-write (Dokploy has no read-only option for binds) |
| Data mount | host `/home/leon/acm-database` → `/app/database` (read-write) |
| `SCAN_INTERVAL_MINUTES` | `15` |

Why the data mount source is a dedicated directory rather than the repo's `database/`: Dokploy
clones the repo to `/etc/dokploy/applications/<appName>/code` and recreates that tree on every
deploy. A data directory inside it would be a moving target for a bind mount. `/home/leon/acm-database`
is stable, host-visible (so `/refresh-cloud` and future SQLite backups stay plain filesystem work),
and survives redeploys.

`HOST_HOME` must be the container path the home content lands at (`/home/leon`), so the absolute
paths stored in the database (the settings and the skip paths) and in snapshots stay meaningful
inside the container. The entrypoint refuses to start when `HOST_HOME` is not a directory and warns
when no `.claude` / `.claude.json` / `.agents` is mounted under it.

The container runs as uid/gid `1000` (the image's `node` user), so the data mount source must be
writable by that uid: `sudo chown -R 1000:1000 /home/leon/acm-database` once, plus a
`chown 1000:1000` on any `dashboard.db` an earlier root container left behind. A bind mount
overrides the image's own ownership of `/app/database`.

`PUBLIC_ORIGIN` must be the URL the browser actually uses. Every mutating request (rescan, settings
save, comment save) is accepted only when its `Origin` matches the request URL's own origin or this
value; forwarded headers are deliberately not trusted, because a foreign page can forge them.

The data directory holds two files: `dashboard.db` (the store — snapshots, settings, comments) and
`cloud.json` (the `/refresh-cloud` drop point). Backing up is copying `dashboard.db` while the
container is stopped; resetting is deleting it and letting the next start recreate it.

## Create the application

Fields as they appear in Dokploy v0.30.8; exact tab grouping may drift between versions.

1. Create host data directory: `mkdir -p /home/leon/acm-database`.
2. Dokploy → project → **Create Service → Application**.
3. **General**: Name `acm`; Provider `GitHub`; Repository `agent-config-manager`; Branch `main`;
   Build Type `Dockerfile`; Dockerfile Path `Dockerfile`; Build Context Path `.`.
   (A GitHub provider is already configured on this instance — the existing `hrms` application
   uses the same source/build combination.)
4. **Environment**: `HOST_HOME=/home/leon`, `SCAN_INTERVAL_MINUTES=15`, `PUBLIC_ORIGIN=http://acm.localhost`. Leave `PORT` alone.
5. **Advanced → Mounts**, two bind mounts. Dokploy v0.30.8 stores only type / host path / mount
   path / volume name per mount, so a bind mount **cannot be made read-only** — the home mount is
   writable. The app's own code only reads the home and writes the SQLite store in `/app/database`,
   but an env-tool `checkCommand` from `/settings` runs as a shell command in the container (see the
   security note below), so the writable home is a trust boundary rather than a pure read mount.

   | Type | Host path | Mount path |
   | --- | --- | --- |
   | Bind | `/home/leon` | `/home/leon` |
   | Bind | `/home/leon/acm-database` | `/app/database` |

   The home bind must repeat the host path exactly (`/home/leon` → `/home/leon`); the data bind maps
   the host's `/home/leon/acm-database` to `/app/database`. On either one, a suffix like `:ro` in the
   mount path is *part of the path*, and the real path then does not exist in the container.

   Narrowing the home mount to the four paths the scanner reads (`~/.claude`, `~/.claude.json`,
   `~/.agents`, `~/Projects`) is optional: it changes no code and scans the same data, and it keeps
   the rest of the home — credentials, dotfiles — out of the container.

6. **Ports**: publish `3100` → container `3000`. Host IP `127.0.0.1` if the form accepts one;
   see [Loopback port bind refused](#loopback-port-bind-refused) if Swarm rejects it.
7. **Domains → Add Domain**: Host `acm.localhost`, Path `/`, Internal Port `3000`,
   HTTPS **unchecked**, Certificate Provider left empty.
8. **General → Auto Deploy**: on (Dokploy registers the GitHub webhook; a push to `main` deploys).
9. **Deploy**.

Security note: the home mount is read-write, because Dokploy cannot mount a bind read-only. The
dashboard's own code only reads the home and writes the SQLite store under `/app/database`. The
exception is the env-tool list in `/settings`: a `checkCommand` is any non-empty string, and
`scan.cjs` runs it through `execSync` as a shell command in the container. The app has no
authentication — the settings and rescan endpoints are guarded only by the same-origin check, which
a direct client satisfies — so anyone who can reach the dashboard can store a command that writes to
the writable home (a `~/.claude/settings.json` hook, say) and reach host code execution through it.
Treat that list as commands you would run yourself, keep the dashboard on a trusted network (see
[Reachability](#reachability)), and treat the writable home as the trust boundary it is.

## Reachability

`acm.localhost` resolving to loopback says nothing about who can reach the service. Traefik
publishes its `web` entrypoint on `0.0.0.0:80`, so any host on the same network that sends
`Host: acm.localhost` gets the dashboard, and the published fallback port is reachable the same
way when Swarm accepts an unscoped bind. Hostname resolution and the `.localhost` suffix are not
access control, and the app has no authentication by design.

The enforceable restriction therefore has to sit outside the app. Pick at least one:

- **Firewall the published ports to loopback.** Published container ports are DNAT'ed and traverse
  `FORWARD`, so the rule belongs in Docker's own chain, not `INPUT`: the rule below covers
  Traefik's port 80 and the fallback port together.

  ```bash
  sudo iptables -I DOCKER-USER -p tcp -m multiport --dports 80,3100 ! -s 127.0.0.1 -j DROP
  ```

  Verify from another device: `curl -m 2 http://<host-lan-ip>/` must time out, while
  `curl http://acm.localhost/` still answers locally. Persist it (iptables-persistent, or a
  systemd unit) if it needs to survive a reboot.
- **Scope the fallback port to loopback** with `127.0.0.1:3100:3000` where Swarm accepts it (see
  [Loopback port bind refused](#loopback-port-bind-refused) when it does not). That alone does not
  close port 80.
- **Put an authenticating proxy in front of both routes** if anything beyond plain isolation is
  wanted; authentication is out of scope for this tool.

## Routes

The Dokploy Traefik config on this machine enables the `swarm`, `docker`, and `file`
providers with `exposedByDefault: false` and entrypoints `web` (:80) and `websecure` (:443, with a
Let's Encrypt resolver attached by default).

With HTTPS off, Dokploy writes a dynamic file for the app (this is the shape of the existing
`/etc/dokploy/traefik/dynamic/reverse-engineering-hrms-6ubwzq.yml`, same `web`-only pattern):

```yaml
http:
  routers:
    acm-router:
      rule: Host(`acm.localhost`)
      service: acm-service
      middlewares: []
      entryPoints:
        - web
  services:
    acm-service:
      loadBalancer:
        servers:
          - url: http://acm:3000
```

Sanity check after deploying:

```
curl -s -o /dev/null -w '%{http_code}\n' http://acm.localhost/
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/
```

Both should print `200`. A `404` from Traefik means the domain rule or entrypoint is wrong; a
`502` means Traefik found the rule but not the container.

## Redeploy and roll back by commit

- **Redeploy current `main`**: Dokploy → application → **Deployments** → **Deploy**, or push any
  commit (auto-deploy is on).
- **Roll back**: **Deployments** lists past deployments with their commit hash. Redeploy the
  previous commit from that list — that rebuilds the image from that commit, no action on the
  host repo needed.
- **Roll back through git** instead if the deployment list is not enough:
  `git revert <bad-commit> && git push`, which re-enters through auto-deploy.
- The data directory is not part of the image or the deploy, so redeploying and rolling back
  never touch `dashboard.db`. Restoring data is copying the file back and restarting the container.

## Restart and reboot behaviour

Swarm keeps one replica running: if the task exits, the service recreates it, and services come
back when the Docker daemon starts. That is the whole reason this is an Application on Swarm and
not a plain `docker run`.

Proven locally with the same restart policy Swarm applies (`--restart always`), plus the
container's own supervision of the scanner. Docker **daemon** restart was not proven here: it
needs `sudo` (a password is required on this machine) and it would restart 67 running
containers, including Dokploy itself. Do it once by hand when convenient:

```
sudo systemctl restart docker
docker service ls                       # acm should be 1/1 within a minute
curl -s -o /dev/null -w '%{http_code}\n' http://acm.localhost/
stat -c %y /home/leon/acm-database/dashboard.db   # mtime should advance: a fresh scan ran
```

## Local proof

The pasted output below was captured before ticket 08 retired the JSON snapshot: the scanner now
logs `-> database/dashboard.db` and writes no `local.json`, so read every `local.json` in these
commands as `dashboard.db`.

Run on this machine, real Docker daemon (v29.2.0, Swarm active), same image the Dokploy service
uses, host port 3100 to avoid the Dokploy UI on 3000. Recorded with the whole home mounted
read-only; `docker run` accepts `:ro`, Dokploy does not, so the deployed mount is read-write at the
same path.

```
$ docker build -t agent-config-manager .
#23 naming to docker.io/library/agent-config-manager done
#23 DONE 0.0s

$ docker run -d --name acm --restart always -p 127.0.0.1:3100:3000 \
    -e HOST_HOME=/home/leon -e SCAN_INTERVAL_MINUTES=5 \
    -e PUBLIC_ORIGIN=http://localhost:3100 \
    -v /home/leon:/home/leon:ro -v "$PWD/database:/app/database" agent-config-manager
0b1681c9487a1096b57b3d6a92ffd5eb8cd712918b2b1abd0179a812ddadb1b7

$ docker ps --filter name=acm
STATUS Up 20 seconds
$ docker logs acm
➜ Listening on: http://localhost:3000/ (all interfaces)
Scanned: 5 plugins, 4 user MCP servers, 13 user skills, 13 npx-skills, 0/0 env tools installed, 129 projects -> database/local.json
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3100/
200
$ stat -c %y database/local.json
2026-10-21 01:08:19.450781087 +0700

--- proof 1: container restart, no manual start ---
$ docker restart acm
acm
$ docker ps --filter name=acm --format "STATUS {{.Status}}"
STATUS Up 20 seconds
$ docker logs acm | tail -2
➜ Listening on: http://localhost:3000/ (all interfaces)
Scanned: 5 plugins, 4 user MCP servers, 13 user skills, 13 npx-skills, 0/0 env tools installed, 129 projects -> database/local.json
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3100/
200
$ stat -c %y database/local.json
2026-10-21 01:08:43.713935988 +0700

--- proof 2: process crash, container restarted by restart policy, no manual start ---
$ docker exec acm node -e "<kill scan.cjs child>"
$ docker inspect acm --format "restartCount={{.RestartCount}} status={{.State.Status}}"
restartCount=1 status=running
$ docker logs acm | tail -3
Scanner loop exited with code null; stopping so the container restarts
➜ Listening on: http://localhost:3000/ (all interfaces)
Scanned: 5 plugins, 4 user MCP servers, 13 user skills, 13 npx-skills, 0/0 env tools installed, 129 projects -> database/local.json
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3100/
200
$ stat -c %y database/local.json
2026-10-21 01:09:04.225066837 +0700
```

Read it as: `200` after a restart, `200` after a crash nobody restarted by hand, and the snapshot
mtime advancing each time — the page comes back with fresh data, not from a cache.

One correction worth knowing: `docker kill` does **not** trigger a restart policy, because Docker
counts it as a manual stop, and `--restart unless-stopped` counts it as manual too. That is why
the crash proof kills the scanner child inside the container rather than the container itself.
Swarm behaves the same way: a stopped task stays stopped, an exited task is recreated.

## HTTPS limitation for `.localhost`

No certificate authority issues for `.localhost`, so keeping HTTPS on that domain means a
permanently failing ACME challenge and a browser warning. The route is therefore `web` only, and
the domain entry leaves HTTPS unchecked. This has two visible consequences:

- The URL is `http://acm.localhost`, not `https://`.
- Chrome, Firefox, and Safari all treat `.localhost` as a secure context even over plain HTTP, so
  the page, its clipboard button and its `localStorage` work normally. Switching the domain to
  HTTPS later would need a real hostname with a public DNS record, which is out of scope for this
  tool.

The published port exists exactly for the case where Traefik is the broken part:
`http://localhost:3100` goes straight to the container and bypasses Traefik and Dokploy's routing.
Traefik itself is reachable but unmapped right now — `curl http://acm.localhost/` returns `404`
until the domain is added:

```
$ curl -s -o /dev/null -w '%{http_code}\n' http://acm.localhost/
404
```

## Loopback port bind refused

Swarm publishes ports through its ingress network, and ingress will refuse a host-IP-scoped
publish (`127.0.0.1:3100:3000`) in some configurations — the deploy fails and the task never
starts. Same failure mode appears if host port 3100 is taken (`docker service ls` shows the
service stuck at `0/1`, `docker service ps acm --no-trunc` shows the port error).

Order of fixes, cheapest first:

1. Publish `3100` → `3000` **without** a host IP. Ingress then binds all interfaces, so the port
   is reachable from the network — close it with the firewall rule in [Reachability](#reachability),
   or accept it. Reach the fallback at `127.0.0.1:3100`.
2. Publish in `host` mode instead of `ingress` (Dokploy exposes this as the port's publish mode).
   A host-mode publish binds only on the node running the task and accepts the loopback IP.
3. Drop the published port entirely and keep the Traefik route. This gives up the fallback but
   keeps the dashboard reachable.
4. Change the host port (`3100` → any free port) and update the fallback URL.

Note that a direct `docker run -p 127.0.0.1:3100:3000` is always accepted — the refusal is a Swarm
ingress behaviour, not a Docker one. That is how the local proof above was run.

## Operator checklist

Everything that needs clicking in Dokploy, in order. Roughly 10 minutes.

1. `mkdir -p /home/leon/acm-database`
2. Create the Application with the values in [Values](#values) and [Create the application](#create-the-application).
3. Deploy, then confirm `200` from both `http://acm.localhost/` and `http://localhost:3100/`.
4. Confirm the first scan landed: `ls -l /home/leon/acm-database/dashboard.db` — it should exist
   and its mtime should be within a minute of the deploy.
5. Reboot once (or later) and confirm the page returns without starting anything:
   `curl -s -o /dev/null -w '%{http_code}\n' http://acm.localhost/`
6. Optional, when convenient: `sudo systemctl restart docker` and repeat step 5.

## Risks

- **Host port 3000 is unavailable.** Dokploy's own UI already publishes `0.0.0.0:3000`, so the
  fallback port must be something else; this doc uses 3100. Anything that assumes 3000 for the
  dashboard will collide with Dokploy.
- **Data files are written as uid 1000.** The container runs as `1000:1000`, so the data mount
  source must be owned and writable by that uid (`sudo chown -R 1000:1000 /home/leon/acm-database`)
  or the store fails to open and the page shows the empty state. Files it writes are owned by uid
  1000 on the host, not root — a host-side `node scan.cjs` against the same directory works without
  `sudo` as long as you are that uid too.
- **`HOST_HOME` must be the container path the scans land on**, or the scanner inventories the
  container's empty `HOME` and the page shows zeros. Dokploy has no read-only toggle, so the mount
  paths are plain paths and must repeat the host path exactly: a `:ro` pasted into the mount path
  makes the target `/home/leon:ro`, leaves `/home/leon` absent (the entrypoint then exits 1 on
  startup), and makes the mount writable. `docker inspect <container> --format '{{json .Mounts}}'`
  shows the landed `Destination`.
- **Cloud data is still a host step.** `database/cloud.json` only appears after `/refresh-cloud`
  runs on the host and writes into `/home/leon/acm-database` (or is copied there). Nothing in the
  container produces it; the scanner only ingests it into `dashboard.db`.
- **Rolling back past the SQLite phase loses settings and comments**, because they live in the
  data directory. Copy `dashboard.db` before reverting. A rollback to a build that predates the
  store cannot read it at all, so the page falls back to its empty state.
