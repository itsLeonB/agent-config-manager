# 17: The home environment file migrates

**What to build:** the home environment file is rewritten in the shape this slice settles — Payloads
for declared text, Sections for instruction blocks, and shared Checks/Install commands where every
harness entry inherits them — and `acm status` reports the same entries with the same Presences
afterwards. This ticket changes no ACM code: it is the migration that proves the rest, against the
file that produced the original findings.

**Blocked by:** 10, 11, 12, 13, 14, 18

**Status:** ready-for-agent

- [ ] Every Install command that spelled more than one command lives in a Payload, and its entry names
      the Payload and its arguments; no line in the file holds an escaped multi-line command.
- [ ] The two instruction texts each exist once, as one Payload, and serve their harness entries
      through a Section write; editing one flips those rows to `absent` and converges them.
- [ ] The skill Provisions check the skill they name at its own address rather than a whole-file
      pattern, one Provision per skill.
- [ ] `acm status` names every row's file and reports the same entries with the same Presences as
      before the migration.
- [ ] `acm install --dry-run` prints the whole run and spawns nothing.
- [ ] Each `skills-*` Provision declares its Check and Install command once, shared, with empty
      `.pi` and `.opencode` entries — `acm install` runs the shared command once, not twice.
- [ ] `serena` splits into a shared `uv tool install` Install command and per-harness `mcp add`
      commands, so the tool install runs once for both harnesses.
