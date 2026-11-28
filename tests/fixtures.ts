import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Hermetic git: the developer's global gitignore and config must not decide what a fixture commits
// or what the audit sees as ignored.
process.env['GIT_CONFIG_GLOBAL'] = '/dev/null';
process.env['GIT_CONFIG_NOSYSTEM'] = '1';
// ~/.config/git/ignore applies even without a global config, so point the excludes file away too.
process.env['GIT_CONFIG_COUNT'] = '1';
process.env['GIT_CONFIG_KEY_0'] = 'core.excludesFile';
process.env['GIT_CONFIG_VALUE_0'] = '/dev/null';

export interface TempRepo {
  dir: string;
  write: (relPath: string, content: string) => void;
  /** Creates `relPath` as a symlink to `target` (relative to the link's directory). */
  symlink: (relPath: string, target: string) => void;
  /** `git init` on first use, then stages everything and commits as `author`, optionally dated in the past. */
  commit: (author?: string, date?: string) => void;
  cleanup: () => void;
}

export function createTempRepo(prefix = 'harness-audit-test-'): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  let initialised = false;
  // Run from a git hook, the caller's GIT_DIR and author variables would otherwise win over the fixture's.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|PREFIX|AUTHOR_|COMMITTER_)/.test(key)) {delete env[key];}}
  const git = (...args: Array<string>): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', env });
  };
  return {
    dir,
    write(relPath: string, content: string) {
      const full = join(dir, relPath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    },
    symlink(relPath: string, target: string) {
      const full = join(dir, relPath);
      mkdirSync(dirname(full), { recursive: true });
      symlinkSync(target, full);
    },
    commit(author = 'dev@example.com', date?: string) {
      if (!initialised) {
        git('init', '-q', '-b', 'main');
        initialised = true;
      }
      git('add', '-A');
      // One name per address, as real people have; the audit counts people, not addresses.
      const name = author.split('@')[0]!.replaceAll(/[^a-z0-9]+/gi, ' ').trim() || 'dev';
      execFileSync(
        'git',
        ['-c', `user.email=${author}`, '-c', `user.name=${name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'snapshot', ...(date ? ['--date', date] : [])],
        { cwd: dir, stdio: 'ignore', env: { ...env, ...(date ? { GIT_COMMITTER_DATE: date } : {}) } },
      );
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Fixture 1: Level 0 bare repository — minimal JS file, no instructions, no tests, no CI.
 */
export function createLevel0BareRepo(): TempRepo {
  const repo = createTempRepo('ha-l0-');
  repo.write('package.json', JSON.stringify({ name: 'bare-app', version: '1.0.0' }, null, 2));
  repo.write('src/index.js', 'export function add(a, b) { return a + b; }\n');
  return repo;
}

/**
 * Fixture 2: Level 2 anti-pattern repo — bloated duplicated CLAUDE.md, retired Codex
 * `approval_policy = "untrusted"`, archived `@modelcontextprotocol/server-postgres`,
 * hardcoded Bearer token, Stop hook without `stop_hook_active`, and tautological tests.
 */
export function createAntiPatternRepo(): TempRepo {
  const repo = createTempRepo('ha-l2-anti-');
  repo.write(
    'package.json',
    JSON.stringify(
      {
        name: 'antipattern-app',
        scripts: {
          test: 'vitest run',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          build: 'tsc',
        },
        devDependencies: {
          typescript: '^5.8.0',
          vitest: '^3.0.0',
          eslint: '^9.0.0',
        },
      },
      null,
      2,
    ),
  );
  repo.write('package-lock.json', '{ "lockfileVersion": 3 }\n');
  repo.write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: false } }, null, 2));
  repo.write('.gitignore', 'node_modules/\n');

  // Bloated AGENTS.md (380 lines) + unrelated long CLAUDE.md (50 lines)
  const fillerLines = Array.from(
    { length: 380 },
    (_, i) => `Line ${i + 1}: Always write clean code and follow best practices to ensure high quality.`,
  ).join('\n');
  repo.write('AGENTS.md', `# Project\n${fillerLines}\n`);
  repo.write(
    'CLAUDE.md',
    Array.from({ length: 50 }, (_, i) => `Duplicated instruction line ${i + 1}`).join('\n'),
  );

  // Retired Codex approval_policy = "untrusted"
  repo.write('.codex/config.toml', 'approval_policy = "untrusted"\nsandbox_mode = "workspace-write"\n');

  // Claude Stop hook missing stop_hook_active guard
  repo.write(
    '.claude/settings.json',
    JSON.stringify(
      {
        permissions: { allow: ['Bash(npm test)'] },
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'npm test', timeout: 60 }] }],
        },
      },
      null,
      2,
    ),
  );

  // Broken/archived MCP server + deprecated /sse + hardcoded Bearer token
  repo.write(
    '.mcp.json',
    JSON.stringify(
      {
        mcpServers: {
          pg: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-postgres', 'postgres://localhost/db'],
          },
          remoteApi: {
            type: 'sse',
            url: 'https://api.example.com/sse',
            headers: {
              Authorization: 'Bearer super_secret_live_token_987654321',
            },
          },
        },
      },
      null,
      2,
    ),
  );

  repo.write('src/app.ts', 'export function greet(name: string) { return `hi ${name}`; }\n');
  repo.write(
    'tests/app.test.ts',
    `import { describe, it, expect } from 'vitest';
describe('app', () => {
  it.only('tautology', () => {
    expect(true).toBe(true);
  });
  it('empty', () => {});
  it('empty2', () => {});
});
`,
  );
  repo.write(
    '.github/workflows/ci.yml',
    `name: CI
on: [pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
      - run: npm run lint
`,
  );

  return repo;
}

