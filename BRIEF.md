# Agent Config Manager
## Project Brief

### 1. Overview

Agent Config Manager (ACM) is a local-first, multi-harness configuration management system for AI coding agents.

It provides a unified way to discover, inspect, compare, install, and manage the tools and configuration that make up an AI coding environment, across different coding-agent harnesses.

ACM is built around a **shared management engine exposed through a CLI and MCP server**. Developers can manage their environments directly through the CLI, while AI agents can perform the same operations through MCP.

A separate web interface provides a read-only view of the environment, using the same underlying data source. It exists for human visibility, inspection, and observability—not as another management interface.

The system should work with each harness's native configuration format and preserve native behavior rather than attempting to replace harness configuration with a universal format.

**Core principle: One management engine, multiple interfaces, native configuration as the source of truth.**

---

### 2. Problem Statement

AI coding environments are becoming increasingly fragmented.

Developers use multiple coding-agent harnesses, each with different conventions, configuration locations, installation methods, and supported capabilities.

The same component may need to be installed or configured differently depending on the harness:

- Instructions use different filenames and discovery conventions.
- Skills may have different directory structures and compatibility requirements.
- MCP servers use different configuration formats and scopes.
- Hooks and plugins have harness-specific lifecycle and execution behavior.
- Some harnesses support global configuration, while others primarily support project-level configuration.

This creates several problems:

1. **Fragmentation:** Developers must understand and maintain multiple configuration systems.
2. **Duplication:** The same component may be installed independently across multiple harnesses.
3. **Poor visibility:** There is no consistent overview of what is installed, where it is installed, and which harness uses it.
4. **Configuration drift:** Changes made outside a management tool can cause environments to become inconsistent.
5. **Installation complexity:** Documentation is scattered, and installation procedures vary by harness and version.
6. **Limited agent autonomy:** Coding agents can use their own tools but lack a standardized, safe interface for managing the broader agent ecosystem.

Existing solutions address parts of this problem through configuration synchronization, package management, or dashboards. ACM aims to combine environment discovery, lifecycle management, installation intelligence, and agent-native operations.

---

### 3. Product Vision

Build the management infrastructure for AI coding environments.

ACM should allow a developer or coding agent to answer questions such as:

- Which coding-agent harnesses are installed?
- What version of each harness is available?
- Which skills, MCP servers, hooks, plugins, and instruction files are installed?
- Which installations are global, project-shared, or developer-local?
- Which components are shared across harnesses?
- What is supported by each harness?
- How can a component be installed correctly for a particular harness and scope?
- Has an installation changed outside ACM?
- Can an installation be verified, repaired, or rolled back?

The goal is not to create another configuration format or synchronization dashboard.

It is to provide a reliable management layer that understands the native configuration systems of multiple harnesses.

---

### 4. Product Interfaces

ACM has three primary interfaces, all backed by the same core engine and data model.

#### 4.1 CLI — Developer Interface

The CLI is the primary interface for direct human operation, scripting, automation, and troubleshooting.

It should expose the full management capabilities of the core engine.

Example commands:

```bash
# Environment discovery
acm scan
acm status
acm list harnesses

# Component inventory
acm list
acm list skills
acm list mcp
acm inspect serena

# Comparison and diagnostics
acm compare --project ./project-a --project ./project-b
acm drift
acm doctor

# Installation lifecycle
acm install serena --harness opencode --scope user
acm plan show <plan-id>
acm plan apply <plan-id>
acm verify <installation-id>
acm rollback <operation-id>

# Machine-readable output
acm list --json
acm status --json
```

Requirements:

- Human-readable output by default.
- Machine-readable JSON output for agent and script consumption.
- Consistent command behavior across operating systems.
- Clear distinction between read operations and mutations.
- Explicit approval for operations that modify the environment.
- Noninteractive operation where explicitly requested and safely permitted.

#### 4.2 MCP Server — Agent Interface

