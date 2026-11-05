# Split "scope" into scope bucket (canonical) and tier (adapter-declared)

An Installation's scope had to be one word, but the three in-slice harnesses do not agree on what
layers exist: Pi has user + project; Codex adds a launch-time-only `profile` and a project layer
gated on a `trust_level` in the *user* config; OpenCode adds a root-owned `/etc/opencode` that
outranks the project, an undocumented `~/.opencode`, and a per-ancestor project chain. So the model
stores a **tier** the adapter declares (`id`, native label, rank, config path, writability) and a
**scope bucket** that tier maps to (`user`, `project`, `project-local`, `system`). Identity uses
the bucket; capability, writability, and path resolution use the tier.

## Considered Options

- **One canonical enum only** (BRIEF §6, three values): simplest, but `profile`, `/etc/opencode`,
  and MDM layers become invisible or get silently mislabelled as `user`, which would make a mirror
  believe it can write a layer it cannot.
- **Free-form native tier strings, no bucket**: perfectly faithful, no cross-harness queries.
- **Chosen**: both, with the dependency pointing one way — a tier always declares its bucket, and
  nothing derives a tier from a bucket.

## Consequences

- Every adapter ships a tier table; it is versioned with the adapter because a harness can add a
  tier (`~/.opencode` is undocumented and already real).
- Writability is a tier property, so "discovered but not writable" needs no Installation-level flag,
  and no permission check is duplicated per installation.
- `project-local` is currently unused by all three harnesses. It stays in the vocabulary: deleting
  it would force a schema change the first time a harness gains that tier.