/**
 * Fixture 3: Level 4/5 well-harnessed repository covering all 6 stations cleanly.
 */
export function createWellHarnessedRepo(): TempRepo {
  const repo = createTempRepo('ha-l5-');
  repo.write(
    'package.json',
    JSON.stringify(
      {
        name: 'factory-ready-app',
        engines: { node: '>=22.0.0' },
        workspaces: ['packages/*'],
        scripts: {
          check: 'npm run typecheck && npm run lint && npm test && npm run build',
          typecheck: 'tsc --noEmit',
          lint: 'biome check .',
          test: 'vitest run',
          build: 'tsc',
          'audit:size': 'size-limit',
        },
        dependencies: {
          hono: '^4.0.0',
          '@sentry/node': '^9.0.0',
          'drizzle-orm': '^0.40.0',
        },
        devDependencies: {
          typescript: '^5.8.0',
          vitest: '^3.0.0',
          '@biomejs/biome': '^1.9.0',
          '@playwright/test': '^1.50.0',
          'size-limit': '^11.0.0',
        },
      },
      null,
      2,
    ),
  );
  repo.write('package-lock.json', '{ "lockfileVersion": 3 }\n');
  repo.write('.node-version', '22\n');
  repo.write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }, null, 2));
  repo.write('biome.json', '{ "linter": { "enabled": true } }\n');
  repo.write('.gitignore', 'node_modules/\ndist/\n.env\n.env.local\n*.pem\n*.key\n');
  repo.write('.env.example', 'PORT=3000\nDATABASE_URL=sqlite://local.db\n');
  repo.write('.wt-env', 'PORT=4101\n');
  repo.write('.worktreeinclude', '.env.local\n');
  repo.write('bin/wt', '#!/usr/bin/env bash\necho worktree helper\n');
  repo.write('Dockerfile', 'FROM node:22-alpine\n');
  repo.write('ARCHITECTURE.md', '# Architecture\nPackages are isolated under packages/*.\n');
  repo.write('TESTING.md', '# Testing\nRun `npm run check` before concluding.\n');
  repo.write('CHANGELOG.md', '# Changelog\n');
  repo.write('renovate.json', '{ "$schema": "https://docs.renovatebot.com/renovate-schema.json" }\n');
  repo.write('playwright.config.ts', 'export default { webServer: { port: Number(process.env.PORT || 3000) } };\n');
  repo.write('vitest.config.ts', 'export default { test: { coverage: { thresholds: { lines: 80 } } } };\n');
  repo.write('migrations/0001_init.sql', 'CREATE TABLE items (id TEXT PRIMARY KEY);\n');

  repo.write(
    'AGENTS.md',
    `# factory-ready-app

## Verification Commands
Run \`npm run check\` (runs typecheck, lint, test, and build).

## Production is Shared
Never run production deploys or remote database commands locally.

## Worktree Isolation
Use \`bin/wt new <slug>\` for parallel agent checkouts.

## Architecture
- \`src/\`: application modules
- \`tests/\`: unit and E2E verification
`,
  );
  repo.write('CLAUDE.md', '@AGENTS.md\n');
  repo.write(
    '.claude/rules/testing.md',
    `---
paths:
  - "tests/**"
---
Keep tests behavioral.
`,
  );
  repo.write(
    '.cursor/rules/testing.mdc',
    `---
description: Testing rules
globs: "tests/**"
alwaysApply: false
---
Keep tests behavioral.
`,
  );
  repo.write('.claude/skills/release-check/SKILL.md', '---\nname: release-check\ndescription: Verify release\n---\n');
  repo.write('.claude/agents/reviewer.md', '# Read-only Reviewer\n');
  repo.write('.cursor/BUGBOT.md', '# Bugbot rules\nCheck auth boundaries.\n');
  repo.write(
    '.claude/settings.json',
    JSON.stringify(
      {
        permissions: {
          allow: ['Bash(npm run check)', 'Bash(npm test)'],
          deny: ['Bash(npm run deploy)', 'Edit(tests/**)'],
        },
        sandbox: { enabled: true },
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'grep -q \'"stop_hook_active":true\' && exit 0; npm test',
                  timeout: 60,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  repo.write(
    '.codex/config.toml',
    'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n',
  );
  repo.write(
    '.mcp.json',
    JSON.stringify(
      {
        mcpServers: {
          docs: {
            type: 'http',
            url: 'https://docs.example.com/mcp',
            headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
          },
        },
      },
      null,
      2,
    ),
  );
  repo.write(
    '.github/CODEOWNERS',
    'tests/ @platform-team\n.github/ @platform-team\nAGENTS.md @platform-team\n',
  );
  repo.write(
    '.github/pull_request_template.md',
    `## Summary
## Verification Evidence
- [ ] Ran \`npm run check\` and pasted output
- [ ] Risk / rollback notes checked
`,
  );
  repo.write(
    '.github/workflows/ci.yml',
    `name: CI & Deploy
on:
  pull_request:
  push:
    branches: [main]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
      - run: npx gitleaks detect
  deploy:
    needs: [verify]
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`,
  );

  // Source & real behavioral test files
  repo.write('src/math.ts', 'export function sum(nums: number[]): number { return nums.reduce((a, b) => a + b, 0); }\n');
  repo.write('src/health.ts', 'export const health = () => ({ ok: true });\n');
  repo.write('src/format.ts', 'export const formatEur = (cents: number) => `€${(cents / 100).toFixed(2)}`;\n');
  repo.write(
    'tests/math.test.ts',
    `import { describe, it, expect } from 'vitest';
import { sum } from '../src/math';
describe('sum', () => {
  it('adds integers', () => {
    expect(sum([2, 3, 5])).toBe(10);
  });
});
`,
  );
  repo.write(
    'tests/format.test.ts',
    `import { describe, it, expect } from 'vitest';
import { formatEur } from '../src/format';
describe('formatEur', () => {
  it('formats cents to euros', () => {
    expect(formatEur(1250)).toBe('€12.50');
  });
});
`,
  );
  repo.write(
    'tests/e2e/health.spec.ts',
    `import { test, expect } from '@playwright/test';
test('health returns ok', async ({ request }) => {
  const res = await request.get('/health');
  expect(res.status()).toBe(200);
});
`,
  );

  return repo;
}
