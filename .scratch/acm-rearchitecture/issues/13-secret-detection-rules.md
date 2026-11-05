# Secret detection rules and secret-free-by-design guidance

Labels: wayfinder:research
Type: research
Status: resolved
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

## Answer

Long form: [`assets/13-secret-detection-rules.md`](../assets/13-secret-detection-rules.md). Verified
against Pi 1.5.0, Codex 0.166.0 (`config.schema.json` at `rust-v0.166.0`), OpenCode 2.2.5 on
2026-11-05 — **run**, not read, wherever a binary could answer.

### 1. The classifier rule table — ordered, first match wins

| # | Rule | Verdict |
|---|---|---|
| 0 | pointer ∈ adapter `credentialPointers` | `secret` |
| 1 | value is an env ref (`${VAR}`, `{env:VAR}`, `$VAR`, `Bearer ${VAR}`) or `!command` | `clean` (`!command` is `executable`, not secret) |
| 2 | length-anchored provider pattern | `secret` |
| 3 | PEM block | `secret` |
| 4 | hash shape (hex ≥32, UUID, `sha256:`/`sha1:`/`sha512:` prefix, ULID) **and** pointer name matches `hash\|digest\|checksum\|fingerprint\|id$` | `clean` |
| 5 | pointer name matches `(api[-_]?key\|token\|secret\|passw(or)?d\|credential\|bearer\|authorization\|client[-_]?secret)` and len ≥ 8 | `suspect` |
| 6 | base64 gate (≥20 chars, has digit **and** upper-case) **and** entropy ≥ **4.4** | `suspect` |
| 7 | pure-hex ≥32 **and** entropy ≥ 3.0 **and** pointer name from rule 5 | `suspect` |
| 8 | otherwise | `clean` |

Rule 4 is not optional: **14 of 49** entropy hits on the real corpus are Codex
`hooks.state.*.trusted_hash` digests.

### 2. Patterns, instanced

`sk-(proj|svcacct|admin)-…T3BlbkFJ…`, `sk-ant-api03-…AA`, `gh[pousr]_[0-9a-zA-Z]{36}`,
`github_pat_\w{82}`, `(AKIA|ASIA|ABIA|ACCA|A3T…)[A-Z2-7]{16}`, `xox[abposre]-…`, `xapp-…`,
`ey…​.ey…​.…` (JWT), `-----BEGIN …PRIVATE KEY-----`, `npm_[a-z0-9]{36}`,
`(sk|rk)_(test|live|prod)_…`, `pypi-…`. All from gitleaks' master config; **0 hits** on the
harness corpus.

False-positive-prone, with what actually triggers them here: hashes (`trusted_hash`,
`contentDigest` — largest class), `ENV_VAR_NAME`s (the secret-free form flagged as a secret),
slugs/ids/paths, URLs (only when they carry basic-auth userinfo), prose, public keys, JWTs in
fixtures, `sk_test_` keys.

### 3. Entropy threshold, and why one number cannot work

Entropy per char is capped by `log2(min(alphabet, length))`, so **no hex secret can exceed 4.00**
while a 32-char base64 key sits at 4.33–4.75. One threshold therefore either flags every hash (3.5)
or misses every hex key (≥4.1). Published thresholds, which split by alphabet for that reason:
gitleaks `generic-api-key` **3.5** (on the `secretGroup` capture), detect-secrets **4.5 base64 /
3.0 hex**, trufflehog per-detector **3.5**, applied *only to unverified results*.

Detection rate by threshold (20k samples/row): base64-32 → 100% at 3.5, **88% at 4.4**, 70% at 4.5;
hex-32/64 → 82–100% at 3.5, **0% at 4.4**. So 4.4 is the base64/hex separator and costs ~12% of
32-char keys; 3.5 separates nothing.

False-positive rate — **no tool publishes one for entropy alone**, so two numbers:

- *Published, per tool, on SecretBench* (818 repos, 97,479 labelled candidates / 15,084 real):
gitleaks precision **46% → 54% FP**, trufflehog **6% → 94% FP** (90%, 611 alerts, with
`--only-verified`), GitHub scanner 75%, SpectralOps 1%. The paper blames generic regexes and
ineffective entropy directly.
- *Measured here*, 111 string leaves across 5 real config files, **0 credentials present**:
bare ≥3.5 → **49 hits, 44.1% FP**; ≥4.0 → 21.6%; ≥4.5 → 0.9%; **≥4.5 + base64 gate → 0%**.

