'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const HOME = os.homedir();
const DATABASE_DIR = path.join(__dirname, 'database');
const SECRET_KEY_RE = /token|key|secret|authorization|password|credential|bearer|cookie|session/i;
const ENV_VAR_PLACEHOLDER_RE = /^\$\{[^}]+\}$/;
const SKIP_DIR_RE = /^node_modules$|^\.git$/;
// Matches inline `--token=value` / `TOKEN=value` style assignments in a single string.
const INLINE_ASSIGNMENT_RE = /^(-{0,2}[\w-]*(?:token|key|secret|authorization|password|credential|bearer|cookie|session)[\w-]*=)(.+)$/i;
// Matches a bare `--token` / `--api-key` style flag, whose value is the next array element.
const SECRET_FLAG_RE = /^-{1,2}[\w-]*(?:token|key|secret|authorization|password|credential|bearer|cookie|session)[\w-]*$/i;

function maskValue(v) {
  return v.length > 4 ? '****' + v.slice(-4) : '[REDACTED]';
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// ponytail: catches "--token=xxx" and "--token xxx" shapes in command/args
// arrays via regex heuristics; does not parse full shell-quoting edge cases.
function redactArgsArray(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const v = args[i];
    if (typeof v !== 'string') {
      out.push(redactSecrets(v));
      continue;
    }
    const inline = v.match(INLINE_ASSIGNMENT_RE);
    if (inline && !ENV_VAR_PLACEHOLDER_RE.test(inline[2])) {
      out.push(inline[1] + maskValue(inline[2]));
      continue;
    }
    if (SECRET_FLAG_RE.test(v) && typeof args[i + 1] === 'string' && !ENV_VAR_PLACEHOLDER_RE.test(args[i + 1])) {
      out.push(v, maskValue(args[i + 1]));
      i++;
      continue;
    }
    out.push(v);
  }
  return out;
}

function redactSecrets(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return redactArgsArray(obj);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && SECRET_KEY_RE.test(k) && !ENV_VAR_PLACEHOLDER_RE.test(v)) {
      out[k] = maskValue(v);
    } else {
      out[k] = redactSecrets(v);
    }
  }
  return out;
}

function redactMcpServers(mcpServers) {
  if (!mcpServers || typeof mcpServers !== 'object') return mcpServers;
  const out = {};
  for (const [name, cfg] of Object.entries(mcpServers)) {
    out[name] = redactSecrets(cfg);
  }
  return out;
}

function getInstalledPlugins() {
  const data = readJsonSafe(path.join(HOME, '.claude/plugins/installed_plugins.json'));
  if (!data || !data.plugins) return [];
  const rows = [];
  for (const [key, installs] of Object.entries(data.plugins)) {
    const [plugin, marketplace] = key.split('@');
    for (const install of installs) {
      rows.push({ plugin, marketplace, ...install });
    }
  }
  return rows;
}

function getEnabledPluginsFromSettings() {
  const data = readJsonSafe(path.join(HOME, '.claude/settings.json'));
  return {
    enabledPlugins: (data && data.enabledPlugins) || {},
    extraKnownMarketplaces: (data && data.extraKnownMarketplaces) || {},
  };
}

function getKnownMarketplaces() {
  return readJsonSafe(path.join(HOME, '.claude/plugins/known_marketplaces.json')) || {};
}

function getUserMcpServers() {
  const data = readJsonSafe(path.join(HOME, '.claude.json'));
  return redactMcpServers((data && data.mcpServers) || {});
}

function readSkillMeta(skillDir) {
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) return {};
  const content = fs.readFileSync(skillMd, 'utf8');
  const nameMatch = content.match(/^name:\s*(.+)$/m);
  const descMatch = content.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch ? nameMatch[1].trim() : undefined,
    description: descMatch ? descMatch[1].trim() : undefined,
  };
}

