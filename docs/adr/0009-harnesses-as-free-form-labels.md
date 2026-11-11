# Harnesses are free-form labels in the environment layer

The environment file's harness field was typed as a closed enum inherited from the native-read
layer. That coupling is wrong: a user may run a harness ACM has no reader for, and the set of
harnesses a machine faces is itself per-machine configuration.

So the environment layer (types, parser, loader, service, runner, history, define) treats a
harness name as an unconstrained string: no enum, no validation beyond non-empty and NUL-free.
The native-read layer keeps its closed `HarnessId` enum and `acm read <harness>` still rejects
unknown names. An environment file may declare the harnesses it faces at the top level with
`harnesses = [ ... ]`; these lists merge across tiers as a union in precedence order,
deduplicated, and default to `pi`, `codex`, `opencode` when none is declared.