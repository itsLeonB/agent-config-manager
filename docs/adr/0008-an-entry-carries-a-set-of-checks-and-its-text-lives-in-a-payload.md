# An entry declares a set of Checks, and the text it declares lives in a Payload

The first real environment — 37 entries over three harnesses — failed the file's shape in four ways at
once. One Check per entry could not say "the plugin is installed **and** its hooks are trusted", so a
half-installed state read `present`. A pointer walked objects only, so an array element (`plugins`,
`hooks.PreToolUse`) and a key containing a dot were unaddressable, and an address ACM could not spell
answered `missing` — an absence — rather than saying so. Nineteen of those entries needed more than one
command, so their text was escaped into a single thousand-character line. And one instruction text was
pasted into three harness entries with nothing tying the copies together, so fixing one copy left the
other two broken.

So an entry declares **`checks`**, one or more, and its Presence is their fold: any `absent` answers
`absent`, otherwise any `unknown` answers `unknown`, otherwise `present`. `check = { … }` stays legal as
a one-element list, and the file stays at `version = 1`. A pointer segment may be double-quoted to name
a key literally or numeric to index an array, and a pointer ACM cannot spell refuses the file with its
line and column instead of answering for it. A fifth predicate `includes` answers membership in the
array at an address by deep equality; a sixth, `section`, compares one Section of a native instruction
file against a Payload. An Install command's text, when it is too long to read inline, lives in a
Payload, and a Payload takes arguments, which reach it as argv and are never substituted into its text.

A **Section** is where the native file and the environment file already agree: the `## ` heading the
Payload's first line spells, through the line before the next `## ` heading, with `## ` lines inside a
fenced code block ignored. ACM compares it byte for byte after stripping trailing blank lines from both
sides, and an install may rewrite that Section and nothing else of the file. The alternative was markers
ACM injected, which would put ACM's own syntax inside a file it does not own; the heading was already
there, and taking the title from the Payload means one place spells it.

## Considered Options

- **Injecting `<!-- acm:… -->` markers into the native file.** Rejected: the environment file would
  write its own syntax into a file it does not own, and every native instruction file would carry ACM's
  comment convention forever, visible in the harness and in any editor.
- **Comparing the whole native file against a Payload.** Rejected: all three real instruction files hold
  hand-written sections of their own, so an ACM-owned file would have to absorb them.
- **Steps: each sub-entry with its own Check and its own Install command.** Rejected: an entry would
  nest, every Run would record a step rather than a Provision, and the entry would need a second fold
  for its own Presence anyway.
- **Placeholders in Install text (`{name}` substitution).** Rejected: substitution turns a static text
  into a template, and then two entries that differ by one word can no longer be read as one command.
- **A JSONPath in `pointer`.** Rejected: one predicate would then have to answer over a set, which is
  what `includes` is for.
- **`version = 2` refusing `version = 1`.** Rejected: every change here is additive, so the bump would
  cost a rewrite of every existing file to buy nothing.

## Consequences

- An Install command has two shapes — text, or a Payload plus argv — and `args` is the one place an
  entry names values instead of text. A Run records the argv as spelled, so history names the Payload
  that ran rather than the bytes it held at the time.
- `contains` stays whole-file and remains the answer for a file that holds one thing. It is the only
  predicate that cannot be scoped, which is why a stale entry in a mixed file matched it.
- A file is read once: when two Tiers resolve to one path, the `user` Tier keeps it, because a
  Project root inside `$HOME` must not relabel the home file as a project declaration. `status` prints
  the file each entry came from, and `--tier` names where it looked when a filter matches nothing.
- Nothing is declared absent and nothing is removed. A Provision says what should be present, an
  entry's Section is the only text ACM may overwrite, and retiring a Provision is an edit to the file.
  A remove command, a `--prune` mode, and a delete tool stay out of scope until a machine has to be
  reproduced *without* a leftover.
