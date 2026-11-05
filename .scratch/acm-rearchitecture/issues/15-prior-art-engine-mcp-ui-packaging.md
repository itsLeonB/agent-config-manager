# Prior art: how comparable tools package an engine + MCP server + UI

Labels: wayfinder:research
Type: research
Status: claimed
Blocked by: none
Blocks: 14

## Question

Ticket 14 has to say what each moving part **is**: which runtime hosts the engine, what command a
harness spawns, which process owns the SQLite file, and whether the UI is a web dashboard (today),
a desktop app, or neither. Those are packaging questions, and other projects have already paid for
the answers. Before deciding, establish what the field actually does — from primary sources
(their repos, specs, and first-party docs), not blog summaries.

Survey the design space of tools that ship **all or most** of: a core engine installed on the user's
own machine, an MCP server that foreign harnesses spawn, several different harness config formats
to write into, and a UI that is *not* a plain server-rendered web page.

Candidate corpus (add or drop as the sources dictate — judge by "does it ship 2+ of the three parts"):

1. **MCPB / `.mcpb` bundles** (`modelcontextprotocol/mcpb`) and Claude Desktop's extension packaging —
   the official answer to "how does a host ship a server the user does not build".
2. **Multi-client MCP config managers** — a macOS/native app that writes per-harness MCP config for
   several clients at once (e.g. `mcpbundler`), `1mcp-app/agent`, `metamcp`, `mcpm`-style hubs.
3. **Electron/Tauri AI clients that spawn MCP servers** — Cherry Studio, Jan, ChatWise/DeepChat,
   Continue (VS Code extension + core + MCP).
4. **Harness-side precedents** — how Codex, OpenCode, and Pi themselves ship and spawn their own
   bundled MCP servers (`codex-app-tools` launcher is on this machine; inspect it as a primary
   source), and how they locate `node`.

Answer, with a citation per claim:

- **Process topology.** One process, a daemon, or a fresh process per client? Who owns the database
  and what happens when two instances run at once (WAL, lock file, socket, or single-writer daemon)?
- **Spawn shape.** Absolute interpreter + entry path, a bundled runtime inside the app, a
  single-file binary, `npx`/`uvx`, or an MCPB manifest? What breaks in each (PATH, cwd, node
  version, first-run download)?
- **Where the engine lives relative to the MCP entry.** Same package, sibling package, or separate
  install; and how they stop the two from importing past a boundary.
- **UI shape and what it buys.** Electron/Tauri/extension/web: does the UI ever *own* the engine
  (start/stop it, host the MCP server in-process), and what did that cost them?
- **Multi-harness config writing.** Anyone writing several harness formats from one engine: how
  they model per-harness differences and whether they write config directly or shell out to CLIs.

Deliverable: `.scratch/acm-rearchitecture/assets/15-prior-art.md` on a `research/prior-art` branch,
no PR. Close with a short "what this implies for ticket 14" section — options only, no decision;
the decision is ticket 14's.