function getUserSkills(installedPlugins) {
  const skills = [];

  const userSkillsDir = path.join(HOME, '.claude/skills');
  if (fs.existsSync(userSkillsDir)) {
    for (const entry of fs.readdirSync(userSkillsDir)) {
      const entryPath = path.join(userSkillsDir, entry);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) continue; // managed by npx skills, see npxSkillsGlobal
      skills.push({
        name: entry,
        path: entryPath,
        source: 'standalone',
        isSymlink: false,
        ...readSkillMeta(entryPath),
      });
    }
  }

  // Only scan each plugin's currently-installed version — a plugin cache
  // dir can retain stale sibling version dirs from before an update
  // (installed_plugins.json doesn't point at them anymore), and walking
  // every version on disk would surface the same skill twice.
  const seenInstallPaths = new Set();
  for (const p of installedPlugins) {
    if (seenInstallPaths.has(p.installPath)) continue;
    seenInstallPaths.add(p.installPath);
    const skillsDir = path.join(p.installPath, 'skills');
    if (!fs.existsSync(skillsDir)) continue;
    for (const entry of fs.readdirSync(skillsDir)) {
      const entryPath = path.join(skillsDir, entry);
      skills.push({
        name: entry,
        path: entryPath,
        source: 'plugin',
        plugin: p.plugin,
        marketplace: p.marketplace,
        ...readSkillMeta(entryPath),
      });
    }
  }

  return skills;
}

function getNpxSkillsGlobal() {
  const lock = readJsonSafe(path.join(HOME, '.agents/.skill-lock.json'));
  if (!lock) return { skills: [], lastSelectedAgents: [] };
  const userSkillsDir = path.join(HOME, '.claude/skills');
  const skills = Object.entries(lock.skills || {}).map(([name, meta]) => {
    const linkPath = path.join(userSkillsDir, name);
    let linkedToClaudeUserSkills = false;
    if (fs.existsSync(linkPath)) {
      linkedToClaudeUserSkills = fs.lstatSync(linkPath).isSymbolicLink();
    }
    // Non-interactive `npx skills add` invocation (see vercel-labs/skills CLI
    // docs) that reproduces this exact skill install in a fresh environment.
    const installCommand =
      meta.sourceType === 'github' && meta.source
        ? `npx skills add ${meta.source} --skill "${name}" -g -a claude-code -y`
        : null;
    return { name, ...meta, linkedToClaudeUserSkills, installCommand };
  });
  return { skills, lastSelectedAgents: lock.lastSelectedAgents || [] };
}

function getSkipPaths() {
  const config = readJsonSafe(path.join(DATABASE_DIR, 'scan-config.json'));
  return new Set((config && config.skipPaths) || []);
}

// Tools that live outside the plugin/MCP/skill system (standalone CLIs,
// marker files) but still need to be set up in every environment —
// tracked via database/env-tools.json so new ones can be added by editing
// config, not code.
function getEnvironmentTools() {
  const config = readJsonSafe(path.join(DATABASE_DIR, 'env-tools.json'));
  const tools = (config && config.tools) || [];
  return tools.map((t) => {
    let installedLocally = false;
    try {
      execSync(t.checkCommand, { stdio: 'ignore', timeout: 5000 });
      installedLocally = true;
    } catch {
      installedLocally = false;
    }
    return { id: t.id, name: t.name, installedLocally, installCommand: t.installCommand };
  });
}

function looksLikeGitRepo(dirPath) {
  return fs.existsSync(path.join(dirPath, '.git'));
}

function walkProjects(root, skipPaths = new Set(), maxDepth = 5) {
  const found = [];
  function recurse(dir, depth) {
    if (depth > maxDepth) return;
    if (skipPaths.has(dir)) return;
    if (looksLikeGitRepo(dir)) {
      found.push(dir);
      return; // don't recurse into a repo looking for nested repos
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIR_RE.test(entry.name)) continue;
      recurse(path.join(dir, entry.name), depth + 1);
    }
  }
  recurse(root, 0);
  return found;
}

function listSkillsDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((entry) => {
    const entryPath = path.join(dir, entry);
    const stat = fs.lstatSync(entryPath);
    return {
      name: entry,
      isSymlink: stat.isSymbolicLink(),
      symlinkTarget: stat.isSymbolicLink() ? fs.readlinkSync(entryPath) : undefined,
    };
  });
}

// A project-scoped `npx skills add` invocation writes its lock file at the
// project root (unlike the global one at ~/.agents/.skill-lock.json), so a
// project's skills can be cross-checked against it to tell npx-managed
// skills apart from ones added by hand.
function getProjectNpxSkills(projectPath) {
  const lock = readJsonSafe(path.join(projectPath, 'skills-lock.json'));
  return lock && lock.skills ? Object.keys(lock.skills) : [];
}

