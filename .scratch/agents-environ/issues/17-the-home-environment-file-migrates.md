# 17: The home environment file migrates

**What to build:** the home environment file is rewritten in the shape this slice settles — Payloads
for declared text, Sections for instruction blocks, and shared Checks/Install commands where every
harness entry inherits them — and `acm status` reports the same entries with the same Presences
afterwards. This ticket changes no ACM code: it is the migration that proves the rest, against the
file that produced the original findings.

**Blocked by:** 10, 11, 12, 13, 14, 18

**Status:** resolved

- [x] Every Install command that spelled more than one command lives in a Payload, and its entry names
      the Payload and its arguments; no line in the file holds an escaped multi-line command.
- [x] The two instruction texts each exist once, as one Payload, and serve their harness entries
      through a Section write; editing one flips those rows to `absent` and converges them.
- [x] The skill Provisions check the skill they name at its own address rather than a whole-file
      pattern, one Provision per skill.
- [x] `acm status` names every row's file and reports the same entries with the same Presences as
      before the migration.
- [x] `acm install --dry-run` prints the whole run and spawns nothing.
- [x] Each `skills-*` Provision declares its Check and Install command once, shared, with empty
      `.pi` and `.opencode` entries — `acm install` runs the shared command once, not twice.
- [x] `serena` splits into a shared `uv tool install` Install command and per-harness `mcp add`
      commands, so the tool install runs once for both harnesses.

## Answer

Ticket 18's shared declarations were not yet built, so this ticket first landed them (see 18's
Answer), then rewrote `~/agents_environ.toml` — the file lives outside this repository, so the
migration is the file itself plus five new Payloads under `~/agents_environ/payloads/`:

- `rtk-opencode.sh`, `i-have-adhd-opencode.sh`, `subagents-off-opencode.sh`, and
  `claude-code-compat-off.sh` hold the four compound commands (`;`, `&&`, `||`); every other
  Install command in the file is a single command and stayed inline. `skills-add.sh` holds the one
  `npx skills add` command, taking the repo and skill name as argv.
- The five repo-shaped `skills-*` Provisions became twelve, one per skill, each checking
  `skills.<name>.source` at its own address in `.skill-lock.json` and sharing one Payload install
  with empty `.pi`/`.opencode` entries. The eight mattpocock skills the original command installed
  keep their names; `skill-creator`, `find-skills`, `writing-guidelines`, and `install-anti-slop`
  map to `anthropics/skills`, `vercel-labs/skills`, `vercel-labs/agent-skills`, and
  `dmmulroy/anti-slop`.
- `serena` declares `uv tool install -p 3.13 serena-agent` once on the Provision; the `.pi` and
  `.opencode` entries keep only their `mcp add` commands and their own Checks.
- The two instruction Provisions needed no reshape: each Payload already exists once and each
  entry's Section write names it. Verified live — appending a line to `context-mode.md` flipped
  both rows to `absent` with the Section reason, and restoring the bytes flipped them back.

After the migration `acm status` reports 45 entries over 24 provisions, every row naming
`~/agents_environ.toml` and every Presence `present` — the same coverage the file had before, with
the skill rows now per skill. `acm install --dry-run` prints the whole run — the shared commands
once, labeled `$ shared:` — and spawns nothing.
