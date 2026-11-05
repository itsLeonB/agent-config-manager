# Secret detection rules and secret-free injection (facts only)

Asset for [Secret detection rules and secret-free-by-design guidance](../issues/13-secret-detection-rules.md).
Feeds [Per-category field tables](../issues/12-per-category-field-tables.md) (its Q3) and
[Minimal MCP tool surface](../issues/09-mcp-tool-surface.md) (the worked trace's secret path).

No decisions are recorded here. Each fact a decision hangs on is marked **→ blocks**.

Research date **2026-11-05**. Marker on every claim:

| Mark | Meaning |
|---|---|
| **[V]** | Verified by running the installed binary on this machine, now |
| **[S]** | Verified against that harness's own schema/native file shipped at the pinned version |
| **[D]** | Read from official documentation |
| **[R]** | Published detection rule set (gitleaks / detect-secrets / trufflehog) |
| **[M]** | Measured here by script over the real config corpus — method in the section |

Versions probed: Pi `1.5.0`, Codex `codex-cli 0.166.0`, OpenCode `v2.2.5`. Codex schema read at
tag `rust-v0.166.0` (`codex-rs/core/config.schema.json`, draft-07, 8,599 lines).

---

## 1. Where a credential can sit — the `credentialPointers` substrate

This is the list [Adapter contract](../issues/02-adapter-contract-and-capabilities.md)'s descriptor
gains and [12](../issues/12-per-category-field-tables.md) Q3 asks for. Every row below exists in a
native config file the slice can write.

### `mcp` — the only category where a secret is structurally expected

| Harness | Pointer | Holds a secret? | Evidence |
|---|---|---|---|
| Pi | `mcpServers.<id>.env.<KEY>` | yes (stdio) | [D] `docs/mcp.md:60-64`, [V] child process received the resolved value |
| Pi | `mcpServers.<id>.headers.<Header>` | yes — `Authorization` is the normal case | [D] `docs/mcp.md:64`, [V] `--bearer-token-env-var` writes `headers.Authorization = "Bearer ${NAME}"` |
| Pi | `mcpServers.<id>.oauth.clientSecret` | **yes** — a pre-registered OAuth client secret lives in `mcp.json` | [V] `pi mcp add --oauth-client-secret` wrote `oauth.clientSecret` into `mcp.json`; [D] `docs/mcp.md:140,145` (`"clientSecret": "${EXAMPLE_SECRET}"`, "can use an environment variable or command") |
| Pi | `mcpServers.<id>.url` | can — basic-auth userinfo `https://u:p@host/mcp` | [D] `url` is a plain string in the Claude-compatible shape |
| Codex | `mcp_servers.<id>.env.<KEY>` | yes (stdio) | [S] `RawMcpServerConfig.env`; [V] `env` on a streamable-http server is **rejected**: `env is not supported for streamable_http` |
| Codex | `mcp_servers.<id>.env_vars[]` | no — names only (or `{name, source}`) | [S] `McpServerEnvVar = string \| {name, source?}`; [D] "allow and forward" |
| Codex | `mcp_servers.<id>.http_headers.<Header>` | yes — static values | [S] `http_headers: {string: string}` |
| Codex | `mcp_servers.<id>.env_http_headers.<Header>` | no — header → env **var name** | [S], [D] "values pulled from the environment" |
| Codex | `mcp_servers.<id>.bearer_token_env_var` | no — a var name | [S], [D] |
| Codex | `mcp_servers.<id>.oauth.client_secret` | **yes** — plaintext in `config.toml` | [S] `McpServerOAuthConfig.client_secret`; [D] "Keep that file private" |
| Codex | `mcp_servers.<id>.auth.idp.client_secret` | **yes** — enterprise-managed-auth client secret | [S] `McpServerIdpOAuthConfig.client_secret` |
| Codex | `mcp_servers.<id>.url` | can — basic-auth userinfo | [S] `url: string` |
| OpenCode | `mcp.servers.<id>.environment.<KEY>` | yes (local) | [V] `opencode mcp add --env` wrote `environment`; [D] |
| OpenCode | `mcp.servers.<id>.headers.<Header>` | yes (remote) | [V] `opencode mcp add --url --header` wrote `headers` |
| OpenCode | `mcp.servers.<id>.url` | can — basic-auth userinfo | `{env:}` substitution confirmed in `url` [V] |

### The other five categories

| Category | Harness | Pointer | Why it is credential-bearing |
|---|---|---|---|
| `hooks` | Codex | `hooks[].command`, inline `[hooks.*].command` | a shell command string; embedding `export TOKEN=…` is legal [D] `04` §2 |
| `hooks` | Pi, OpenCode | *none* — hooks are code (extension / `Plugin.define`) | the secret lives in the `.ts`/`.js` source, not a config pointer [D] `03` §2, `05` §2 |
| `plugins` | Codex | `[marketplaces.<n>].source`, `[plugins."<id>@<mkt>"].*` | git URL can carry basic-auth userinfo; plugin auth is install-time [V] real `source = "https://github.com/…"` rows exist in `config.toml` |
| `plugins` | Pi | `settings.json` `packages[]` | `git:`/`npm:`/`https:` spec — a tokenised git URL is legal there [V] real entries present |
| `plugins` | OpenCode | `plugins[]` | npm/git spec, same hazard [D] `05` §4 |
| `skills` | all three | `SKILL.md` body + frontmatter | markdown is free text; a bearer token or `!gh auth token` inside a fenced block is legal |
| `commands` | all three | command markdown body | as above |
| `instructions` | all three | `AGENTS.md` body; OpenCode `instructions[]` entries | as above |

**→ blocks 12 Q3:** the `credentialPointers` list is per `(harness, category)`; only `mcp` has
structurally-typed credential fields. For `skills` / `commands` / `instructions` the "pointer" is a
*whole file*, so the classifier must run over file text, not over a typed leaf — the same code path,
different scope. `hooks` splits: Codex has a pointer, Pi and OpenCode do not.

**→ blocks 02:** `credentialPointers` cannot be a flat `string[]` if it must mean both "this typed
leaf" and "this whole file". It needs the pointer plus the pointer's *kind*.

---

## 2. Provider patterns, instanced against these pointers

gitleaks' master config is the reference set: 200+ rules, each `regex` + optional `keywords` +
optional `entropy` + `secretGroup`. Values below are copied from it **[R]**
(`config/gitleaks.toml`, fetched 2026-11-05).

| Rule id | Pattern | `entropy` on the secret group | FP-prone in harness config? |
|---|---|---|---|
| `openai-api-key` | `sk-(proj\|svcacct\|admin)-…T3BlbkFJ…`, `sk-[A-Za-z0-9]{20}T3BlbkFJ…` | 3 | barely — modern `sk-proj-` shape is unambiguous |
| `anthropic-api-key` | `sk-ant-api03-[A-Za-z0-9_-]{93}AA` | — (fixed length) | no |
| `github-pat` / `-oauth` / `-app` / `-refresh` | `gh[pousr]_[0-9a-zA-Z]{36}` | 3 | no |
| `github-fine-grained-pat` | `github_pat_\w{82}` | 3 | no |
| `aws-access-token` | `(A3T[A-Z0-9]\|AKIA\|ASIA\|ABIA\|ACCA)[A-Z2-7]{16}` | 3 | no — but a **public** access-key id is common in docs; the *secret* key is the sensitive half |
| `slack-*` | `xox[abposre]-…`, `xapp-\d-…` | 2–3 | no |
| `jwt` | `ey[…]{17,}\.ey[…]{17,}\.…` | 3 | **yes** — session tokens appear in logs, test fixtures, docs |
| `jwt-base64` | `ZXlK…` | 2 | **yes** |
| `private-key` | `-----BEGIN …PRIVATE KEY-----…KEY-----` | — (structure) | no |
| `npm-access-token` | `npm_[a-z0-9]{36}` | 2 | no |
| `stripe-access-token` | `(sk\|rk)_(test\|live\|prod)_[A-Za-z0-9]{10,99}` | 2 | `sk_test_` keys are public by design in samples |
| `generic-api-key` | keyword-window + `([\w.=-]{10,150}\|[a-z0-9][a-z0-9+/]{11,}={0,3})` | **3.5** | **yes — this is the whole problem** |

### Which of these actually appear in harness config

Measured over the real corpus (5 files: `~/.pi/agent/{mcp,settings,trust}.json`,
`~/.codex/{config.toml,hooks.json}`, `~/.config/opencode/opencode.json`; 111 string leaves; **zero
real credentials present**) **[M][V]**:

| Rule family | Hits in corpus |
|---|---|
| provider patterns (`sk-`, `ghp_`, `AKIA`, `xoxb-`, PEM, JWT) | **0** |
| key-name match on the pointer name | **0** |
| bare Shannon entropy ≥ 3.5 | **49 / 111 (44.1%)** |
| entropy ≥ 4.5 + base64 character-class gate | **0 / 111 (0%)** |

### The four false-positive classes, with real examples from this machine

1. **Hashes.** `hooks.state."…".trusted_hash` and `trusted_content_hash` are `sha256:`-prefixed
   digests — **14 leaves**, every one over 3.5 **[M]**, and they are the single largest FP class.
   gitleaks issue #1578 documents the same class upstream (a git commit hash
   `9a038989604e8da62ecddbe2094b16ce1b778be1` at entropy ≈3.9) **[R]**.
