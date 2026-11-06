# Grade every plan in the engine, and gate only the writes that need a human's own answer

Engine and agent run as the same OS user, so no channel the engine controls can tell a human's
approval from an agent's assertion: an approval token, a state file, a `confirm: true` argument, or
a `--yes` flag are all writable by the agent. Only MCP elicitation escapes that, because the client
renders the dialog. So the engine grades each plan `safe` or `risky` from one table of risk
conditions, and only a risky write needs a human's own answer. A `safe` plan applies on any client
and records `consent: client-policy`, meaning the harness's own permission configuration authorised
it — the same authorisation every other tool that client offers runs on.

A plan is self-addressed and `planIdOf` is public, so the grade on the document is a claim. `apply`
therefore re-computes it from the writes it is about to perform and takes the stricter of the two,
and the operation row records the grade apply computed.

## Considered Options

- **Grade in the engine, gate per write** (chosen). A client without elicitation (Pi 1.5.0, and the
  CLI) still applies the safe remainder; the risky writes come back as `manualSteps[]`, handed over
  as `file` + `pointer`, never as their value.
- **Refuse a risky plan outright.** Simple, but it makes every first mirror impossible: a target file
  that does not exist yet is a risk condition.
- **A caller-supplied `confirm` / `--yes` / environment variable.** Rejected: the agent can write all
  three, so the gate would be decorative. There is no automation policy, no blanket approval, no
  session-wide consent, and no standing consent per path or adapter.
- **Gate the whole plan instead of the writes.** Then one executable write would stop a plan whose
  other writes are harmless, and the human would have to re-plan after typing the one line.

## Consequences

- **`onConflict: replace` is a gate, not a bypass.** A target that differs refuses by default and the
  refusal shows every pointer with both values. `replace` is the named ask from ticket 07 §6; it
  answers only the conflict, so a conflicting write that also runs a command still comes back as a
  manual step.
- **A write that creates its target file lands.** It grades the plan risky (safe needs a pre-existing
  file) but it needs no tick, and the engine seeds an empty document of the right format, so the
  first mirror into a fresh config works. The grade still reaches the client's own permission layer,
  which is what gates on it.
- **`consent: elicitation` is declared and unproduced.** Only a client can render the dialog, and the
  engine must not send `elicitation/create` unless the client declared the capability, so the human's
  answer arrives with the MCP surface. Until then every apply records `client-policy` and every
  flagged write is a manual step.
- **The cost is stated:** a `safe` write can still break a config file if the classifier is wrong
  about "safe". The mitigation is structural — preconditions, `preserved[]`, pointer-level merge —
  not consent. The engine can bound *what it will do without an answer*; it cannot promise the answer
  was wise.
