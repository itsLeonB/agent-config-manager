# 21: Mirror plan into an OpenCode target

Type: task
**Status:** resolved

**What to build:** the same planning path, targeting OpenCode. This is where the mechanical
differences live: an inverted enable flag, a command array instead of a command plus arguments, a
required type field a source does not have, seconds becoming milliseconds, and a config file that may
still hold a legacy flat shape. The plan must show each of those as a named mapping, must not mix the
old and new shapes into one document, and must report target-only and source-only fields correctly
instead of guessing.

**Blocked by:** 19.

- [x] an enable flag mirrors as its inverted counterpart, shown as an invert mapping
- [x] a command plus arguments mirrors as one command array, shown as a concat mapping
- [x] the transport type is inferred from the source's shape and written as a required value
- [x] second-valued timeouts land as milliseconds and the mapping is named
- [x] a config holding the legacy flat shape is normalised so the written document has one shape, and sibling entries are preserved
- [x] timeouts that do have an OpenCode equivalent are mapped rather than dropped, while fields with no equivalent become gaps with a reason
- [x] a manual step names any higher-precedence layer that could shadow the write

## Answer

The OpenCode write surface itself landed with ticket 19 (`opencode` in
`src/engine/adapters/mcp-write.ts`: `invert` on `enabled → disabled`, `concat` on
`command + args → command[]`, `infer` on `type`, `unit` on both timeouts), so this ticket is the
planner work the legacy shape and the shadowing layer needed, plus one test per checklist line.
`normaliseLegacyMcp` in `adapters/opencode/read.ts`, `legacyBlock` / `normalisedWrite` /
`uncleanPointer` / `legacySteps` in `plan.ts`, the container replacement in `edit.ts`, and the
`oc:user` manual step in `tierManualSteps`.

Choices worth knowing beyond the ticket:

- **A legacy-shape file is normalised in one write of the `mcp` block.** OpenCode still reads
  `mcp.<name>` beside `mcp.servers`, and one file may hold both, so the plan cannot leave the two
  shapes side by side — and this slice has no removal op to delete the flat keys with. So the plan
  emits a single write at pointer `mcp` holding the current shape: the mirrored entry at
  `servers.<name>`, every sibling carried across, `enabled` inverted to `disabled`, one numeric
  `timeout` split across `startup`/`execution`, and the reserved `mcp.timeout` left where it is. The
  entry's leaf writes are folded into that one value, and its own fields the source does not set are
  kept, which is how a target-only field survives instead of being reported absent.
- **The file is normalised in memory before anything is read from it.** Prior values, conflicts, and
  the two structural refusals all run against the normalised view, so a value only the target holds
  is reported rather than guessed missing, and a legacy `url`/`command` that would leave the other
  transport in place is still refused.
- **The block write is classified before it can reach the plan.** It carries sibling values from a
  file this engine did not write, and a withheld marker cannot be written back into a config, so an
  unclean leaf anywhere in the value (or in the block it replaces, which `priorValue` shows verbatim)
  refuses the plan and names the pointer. The classifier reads the canonical last two segments, as
  `priorValueAt` does, with `environment` under the name `env`: `env.<K>` is therefore
  credential-bearing by declaration, so a sibling value there refuses without having to look like a
  token. The refusal is caller input, not a gap — the same class as an unwritable tier — because the
  alternative would write a marker into somebody's config.
- **A sibling whose spelling had to change is named.** `normaliseLegacyMcp` returns the entries it
  rewrote (`enabled` inverted, a numeric `timeout` split) and the plan carries one manual step per
  entry, so a conversion nobody asked for is visible rather than quiet. An already per-phase
  `timeout` — `catalog` included — is carried as it stands, because the vocabulary does not name
  `catalog` but the file still holds it.
- **A name defined in both shapes, or a legacy value that is not a table, is a refusal** — which of
  the two definitions the harness honours is unverified, so the plan does not pick one.
- **The editor replaces a node of the same kind, and no other.** `writeJson` used to accept only a
  leaf; a plan that names `mcp` now replaces that table, and an existing `command[]` is replaceable
  too, which it was not before. A write that would turn a table into a scalar is still refused —
  that is a plan the engine misread. The cost is stated where it happens: comments *inside* the old
  `mcp` block do not survive the rewrite (a manual step), and the plan grades `risky` because the
  block it writes disagrees with the bytes on disk.
- **`oc:user` gets the same shadowing manual step `oc:project` had**, because a root-managed
  `/etc/opencode` outranks the user config too; its `why` also names `~/.opencode`, whose precedence
  against `~/.config/opencode` is still unverified.
- **`PlanValue` moved to `src/engine/plan-value.ts`** so the reader that owns the legacy shape can be
  typed over the plan's value domain without importing the planner back.
