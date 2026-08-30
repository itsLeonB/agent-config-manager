Scrape claude.ai's cloud-side plugin/skill configuration and write it to `database/cloud.json` in this project, so the dashboard's Cloud section reflects current state.

Do NOT scrape connectors (`https://claude.ai/customize/connectors`). Connectors (Figma, Notion, Google Drive, etc.) sync automatically into Claude Code's local MCP server list — verified via `claude mcp list`, which shows them as `claude.ai <Name>` entries even though they're never written to `~/.claude.json`. Tracking them separately here as "cloud" data produced false "missing from user scope" flags for things that were already present locally. `mcpServers` in `cloud.json` stays `[]`; leave it alone.

Steps:

1. Use the `claude-in-chrome` tools to navigate to claude.ai's Customize page, which has skills and plugins as tabs, filtered to "Yours" (not "Browse"):
   - `https://claude.ai/customize/skills`
   - `https://claude.ai/customize/plugins`
   (If these redirect or 404, the page moved — search around; `claude.ai/customize` is the parent.)
2. Extract, for each category: plugins (name, marketplace — shown as the colored tag next to the title, description), skills (name, description, and — if the skill card shows a colored plugin tag next to its title, same as on the Plugins tab — that tag's value as `marketplace`, matching the `marketplace` of the corresponding plugin entry; skills with no tag are standalone and should omit `marketplace`).
3. Overwrite `database/cloud.json` (full snapshot, no merge with the previous file) matching exactly this schema:

```json
{
  "lastUpdated": "2026-01-01T00:00:00.000Z",
  "plugins": [{ "name": "", "marketplace": "", "description": "" }],
  "mcpServers": [],
  "skills": [{ "name": "", "description": "", "marketplace": "(optional — only if tagged to a plugin)" }]
}
```

`lastUpdated` must be the current time in ISO 8601. Omit fields you couldn't find rather than guessing at values. If a category has nothing, write an empty array `[]` for it, not `null`.

4. Report a one-line summary of counts (plugins/skills found).
