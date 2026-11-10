# 14: Two tiers, one file

**What to build:** running `acm` in the home directory no longer relabels the home environment file as
a project declaration. The file is read once, every row names the file it came from, and a `--tier`
filter that matches nothing says where it looked.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] When a Project root is `$HOME`, so the `user` and `project` tiers resolve to one path, that file
      loads once under `user` and the project tier contributes nothing.
- [ ] `acm status` prints the file each row came from, and `--json` carries it, so a row's tier is
      checkable against the file rather than assumed.
- [ ] `acm status --tier <tier>` that matches no entry prints the tiers it read and their files
      instead of an empty table, so an empty answer is never mistaken for an empty environment.
- [ ] spec.md's Loading and merging section states the read-once rule.
- [ ] Tests cover a `user` file and a project file at one path, and a filter that selects nothing.
