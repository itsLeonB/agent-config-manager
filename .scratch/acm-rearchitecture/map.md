# Wayfinder map — Agent-driven cross-harness config mirroring

Labels: wayfinder:map

## Destination

A handoff spec + ADR set, committed to the repo, for the **smallest first slice** whose entire
purpose is: an AI agent, through MCP, takes how a component is configured in one harness and
creates the equivalent, correctly-adapted configuration in another harness — native formats
preserved, explicit approval before any write. Adapters in this slice: **Pi, Codex, OpenCode**
(Claude Code skipped). The way is clear when nothing is left to decide before someone builds
that slice.

## Notes

- **Domain:** AI coding-agent harness configuration management. Use the vocabulary of
  `BRIEF.md` §5–6 (Component, Installation, Scope, Harness, Adapter, Plan) plus the sharpened
  term settled in charting Q3: *mirror* = given a source Installation, produce a plan that
  creates an equivalent Installation in a target harness+scope, translating config per that
  harness's declared capabilities (never a blind byte-copy), surfacing unsupported/partial-
  support cases, then apply/verify under approval.
- **Source of truth:** `BRIEF.md` is the target vision, but this map targets only the first
  slice. Accept its vision, non-goals (§16), and guiding principles (§18); decide the *how*,
  not the *whether*.
- **Standing constraints** (`BRIEF.md` §1, §4.2, §10, §18): native config is the source of
  truth; discovery never implies ownership; no unrestricted shell execution; separate planning
  from execution; explicit authorization for mutations; preserve unknown fields; never copy
  credentials; treat hooks/plugins as executable code; mutations recorded and verifiable.
- **Codebase fact:** this repo is currently a read-only Claude Code dashboard (TanStack Start,
  SQLite via `src/server/store.cjs`, `scan.cjs` discovery, project-vs-project compare). There
  is no CLI, no MCP server, no harness adapter, and no mutation path. All of Pi, Codex,
  OpenCode (and Cursor) are installed on this machine. **Because Claude is skipped, none of
  the existing Claude-specific discovery transfers as an adapter** — the three adapters are
  greenfield; reusable parts are the SQLite store, the redaction helper in `scan.cjs`, the
  origin guard, and the TanStack shell. This is the single biggest consequence of Q4.
- **Skills each session should consult:** `grilling` + `domain-modeling` for grilling tickets;
  `research` for research tickets; `prototype` for the prototype ticket. Also `AGENTS.md`
  (Bun only, never npm/npx), `docs/agents/issue-tracker.md`, `docs/agents/domain.md`.
- **Tracker:** local markdown — `.scratch/acm-rearchitecture/`. Frontier = open, unblocked,
  unclaimed child issues; first by number wins. Tickets carry `wayfinder:<type>` labels only.
- **Scope decisions settled during charting (not tickets):** Q1 destination; Q2 no automatic
  sync; Q3 mirror is first-class; Q4 slice = Pi/Codex/OpenCode with Claude skipped.

## Decisions so far

<!-- one line per closed ticket: [Title](link): gist. Empty at charting; charting resolves nothing by hand. -->

## Not yet specified

- **Capability-gap semantics.** Once the Pi/Codex/OpenCode research reports what each harness
  actually supports, we must decide what "equivalent" means when the target lacks a feature:
  block, degrade, or ask. Not sharp until those facts exist.
- **Equivalence per component category.** How config is translated for MCP servers vs skills
  vs hooks vs instructions vs plugins differs; the shape of that translation is unknown until
  adapters and the mirror plan exist.
- **Which harness pairs matter most.** Source/target precedence and the highest-value first
  pair depend on the research findings and on which harnesses are actually used day to day.

## Out of scope

- **Automatic / blanket synchronization** of every component across harnesses, including
  continuous or background sync (`BRIEF.md` §16 Non-Goal; settled in charting Q2). Mirroring
  here is agent-initiated, explicit, and per-component.
- **Claude Code adapter** — explicitly skipped for this slice (charting Q4). The brief's
  §14 step 5 / §15 Phase 2 "convert/implement the Claude adapter" is not on this route. It
  returns only if the destination is redrawn, as a fresh effort.
- **Full CLI** (`BRIEF.md` Phase 3) and **the read-only web UI** (Phase 7) — deferred; the
  existing dashboard stays as-is for this slice.
- **Installation-intelligence research pipeline / recipes with evidence & confidence**
  (`BRIEF.md` Phase 5, §9) — deferred.
- **Adoption, drift-detection lifecycle, and full rollback** (`BRIEF.md` §11, Phase 8) —
  deferred. Verification *of a mirror* is in-slice; the broader lifecycle is not.
- **Universal config format, replacing native config, or a marketplace** (`BRIEF.md` §16).
- Harnesses beyond Pi/Codex/OpenCode (Gemini CLI, Qoder, Mistral Vibe, Cursor, Copilot).