function scanProject(projectPath, allInstalledPlugins) {
  const claudeSettings = readJsonSafe(path.join(projectPath, '.claude/settings.json'));
  const claudeSettingsLocal = readJsonSafe(path.join(projectPath, '.claude/settings.local.json'));
  const mcpJson = readJsonSafe(path.join(projectPath, '.mcp.json'));

  let docsFile = null;
  if (fs.existsSync(path.join(projectPath, 'CLAUDE.md'))) docsFile = 'CLAUDE.md';
  else if (fs.existsSync(path.join(projectPath, 'AGENTS.md'))) docsFile = 'AGENTS.md';

  const claudeSkillsDir = path.join(projectPath, '.claude/skills');
  const skills = listSkillsDir(claudeSkillsDir);

  const agentsSkillsDir = path.join(projectPath, '.agents/skills');
  const agentsSkills = listSkillsDir(agentsSkillsDir).map((s) => {
    const linkPath = path.join(claudeSkillsDir, s.name);
    let linkedIntoClaudeSkills = false;
    if (fs.existsSync(linkPath)) {
      linkedIntoClaudeSkills = fs.lstatSync(linkPath).isSymbolicLink();
    }
    return { name: s.name, linkedIntoClaudeSkills };
  });

  const pluginInstalls = allInstalledPlugins.filter(
    (p) => p.scope === 'project' && p.projectPath === projectPath
  );

  const globalState = readJsonSafe(path.join(HOME, '.claude.json'));
  const projectEntry = globalState && globalState.projects && globalState.projects[projectPath];
  let projectOverrides = null;
  if (projectEntry) {
    projectOverrides = {
      enabledMcpjsonServers: projectEntry.enabledMcpjsonServers,
      disabledMcpjsonServers: projectEntry.disabledMcpjsonServers,
      disabledMcpServers: projectEntry.disabledMcpServers,
      mcpContextUris: projectEntry.mcpContextUris,
      mcpServers: redactMcpServers(projectEntry.mcpServers),
    };
  }

  return {
    path: projectPath,
    name: path.basename(projectPath),
    claudeSettingsKeys: claudeSettings ? Object.keys(claudeSettings) : null,
    claudeSettingsLocalKeys: claudeSettingsLocal ? Object.keys(claudeSettingsLocal) : null,
    mcpJson: mcpJson ? redactSecrets(mcpJson) : null,
    docsFile,
    skills,
    agentsSkills,
    npxSkills: getProjectNpxSkills(projectPath),
    pluginInstalls,
    projectOverrides,
  };
}

function assembleLocal(projectsRoot) {
  const installedPlugins = getInstalledPlugins();
  const { enabledPlugins, extraKnownMarketplaces } = getEnabledPluginsFromSettings();

  const plugins = installedPlugins
    .filter((p) => p.scope === 'user')
    .map((p) => ({
      ...p,
      enabled: Boolean(enabledPlugins[`${p.plugin}@${p.marketplace}`]),
    }));

  const projectPaths = walkProjects(projectsRoot, getSkipPaths());
  const projects = projectPaths.map((p) => scanProject(p, installedPlugins));

  return {
    generatedAt: new Date().toISOString(),
    userScope: {
      plugins,
      marketplaces: { ...getKnownMarketplaces(), ...extraKnownMarketplaces },
      mcpServers: getUserMcpServers(),
      skills: getUserSkills(plugins),
    },
    npxSkillsGlobal: getNpxSkillsGlobal(),
    environmentTools: getEnvironmentTools(),
    projects,
  };
}

function main() {
  const projectsRoot = process.argv[2] || path.join(HOME, 'Projects');
  const result = assembleLocal(projectsRoot);

  fs.mkdirSync(DATABASE_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATABASE_DIR, 'local.json'), JSON.stringify(result, null, 2));

  console.log(
    `Scanned: ${result.userScope.plugins.length} plugins, ` +
      `${Object.keys(result.userScope.mcpServers).length} user MCP servers, ` +
      `${result.userScope.skills.length} user skills, ` +
      `${result.npxSkillsGlobal.skills.length} npx-skills, ` +
      `${result.environmentTools.filter((t) => t.installedLocally).length}/${result.environmentTools.length} env tools installed, ` +
      `${result.projects.length} projects -> database/local.json`
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  readJsonSafe,
  redactSecrets,
  redactMcpServers,
  getInstalledPlugins,
  getEnabledPluginsFromSettings,
  getKnownMarketplaces,
  getUserMcpServers,
  getUserSkills,
  getNpxSkillsGlobal,
  getSkipPaths,
  getEnvironmentTools,
  looksLikeGitRepo,
  walkProjects,
  getProjectNpxSkills,
  scanProject,
  assembleLocal,
};
