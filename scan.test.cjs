'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  redactSecrets,
  looksLikeGitRepo,
  walkProjects,
  getEnvironmentTools,
  getProjectNpxSkills,
  readJsonSafe,
  resolveConfig,
  loadConfig,
  scanOnce,
  resolveScanInterval,
  writeJsonAtomic,
} = require('./scan.cjs');
const { openStore } = require('./src/server/store.cjs');

function tempStoreFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-manager-test-'));
  return path.join(dir, 'dashboard.db');
}

test('redactSecrets masks token/key/secret values, leaves others alone', () => {
  const input = {
    GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_abcdefgh1234',
    Authorization: 'Bearer abcd1234wxyz',
    apiKey: 'sk-abcdef123456',
    NODE_ENV: 'production',
    nested: { password: 'hunter2222' },
  };
  const out = redactSecrets(input);
  assert.strictEqual(out.GITHUB_PERSONAL_ACCESS_TOKEN, '****1234');
  assert.strictEqual(out.Authorization, '****wxyz');
  assert.strictEqual(out.apiKey, '****3456');
  assert.strictEqual(out.NODE_ENV, 'production');
  assert.strictEqual(out.nested.password, '****2222');
});

test('redactSecrets leaves ${VAR} placeholders unmasked', () => {
  const out = redactSecrets({ GITHUB_TOKEN: '${GITHUB_TOKEN}' });
  assert.strictEqual(out.GITHUB_TOKEN, '${GITHUB_TOKEN}');
});

test('redactSecrets does not mutate the input object', () => {
  const input = { token: 'abcdefgh' };
  redactSecrets(input);
  assert.strictEqual(input.token, 'abcdefgh');
});

test('redactSecrets masks Cookie and session keys too', () => {
  const out = redactSecrets({ Cookie: 'sid=abcdef1234', session: 'xyzxyzxyz9999' });
  assert.strictEqual(out.Cookie, '****1234');
  assert.strictEqual(out.session, '****9999');
});

test('redactSecrets masks inline "--token=value" args in an array', () => {
  const out = redactSecrets({ args: ['-y', 'some-mcp', '--token=abcdefgh1234'] });
  assert.strictEqual(out.args[2], '--token=****1234');
  assert.strictEqual(out.args[0], '-y');
});

test('redactSecrets masks a "--token value" pair split across two array elements', () => {
  const out = redactSecrets({ args: ['--api-key', 'abcdefgh5678', '--verbose'] });
  assert.strictEqual(out.args[0], '--api-key');
  assert.strictEqual(out.args[1], '****5678');
  assert.strictEqual(out.args[2], '--verbose');
});

