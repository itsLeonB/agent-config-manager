# 22: Risky plans, graded consent, and conflicts

Type: task
**Status:** ready-for-agent

**What to build:** a plan that carries executable content, secret values, an irreversible write, a copy
of a directory, a new directory, or a conflict is graded risky; everything else is safe. On a client
that cannot ask a human, the risky writes come back as manual steps while the safe remainder still
lands. A target that already matches, or is the source location itself, comes back with no writes at
all. A target that differs refuses until replacement is asked for explicitly.

**Blocked by:** 20.

- [ ] each risk condition flips the plan's grade to risky, and a plan with none of them stays safe
- [ ] a safe plan applies without any human answer, recorded as authorised by the client's own policy
- [ ] a risky plan on a client without elicitation applies the safe writes and returns the risky ones as manual steps
- [ ] an already-matching target and a target equal to the source each return a plan with no writes and the reason stated
- [ ] a differing target refuses by default, shows both the current and proposed value, and proceeds only when replacement is explicitly requested
- [ ] every gap reason maps to exactly one disposition, and a test fails if a reason has no rule
- [ ] no flag, environment variable, or stored approval lets a risky write skip the gate

