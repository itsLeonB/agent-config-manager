# 03: Deploy to Dokploy at acm.localhost, survive reboot

**What to build:** The deployment itself. The image from ticket 01 is deployed as a Dokploy
Application built from the repo, given the home directory as a read-only bind mount at its own
absolute path, the data directory as a read-write bind mount, one interval variable, and a single
host-specific value naming the home directory so a second machine needs only that value changed.
The service is reachable at `acm.localhost` through Traefik with HTTPS disabled, with the
container port also published on the host as a fallback route. After a reboot the dashboard is
there with no manual start.

The clicking inside Dokploy is the operator's step; everything that can be prepared and proven
locally is this ticket's job.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] A written recipe covers service type, build source, both mounts, the interval variable, the host-path variable, the published port, and the Traefik host rule with HTTPS off
- [ ] The deployment consumes artifacts that already exist in the repo; no manual image surgery
- [ ] Local proof recorded: the service returns traffic again after a container restart, and after a Docker daemon restart where that is permitted, with no manual start
- [ ] The HTTPS limitation for `.localhost` and the published-port fallback are documented, including what to do when the loopback port bind is refused
- [ ] No machine-specific path is baked into the image