Use **4.4 + base64 gate**, never 3.5 alone, plus the hex rule (7) for the case no high threshold
can reach.

### 4. `credentialPointers`, per category

| Category | Pi | Codex | OpenCode |
|---|---|---|---|
| `mcp` | `env.<K>`, `headers.<H>`, **`oauth.clientSecret`**, `url` (basic-auth) | `env.<K>`, `http_headers.<H>`, **`oauth.client_secret`**, **`auth.idp.client_secret`**, `url` | `environment.<K>`, `headers.<H>`, `url` |
| `hooks` | — (hooks are code) | `hooks[].command` (or inline `[hooks.*].command`) | — (hooks are plugin code) |
| `plugins` | `settings.json` `packages[]` spec | `[marketplaces.*].source`, plugin rows | `plugins[]` spec |
| `skills` / `commands` / `instructions` | whole file (`SKILL.md`, command md, `AGENTS.md`) | same | same, plus `instructions[]` |

Only `mcp` has typed credential fields. For the three markdown categories the "pointer" is the
whole file, so `credentialPointers` needs a **kind** (`typed-leaf` vs `whole-file`), not a flat
`string[]` — that amends ticket 02's descriptor.

### 5. Secret-free forms, exactly (all run, not read)

| | Pi | Codex | OpenCode |
|---|---|---|---|
| interpolation | `${VAR}`, `!command` (executes) | **none — a `$VAR` is passed through verbatim** | `{env:VAR}`, `{file:path}` |
| an interpolated string lifted from Pi | works | **silently literal → wrong token sent** | **silently literal** |
| undefined reference | **hard error**, server skipped | n/a | **empty string, silent** |
| stdio | `"${VAR}"` | `env_vars = ["NAME"]` | `"{env:VAR}"` |
| header | `"Bearer ${VAR}"` | `bearer_token_env_var`, `env_http_headers` | `"Bearer {env:VAR}"` |
| file retrieval | `!cmd` only | — | `{file:path}` |
| keyring | — | `mcp_oauth_credentials_store = "keyring"` | — |

**The dangerous translation is Pi → Codex:** `headers.Authorization: "Bearer ${T}"` must become
`bearer_token_env_var = "T"` (delete the header). Codex has no interpolation, so a naive field copy
ships the literal `${T}` **as a bearer token**. Codex also rejects `env` on HTTP servers (`env is
not supported for streamable_http`).

Ranked for the migrate-out advice: **(1)** harness OAuth (`pi mcp login` / `codex mcp login` /
`opencode mcp auth`) — removes the secret entirely, needs server support; **(2)** the harness's own
named indirection (`env_vars`, `bearer_token_env_var`, `env_http_headers`, `${VAR}`, `{env:VAR}`) —
non-portable, must be emitted per target; **(3)** Codex `keyring` store — grants only; **(4)**
file/command retrieval (`{file:}`, `!command`) — the latter is `executable`, so it can never land
`verified`; **(5)** env-file injection; **(6)** plaintext + blind copy.

### 6. Blind copy survives, but only via ACM's own span-addressed writer

| Format | Lossless pointer write? | Destroys |
|---|---|---|
| TOML (`config.toml`) | yes, with a CST editor; **not** via `codex mcp add` | `codex mcp add` re-serializes the whole `mcp_servers` table: every comment under it dies, **including in untouched sibling entries** — a correction to ticket 04 §4. Tables outside it keep comments |
| JSONC (`opencode.jsonc`) | yes, offset-based (`jsonc-parser.modify`) | full parse+stringify kills all comments. `opencode mcp add` itself preserves comments and key order but reflows whitespace |
| JSON (`mcp.json`) | yes, parse→stringify is enough | whitespace/inline layout only; a round trip of the four real JSON configs here is **byte-identical** |

Repo has no TOML/JSONC editor dependency today; `smol-toml` and `@iarna/toml` both drop comments.

### 7. What this contradicts or leaves open for 12

- **08 §6's "migrate the secret out" is not one recommendation** — three different syntaxes, two of
them silent-corruption cases. 12 needs a per-`(harness, field)` `replacement` for credentials.
- **07 §2's `replacement ∈ renamed | inverted | dropped` has no value for a credential gap.**
- **Ticket 04 §4 is too generous** about Codex comment preservation (see §6 above).
- Unverified: `http_headers_helper` (schema field, no doc), where Codex's MCP OAuth *tokens* land in
  `file` mode, and OpenCode's `~/.opencode` vs `~/.config/opencode` precedence.
- FP measurement is n=111 with no secrets present: evidence about noise, not recall.
