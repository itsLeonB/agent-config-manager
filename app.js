const CLOUD_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function loadJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function skillsDropdown(name, skills) {
  if (!skills.length) return esc(name);
  return `<details><summary>${esc(name)} <span class="muted">(${skills.length} skills)</span></summary>
      <ul style="margin:4px 0 0 16px">
        ${skills.map((s) => `<li>${esc(s.name)}${s.description ? ` <span class="muted">— ${esc(s.description)}</span>` : ''}</li>`).join('')}
      </ul>
    </details>`;
}

function groupByMarketplace(items, marketplaceOf) {
  const map = new Map();
  for (const item of items) {
    const key = marketplaceOf(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

// Comments explaining a missing counterpart are stored per-browser
// (localStorage) — there's no backend to write them back to a file.
function commentKey(category, id) {
  return `agent-manager:comment:${category}:${id}`;
}

function loadComment(category, id) {
  try {
    return localStorage.getItem(commentKey(category, id)) || '';
  } catch {
    return '';
  }
}

function wireCommentInputs() {
  document.body.addEventListener('input', (e) => {
    if (!e.target.matches('.comment-input')) return;
    try {
      localStorage.setItem(e.target.dataset.commentKey, e.target.value);
    } catch {
      // localStorage unavailable — comment just won't persist across reloads
    }
  });
}

// cloudLoaded=false means cloud.json hasn't been scraped yet — show "not
// scraped" rather than implying a confirmed absence with a red highlight.
function missingCell(category, id, placeholder, cloudLoaded) {
  if (!cloudLoaded) return `<td class="muted">not scraped yet</td>`;
  const value = esc(loadComment(category, id));
  return `<td class="missing">
      <span class="badge missing-badge">missing</span>
      <input type="text" class="comment-input" data-comment-key="${esc(commentKey(category, id))}" placeholder="${esc(placeholder)}" value="${value}">
    </td>`;
}

function renderPluginsComparison(userScope, cloud) {
  const cloudLoaded = !!cloud;
  const cloudPlugins = cloud?.plugins || [];
  const cloudByMarketplace = new Map(cloudPlugins.map((p) => [p.marketplace, p]));
  const matchedMarketplaces = new Set();

  const skillsByUserPlugin = new Map();
  for (const s of userScope.skills) {
    if (s.source !== 'plugin') continue;
    const key = `${s.plugin}@${s.marketplace}`;
    if (!skillsByUserPlugin.has(key)) skillsByUserPlugin.set(key, []);
    skillsByUserPlugin.get(key).push(s);
  }
  const userRows = groupByMarketplace(userScope.plugins, (p) => p.marketplace)
    .map(([marketplace, plugins]) => {
      const cloudPlugin = cloudByMarketplace.get(marketplace);
      if (cloudPlugin) matchedMarketplaces.add(marketplace);
      const groupMissing = !cloudPlugin; // uniform per group: match key is the marketplace itself

      const body = plugins
        .map((p) => {
          const skills = skillsByUserPlugin.get(`${p.plugin}@${p.marketplace}`) || [];
          const nameCell = skillsDropdown(p.plugin, skills);
          const userCell = `<td class="col-user"><span class="badge ${p.enabled ? 'on' : ''}">${p.enabled ? 'enabled' : 'disabled'}</span> <span class="muted">${esc(p.version || '')}</span></td>`;
          const cloudCell = cloudPlugin
            ? `<td class="col-cloud muted">${esc(cloudPlugin.description || '')}</td>`
            : `<td class="missing col-cloud"><span class="badge missing-badge">missing</span></td>`;
          return `<tr><td>${nameCell}</td>${userCell}${cloudCell}</tr>`;
        })
        .join('');

      const groupHeader = groupMissing
        ? `<tr class="group-row"><td>${esc(marketplace)} <span class="muted">(${plugins.length})</span></td><td class="col-user"></td>${missingCell(
            'plugins',
            `group:${marketplace}`,
            'Why missing from cloud? e.g. all claude-plugins-official entries cannot be installed in cloud',
            cloudLoaded
          ).replace('<td class="missing">', '<td class="missing col-cloud">')}</tr>`
        : `<tr class="group-row"><td colspan="3">${esc(marketplace)} <span class="muted">(${plugins.length})</span></td></tr>`;

      return groupHeader + body;
    })
    .join('');

  const cloudOnlyPlugins = cloudPlugins.filter((p) => !matchedMarketplaces.has(p.marketplace));
  const cloudOnlyRows = cloudOnlyPlugins
    .map(
      (p) =>
        `<tr><td>${esc(p.name)}</td><td class="missing col-user"><span class="badge missing-badge">missing</span></td><td class="col-cloud muted">${esc(p.description || '')}</td></tr>`
    )
    .join('');

  const cloudOnlyBlock = cloudOnlyRows
    ? `<tr class="group-row"><td>Cloud-only <span class="muted">(${cloudOnlyPlugins.length})</span></td>${missingCell(
        'plugins',
        'group:cloud-only',
        'Why missing from user scope?',
        true
      ).replace('<td class="missing">', '<td class="missing col-user">')}<td class="col-cloud"></td></tr>${cloudOnlyRows}`
    : '';

  document.getElementById('plugins-count').textContent = `(${userScope.plugins.length} user, ${cloudPlugins.length} cloud)`;
  document.getElementById('plugins-compare').innerHTML = `
    <table>
      <thead><tr><th>Plugin</th><th class="col-user">User scope</th><th class="col-cloud">Cloud</th></tr></thead>
      <tbody>${userRows + cloudOnlyBlock || '<tr><td class="muted">none</td></tr>'}</tbody>
    </table>`;
}

// claude.ai connectors (Figma, Notion, Google Drive, ...) sync automatically
// into Claude Code's live MCP list (`claude mcp list`) — they're not written
// to ~/.claude.json and aren't tracked here, so there's nothing to compare
// against a "cloud" side. This just lists what scan.js found locally.
function renderMcpList(userScope) {
  const entries = Object.entries(userScope.mcpServers || {});
  const rows = entries
    .map(
      ([name, cfg]) => `<tr>
        <td>${esc(name)}</td>
        <td class="muted">${esc(cfg.type || 'stdio')}</td>
        <td class="muted">${esc(cfg.url || cfg.command || '')}</td>
      </tr>`
    )
    .join('');

  document.getElementById('mcp-count').textContent = `(${entries.length})`;
  document.getElementById('mcp-compare').innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Type</th><th>Command / URL</th></tr></thead>
      <tbody>${rows || '<tr><td class="muted">none</td></tr>'}</tbody>
    </table>
    <p class="muted">claude.ai connectors (Figma, Notion, Google Drive, etc.) sync automatically into Claude Code — check <code>claude mcp list</code> for the live set. Not duplicated here.</p>`;
}

function renderSkillsComparison(userScope, cloud) {
  const cloudLoaded = !!cloud;
  const userSkills = userScope.skills.filter((s) => s.source === 'standalone');
  const cloudSkills = (cloud?.skills || []).filter((s) => !s.marketplace);
  const cloudByName = new Map(cloudSkills.map((s) => [s.name.toLowerCase(), s]));
  const matched = new Set();

  const userRows = userSkills
    .map((s) => {
      const key = s.name.toLowerCase();
      const cloudMatch = cloudByName.get(key);
      let cloudCell;
      if (cloudMatch) {
        matched.add(key);
        cloudCell = `<td class="col-cloud muted">${esc(cloudMatch.description || '')}</td>`;
      } else {
        cloudCell = missingCell('skills', key, 'Why missing from cloud?', cloudLoaded).replace('<td class="missing">', '<td class="missing col-cloud">');
      }
      return `<tr><td>${esc(s.name)}</td><td class="col-user muted">${esc(s.description || '')}</td>${cloudCell}</tr>`;
    })
    .join('');

  const cloudOnlyRows = cloudSkills
    .filter((s) => !matched.has(s.name.toLowerCase()))
    .map((s) => {
      const userCell = missingCell('skills', `cloud-only:${s.name.toLowerCase()}`, 'Why missing from user scope?', true).replace(
        '<td class="missing">',
        '<td class="missing col-user">'
      );
      return `<tr><td>${esc(s.name)}</td>${userCell}<td class="col-cloud muted">${esc(s.description || '')}</td></tr>`;
    })
    .join('');

  document.getElementById('skills-count').textContent = `(${userSkills.length} user, ${cloudSkills.length} cloud)`;
  document.getElementById('skills-compare').innerHTML = `
    <table>
      <thead><tr><th>Name</th><th class="col-user">User scope</th><th class="col-cloud">Cloud</th></tr></thead>
      <tbody>${userRows + cloudOnlyRows || '<tr><td class="muted">none</td></tr>'}</tbody>
    </table>`;
}

// Builds a pasteable script from a list of { heading, commands } groups:
// one `# <heading>` comment per group, followed by that group's commands
// (one comment covers all of a group's commands, not one per command).
function buildInstallScript(groups) {
  return groups
    .filter((g) => g.commands.length)
    .map((g) => `# ${g.heading}\n${g.commands.join('\n')}`)
    .join('\n\n');
}

// Wires a "copy install commands" button. getGroups is called at click time
// so it always reflects the latest rendered data.
function wireCopyButton(buttonId, getGroups) {
  const copyBtn = document.getElementById(buttonId);
  const originalLabel = copyBtn.textContent;
  copyBtn.onclick = async () => {
    const script = buildInstallScript(getGroups());
    try {
      await navigator.clipboard.writeText(script);
      copyBtn.textContent = 'Copied!';
    } catch {
      copyBtn.textContent = 'Copy failed';
    }
    setTimeout(() => {
      copyBtn.textContent = originalLabel;
    }, 1500);
  };
}

function renderEnvironmentTools(tools) {
  document.getElementById('env-tools-count').textContent = `(${tools.filter((t) => t.installedLocally).length}/${tools.length} installed locally)`;

  const rows = tools
    .map(
      (t) => `<tr>
        <td>${esc(t.name)}</td>
        <td>${t.installedLocally ? '<span class="check-yes">✓</span>' : '<span class="check-no">—</span>'}</td>
        <td><pre class="install-cmd">${esc(t.installCommand)}</pre></td>
      </tr>`
    )
    .join('');

  document.getElementById('env-tools').innerHTML = `
    <table>
      <thead><tr><th>Tool</th><th>Local</th><th>Cloud install command</th></tr></thead>
      <tbody>${rows || '<tr><td class="muted">none</td></tr>'}</tbody>
    </table>`;
}

function renderNpxSkills(npx) {
  document.getElementById('npx-count').textContent = `(${npx.skills.length})`;
  const rows = npx.skills
    .map(
      (s) => `<tr>
        <td>${esc(s.name)}</td>
        <td class="muted">${esc(s.source || '')}</td>
        <td><span class="badge ${s.linkedToClaudeUserSkills ? 'on' : ''}">${s.linkedToClaudeUserSkills ? 'linked' : 'not linked'}</span></td>
        <td class="muted">${esc(s.updatedAt || s.installedAt || '')}</td>
        <td>${s.installCommand ? `<pre class="install-cmd">${esc(s.installCommand)}</pre>` : '<span class="muted">—</span>'}</td>
      </tr>`
    )
    .join('');
  document.getElementById('npx-skills').innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Source</th><th>Claude Code</th><th>Updated</th><th>Cloud install command</th></tr></thead>
      <tbody>${rows || '<tr><td class="muted">none</td></tr>'}</tbody>
    </table>
    ${npx.lastSelectedAgents?.length ? `<p class="muted">Target agents: ${npx.lastSelectedAgents.map(esc).join(', ')}</p>` : ''}
  `;
}

function renderCloudBanner(cloud) {
  const el = document.getElementById('cloud-banner');
  if (!cloud) {
    el.innerHTML = `<div class="banner">No cloud data yet. Ask Claude to run <code>/refresh-cloud</code> to scrape claude.ai.</div>`;
    return;
  }
  const age = Date.now() - new Date(cloud.lastUpdated).getTime();
  el.innerHTML =
    age > CLOUD_STALE_MS
      ? `<div class="banner">Cloud data is stale (last updated ${esc(cloud.lastUpdated)}). Run <code>/refresh-cloud</code> to update.</div>`
      : '';
}

function renderProjects(projects) {
  document.getElementById('project-count').textContent = `(${projects.length})`;
  const rows = projects
    .map((p) => {
      const skillCount = (p.skills?.length || 0) + (p.agentsSkills?.length || 0);
      const unlinked = (p.agentsSkills || []).filter((s) => !s.linkedIntoClaudeSkills).length;
      return `<tr data-name="${esc(p.name.toLowerCase())}">
        <td>${esc(p.name)}</td>
        <td class="muted">${esc(p.path)}</td>
        <td>${p.docsFile ? `<span class="badge">${esc(p.docsFile)}</span>` : ''}</td>
        <td>${p.mcpJson ? `<span class="badge on">.mcp.json</span>` : ''}</td>
        <td>${p.pluginInstalls?.length ? `<span class="badge on">${p.pluginInstalls.length} plugin(s)</span>` : ''}</td>
        <td>${skillCount || ''}${unlinked ? ` <span class="badge">${unlinked} unlinked</span>` : ''}</td>
      </tr>`;
    })
    .join('');

  document.getElementById('projects').innerHTML = `
    <table id="projects-table">
      <thead><tr><th>Project</th><th>Path</th><th>Docs</th><th>MCP</th><th>Plugins</th><th>Skills</th></tr></thead>
      <tbody id="projects-body">${rows || '<tr><td class="muted">none</td></tr>'}</tbody>
    </table>
  `;

  document.getElementById('filter').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    for (const row of document.querySelectorAll('#projects-body tr[data-name]')) {
      row.classList.toggle('hidden', q && !row.dataset.name.includes(q));
    }
  });
}

async function main() {
  const [local, cloud] = await Promise.all([
    loadJson('database/local.json'),
    loadJson('database/cloud.json'),
  ]);

  if (!local) {
    document.getElementById('meta').textContent =
      'database/local.json not found. Run: node scan.js';
    return;
  }

  document.getElementById('meta').textContent = `Generated ${local.generatedAt}`;

  renderCloudBanner(cloud);
  renderPluginsComparison(local.userScope, cloud);
  renderMcpList(local.userScope);
  renderSkillsComparison(local.userScope, cloud);
  const environmentTools = local.environmentTools || [];
  renderEnvironmentTools(environmentTools);
  renderNpxSkills(local.npxSkillsGlobal);
  wireCopyButton('copy-env-tools', () => [
    ...environmentTools.map((t) => ({ heading: t.name, commands: [t.installCommand] })),
    { heading: 'npx skills', commands: local.npxSkillsGlobal.skills.map((s) => s.installCommand).filter(Boolean) },
  ]);
  renderProjects(local.projects);
  wireCommentInputs();
}

main();