The MCP server exposes ACM's management capabilities to AI coding agents.

An agent should be able to inspect and manage the developer's broader coding-agent environment without needing to understand every harness's filesystem layout or configuration format.

The MCP server must use the same core services as the CLI. It must not implement an independent management system.

Initial tool groups:

| Group | Example tools |
|---|---|
| Discovery | `scan_environment`, `list_harnesses` |
| Inventory | `list_components`, `inspect_installation` |
| Comparison | `compare_scopes`, `detect_drift` |
| Research | `research_installation`, `get_recipe` |
| Planning | `create_installation_plan` |
| Execution | `apply_plan`, `rollback_operation` |
| Verification | `verify_installation` |

The agent workflow should generally follow:

1. Discover the current environment.
2. Inspect the requested component and target harness.
3. Research the appropriate installation method if necessary.
4. Generate a structured installation plan.
5. Present the plan and obtain approval where required.
6. Apply the plan through the deterministic executor.
7. Verify the resulting installation.

**Security requirements:**

- Do not expose an unrestricted shell execution tool.
- Separate planning from execution.
- Require explicit authorization for mutations unless a deliberate automation policy grants it.
- Apply filesystem and command execution restrictions.
- Preserve unknown configuration fields.
- Never copy credentials automatically.
- Treat hooks and plugins as executable code requiring appropriate trust controls.

MCP should be designed for both interactive agents and autonomous workflows, with permissions enforced by the core engine rather than relying on the agent to behave correctly.

#### 4.3 Web UI — Read-Only Human Interface

The web interface provides visibility into the developer's coding-agent environment.

It is not a second management application.

The UI should:

- Read from the same underlying data source as the CLI and MCP.
- Display detected harnesses and versions.
- Show installed components and their locations.
- Visualize scope and harness compatibility.
- Show component relationships and shared installations.
- Display configuration differences and drift.
- Present installation recipes and their evidence.
- Display operation history, verification results, and rollback outcomes.
- Highlight unmanaged installations and configuration health.

The UI must not independently install, edit, remove, synchronize, or repair configuration.

All management operations belong to the core engine and are invoked through the CLI or MCP.

This separation avoids duplicating business logic and ensures that agents and developers use the same management rules.

---

### 5. Managed Components

ACM should manage the following categories.

| Category | Description |
|---|---|
| Instructions | Agent guidance and instruction files such as `AGENTS.md`, `CLAUDE.md`, and harness-specific equivalents |
| Skills | Reusable capabilities and workflows exposed to coding agents |
| MCP servers | External tools and services exposed through the Model Context Protocol |
| Hooks | Lifecycle-triggered scripts and commands |
| Plugins | Harness-specific extensions and packaged integrations |

The canonical data model should distinguish between a component and its installations.

For example, Serena is a component. Its installation in Claude Code at user scope and its installation in OpenCode at project scope are two distinct installation records.

The same component may have multiple installations with different versions, configurations, scopes, and compatibility constraints.

ACM should also distinguish:

- **Discovered:** Found in the environment but not managed by ACM.
- **Adopted:** Existing installation explicitly brought under ACM management.
- **Managed:** Installation whose lifecycle and expected state are tracked by ACM.

Discovery must not automatically imply ownership or permission to modify an installation.

---

### 6. Scope Model

Scopes are first-class concepts in the data model.

| Scope | Meaning |
|---|---|
| User | Global configuration belonging to an individual developer |
| Project | Shared configuration intended to be committed and used by collaborators |
| Project-local | Developer-specific project configuration, generally excluded from version control |

Not every harness supports every category at every scope.

ACM must represent actual harness capabilities accurately rather than pretending that all combinations are supported.

Each installation should record:

- Harness
- Component
- Scope
- Native configuration location
- Installation method
- Version, if applicable
- Configuration state
- Provenance
- Management status
- Verification status

Native paths and configuration formats should remain visible and traceable.

