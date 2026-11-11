# 15: A Provision is defined with its real shape

**What to build:** an agent calling `define_provision` sees every predicate and every install form in
the tool's own schema, so writing a Provision no longer means reading the evaluator to guess at the
shape, and a wrong one is refused before anything is written.

**Blocked by:** 10, 11, 12, 13

**Status:** resolved

- [x] The tool's `checks` input is a discriminated union over the six predicates, each with a
      description naming what it answers, and `install` is a union over the three shapes.
- [x] A refused definition reports the same line, column, and reason the loader would, and writes
      nothing.
- [x] An entry with several Checks, a Payload with arguments, and a Section write can each be defined
      through the tool and then read back by `acm status`.
- [x] spec.md's MCP surface section states that the schema is the shape, and that no tool deletes a
      Provision.
- [x] Tests cover one accepted definition per predicate and one refused definition per refusal reason.

## Answer

`define_provision`'s schema now spells the file: `checks` is a discriminated union of the six
predicates with a description per member, and `install` a union of the command string, the Payload
form and the Section form. The zod layer expresses shape only, not rules — exclusivity, emptiness,
pointer spellability and the closed key set still come from `parse.ts`, so a definition the loader
would refuse comes back as the loader's own `line:column: reason` and nothing is written. The one gap
that remains is a declared field of the wrong type, which zod rejects before the loader can name it.

The round trip is tested through the built bundle over stdio (Seam C, extended rather than added):
one accepted definition per predicate each landing in the fixture file and read back by
`acm status --json`, several Checks and a Payload with arguments and a Section write round-tripping,
and one refused definition per refusal reason pinned to the exact refusal string. `tools/list` is
asserted to carry the three tool names, their read-only hints, the six predicates and the three
install forms.

spec.md needed no edit: it already stated the schema-is-the-shape decision and that no tool deletes a
Provision.
