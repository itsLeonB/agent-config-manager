# Secret detection rules and secret-free-by-design guidance

Labels: wayfinder:research
Type: research
Status: open
Blocked by: none

## Question

[Permission, approval, and safety model](./08-permission-and-approval-model.md) settled the *gate*:
a deterministic in-engine classifier emits `clean | suspect | secret` per pointer, a hit stops the
plan and offers migrate-out / blind-copy / risk-read, and nothing secret is ever emitted. It
deliberately did not settle the rulebook. This ticket does, as facts to act on:

1. **Which patterns actually appear in real harness config?** Instance the provider-pattern list
   (`sk-`, `ghp_`, `AKIA`, `xoxb-`, PEM, JWT shape) and the key-name list against the three
   harnesses' own config surfaces — including `~/.codex/config.toml`
   (`mcp_servers.<id>.env.*`, `oauth.client_secret`), Pi `mcp.json`
   (`headers.Authorization`, `env.*`), OpenCode `mcp.servers.*`. List which are
   false-positive-prone (short values, hashes, URLs with embedded basic-auth).
2. **What entropy threshold separates a key from a hash or a UUID?** Cite a published rule set
   (gitleaks / trufflehog rule taxonomy) rather than inventing one; give the number and its
   false-positive rate.
3. **The secret-free forms each harness supports, exactly.** Pi: `${ENV_VAR}` and `!command` in
   `env`/`headers` (`docs/mcp.md:81`). Codex: what does `config.toml` support — `env_vars`
   allowlists, `$VAR` expansion, `bearer_token_env_var`? OpenCode: `{env:VAR}`, `$VAR`, or
   nothing? Read each harness's own schema, per the three research tickets. This is the
   "migrate the secret out" recommendation the plan emits, so it must be right per harness.
4. **Does blind copy survive the format?** To write a value the plan never holds, `apply`
   re-reads source and target and projects the one pointer. Confirm per format that a
   pointer-addressed write is possible without re-serializing the whole file — TOML
   (`config.toml` must stay comment/order-preserving outside the edited table, per
   [Codex native configuration surface](./04-codex-config-surface.md)), JSON/JSONC (`mcp.json`),
   and OpenCode's config. Where re-serialization is unavoidable, say what it destroys.
5. **What are the alternatives to secrets-in-config, by harness?** OAuth (`pi mcp login`,
   `codex mcp login`, `opencode mcp auth`), keychain/`!command` retrieval, env-file injection,
   and `bearer_token_env_var`. Rank them for the guidance ACM emits.

**Zoom:** `BRIEF.md` §10 ("never silently copy credentials" — read by 08 as "never
*automatically*"), §18.9. Builds on: [08](./08-permission-and-approval-model.md), the three
config-surface researches, and feeds [Per-category field tables](./12-per-category-field-tables.md)
(which needs the `credentialPointers` list per category) and [Minimal MCP tool surface](./09-mcp-tool-surface.md)
(the worked trace should show one secret handled end to end).

**Output:** a research asset under `assets/`, and the classifier rule table (patterns, thresholds,
per-category `credentialPointers`, per-harness injection mechanisms) that 12 turns into field
tables. Branch: `research/secret-detection`.