test('walkProjects stops at a repo boundary and does not recurse into it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-manager-test-'));
  try {
    const repoA = path.join(root, 'org', 'repoA');
    fs.mkdirSync(path.join(repoA, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repoA, 'nested-repo', '.git'), { recursive: true });

    const repoB = path.join(root, 'org', 'repoB');
    fs.mkdirSync(path.join(repoB, '.git'), { recursive: true });

    assert.ok(looksLikeGitRepo(repoA));
    assert.ok(!looksLikeGitRepo(root));

    const found = walkProjects(root).sort();
    assert.deepStrictEqual(found, [repoA, repoB].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('walkProjects skips paths in skipPaths without descending into them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-manager-test-'));
  try {
    const repoA = path.join(root, 'org', 'repoA');
    fs.mkdirSync(path.join(repoA, '.git'), { recursive: true });

    const skipped = path.join(root, 'org', 'skipped');
    fs.mkdirSync(path.join(skipped, 'nested-repo', '.git'), { recursive: true });

    const found = walkProjects(root, new Set([skipped]));
    assert.deepStrictEqual(found, [repoA]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getProjectNpxSkills reads skill name + source metadata from a project-root skills-lock.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-manager-test-'));
  try {
    fs.writeFileSync(
      path.join(root, 'skills-lock.json'),
      JSON.stringify({
        version: 1,
        skills: {
          'tanstack-router': { source: 'tanstack-skills/tanstack-skills', sourceType: 'github' },
          'tanstack-start': { source: 'tanstack-skills/tanstack-skills', sourceType: 'github' },
        },
      })
    );
    const skills = getProjectNpxSkills(root).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepStrictEqual(skills, [
      { name: 'tanstack-router', source: 'tanstack-skills/tanstack-skills', sourceType: 'github' },
      { name: 'tanstack-start', source: 'tanstack-skills/tanstack-skills', sourceType: 'github' },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getProjectNpxSkills returns an empty array when there is no lock file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-manager-test-'));
  try {
    assert.deepStrictEqual(getProjectNpxSkills(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getEnvironmentTools reports installedLocally from checkCommand exit code', () => {
  const tools = getEnvironmentTools([
    { id: 'present', name: 'Present Tool', checkCommand: 'true', installCommand: 'install-present' },
    { id: 'absent', name: 'Absent Tool', checkCommand: 'false', installCommand: 'install-absent' },
  ]);
  assert.deepStrictEqual(
    tools.map((t) => [t.id, t.installedLocally, t.installCommand]),
    [
      ['present', true, 'install-present'],
      ['absent', false, 'install-absent'],
    ]
  );
});

test('resolveConfig prefers the stored value, then the environment, then the default', () => {
  assert.deepStrictEqual(
    resolveConfig(
      { projectsRoot: '/stored/projects', scanIntervalMinutes: 30, skipPaths: ['/stored/skip'], environmentTools: [{ id: 'stored' }] },
      { PROJECTS_ROOT: '/env/projects', SCAN_INTERVAL_MINUTES: '5' }
    ),
    {
      projectsRoot: '/stored/projects',
      scanIntervalMinutes: 30,
      skipPaths: ['/stored/skip'],
      environmentTools: [{ id: 'stored' }],
    }
  );

  assert.deepStrictEqual(resolveConfig({}, { PROJECTS_ROOT: '/env/projects', SCAN_INTERVAL_MINUTES: '5' }), {
    projectsRoot: '/env/projects',
    scanIntervalMinutes: 5,
    skipPaths: [],
    environmentTools: [],
  });
});

test('resolveConfig falls back to ~/Projects, 15 minutes and empty lists when nothing is configured', () => {
  assert.deepStrictEqual(resolveConfig({}, {}), {
    projectsRoot: path.join(os.homedir(), 'Projects'),
    scanIntervalMinutes: 15,
    skipPaths: [],
    environmentTools: [],
  });
});

test('loadConfig reads the four values a settings save writes', () => {
  const db = tempStoreFile();
  const writer = openStore(db);
  writer.writeConfig('projectsRoot', '/stored/projects');
  writer.writeConfig('scanIntervalMinutes', 3);
  writer.writeConfig('skipPaths', ['/stored/skip']);
  writer.writeConfig('environmentTools', [
    { id: 'tool-a', name: 'Tool A', checkCommand: 'true', installCommand: 'install-a' },
  ]);
  writer.close();

  assert.deepStrictEqual(loadConfig(db, { PROJECTS_ROOT: '/env/projects', SCAN_INTERVAL_MINUTES: '9' }), {
    projectsRoot: '/stored/projects',
    scanIntervalMinutes: 3,
    skipPaths: ['/stored/skip'],
    environmentTools: [{ id: 'tool-a', name: 'Tool A', checkCommand: 'true', installCommand: 'install-a' }],
  });
});

test('an install that has never been configured scans with defaults against an empty store', () => {
  const db = tempStoreFile();
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-manager-test-'));
  try {
    const config = loadConfig(db, {});
    assert.deepStrictEqual(config, {
      projectsRoot: path.join(os.homedir(), 'Projects'),
      scanIntervalMinutes: 15,
      skipPaths: [],
      environmentTools: [],
    });

    // The temp root keeps the scan offline and fast; everything else is the default.
    const result = scanOnce({ ...config, projectsRoot }, db);
    assert.deepStrictEqual(result.projects, []);

    const reader = openStore(db);
    try {
      assert.strictEqual(typeof reader.readLatestSnapshot('local').generatedAt, 'string');
    } finally {
      reader.close();
    }
  } finally {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  }
});

test('resolveScanInterval prefers the stored config over the environment variable', () => {
  assert.strictEqual(resolveScanInterval({ scanIntervalMinutes: 30 }, { SCAN_INTERVAL_MINUTES: '5' }), 30);
});

test('resolveScanInterval uses the environment variable when no stored value exists', () => {
  assert.strictEqual(resolveScanInterval({}, { SCAN_INTERVAL_MINUTES: '5' }), 5);
  assert.strictEqual(resolveScanInterval({ skipPaths: [] }, { SCAN_INTERVAL_MINUTES: '45' }), 45);
});

test('resolveScanInterval falls back to 15 minutes when nothing is configured', () => {
  assert.strictEqual(resolveScanInterval({}, {}), 15);
  assert.strictEqual(resolveScanInterval(undefined, {}), 15);
  assert.strictEqual(resolveScanInterval({}, { SCAN_INTERVAL_MINUTES: '' }), 15);
});

test('resolveScanInterval falls back past zero, negative and non-numeric values', () => {
  assert.strictEqual(resolveScanInterval({ scanIntervalMinutes: 0 }, { SCAN_INTERVAL_MINUTES: '8' }), 8);
  assert.strictEqual(resolveScanInterval({ scanIntervalMinutes: -4 }, { SCAN_INTERVAL_MINUTES: '8' }), 8);
  assert.strictEqual(resolveScanInterval({ scanIntervalMinutes: 'abc' }, { SCAN_INTERVAL_MINUTES: '8' }), 8);
  assert.strictEqual(resolveScanInterval({ scanIntervalMinutes: 0 }, { SCAN_INTERVAL_MINUTES: 'nope' }), 15);
  assert.strictEqual(resolveScanInterval({ scanIntervalMinutes: -1 }, { SCAN_INTERVAL_MINUTES: '0' }), 15);
});

test('resolveScanInterval floors a valid sub-minute value at one minute', () => {
  assert.strictEqual(resolveScanInterval({ scanIntervalMinutes: 0.2 }, {}), 1);
  assert.strictEqual(resolveScanInterval({}, { SCAN_INTERVAL_MINUTES: '0.5' }), 1);
  assert.strictEqual(resolveScanInterval({ scanIntervalMinutes: 2.9 }, {}), 2);
});

test('writeJsonAtomic writes the snapshot and leaves no temp file behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-manager-test-'));
  try {
    const target = path.join(dir, 'nested', 'local.json');
    writeJsonAtomic(target, { generatedAt: 'first' });
    assert.deepStrictEqual(readJsonSafe(target), { generatedAt: 'first' });
    assert.deepStrictEqual(fs.readdirSync(path.dirname(target)), ['local.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an interrupted snapshot write leaves the previous snapshot intact and readable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-manager-test-'));
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  try {
    const target = path.join(dir, 'local.json');
    writeJsonAtomic(target, { generatedAt: 'old' });

    // Root ignores directory permissions, so the interruption cannot be simulated there.
    if (!isRoot) {
      fs.chmodSync(dir, 0o555);
      try {
        assert.throws(() => writeJsonAtomic(target, { generatedAt: 'new' }));
      } finally {
        fs.chmodSync(dir, 0o755);
      }
      assert.deepStrictEqual(readJsonSafe(target), { generatedAt: 'old' });
      assert.deepStrictEqual(fs.readdirSync(dir), ['local.json']);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale temp file left by a killed scan never shadows the readable snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-manager-test-'));
  try {
    const target = path.join(dir, 'local.json');
    writeJsonAtomic(target, { generatedAt: 'old' });
    fs.writeFileSync(path.join(dir, 'local.json.tmp'), '{"generatedAt": "half-writ');

    assert.deepStrictEqual(readJsonSafe(target), { generatedAt: 'old' });

    writeJsonAtomic(target, { generatedAt: 'new' });
    assert.deepStrictEqual(readJsonSafe(target), { generatedAt: 'new' });
    assert.deepStrictEqual(fs.readdirSync(dir), ['local.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
