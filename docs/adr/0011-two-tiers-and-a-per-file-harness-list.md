# Two environment tiers, and a file's harness list constrains its entries

The three-tier model (user, project, project-local) added a gitignored file that was rarely used and
made "which file declared this harness?" ambiguous. The harness list merged across tiers, so a file
could not say which harnesses it faced, and `define_provision` accepted any harness name even when
the file declared a list.

So there are two tiers: `user` (`~/agents_environ.toml`) and `project`
(`<repo>/agents_environ.toml`). The `harnesses` list is per file and is never merged. When a file
declares one, every entry in that file must use a name from it, and the parser refuses the file
otherwise. `define_provision` and the new `declare_harnesses` tool require an explicit tier, so an
unreviewed write cannot land in a committed file by accident.

This supersedes ADR 0009's rule that harness lists merge as a union across tiers, and the
`project-local` vocabulary in ADR 0001. `agents_environ.local.toml` is no longer read, and the
default three-harness answer is gone: a file with no `harnesses` list declares no harnesses.