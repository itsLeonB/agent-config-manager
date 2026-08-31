'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { redactSecrets, looksLikeGitRepo, walkProjects, getEnvironmentTools, getProjectNpxSkills } = require('./scan.cjs');

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
  const configPath = path.join(__dirname, 'database', 'env-tools.json');
  const backup = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        tools: [
          { id: 'present', name: 'Present Tool', checkCommand: 'true', installCommand: 'install-present' },
          { id: 'absent', name: 'Absent Tool', checkCommand: 'false', installCommand: 'install-absent' },
        ],
      })
    );
    const tools = getEnvironmentTools();
    assert.deepStrictEqual(
      tools.map((t) => [t.id, t.installedLocally, t.installCommand]),
      [
        ['present', true, 'install-present'],
        ['absent', false, 'install-absent'],
      ]
    );
  } finally {
    if (backup === null) fs.rmSync(configPath, { force: true });
    else fs.writeFileSync(configPath, backup);
  }
});