2. **`ENV-VAR-NAME`s.** `BROWSER_USE_ACCESS_EXECUTOR_ID`-style names — **4 leaves**, 3 over 3.5
   **[M]**. These are the *secret-free form* being flagged as a secret. Same FP is reported
   upstream: `LLM_SECRET_NAME = "NEXUS-GPT4-API-KEY"` at entropy 3.7 **[R]**.
3. **Slugs, ids, paths.** `serena`, `start-mcp-server`, `npm:context-mode`, `deepseek-flash`,
   `chrome,iab,mcpapps` — **32 leaves, 14 over 3.5** **[M]**. Nothing separates a random 32-char
   base64 key (median 4.56) from a random 32-char lowercase path segment (median 4.05) by entropy
   alone **[M]**.
4. **URLs, including basic-auth userinfo.** 6 present, 6 over 3.5 **[M]**. A URL *is* a secret when
   it carries `https://user:pass@host` — so the URL shape can neither be blanket-trusted nor
   blanket-dropped; it must be inspected for userinfo.

Public keys and prose complete the list: `public_key = "Gc3Q0RXJM2CUNbgKpUMnkPtOfOzeFzsW"` and
`keyword = "Befaehigung_P2"` (entropy 3.5) are both documented gitleaks false positives **[R]**.

