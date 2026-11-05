# Do not manage claude.ai cloud configuration

ACM inventories configuration that lives on this machine. It does not read, store, display, or
manage the plugins and skills configured on claude.ai. The cloud half of the dashboard — the
`/refresh-cloud` scrape, its `cloud.json` drop file, the cloud snapshot rows, the Cloud columns in
the plugin and skill tables, and the per-item comments that existed only to explain a missing
counterpart — was removed rather than extended. Cloud configuration is outside the target vision:
this tool manages config the user operates on their own machine, and a claude.ai account's plugin
list is not that, is not what the cross-harness mirroring work targets, and is not something the
user runs.

## Considered Options

- **Keep the scrape and the comparison** (the state before this ADR): the only read path is an
  agent driving a browser against claude.ai and writing JSON. Nothing verifies the result, the
  page can change without notice, and every misread shows up as a false "missing" row that then
  needs a human comment to explain.
- **Keep the display, drop the scrape**: leaves a panel that can only go stale, with no path back
  to fresh data.
- **Chosen**: no cloud configuration management at all.

## Consequences

- The `comments` feature is gone with it. It had no second purpose: every comment input rendered
  into a "missing on the other side" cell, so with no other side there is nothing to annotate.
  Comments for project-vs-project comparisons never used it — that view has its own selection UI.
- `installCommand` in `/settings` survives, and both its dashboard columns are now labelled
  "Install command". Those are recipes for setting a tool up on a machine that lacks it, cloud or
  otherwise; they are not claude.ai configuration.
- `cloud.json` is no longer a drop point. The scanner writes only local snapshots.
- Reintroducing cloud inventory means reintroducing an unverifiable input. The bar is a read path
  that can be tested without a browser and an agent, not another scrape.