---

### 7. Supported Harnesses

#### Initial support

1. Claude Code
2. OpenCode
3. Codex
4. Pi

#### Future candidates

- Gemini CLI
- Qoder
- Mistral Vibe
- Cursor
- GitHub Copilot
- Other emerging coding-agent harnesses

Harness support must be implemented through independent adapters.

Each adapter describes:

- Harness identification and version detection.
- Supported component categories.
- Supported scopes.
- Native configuration paths.
- Discovery and parsing logic.
- Installation and removal behavior.
- Configuration merging and preservation.
- Verification procedures.
- Compatibility limitations.

A harness adapter must not claim support for a feature that the harness itself does not support.

---

### 8. Core Architecture

The core engine is the primary product. CLI, MCP, and web UI are interfaces to it.

Conceptually:

```text
                   Developer
                       |
                 +-----+-----+
                 |           |
                CLI         Web UI
                 |       (Read-only)
                 |           |
                 +-----+-----+
                       |
                 Shared Data
                       |
                 Core Engine
                       |
          +------------+-------------+
          |            |             |
       Discovery    Management    Installation
          |            |          Intelligence
          |            |             |
          +------------+-------------+
                       |
                    Adapters
                       |
          +------------+-------------+
          |            |             |
        Claude      OpenCode       Codex
                       |
                      Pi

                 MCP Server
                      |
                AI Coding Agents
```

The MCP server and CLI invoke the same application services.

The web interface reads from the same persisted state through a read-only API or service boundary.

#### 8.1 Core Domain and Application Services

The engine should provide reusable operations such as:

```typescript
discover()
listHarnesses()
listComponents()
inspectInstallation()
compareScopes()
detectDrift()

researchInstallation()
getInstallationRecipe()
createInstallationPlan()

applyPlan()
verifyInstallation()
rollbackOperation()
```

These are conceptual operations, not necessarily the final public API.

The engine owns:

- Domain models.
- Harness capability resolution.
- Component and installation lifecycle.
- Compatibility checks.
- Plan validation.
- Permission enforcement.
- Execution coordination.
- Verification.
- Drift detection.
- Operation history.

#### 8.2 Harness Adapters

Adapters translate between ACM's domain model and each harness's native configuration system.

They should provide a consistent contract while retaining harness-specific behavior.

Avoid forcing every harness into identical installation semantics.

An adapter may report an operation as unsupported, partially supported, or requiring manual intervention.

#### 8.3 Storage

Use SQLite initially as the shared local data store.

It should persist:

- Detected harnesses and versions.
- Component catalog.
- Installation records.
- Native configuration metadata.
- Installation recipes.
- Execution plans.
- Operation history.
- Verification results.
- Drift observations.

The database is ACM's management metadata and operational history—not a replacement for native harness configuration.

The actual harness configuration remains authoritative for runtime behavior.

The core engine should be the only component responsible for writing to ACM's database.

The web UI should consume read-only views or API endpoints rather than writing directly to SQLite.

#### 8.4 Local Execution Model

Start with an embedded core library and shared SQLite database used by the CLI, MCP server, and web application.

Do not require a background daemon for the initial release.

Keep a service boundary so a local daemon can be introduced later if needed for:

- File watching.
- Concurrent operations.
- Process coordination and locking.
- Multiple clients.
- Remote or browser-based access.
- Long-running installation workflows.

---

### 9. Installation Intelligence

One of ACM's key differentiators should be its ability to discover and understand installation procedures.

Installation methods differ across harnesses, versions, and component types. Static mappings alone will eventually become outdated.

ACM should support agent-assisted research that generates structured installation recipes.

#### Research workflow

1. Identify the component and target harness.
2. Determine the harness version and requested scope.
3. Research the relevant official documentation.
4. Resolve prerequisites and compatibility.
5. Determine the appropriate installation method.
6. Produce a structured installation recipe.
7. Attach supporting sources and evidence.
8. Define verification and rollback procedures.

