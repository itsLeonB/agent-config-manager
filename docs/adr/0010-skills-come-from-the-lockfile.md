# Skills come from the skills lockfile, not from Provisions

The environment file used to declare each skill as a Provision: a Check that the lockfile contained
the source, and an Install command that ran `npx skills add`. That made the environment file a second
copy of a lockfile the `skills` CLI already maintains, and one Provision per skill hid the one fact
that matters: which skills this machine has.

So ACM does not model skills as Provisions. `acm skills install` reads the user lockfile and the
project lockfile, groups each by source, and runs `npx skills add` once per source with the harness
list the matching environment file declares. Skills stay out of `acm status` and `acm install`; the
engine's skill reader stays, because a native read still answers what a harness declares. A
`skills-*` Provision is a generic Provision: legal, but not a supported category.

The per-tier harness list this depends on is decided in
[ADR 0011](0011-two-tiers-and-a-per-file-harness-list.md).