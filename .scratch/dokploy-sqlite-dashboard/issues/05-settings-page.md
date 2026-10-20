# 05: Settings page

**What to build:** A settings page holding every value that drives the scan: the projects root,
the scan interval, the list of skip paths, and the environment tools (name, check command,
install command). Values are stored and read by the scanner on its next tick, so a change takes
effect without a restart or redeploy. Editing is explicit: nothing is written until save, invalid
values are reported in the field that owns them when the field loses focus, and a failed save
raises an error summary that receives focus and links to each invalid field. Save shows a pending
state and then a distinct success state. Writes from a foreign origin are rejected, using the
same guard as the rescan control. An install that has never been configured still scans with
sensible defaults.

**Blocked by:** 04

**Status:** resolved

- [x] All four config areas are editable and persist across a container restart
- [x] The scanner uses saved values on its next tick, with no restart
- [x] An invalid value is reported in its own field on blur, and a failed save shows a focused error summary linking each error to its field
- [x] Saving shows a pending state, then success; no write happens until save is pressed
- [x] A settings write from a foreign origin is rejected
- [x] A never-configured install scans successfully with defaults

## Comments

Resolved on `feat/dokploy-sqlite-dashboard`. `/settings` route, four config keys in the store, env as defaults only, explicit save with pending/success states, per-field errors.