#### Evidence priority

1. Official harness documentation.
2. Official component or vendor documentation.
3. Official repositories and release notes.
4. Official package registry documentation.
5. Community documentation as a fallback.

#### Recipe metadata

Each recipe should contain:

- Component identity and version.
- Target harness and version constraints.
- Supported scope.
- Installation operations.
- Prerequisites.
- Expected filesystem and configuration changes.
- Verification procedure.
- Rollback procedure.
- Known limitations.
- Source URLs and supporting evidence.
- Research date.
- Confidence and verification status.

#### Recipe confidence states

| State | Meaning |
|---|---|
| Verified | Installation has been tested and verified |
| Documented | Supported by official documentation but not independently tested |
| Agent-proposed | Generated from available evidence and awaiting review |
| Manual | Requires an interactive or unsupported operation |

Recipes should be versioned and considered stale when relevant harness versions, component releases, or documentation change.

#### Separation of responsibilities

Installation intelligence must not directly execute arbitrary installation instructions.

The process should be separated into:

1. **Research agent:** Finds and proposes installation methods.
2. **Recipe compiler:** Converts research into structured operations.
3. **Core validator:** Checks compatibility, permissions, and safety.
4. **Executor:** Applies approved operations deterministically.
5. **Verifier:** Checks the resulting installation.

This is important because an AI-generated installation recipe should never automatically become unrestricted executable code.

---

### 10. Installation Execution and Lifecycle

Installation operations should use a structured operation vocabulary.

Examples:

- Create directory.
- Copy file or directory.
- Create symlink.
- Write file.
- Merge configuration.
- Install package.
- Run approved command.
- Remove managed file.
- Perform manual action.
- Restart or reload required service.

Every plan should describe:

- Target installation.
- Intended changes.
- Prerequisites.
- Expected resulting state.
- Required permissions.
- Potential conflicts.
- Verification steps.
- Rollback feasibility.

#### Plan → Apply → Verify

All meaningful mutations should follow a consistent lifecycle:

**Plan**

Generate a preview of the intended changes without modifying the environment.

**Apply**

Execute the approved plan through the appropriate adapter.

**Verify**

Check that the resulting configuration and installation match the expected state.

**Rollback**

Restore the previous state where possible.

Not all operations can be reversed. The engine must explicitly identify irreversible or partially reversible operations before approval.

#### Configuration preservation

ACM must avoid destructive configuration replacement.

It should:

- Preserve unknown fields.
- Merge only the intended configuration.
- Avoid overwriting unrelated user changes.
- Detect conflicting modifications.
- Keep backups before modifying files.
- Record what it changed.
- Never silently take ownership of unmanaged configurations.

Hooks and plugins require additional caution because they can execute arbitrary code.

---

### 11. Discovery, Inventory, and Drift Detection

Discovery should be useful even when users do not want ACM to manage anything.

ACM should scan the environment and produce a structured inventory of:

- Installed harnesses.
- Harness versions.
- Components.
- Native configuration locations.
- Scope.
- Installation status.
- Dependencies and relationships.
- Compatibility information.

Drift detection should compare expected managed state against actual native configuration.

Examples:

- A managed skill was manually modified.
- An MCP server was removed outside ACM.
- A harness upgraded and changed its configuration format.
- A component exists in one harness but not another.
- An unmanaged installation conflicts with a proposed managed installation.

Drift detection should report differences, not automatically overwrite them.

The user or agent must decide whether to adopt, repair, ignore, or remove conflicting state.

---

### 12. User Workflows

#### Workflow A: Environment Discovery

1. Run `acm scan`.
2. Detect installed harnesses and versions.
3. Inspect supported scopes and component categories.
4. Discover existing installations.
5. Persist inventory and provenance.
6. Display the environment in the read-only UI.

#### Workflow B: Cross-Harness Comparison

