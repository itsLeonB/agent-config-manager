# 15: A Provision is defined with its real shape

**What to build:** an agent calling `define_provision` sees every predicate and every install form in
the tool's own schema, so writing a Provision no longer means reading the evaluator to guess at the
shape, and a wrong one is refused before anything is written.

**Blocked by:** 10, 11, 12, 13

**Status:** ready-for-agent

- [ ] The tool's `checks` input is a discriminated union over the six predicates, each with a
      description naming what it answers, and `install` is a union over the three shapes.
- [ ] A refused definition reports the same line, column, and reason the loader would, and writes
      nothing.
- [ ] An entry with several Checks, a Payload with arguments, and a Section write can each be defined
      through the tool and then read back by `acm status`.
- [ ] spec.md's MCP surface section states that the schema is the shape, and that no tool deletes a
      Provision.
- [ ] Tests cover one accepted definition per predicate and one refused definition per refusal reason.
