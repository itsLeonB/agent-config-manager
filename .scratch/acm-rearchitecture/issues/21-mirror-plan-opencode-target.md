# 21: Mirror plan into an OpenCode target

Type: task
**Status:** ready-for-agent

**What to build:** the same planning path, targeting OpenCode. This is where the mechanical
differences live: an inverted enable flag, a command array instead of a command plus arguments, a
required type field a source does not have, seconds becoming milliseconds, and a config file that may
still hold a legacy flat shape. The plan must show each of those as a named mapping, must not mix the
old and new shapes into one document, and must report target-only and source-only fields correctly
instead of guessing.

**Blocked by:** 19.

- [ ] an enable flag mirrors as its inverted counterpart, shown as an invert mapping
- [ ] a command plus arguments mirrors as one command array, shown as a concat mapping
- [ ] the transport type is inferred from the source's shape and written as a required value
- [ ] second-valued timeouts land as milliseconds and the mapping is named
- [ ] a config holding the legacy flat shape is normalised so the written document has one shape, and sibling entries are preserved
- [ ] timeouts that do have an OpenCode equivalent are mapped rather than dropped, while fields with no equivalent become gaps with a reason
- [ ] a manual step names any higher-precedence layer that could shadow the write