1. Inspect a component or scope.
2. Compare its installations across harnesses.
3. Identify missing, different, or incompatible configurations.
4. Generate a report.

#### Workflow C: Agent-Assisted Installation

1. Agent requests a component installation through MCP.
2. ACM discovers the target harness and scope.
3. ACM finds an existing recipe or researches one.
4. ACM generates a validated plan.
5. Agent presents the plan for approval.
6. ACM executes the approved operations.
7. ACM verifies and records the result.

#### Workflow D: Adopt Existing Installation

1. Discover an unmanaged component.
2. Inspect its native configuration.
3. Present its current state and provenance.
4. User or agent explicitly adopts it.
5. ACM starts tracking it without unnecessarily changing it.

#### Workflow E: Drift Investigation

1. ACM detects a change.
2. The CLI or MCP reports the affected installation.
3. The user or agent inspects the difference.
4. ACM proposes possible remediation.
5. Approved remediation is applied and verified.

---

### 13. Web UI Information Architecture

The web UI should be organized around visibility into the environment.

Suggested sections:

**Overview**
- Environment health.
- Detected harnesses.
- Component counts.
- Drift alerts.
- Recent operations.

**Harnesses**
- Installed harnesses and versions.
- Supported capabilities.
- Native configuration locations.
- Component inventory per harness.

**Components**
- Skills.
- MCP servers.
- Instructions.
- Hooks.
- Plugins.
- Component details and installation relationships.

**Scopes**
- User.
- Project.
- Project-local.
- Cross-harness comparisons.

**Compatibility**
- Harness and component support matrix.
- Version constraints.
- Unsupported or partially supported capabilities.

**Recipes**
- Installation procedures.
- Evidence and source references.
- Confidence and verification state.
- Known limitations.

**Activity**
- Installation plans.
- Applied operations.
- Verification results.
- Rollback history.
- Drift observations.

The UI should favor clear inventory, comparison, and diagnostic views over configuration editors or management dashboards.

---

### 14. Existing Project Migration

ACM should evolve from the existing Agent Config Manager implementation rather than replace it wholesale.

The current application already contains useful foundations:

- TanStack Start and React 19 interface.
- TypeScript and Bun tooling.
- Existing Claude Code configuration discovery.
- Skills, MCP, plugins, and instruction inventory.
- SQLite persistence.
- Secret redaction.
- Project comparison.
- Offline scanning through `scan.cjs`.
- Centralized database access through `src/server/store.cjs`.

These capabilities should be preserved where practical.

The migration should progressively separate existing responsibilities:

1. Extract existing domain logic and discovery functionality.
2. Establish canonical component and installation models.
3. Move database access behind the storage layer.
4. Introduce adapter contracts.
5. Convert the existing Claude implementation into the first adapter.
6. Add OpenCode, Codex, and Pi adapters.
7. Expose the engine through CLI and MCP.
8. Refactor the existing TanStack Start application into a read-only UI.

Avoid a full rewrite simply to achieve a new directory structure.

The migration should preserve existing working behavior while gradually moving responsibilities into the core engine.

---

### 15. Implementation Roadmap

#### Phase 1 — Core Extraction

- Audit existing implementation.
- Identify domain logic and existing capabilities.
- Define canonical data models.
- Separate storage from application logic.
- Establish adapter interfaces.
- Preserve existing scanner functionality.

**Outcome:** A reusable core engine with the existing Claude functionality.

#### Phase 2 — Multi-Harness Discovery

- Implement Claude Code adapter.
- Implement OpenCode adapter.
- Implement Codex adapter.
- Implement Pi adapter.
- Add harness capability metadata.
- Discover components across supported harnesses.
- Persist inventory and provenance.

**Outcome:** Consistent environment discovery across the initial harnesses.

#### Phase 3 — CLI

