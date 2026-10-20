# 02: Rescan from the dashboard

**What to build:** A control on the dashboard that forces a scan on demand. Clicking it runs the
scanner, shows a pending state while it runs, and refreshes the page's data when it finishes, so
the effect of a config change is visible immediately instead of after the next interval. A failed
scan reports the failure and leaves the previous snapshot in place. Because the scanner executes
shell commands for environment tool checks, every request that mutates state is rejected unless it
comes from the dashboard's own origin.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] The control triggers a scan and the page shows the new snapshot without a manual reload
- [ ] The control shows progress while scanning and cannot be fired twice concurrently
- [ ] A scan failure surfaces an error and the previous snapshot stays displayed
- [ ] A mutating request from a foreign origin is rejected; the guard is unit-tested for same-origin (allowed), cross-origin (rejected), and carrying neither origin nor a same-origin fetch indicator (rejected)
- [ ] Works both under the dev server and inside the container
