# 08: Native reads, secret-free

**What to build:** an agent can ask what one harness declares at its configuration paths, so it can author Provisions for a harness that has none yet. The answer names each declaration's native location and never carries a credential: a credentialed pointer comes back as its marker, not its value. The answer is live and unstored.

**Blocked by:** 02, 03

**Status:** ready-for-agent

- [ ] The MCP tool `read_native_config` accepts a harness and an optional tier, and declares `readOnlyHint: true`.
- [ ] `acm read <harness>` prints the same answer on the command line.
- [ ] The answer covers every path that harness's read lookup declares at that tier, and names each declaration's native location.
- [ ] The secret classifier and the credential pointers run before anything reaches the result: a fixture config holding a secret-shaped value reports its marker, and the value appears in no field of the result, no log line, and no error message.
- [ ] A file that does not parse is reported as a parse failure naming the file, not as an empty answer.
- [ ] Nothing is stored, and no Install command runs.