---

## 3. Entropy: what number separates a key from a hash or a UUID

### 3.1 The arithmetic — why one threshold cannot work

Shannon entropy per character is bounded by `log2(min(alphabet size, length))`, so the *alphabet*
sets a hard ceiling that no threshold can exceed **[M]**:

| Shape | Alphabet | Ceiling | Observed median (n=500) |
|---|---|---|---|
| hex sha256, 64 chars | 16 | **4.00** | 3.83 |
| hex uuid4, 32 chars | 16 | **4.00** | 3.63 |
| base64 key, 32 chars | 64 | 5.00 | **4.56** |
| base64 key, 40 chars | 64 | 5.33 | 4.78 |
| base64 key, 64 chars | 64 | 6.00 | 5.18 |
| lowercase path segment, 32 chars | 26 | 4.70 | 4.05 |

**No hex-encoded secret can ever exceed 4.00.** A threshold high enough to exclude hex hashes
(≥4.1) therefore excludes *every* hex-encoded key. A threshold low enough to catch hex keys (3.5)
catches every hex hash. This is why the published tools use **one threshold per alphabet**.

### 3.2 Published thresholds

| Tool | Threshold | Applied to | Source |
|---|---|---|---|
| gitleaks `generic-api-key` | **3.5** | the regex `secretGroup` capture | **[R]** `config/gitleaks.toml`; README: entropy is "the minimum shannon entropy a regex group must have" |
| gitleaks per-provider rules | 2.0–3.5 (slack/npm/stripe 2, aws/github/jwt/openai 3, hashicorp-tf 3.5) | same | **[R]** |
| detect-secrets `Base64HighEntropyString` | **4.5** | base64-alphabet strings | **[R]**² |
| detect-secrets `HexHighEntropyString` | **3.0** | hex-alphabet strings | **[R]**² |
| trufflehog | per-detector (e.g. GitHub v1 **3.5**) | unverified results only | **[R]**³ `pkg/detectors/falsepositives.go` |

² the 4.5 / 3.0 pair is documented in detect-secrets' plugin defaults and reproduced in every
summary of it; the plugin source was not read here — treat as **[R]** not **[S]**.
³ trufflehog's `FilterResultsWithEntropy(ctx, results, entropy, …)` is a **post-filter that skips
verified results entirely** — entropy only gates the unverified tier. That is the architecturally
important half: **verification beats entropy**, and the two are not alternatives at the same layer.