- Implement CLI commands.
- Support human-readable and JSON output.
- Expose inventory, inspection, comparison, and diagnostics.
- Add plan previews and operation history.
- Establish mutation approval policies.

**Outcome:** The engine becomes independently usable without the web interface.

#### Phase 4 — MCP

- Expose core operations as MCP tools.
- Implement discovery and inspection tools first.
- Add comparison and drift detection.
- Add installation planning.
- Introduce permission-aware execution tools.

**Outcome:** AI coding agents can inspect and manage the broader environment through a standardized interface.

#### Phase 5 — Installation Intelligence

- Research official installation documentation.
- Define structured recipe schemas.
- Add source and evidence tracking.
- Implement recipe validation.
- Introduce recipe versioning and stale detection.

**Outcome:** ACM can generate harness-specific installation plans from documented evidence.

#### Phase 6 — Deterministic Execution

- Implement plan validation.
- Add safe filesystem operations.
- Add configuration merging.
- Add approved command execution.
- Implement backups and rollback.
- Implement verification.

**Outcome:** Reliable, auditable component lifecycle management.

#### Phase 7 — Read-Only Web UI

- Connect the existing TanStack Start application to shared read-only services.
- Display harness and component inventory.
- Add scope and compatibility views.
- Add drift and activity views.
- Add recipe and evidence inspection.

**Outcome:** Human-friendly visibility into the same environment managed by CLI and MCP.

#### Phase 8 — Advanced Management

- Improve drift detection.
- Add cross-harness comparison and remediation proposals.
- Add more harness adapters.
- Add file watching if justified.
- Evaluate a local daemon for concurrent clients and long-running operations.

**Outcome:** A mature, extensible management platform.

---

### 16. Non-Goals

ACM is not intended to:

- Replace the native configuration systems of coding-agent harnesses.
- Create a universal configuration format that every harness must adopt.
- Become a coding-agent harness itself.
- Replace MCP as a protocol.
- Automatically synchronize every component across all harnesses.
- Silently overwrite existing configuration.
- Execute arbitrary AI-generated shell commands.
- Become a marketplace as its primary purpose.
- Provide a web-based configuration editor or management dashboard.

A component should only be installed where the target harness supports it and where the user or agent explicitly authorizes the operation.

---

### 17. Success Criteria

ACM should be considered successful when:

1. A developer can discover their coding-agent environment through one CLI command.
2. The same inventory can be inspected through MCP by an AI agent.
3. Claude Code, OpenCode, Codex, and Pi are supported through independent adapters.
4. Components and installations are represented consistently without losing native configuration details.
5. Existing unmanaged installations can be discovered and explicitly adopted.
6. An agent can research and propose a harness-specific installation plan.
7. The engine can safely apply, verify, and roll back supported operations.
8. Configuration drift can be detected without automatically overwriting user changes.
9. The read-only web UI accurately reflects the same state available through the CLI and MCP.
10. Adding a new harness does not require redesigning the core domain model.

---

### 18. Guiding Principles

1. **Engine first:** CLI and MCP are first-class interfaces to the management engine.
2. **Read-only UI:** The web interface is for human visibility, not a separate management authority.
3. **Native first:** Preserve each harness's native configuration format and behavior.
4. **Discovery before management:** Understand existing environments before attempting to change them.
5. **Explicit ownership:** Discovering an installation does not automatically make it managed.
6. **Agent-native:** AI agents should be able to manage the ecosystem through structured tools.
7. **Research-backed:** Installation recipes should be grounded in evidence, not assumptions.
8. **Deterministic execution:** AI can research and propose; the core engine validates and executes.
9. **Safe by default:** Mutations require authorization, and existing user configuration must be protected.
10. **Incremental extensibility:** New harnesses and component categories should be added through adapters and capabilities.

**The defining idea: Agent Config Manager is the infrastructure layer that lets developers and AI agents discover, understand, and safely manage the entire AI coding environment—regardless of which harness they use.**
