# 24: Hooks across three different methods

Type: task
**Status:** resolved

**What to build:** mirroring a hook into each of the three targets by the method that target actually
has: native declarative config into Codex, declarative config plus a community bridge into Pi, and
generated plugin code into OpenCode. Event names are translated, not copied, and any event or matcher
with no counterpart becomes a stated gap. The work a human must do — enabling the feature, reviewing
trust, installing the bridge, restarting — is listed per target. Generated code and every write
carrying a command are flagged executable, ticked separately, and can never be reported as verified.

**Blocked by:** 20, 22.

- [x] a Codex hook lands as a pointer write into native hook config, with the feature enablement and the trust review as manual steps
- [x] a Pi hook lands as a pointer write, with the bridge install and a restart as manual steps
- [x] a Codex hook targeting OpenCode lands as a generated plugin module, flagged executable, never verified, with a restart as the manual step
- [x] event names are mapped per target, and every unmapped event appears as a gap
- [x] a non-wildcard matcher is reported as its own gap rather than silently broadened
- [x] OpenCode is readable as a hook target but never as a hook source
- [x] a plan containing any generated or command-carrying hook write lands unverified

## Answer

Landed as the hook vocabulary and the two readers in `src/engine/adapters/hooks.ts`, the three write
surfaces and the one event table in `src/engine/adapters/hook-write.ts`, per-tier `hooks`
declarations in the three adapter descriptors plus `types.ts` (`categoryPaths.hooks`), the planner in
`src/engine/plan.ts` (`buildHookPlan`, `hookSteps`, `carriedHandler`, and `trustRequired` /
`trustSteps` widened to hooks), the hook address in `service.ts`'s `targetLocation` — with
`hooks.test.ts`, one test per checklist line.

Choices worth knowing beyond the ticket:

- **One event table, both directions.** `HOOK_EVENTS` groups an event under its Codex, Pi and
  OpenCode names, so a source event is looked up by any of its spellings and the target's own name is
  what the plan writes. Codex → Pi and Pi → Codex therefore share one table instead of two maps, and
  an event the target has no name for is a `fieldAbsent` gap with a manual step rather than a copied
  name that the harness would ignore.
- **A gap that would change behaviour writes nothing.** An unmapped event and a non-wildcard matcher
  each add their gap *and* leave `writes[]` empty, so the plan states what it cannot carry instead of
  broadening the hook to every tool call. The wildcard (`*`, `""`, or absent) is carried as written.
- **A group is one installation, and one handler list is one write.** `hooks.<Event>.<index>` is the
  native pointer, so two matcher groups on one event are two rows. Codex's three-level group becomes
  one appended entry; the Pi bridge holds one command per entry, so a group of two handlers becomes
  two entries in one pointer write. Both write the event's list with the source's own append, which
  is why an append is never a conflict: it replaces no value, it adds one.
- **Timeouts are normalised at the reader.** Codex reads seconds and the Pi bridge milliseconds, so
  both readers hand the vocabulary seconds and the surfaces convert once. A target reading
  milliseconds is a `unit` mapping on the plan; a target reading seconds carries the field, because
  no translation happened.
- **A command is a plain string, so a credential in one stops the write.** Each handler command goes
  through the classifier before it can reach the plan: a provider token or private-key block is a
  `credential` gap with its own manual step and no write, and the generated module is put through the
  whole-file classifier for the same reason. An existing command already sitting at the target's own
  pointer refuses the plan, because appending would carry it into `priorValue`, which is shown
  verbatim.
- **A handler field a target has no place for is a gap, not a silent drop.** `statusMessage` is
  Codex's, `print` is the bridge's, `mcp_tool` handlers are neither target's — each is named by
  pointer in `gaps[]`. The carried handler only holds what its target's `holds` list says.
- **The generated module is `Plugin.define` with `node:child_process` for the command**, because the
  API for a hook's own shell call is not settled the way `Plugin.define` and `ctx.tool.hook` /
  `ctx.session.hook` are (ticket 12). It is flagged `executable`, asserted by digest, and handed to a
  human to read before they restart OpenCode — which is the whole reason it can never verify.
- **A hook file's digest is the source's digest.** Commands travel inside the plan (nothing is
  re-read at apply the way a copied tree is), so a hooks file edited since the scan refuses the plan
  rather than landing a command no classifier saw.

Limits, stated rather than hidden:

- **No client writes a hook today.** Every hook write is `executable`, and ticket 22's gate hands an
  executable write back to a client that cannot ask a human — which the CLI is. So `acm apply` on a
  hook plan refuses with the writes as manual steps until the MCP surface (ticket 25) can elicit the
  tick. This is the consequence ticket 11 §7 already accepted for hooks; it is not a defect here.
- **Codex's inline `[hooks]` table is not read.** Only `hooks.json` is a source and a target, because
  one layer holding both is merged by Codex with a startup warning; a hook written inline stays
  invisible to the inventory.
- **The generated plugin's hook signature is a convention, not a verified compile.** Nothing in this
  slice runs OpenCode, so the module is reviewed by a human, not typechecked against
  `@opencode/plugin`.
- **`hooks.state.*.trusted_hash` is not written and not read.** Trust is Codex's own record, keyed by
  content hash and position, so the plan names the `/hooks` review and changes nothing there.