### 3.3 Detection rate vs threshold (computed, n=20,000 samples per row)

| Shape | ≥3.5 | ≥4.0 | ≥4.4 | ≥4.5 |
|---|---|---|---|---|
| base64 20 chars | 99.9% | – | 0.0% | 0.0% |
| base64 24 chars | 100% | – | 18.2% | 5.3% |
| base64 32 chars | 100% | – | **87.9%** | 70.0% |
| base64 40 chars | 100% | – | 99.7% | 98.0% |
| base64 64 chars | 100% | – | 100% | 100% |
| hex 32 chars | 81.6% | 0.0% | 0.0% | 0.0% |
| hex 40 chars | 95.2% | 0.0% | 0.0% | 0.0% |
| hex 64 chars | 100% | 0.0% | 0.0% | 0.0% |

Read across the middle column: **4.4 is where base64 keys separate from hex hashes**, and it costs
~12% of 32-char keys. 4.5 costs ~30% of them. 3.5 separates nothing.

### 3.4 Published false-positive rates

There is **no published false-positive rate for an entropy threshold in isolation.** Neither
gitleaks nor trufflehog nor detect-secrets publishes one, and the number depends entirely on the
corpus. What is published is per-tool precision on a labelled corpus — SecretBench
(Meland et al., [arXiv 2307.00714](https://arxiv.org/html/2307.00714)), 818 public repos,
97,479 labelled plain-text candidates of which 15,084 are true secrets **[R]**:

| Tool | Precision | Implied FP rate |
|---|---|---|
| GitHub Secret Scanner | 75% | 25% |
| **gitleaks** | **46%** | **54%** |
| TruffleHog (default) | 6% | 94% — about 100k alerts |
| TruffleHog `--only-verified` | 90% | 10% (611 alerts) |
| SpectralOps | 1% | 99% |

The paper's own diagnosis is the one that matters for a rulebook: FPs were "attributed to generic
regular expressions and ineffective entropy calculation", naming TruffleHog scoring
`2b95710rD1e6287e69Z8f2E24373449d879b70c7601B3x9` at 4.08 and `ThisIsAReallyLongString` at 4.11 —
i.e. commit ids and dummy strings **[R]**. Verification lifted precision 6% → 90%, and the residual
10% is verification's own error.

gitleaks issue #1830 (2025-04) is the field report of the same thing from the other end: after
8.20 → 8.24 the reporter's results were "loaded with any bit of source code that includes the word
key or password", and they concluded "false positives outweigh true detections" **[R]**.

### 3.5 False-positive rate on *this* corpus (the one the classifier runs on)

111 string leaves from 5 real harness config files, **0 real credentials**, so **every** hit is a
false positive by construction **[M]**:

| Rule | Hits | FP rate on corpus | Breakdown |
|---|---|---|---|
| entropy ≥ 3.5, bare | 49 | **44.1%** | 14 hashes, 14 slugs/ids, 12 prose, 6 URLs, 3 env-var names |
| entropy ≥ 4.0, bare | 24 | 21.6% | 9 slugs, 7 hashes, 4 prose, 4 URLs |
| entropy ≥ 4.5, bare | 1 | 0.9% | 1 slug |
| entropy ≥ 4.5 **+ base64 class gate** | **0** | **0%** | — |

Caveat stated plainly: n=111 is small, and "0 credentials present" is the assumption, not a fact
proven by a scanner. What the table establishes is direction and magnitude — a bare 3.5 is
unusable here (near half the file), a gated 4.5 is silent on the whole corpus.

---

## 4. The classifier rule table

Ordered, first match wins. This is the shape [Permission model](../issues/08-permission-and-approval-model.md)
§6 describes (`clean | suspect | secret`, never a severity); columns are what the engine needs.

| # | Rule | Verdict | Why this position |
|---|---|---|---|
| 0 | pointer is in the adapter's `credentialPointers` | `secret` | the harness structurally expects a credential here. No pattern needed. This alone catches `oauth.clientSecret` / `oauth.client_secret` / `auth.idp.client_secret` |
| 1 | value is an env reference: `${VAR}`, `{env:VAR}`, `$VAR`, `Bearer ${VAR}`, `!command` | `clean` | already the secret-free form. `!command` is `executable`, not secret (08 §8) — a separate flag |
| 2 | provider pattern from §2 matches **and** the pattern is length-anchored | `secret` | zero hits on the corpus, near-zero FPs upstream |
| 3 | PEM block marker | `secret` | structural |
| 4 | value shape is a hash (pure hex ≥32, UUID, `sha256:`/`sha1:`/`sha512:` prefix, ULID) **and** the pointer name matches `/hash|digest|checksum|fingerprint|id$/` | `clean` | **necessary**: 14 of 49 bare-3.5 hits are exactly this. Without this rule the classifier flags every Codex hook trust record |
| 5 | pointer name matches `/(api[-_]?key\|token\|secret\|passw(or)?d\|credential\|bearer\|authorization\|client[-_]?secret)/i` and value length ≥ 8 | `suspect` | 0 hits on this corpus, so it is cheap; cannot be `secret` because the env-var *name* FP lives here |
| 6 | base64 class gate (alphabet `[A-Za-z0-9+/=_-]`, ≥20 chars, contains a digit **and** an upper-case letter) **and** entropy ≥ 4.4 | `suspect` | 0% FP on the corpus, ~88% of 32-char keys |
| 7 | hex-gate (alphabet `[0-9a-fA-F]`, ≥32 chars) **and** entropy ≥ 3.0 **and** pointer name from rule 5 | `suspect` | the hex-secret case no ≥4.1 threshold can reach (§3.1). Keeping it `suspect` is what makes the low threshold safe |
| 8 | otherwise | `clean` | — |

Notes that are facts, not choices:

- **`suspect` and `secret` behave identically in 08 §6** (both stop the plan and offer the same
  three responses). The distinction is therefore free — it only shows in `security.secrets[]`.
- **Never 3.5 alone.** 44% of this corpus. The published 3.5 is a *generic-key rule's* threshold,
  paired with a keyword window; lifting the number without the keyword window is what changed
  gitleaks' behaviour between 8.20 and 8.24 **[R]**.
- **Two thresholds, keyed on alphabet.** One number cannot serve both (§3.1) — this is
  detect-secrets' design, not an invention here.
- The check runs over **bytes at read time**, and must also run over whole files for the
  `skills` / `commands` / `instructions` categories (§1), where there is no typed pointer.
- Case matters for the gate: an all-lowercase 32-char random string scores 4.05 median and passes
  rule 6's entropy test, so the upper-case requirement is what keeps slugs out **[M]**.

---

## 5. Secret-free forms, exactly

### Pi 1.5.0 — `~/.pi/agent/mcp.json`, `.pi/mcp.json`

| Form | Verified | Notes |
|---|---|---|
| `${NAME}` in `env` and `headers` | **[V]** + **[D]** `docs/mcp.md:81` | "env and headers values can use environment variables such as `${GITHUB_TOKEN}`" |
| `!command` in `env` and `headers` | **[V]** + **[D]** | "the command must make up the whole value". Verified: `"FROM_BANG": "!echo cmd-out"` reached the server process as `cmd-out` — **Pi executes it** |
| `$NAME` (no braces) | **[V], undocumented** | resolved `tok123` in the probe. Do not emit it; docs promise only `${NAME}` |
| undefined `${NAME}` | **[V]** | **hard failure**: `Failed to resolve MCP server "probe" env "FROM_BRACE_UNDEF" from environment variable: PI_PROBE_UNDEFINED` → the server is skipped. Fails loud |
| `pi mcp add --bearer-token-env-var NAME` | **[V]** | writes `headers.Authorization = "Bearer ${NAME}"` — the CLI's own secret-free path |
| `oauth.clientSecret: "${ENV}"` | **[D]** `docs/mcp.md:140,145` | "clientSecret is optional and can use an environment variable or command" |
| file-based retrieval | **none** | Pi has no `{file:…}` form. `!command` is the retrieval mechanism |
| keychain | **none built in** | OAuth tokens go to `~/.pi/agent/mcp-auth.json` (plain file, mode 600 on this machine) — the *grant*, not the config |

### Codex 0.166.0 — `~/.codex/config.toml`

**A `$VAR` / `${VAR}` in a `config.toml` value is passed through verbatim.** Verified by reading the
parsed config back **[V]**:

```
[mcp_servers.stdio1.env]  LITERAL = "$TEST_TOKEN"  BRACED = "${TEST_TOKEN}"
→ codex mcp get stdio1 --json → "LITERAL": "$TEST_TOKEN", "BRACED": "${TEST_TOKEN}"
```

So Codex has **no interpolation at all**; it has *named indirection fields*, and only these:

| Form | Applies to | Verified | Meaning |
|---|---|---|---|
| `env_vars = ["NAME"]` | stdio | **[S]** + **[V]** | forward the variable from Codex's own environment |
| `env_vars = [{ name = "X", source = "local" }]` | stdio | **[S]** + **[D]** | same, explicit source |
| `env.<KEY> = "value"` | stdio **only** | **[V]** | literal. HTTP rejects it: `env is not supported for streamable_http` |
| `bearer_token_env_var = "NAME"` | streamable HTTP | **[S]** + **[D]** | reads the var, sends `Authorization: Bearer …` |
| `env_http_headers = { "X-H" = "NAME" }` | streamable HTTP | **[S]** + **[D]** | header value pulled from that var |
| `http_headers = { "X-H" = "value" }` | streamable HTTP | **[S]** | literal |
| `http_headers_helper` | streamable HTTP | **[S], undocumented** | schema field, no description, no doc. **Unknown** — do not emit |
| `oauth.client_secret` | streamable HTTP | **[S]** + **[D]** | literal secret in the file. The known hazard |
| `mcp_oauth_credentials_store = "keyring" \| "file" \| "auto"` | top level | **[S]** | "Use an OS-specific keyring service" for **MCP OAuth credentials**; `auto` is default |
| `codex mcp login <name>` | — | **[V]** help | OAuth grant, outside `config.toml` |

**→ blocks 12:** a Codex target takes *three different* secret-free shapes depending on transport —
`env_vars` (stdio), `bearer_token_env_var` / `env_http_headers` (HTTP), or nothing. A
`${VAR}` string emitted into `config.toml` is not a reference; it is a **corrupted literal** that
Codex will happily send as a bearer token. This is the single most dangerous translation in the
slice: Pi → Codex, `headers.Authorization: "Bearer ${TOKEN}"` → must become
`bearer_token_env_var = "TOKEN"`, and a naive field copy ships the literal `${TOKEN}`.

### OpenCode 2.2.5 — `opencode.json(c)`

| Form | Verified | Notes |
|---|---|---|
| `{env:NAME}` | **[V]** | resolved in `command`, `url`, `headers`, `environment` — "Place references inside JSON strings" **[D]** |
| `{file:path}` | **[V]** | read a file's contents; relative to the config file, or absolute, or `~/…` |
| `$NAME`, `${NAME}` | **[V]** | **not substituted** — passed through literally. The Pi → OpenCode hazard, mirror image of Pi → Codex |
| undefined `{env:NAME}` | **[V]** | **empty string, no error**: `https://x.example/{env:TOKEN}/mcp` became `https://x.example//mcp`. Fails silent, unlike Pi. Docs confirm "will be replaced with an empty string" |
| `opencode mcp add --header "Authorization=Bearer {env:TOKEN}"` | **[V]** | wrote exactly that string into `headers` |
| `opencode mcp auth <name>` | **[V]** help | OAuth grant; stored outside the config tables |

### The asymmetry that decides the migrate-out advice

| Behaviour | Pi | Codex | OpenCode |
|---|---|---|---|
| interpolation in config text | yes `${VAR}`, `!cmd` | **none** | yes `{env:VAR}`, `{file:path}` |
| a `${VAR}` string lifted from another harness | works | **silently literal** | **silently literal** |
| an undefined reference | hard error, server skipped | n/a — literal | **empty string, silent** |
| secret-free stdio form | `${VAR}` | `env_vars` | `{env:VAR}` |
| secret-free header form | `headers: "Bearer ${VAR}"` | `bearer_token_env_var` / `env_http_headers` | `headers: "Bearer {env:VAR}"` |
| file-based retrieval | none (`!cmd` only) | none | `{file:path}` |
| OS keyring | none | `mcp_oauth_credentials_store` | none |

**→ blocks 08 §6:** "migrate the secret out" is not one recommendation; it is a per-harness rewrite
with a silent-corruption failure mode in two of the three targets. The migrate step must emit
*per-target* syntax and the plan must record which form it emitted, because verification cannot tell
`"Bearer {env:TOKEN}"` (correct) from `"Bearer ${TOKEN}"` (broken) by shape alone — only by asking
the target harness.

---

## 6. Does blind copy survive the format?

Blind copy writes a value the plan never holds, so `apply` re-reads the source pointer and writes
the target pointer. The question is whether that write can be **pointer-addressed** without
re-serializing the file.

### Measured against each harness's own writer

**Codex / TOML — worse than 04 recorded.** With a commented `config.toml` in a scratch `CODEX_HOME`,
`codex mcp add newone -- echo` **[V]**:

| Content | Survived? |
|---|---|
| comment at top of file | yes |
| trailing comment on a **top-level scalar** (`model = "gpt-5"   # …`) | yes |
| trailing comment in an **unrelated table** (`[ui]`) | yes |
| comment **above** an untouched `[mcp_servers.keep]` table | **no** |
| comment **inside** that untouched entry | **no** |
| inline comment on `args = ["a"]  # inline` in that entry | **no** |
| key order, values, and the untouched entry's fields | yes |

So the real rule is **stronger** than `04` §4's "drops comments *inside* it": `codex mcp add`
rewrites the **entire `mcp_servers` table**, so a comment anywhere under `[mcp_servers.*]` is
destroyed, while tables outside it keep their comments. Any blind copy routed through `codex mcp add`
is lossy for that block and therefore **not usable** for a mirror.

**OpenCode / JSONC — comments and order survive, bytes do not.** `opencode mcp add bar -- echo hi`
against a scratch `opencode.jsonc` **[V]**: the `// top comment`, the comment above an untouched
entry, and a trailing comment all survived; key order survived; the untouched entry's inline object
was **expanded to multi-line**, so the byte range of a sibling changed. That matches `05` §5's
"preserve comments and unknown keys but not bytes".

**Pi / JSON — nothing to lose but whitespace.** `pi mcp add newone --bearer-token-env-var MY_TOKEN`
**[V]**: unknown keys survived (`customUnknownKey`, a top-level `someTopLevelUnknown`), key order
survived, inline objects were expanded. A plain `JSON.parse → JSON.stringify(_, null, 2)` round trip
of all four real JSON config files on this machine is **byte-identical** **[M]** — they are already
canonical — so on this corpus JSON re-serialization costs nothing, but that is a property of the
files, not of JSON.

### What a pointer-addressed write needs, per format

| Format | Can a write be pointer-addressed losslessly? | What it takes | What re-serialization destroys |
|---|---|---|---|
| TOML (Codex `config.toml`) | yes, but not with a JS serializer | a comment/order-preserving CST editor (`@taplo/lib` 0.5.0 is the candidate — WASM TOML DOM; `smol-toml` 1.9.1 and `@iarna/toml` 2.2.5 are parse/serialize only and **drop comments**) | all comments; blank-line grouping; quoting style; number formatting; key order in some serializers |
| JSONC (OpenCode `opencode.jsonc`) | yes | an offset-based editor (`jsonc-parser` 3.3.1 `modify()` preserves comments + formatting) or a hand-rolled span splice | **all comments** (fatal — the file is user-authored), key order is preserved by JS objects anyway, formatting/indent |
| JSON (Pi `mcp.json`) | yes | parse → mutate → stringify, or a span splice | whitespace and inline-object layout only; **no comments exist**, so nothing unrecoverable |
| Markdown (skills, commands, instructions) | n/a | whole-file `writeFile` | nothing — it is not a structured format |

Neither `@taplo/lib` nor `jsonc-parser` is currently a dependency of this repo (`package.json` has
`zod` and the TanStack stack only) **[V]**.

**→ blocks 07/09:** blind copy is implementable for all three formats, but only if `apply` uses a
**span-addressed** writer. Two of the three harness CLIs are unusable for it (Codex is lossy; Pi's
JSON writer is fine but `pi mcp add` replaces whole entries per `03` §4, so it cannot be the op
either). The `writeAtPointer` op must therefore be ACM's own code, per format, and the plan's
`precondition.digest` + `preserved[]` are what prove the rest of the file is untouched.

---

## 7. Alternatives to secrets-in-config, ranked

Ranked for the `manualSteps[]` text ACM emits. "Rank" is by *how much of the hazard it removes per
unit of human effort*, and each rank is per harness because the mechanisms are not portable.

| Rank | Mechanism | Pi | Codex | OpenCode | What it removes |
|---|---|---|---|---|---|
| **1** | **OAuth / harness-managed grant** | `pi mcp login <name>` **[D]** | `codex mcp login <name>` **[V]** | `opencode mcp auth <name>` **[V]** | the secret never enters config *or* the plan. Only works if the server speaks OAuth |
| **2** | **Named env indirection** (harness-native, no shell) | `${VAR}` in `headers`/`env` **[V]** | `bearer_token_env_var`, `env_vars`, `env_http_headers` **[S][V]** | `{env:VAR}` **[V]** | the value; leaves a name the user must supply. **Rank 2 only when the harness's own form exists** — a literal `${VAR}` in Codex removes nothing and silently sends the wrong token |
| **3** | **OS keyring** | — | `mcp_oauth_credentials_store = "keyring"` (MCP OAuth grants only) **[S]** | — | the grant file. Config still carries any `client_secret` |
| **4** | **File-based retrieval** | `!command` in `env`/`headers` **[V]** (executes a command at launch — flagged `executable`, 08 §8) | — | `{file:path}` **[V]** | the literal, at the cost of a file on disk (or a command, which is code) |
| **5** | **Env-file injection** | `${VAR}` from the shell that launches Pi | `env_vars` forwarded from `$CODEX_HOME`'s environment | `{env:VAR}` with the var exported before launch | the literal, but silently empty/broken if the var is missing (OpenCode) — and Pi *errors* instead |
| **6** | **Plaintext in config, blind-copied** | n/a — ACM never holds the value (07 §4) | same | same | only the agent's context; the hazard stays on disk |

Two facts that constrain the ranking in practice:

- **Rank 1 is closed for a server that does not support OAuth**, which is most stdio servers.
- **Rank 2 has a different shape in each harness and does not translate.** Pi → Codex is
  `headers.Authorization: "Bearer ${T}"` → `bearer_token_env_var = "T"` (delete the header, add a
  field). Pi → OpenCode is `"Bearer ${T}"` → `"Bearer {env:T}"`. Codex → Pi is the reverse deletion.
  There is no harness pair where the string survives unchanged.
- **Rank 4 is code.** `!command` is already `executable: true` under 08 §8 and can never land
  `verified`.

---

## 8. What this leaves open

1. **`http_headers_helper`** — a schema field on Codex MCP with no description and no doc. It
   appears as `null` in `codex mcp get --json`. Unknown whether it is a command, a path, or a legacy
   alias. Do not emit it; do not classify it.
2. **Where Codex' MCP OAuth *tokens* land** — the schema proves a keyring option exists for them
   (`mcp_oauth_credentials_store`) but not which file the `file` mode uses. `04` §6 already flags
   `~/.codex/auth.json` / `state_5.sqlite` as unread.
3. **OpenCode precedence `~/.opencode` vs `~/.config/opencode`** — still unverified (`05` §1). It
   matters to the classifier only in that a shadowed entry is not the entry the harness reads.
4. **The `credential` gap's `replacement` value.** 07 §2 fixes `replacement ∈ renamed | inverted |
   dropped`. A credential gap is none of the three; it needs a fourth value or an empty one. Not
   settled here, and it is 12's problem.
5. **n=111.** The FP table in §3.5 is a real measurement of a small corpus with no secrets in it.
   It is evidence about *noise*, not about *recall*; recall numbers in §3.3 are synthetic.

---

## 9. File / command index for re-verification

| Fact | How to re-check |
|---|---|
| Pi interpolation + `!command` | temp `PI_CODING_AGENT_DIR` with `mcp.json`, `pi mcp list`, read the child's env |
| Pi undefined-var failure | same, delete the env var from the shell |
| Pi oauth clientSecret pointer | `pi mcp add x --url … --oauth-client-secret …` then read `mcp.json` |
| Codex verbatim `$VAR` | temp `CODEX_HOME`, `codex mcp get <name> --json` |
| Codex `env` HTTP rejection | same, with `url` + `env` on one entry |
| Codex table-rewrite comment loss | temp `CODEX_HOME` with a commented `config.toml`, `codex mcp add`, `diff -u` |
| OpenCode `{env:}` / `{file:}` / `$VAR` | temp dir with `opencode.json`, `opencode --standalone debug config` |
| OpenCode comments-preserved-bytes-reflowed | temp `opencode.jsonc`, `opencode mcp add`, `diff -u` |
| Entropy tables | §3.3 — Shannon per char over 20k random samples per row |
| Corpus FP table | §3.5 — script over 5 real config files, counts by shape |
