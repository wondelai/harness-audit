import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditRepo, initHarness } from '../src/index.js';
import type { AuditReport, CheckResult } from '../src/types.js';
import { branchNotes } from '../src/renderers/gates.js';
import { createTempRepo, type TempRepo } from './fixtures.js';

const repos: TempRepo[] = [];
const temp = (prefix: string): TempRepo => {
  const r = createTempRepo(prefix);
  repos.push(r);
  return r;
};
afterEach(() => {
  while (repos.length > 0) repos.pop()!.cleanup();
});

const check = (report: AuditReport, id: string): CheckResult => {
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
};
const evidence = (report: AuditReport, id: string): string => check(report, id).evidence.join('\n');

// A string no real provider issued, shaped like an Anthropic key so the secret scan reacts to it.
const FAKE_KEY = `sk-ant-api03-${'Zz9'.repeat(12)}`;

describe('scan: what git shows a teammate is what gets audited', () => {
  it('leaves gitignored secrets, build output and nested worktrees out of the audit', () => {
    const repo = temp('ha-ignore-');
    repo.write('package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest run' } }));
    repo.write('.gitignore', '.dev.vars\n.env\n.env.local\n.open-next/\n.claude/\n');
    repo.write('src/app.ts', 'export const a = 1;\n');
    repo.write('tests/app.test.ts', "it('works', () => { expect(1 + 1).toBe(2); });\n");
    repo.write('.dev.vars', `ANTHROPIC_API_KEY=${FAKE_KEY}\n`);
    repo.write('.claude/worktrees/agent-1/tests/copy.test.ts', "it.only('x', () => {});\n");
    repo.write('.open-next/server/handler.test.js', 'x\n');
    repo.commit();

    const report = auditRepo(repo.dir);
    expect(report.scan.mode).toBe('git');
    expect(report.stack.testFileCount).toBe(1);
    expect(check(report, 'harness.secret-hygiene').status).toBe('pass');
    expect(check(report, 'harness.secret-hygiene').meta?.['hasHardcodedSecrets']).toBe(false);
    expect(check(report, 'verification.test-quality-scan').status).toBe('pass');
  });

  it('reports a committed credential by file and line, never by value, and caps the level', () => {
    const repo = temp('ha-leak-');
    repo.write('package.json', JSON.stringify({ name: 'app' }));
    repo.write('.gitignore', '.env\n.env.local\n');
    repo.write('wrangler.toml', `name = "w"\n[vars]\nANTHROPIC_API_KEY = "${FAKE_KEY}"\n`);
    repo.commit();

    const report = auditRepo(repo.dir);
    const secret = check(report, 'harness.secret-hygiene');
    expect(secret.status).toBe('fail');
    expect(secret.severity).toBe('critical');
    expect(secret.evidence[0]).toBe('wrangler.toml:3 Anthropic API key (committed)');
    expect(JSON.stringify(report)).not.toContain(FAKE_KEY);
    expect(secret.meta?.['hasHardcodedSecrets']).toBe(true);
    expect(report.topPriorities[0]!.id).toBe('harness.secret-hygiene');
  });

  it('flags an untracked secret file that nothing ignores, without calling it committed', () => {
    const repo = temp('ha-untracked-');
    repo.write('package.json', JSON.stringify({ name: 'app' }));
    repo.write('.gitignore', '.env.local\n');
    repo.commit();
    repo.write('.env', `ANTHROPIC_API_KEY=${FAKE_KEY}\n`);

    const secret = check(auditRepo(repo.dir), 'harness.secret-hygiene');
    expect(secret.status).toBe('fail');
    expect(secret.evidence.join('\n')).toContain('.env:1 Anthropic API key (untracked, not gitignored)');
    expect(secret.meta?.['hasHardcodedSecrets']).toBe(false);
  });

  it('finds the root brief in a directory walk even next to large build trees', () => {
    const repo = temp('ha-walk-');
    repo.write('AGENTS.md', '# App\nRun `swift test`.\nMore.\nMore.\nMore.\n');
    repo.write('Package.swift', '// swift-tools-version: 6.0\n');
    for (let i = 0; i < 30; i++) repo.write(`.build/checkouts/dep/File${i}.swift`, 'x\n');
    for (let i = 0; i < 30; i++) repo.write(`.derivedData-signed/Build/Thing${i}.swift`, 'x\n');
    repo.write('Sources/App/Main.swift', 'print("hi")\n');

    const report = auditRepo(repo.dir);
    expect(report.scan.mode).toBe('walk');
    expect(check(report, 'intent.instructions-file').status).toBe('pass');
    expect(report.stack.sourceFileCount).toBe(1);
    expect(report.stack.languages).toContain('Swift');
  });

  it('says so when a brief exists only on this machine', () => {
    const repo = temp('ha-localbrief-');
    repo.write('package.json', JSON.stringify({ name: 'app' }));
    repo.write('.gitignore', 'CLAUDE.md\n');
    repo.write('CLAUDE.md', '# Local notes\n');
    repo.commit();

    const brief = check(auditRepo(repo.dir), 'intent.instructions-file');
    expect(brief.status).toBe('warn');
    expect(brief.evidence.join('\n')).toContain('CLAUDE.md exists on this machine but git ignores it');
  });
});

describe('instruction files', () => {
  it('treats CLAUDE.md -> AGENTS.md as one file and reads content through a symlink', () => {
    const linked = temp('ha-symlink-');
    linked.write('AGENTS.md', '# Brief\nRun `npm test`.\nA\nB\nC\nD\n');
    linked.symlink('CLAUDE.md', 'AGENTS.md');
    const single = check(auditRepo(linked.dir), 'intent.single-source');
    expect(single.status).toBe('pass');
    expect(single.evidence[0]).toContain('CLAUDE.md is a symlink to AGENTS.md');

    const legacy = temp('ha-symlink-legacy-');
    legacy.write('.cursorrules', Array.from({ length: 400 }, (_, i) => `Rule ${i}`).join('\n'));
    legacy.symlink('CLAUDE.md', '.cursorrules');
    const report = auditRepo(legacy.dir);
    expect(check(report, 'intent.instruction-budget').status).toBe('fail');
    expect(evidence(report, 'intent.instruction-budget')).toContain('CLAUDE.md → .cursorrules: 400 lines');
  });

  it('counts a missing brief once instead of three times', () => {
    const repo = temp('ha-nobrief-');
    repo.write('package.json', JSON.stringify({ name: 'app' }));
    const report = auditRepo(repo.dir);
    expect(check(report, 'intent.instructions-file').status).toBe('fail');
    expect(check(report, 'intent.single-source').status).toBe('info');
    expect(check(report, 'intent.instruction-budget').status).toBe('info');
  });

  it('counts nested briefs and a routed doc map as scoped context, and ignores a rules README', () => {
    const repo = temp('ha-scoped-');
    repo.write('package.json', JSON.stringify({ name: 'app' }));
    repo.write('AGENTS.md', '# App\n\n## Read before you touch\n- Payments → `src/payments/README.md`\n- Tests → `tests/e2e/README.md`\n- Auth → `src/auth/README.md`\n');
    repo.write('src/payments/README.md', '# Payments rules\n');
    repo.write('tests/e2e/README.md', '# E2E rules\n');
    repo.write('src/auth/README.md', '# Auth rules\n');
    repo.write('migrations/CLAUDE.md', '# Migration rules\n');
    repo.write('.cursor/rules/README.md', '# How these rules are organised\n');
    repo.write('.cursor/rules/api.mdc', '---\nglobs: "src/api/**"\n---\nKeep handlers thin.\n');
    for (let i = 0; i < 45; i++) repo.write(`src/mod${i}.ts`, 'export {};\n');

    const report = auditRepo(repo.dir);
    expect(check(report, 'intent.scoped-rules').status).toBe('pass');
    expect(evidence(report, 'intent.scoped-rules')).toContain('migrations/CLAUDE.md');
    expect(evidence(report, 'intent.scoped-rules')).toContain('routes agents to 3 area docs');
    expect(check(report, 'intent.instructions-file').status).toBe('pass');
  });
});

describe('stacks other than TypeScript', () => {
  it('audits a Swift package through its scripts, CI and Xcode conventions', () => {
    const repo = temp('ha-swift-');
    repo.write('Package.swift', '// swift-tools-version: 6.0\nimport PackageDescription\n');
    repo.write('Package.resolved', '{ "pins": [] }\n');
    repo.write('.xcode-version', '26.1\n');
    repo.write('.swiftlint.yml', 'disabled_rules: []\n');
    repo.write('Sources/Kit/Kit.swift', 'public struct Kit {}\n');
    repo.write('Tests/KitTests/KitTests.swift', 'import XCTest\nfinal class KitTests: XCTestCase { func testIt() { XCTAssertEqual(1 + 1, 2) } }\n');
    repo.write('Tests/KitTests/MoreTests.swift', 'import XCTest\n');
    repo.write('scripts/ci-ios.sh', '#!/bin/bash\nset -euo pipefail\nswiftlint --strict\nswift test --parallel\n');
    repo.write('AGENTS.md', '# Kit\n\nBefore finishing run `scripts/ci-ios.sh`.\n\nNever touch production.\nMore.\n');
    repo.write('.github/workflows/ios.yml', 'name: iOS\non:\n  pull_request:\njobs:\n  build:\n    runs-on: macos-15\n    steps:\n      - name: Xcode\n        run: echo "XCODE=$(xcodebuild -version)" >> "$GITHUB_ENV"\n      - name: Build and test\n        run: scripts/ci-ios.sh\n');

    const report = auditRepo(repo.dir);
    expect(report.stack.languages).toEqual(['Swift']);
    expect(report.stack.testFileCount).toBe(2);
    expect(check(report, 'loop.single-command-verify').status).toBe('pass');
    expect(evidence(report, 'loop.single-command-verify')).toContain('./scripts/ci-ios.sh');
    expect(check(report, 'loop.formatter-linter').status).toBe('pass');
    expect(check(report, 'loop.lockfile-reproducibility').status).toBe('pass');
    expect(check(report, 'loop.static-types').status).toBe('pass');
    expect(check(report, 'release.ci-pipeline').status).toBe('pass');
    expect(evidence(report, 'release.ci-pipeline')).toContain('tests: yes · lint: yes · typecheck: yes');
    // `.env` is not a Swift convention, so nothing is demanded of .gitignore.
    expect(check(report, 'harness.secret-hygiene').status).toBe('pass');
  });

  it('audits an Android Gradle project through gradlew, the wrapper and the version catalog', () => {
    const repo = temp('ha-android-');
    repo.write('gradlew', '#!/bin/sh\n');
    repo.write('settings.gradle.kts', 'include(":app", ":core")\n');
    repo.write('build.gradle.kts', 'plugins { id("com.android.application") version "9.5.1" apply false }\n');
    repo.write('gradle/libs.versions.toml', '[versions]\nagp = "9.5.1"\nsentry = "8.0.0"\n');
    repo.write('gradle/wrapper/gradle-wrapper.properties', 'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.6.1-bin.zip\n');
    repo.write('.gitignore', 'local.properties\nbuild/\n');
    repo.write('app/src/main/kotlin/App.kt', 'class App\n');
    repo.write('app/src/test/kotlin/AppTest.kt', 'class AppTest\n');
    repo.write('app/src/test/kotlin/OtherTest.kt', 'class OtherTest\n');
    repo.write('CLAUDE.md', '# App\n\n```bash\n./gradlew :app:assembleDebug --no-daemon\n./gradlew testDebugUnitTest --no-daemon\n./gradlew lint --no-daemon\n```\nMore.\n');
    repo.write(
      '.github/workflows/android.yml',
      "on: [pull_request, push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-java@v4\n        with:\n          java-version: 17\n      - run: ./gradlew :app:assembleDebug testDebugUnitTest ${{ github.event_name != 'pull_request' && 'lint' || '' }} --no-daemon\n",
    );

    const report = auditRepo(repo.dir);
    expect(report.stack.languages).toContain('Kotlin');
    expect(report.stack.frameworks).toContain('Android');
    expect(check(report, 'loop.single-command-verify').status).toBe('pass');
    expect(evidence(report, 'loop.single-command-verify')).toContain('Root instructions quote 3 verify command(s)');
    expect(check(report, 'loop.lockfile-reproducibility').status).toBe('pass');
    // Android Lint comes with the Gradle plugin; without a Kotlin linter or formatter that is half a setup.
    expect(check(report, 'loop.formatter-linter').status).toBe('warn');
    expect(check(report, 'harness.secret-hygiene').status).toBe('pass');
    // Lint runs only off pull requests, so it is not part of the PR gate.
    expect(evidence(report, 'release.ci-pipeline')).toContain('tests: yes · lint: not on PRs · typecheck: yes');
    expect(evidence(report, 'release.observability-and-safety')).toContain('Sentry');

    repo.write('gradle/libs.versions.toml', '[versions]\nagp = "9.5.1"\ndetekt = "2.0.0"\n');
    expect(check(auditRepo(repo.dir), 'loop.formatter-linter').status).toBe('pass');
  });

  it('does not demand tests or lockfiles from a repository with no program in it', () => {
    const repo = temp('ha-docs-');
    repo.write('README.md', '# Prompts\n');
    repo.write('prompts/review.md', 'Review the diff.\n');
    const report = auditRepo(repo.dir);
    expect(check(report, 'verification.unit-tests').status).toBe('info');
    expect(check(report, 'verification.test-quality-scan').status).toBe('info');
    expect(check(report, 'loop.lockfile-reproducibility').status).toBe('info');
  });
});

describe('verify loop and CI in JavaScript repositories', () => {
  it('follows package scripts from CI to what they prove, and ignores dry-run deploys', () => {
    const repo = temp('ha-ci-');
    repo.write(
      'package.json',
      JSON.stringify({
        name: 'app',
        packageManager: 'bun@1.4.5',
        scripts: {
          verify: 'bun run --parallel lint check test',
          lint: 'oxlint',
          check: 'bun check --no-script',
          test: 'bun test',
        },
        devDependencies: { oxlint: '^1.0.0', typescript: '^6.0.0', wrangler: '^4.0.0' },
      }),
    );
    repo.write('bun.lock', '{}\n');
    repo.write('wrangler.toml', 'name = "app"\n');
    repo.write('AGENTS.md', '# App\nRun `bun run verify` before finishing.\nA\nB\nC\n');
    repo.write(
      '.github/workflows/ci.yml',
      'on:\n  pull_request:\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun install --frozen-lockfile\n      - run: bun run verify\n      - run: bunx wrangler deploy --dry-run\n',
    );

    const report = auditRepo(repo.dir);
    expect(check(report, 'loop.single-command-verify').status).toBe('pass');
    expect(report.stack.verifyCommands[0]).toBe('`bun run verify` → lint + typecheck + test');
    expect(check(report, 'release.ci-pipeline').status).toBe('pass');
    expect(evidence(report, 'release.ci-pipeline')).toContain('.github/workflows/ci.yml: `bun run verify` → lint + typecheck + test');
    // packageManager pins the toolchain; the dry run is a build check, not a deploy workflow.
    expect(check(report, 'loop.lockfile-reproducibility').status).toBe('pass');
    expect(evidence(report, 'release.deploy-safety')).not.toContain('ci.yml: deploys');
  });

  it('resolves strict mode through an extends chain and leaves an uninstalled preset open', () => {
    const chained = temp('ha-tsconfig-');
    chained.write('package.json', JSON.stringify({ name: 'app', devDependencies: { typescript: '^6.0.0' } }));
    chained.write('tsconfig.json', '{ "extends": "./config/base.json", "compilerOptions": { "noEmit": true } }');
    chained.write('config/base.json', '{ // base\n "compilerOptions": { "strict": true } }');
    const strict = check(auditRepo(chained.dir), 'loop.static-types');
    expect(strict.status).toBe('pass');
    expect(strict.evidence[0]).toContain('inherits `strict: true` from config/base.json');

    const open = temp('ha-tsconfig-open-');
    open.write('package.json', JSON.stringify({ name: 'app', devDependencies: { typescript: '^6.0.0' } }));
    open.write('tsconfig.json', '{ "extends": "some-preset/tsconfig" }');
    expect(check(auditRepo(open.dir), 'loop.static-types').status).toBe('info');

    const loose = temp('ha-tsconfig-loose-');
    loose.write('package.json', JSON.stringify({ name: 'app', devDependencies: { typescript: '^6.0.0' } }));
    loose.write('tsconfig.json', '{ "compilerOptions": { "noEmit": true } }');
    expect(check(auditRepo(loose.dir), 'loop.static-types').status).toBe('warn');
  });

  it('counts declared skips and real suppressions, not conditional skips or quoted text', () => {
    const repo = temp('ha-quality-');
    repo.write('package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest run' } }));
    const conditional = Array.from({ length: 8 }, (_, i) => `test('flow ${i}', async ({ isMobile }) => {\n  test.skip(isMobile, 'desktop only');\n  expect(${i} + 1).toBe(${i + 1});\n});`).join('\n');
    repo.write('e2e/flows.spec.ts', conditional);
    repo.write('src/messages.ts', `export const HELP = [${Array.from({ length: 20 }, () => "'replace @ts-ignore with @ts-expect-error'").join(', ')}];\n`);
    // A test that writes a fixture quotes `it.only(` and a constant assertion without running them.
    repo.write('tests/writer.test.ts', "it('writes a fixture', () => {\n  save('bad.test.ts', \"it.only('x', () => { expect(true).toBe(true); });\");\n  expect(read('bad.test.ts').length).toBe(52);\n});\n");
    const clean = auditRepo(repo.dir);
    expect(check(clean, 'verification.test-quality-scan').status).toBe('pass');

    repo.write('tests/skipped.test.ts', Array.from({ length: 6 }, (_, i) => `it.skip('later ${i}', () => {});`).join('\n'));
    repo.write('src/hack.ts', Array.from({ length: 6 }, () => '// @ts-ignore\nexport const x: number = "y";').join('\n'));
    const dirty = auditRepo(repo.dir);
    const scan = check(dirty, 'verification.test-quality-scan');
    expect(scan.status).toBe('warn');
    expect(scan.evidence.join('\n')).toContain('Skipped tests (6)');
    expect(scan.evidence.join('\n')).toContain('src/hack.ts (6)');
  });
});

describe('oracle protection', () => {
  it('does not pass on a CODEOWNERS that covers neither tests nor the workflows directory', () => {
    const repo = temp('ha-codeowners-');
    repo.write('package.json', JSON.stringify({ name: 'app' }));
    repo.write('.github/CODEOWNERS', '/docs/strategy/ @lead\n/.github/CODEOWNERS @lead\n/.github/workflows/one-job.yml @lead\n');
    const hollow = check(auditRepo(repo.dir), 'verification.oracle-protection');
    expect(hollow.status).toBe('warn');
    expect(hollow.evidence[0]).toContain('covers neither tests nor .github/workflows');

    repo.write('.github/CODEOWNERS', '/tests/ @lead\n/.github/workflows/ @lead\n');
    expect(check(auditRepo(repo.dir), 'verification.oracle-protection').status).toBe('pass');
  });

  it('asks a solo repository for a guard and a team for CODEOWNERS', () => {
    const solo = temp('ha-solo-');
    solo.write('package.json', JSON.stringify({ name: 'app' }));
    solo.commit('one@example.com');
    const soloCheck = check(auditRepo(solo.dir), 'verification.oracle-protection');
    expect(soloCheck.status).toBe('warn');
    expect(soloCheck.fix.en).toContain('skip CODEOWNERS');

    const team = temp('ha-team-');
    team.write('package.json', JSON.stringify({ name: 'app' }));
    team.commit('one@example.com');
    team.write('README.md', '# App\n');
    team.commit('two@example.com');
    const teamCheck = check(auditRepo(team.dir), 'verification.oracle-protection');
    expect(teamCheck.status).toBe('fail');
    expect(teamCheck.fix.en).toContain('CODEOWNERS');
  });
});

describe('priorities and the next level', () => {
  it('states what the next level needs and how many points each fix is worth', () => {
    const repo = temp('ha-next-');
    repo.write('package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest run' } }));
    repo.write('src/a.ts', 'export const a = 1;\n');
    const report = auditRepo(repo.dir);

    expect(report.nextLevel?.level).toBe(report.level + 1);
    expect(report.nextLevel?.pointsMissing).toBe(report.nextLevel!.scoreNeeded - report.overallScore);
    const open = report.checks.filter((c) => c.status === 'fail' || c.status === 'warn');
    expect(open.every((c) => typeof c.impact === 'number' && c.impact > 0)).toBe(true);
    expect(report.checks.filter((c) => c.status === 'pass' || c.status === 'info').every((c) => c.impact === undefined)).toBe(true);
    // Fixing everything open lands on 100: the impacts are the score's own arithmetic, station
    // shares plus the critical penalty they lift (the displayed score is floored at 0).
    const total = open.reduce((sum, c) => sum + c.impact!, 0);
    expect(Math.abs(report.stationScore - report.criticalPenalty.points + total - 100)).toBeLessThanOrEqual(2);
    expect(report.overallScore).toBe(Math.max(0, report.stationScore - report.criticalPenalty.points));
    // Critical findings lead the list.
    expect(report.topPriorities[0]!.severity).toBe('critical');
  });
});

describe('init', () => {
  it('writes only commands the repository has, and a starter permission policy', () => {
    const repo = temp('ha-init-');
    repo.write('package.json', JSON.stringify({ name: 'app', packageManager: 'bun@1.4.5', scripts: { test: 'bun test', deploy: 'wrangler deploy' } }));
    repo.write('bun.lock', '{}\n');
    repo.write('wrangler.toml', 'name = "app"\n');

    const dry = initHarness(repo.dir, { dryRun: true, tools: ['claude-code'] });
    const agents = dry.actions.find((a) => a.path === 'AGENTS.md')!.content;
    expect(agents).toContain('bun install --frozen-lockfile');
    expect(agents).toContain('bun run test');
    expect(agents).not.toContain('run lint');
    expect(agents).not.toContain('run typecheck');

    initHarness(repo.dir, { tools: ['claude-code'] });
    const settings = JSON.parse(readFileSync(join(repo.dir, '.claude/settings.json'), 'utf8')) as { permissions: { allow: string[]; deny: string[] } };
    expect(settings.permissions.allow).toContain('Bash(bun run test:*)');
    expect(settings.permissions.deny).toContain('Bash(bun run deploy:*)');
    expect(settings.permissions.deny).toContain('Bash(wrangler deploy:*)');

    // The scaffold closes the findings it was offered for.
    const after = auditRepo(repo.dir);
    expect(check(after, 'intent.instructions-file').status).toBe('pass');
    expect(check(after, 'intent.single-source').status).toBe('pass');
    expect(check(after, 'harness.permissions-policy').status).toBe('pass');
    expect(check(after, 'release.deploy-safety').status).toBe('pass');
  });
});

describe('what a command proves', () => {
  it('judges a command by the program it runs, not by words in its arguments', () => {
    const repo = temp('ha-classify-');
    repo.write(
      'package.json',
      JSON.stringify({
        name: 'app',
        scripts: {
          check: 'pnpm run format:check && pnpm run lint',
          lint: 'oxlint --vitest-plugin --deny-warnings',
          'format:check': 'oxfmt --check',
          test: 'vitest run',
          'test:watch': 'vitest',
        },
      }),
    );
    repo.write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    const report = auditRepo(repo.dir);
    const commands = report.stack.verifyCommands;
    expect(commands).toContain('`pnpm run check` → lint + format');
    expect(commands).toContain('`pnpm run lint` → lint');
    expect(commands).toContain('`pnpm run test` → test');
    // A watcher never exits, so it is not offered as a verify command.
    expect(commands.join(' ')).not.toContain('test:watch');
  });

  it('counts a sub-package test script that CI runs on pull requests', () => {
    const repo = temp('ha-subpkg-');
    repo.write('package.json', JSON.stringify({ name: 'mono', workspaces: ['api', 'client'] }));
    repo.write('api/package.json', JSON.stringify({ name: 'api', scripts: { 'test:ci': 'jest --ci' } }));
    repo.write(
      '.github/workflows/backend-review.yml',
      'on:\n  pull_request:\n    paths: ["api/**"]\njobs:\n  tests:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - run: cd api && npm run test:ci\n      - run: npx eslint api\n',
    );
    const report = auditRepo(repo.dir);
    expect(evidence(report, 'release.ci-pipeline')).toContain('tests: yes · lint: yes');
    expect(check(report, 'release.ci-pipeline').status).toBe('pass');
  });

  it('reads a mixed TypeScript and JavaScript workspace by what its files are', () => {
    const repo = temp('ha-mixed-');
    repo.write('package.json', JSON.stringify({ name: 'mono', workspaces: ['client', 'api'] }));
    repo.write('client/tsconfig.json', '{ "compilerOptions": { "strict": true } }');
    repo.write('packages/data/tsconfig.json', '{ "compilerOptions": { "strict": true } }');
    for (let i = 0; i < 12; i++) repo.write(`client/src/c${i}.tsx`, 'export {};\n');
    for (let i = 0; i < 4; i++) repo.write(`api/server/s${i}.js`, 'module.exports = {};\n');
    const report = auditRepo(repo.dir);
    expect(report.stack.languages).toContain('TypeScript');
    const types = check(report, 'loop.static-types');
    expect(types.status).toBe('pass');
    expect(types.evidence[0]).toContain('2 tsconfig files set `strict: true`');
  });
});

describe('people, briefs and boundaries', () => {
  it('does not count a coding agent or a bot as a second contributor', () => {
    const repo = temp('ha-bots-');
    repo.write('package.json', JSON.stringify({ name: 'app' }));
    repo.commit('human@example.com');
    repo.write('a.txt', 'a\n');
    repo.commit('noreply@anthropic.com');
    repo.write('b.txt', 'b\n');
    repo.commit('49699333+dependabot[bot]@users.noreply.github.com');
    const report = auditRepo(repo.dir);
    expect(report.git.gitAuthors90d).toBe(1);
    expect(check(report, 'verification.oracle-protection').fix.en).toContain('skip CODEOWNERS');
  });

  it('takes a prohibition for a boundary, not the word production', () => {
    const label = temp('ha-boundary-label-');
    label.write('CLAUDE.md', '# App\n\nPrompts are fetched with the `production` label from the prompt store.\nA\nB\nC\n');
    const none = check(auditRepo(label.dir), 'harness.sandbox-readiness');
    expect(none.status).toBe('fail');
    expect(none.evidence.join('\n')).toContain('Found no sentence in CLAUDE.md that forbids or reserves an action on production');

    const rule = temp('ha-boundary-rule-');
    rule.write('CLAUDE.md', '# App\n\n- Never run `wrangler deploy` or a `--remote` migration from a local session.\nA\nB\nC\n');
    rule.write('Dockerfile', 'FROM node:24\n');
    const some = check(auditRepo(rule.dir), 'harness.sandbox-readiness');
    expect(some.status).toBe('warn');
    expect(some.evidence.join('\n')).toContain('Boundary rule at CLAUDE.md:3: "Never run `wrangler deploy`');
    // The product's Dockerfile is not a place agents run in, and the fix asks only for what is missing.
    expect(some.evidence.join('\n')).toContain('No agent sandbox configured');
    expect(some.fix.en).toContain('OS-level boundary');
    expect(some.fix.en).not.toContain('must never touch');
  });

  it('credits a path table in CLAUDE.md as a module map and names the brief the repo has', () => {
    const repo = temp('ha-map-');
    repo.write('package.json', JSON.stringify({ name: 'app' }));
    repo.write(
      'CLAUDE.md',
      '# App\n\n| Before touching | Read |\n| --- | --- |\n| `src/billing/` | `docs/billing.md` |\n| `src/auth/` | `docs/auth.md` |\n| `migrations/` | `docs/migrations.md` |\n',
    );
    for (const d of ['billing', 'auth', 'migrations']) repo.write(`docs/${d}.md`, '# Rules\n');
    const map = check(auditRepo(repo.dir), 'graph.workspace-boundaries');
    expect(map.status).toBe('pass');
    expect(map.evidence[0]).toContain('CLAUDE.md maps areas to 3 doc(s)');

    const bare = temp('ha-nomap-');
    bare.write('package.json', JSON.stringify({ name: 'app' }));
    bare.write('CLAUDE.md', '# App\nA\nB\nC\nD\n');
    const missing = check(auditRepo(bare.dir), 'graph.workspace-boundaries');
    expect(missing.fix.en).toContain('CLAUDE.md');
    expect(missing.fix.en).not.toContain('AGENTS.md');
  });

  it('finds spec docs under docs/ and names only the kinds still missing', () => {
    const repo = temp('ha-specs-');
    repo.write('package.json', JSON.stringify({ name: 'app' }));
    repo.write('docs/ARCHITECTURE.md', '# Architecture\n');
    repo.write('docs/API-CONTRACT.md', '# Contract\n');
    const specs = check(auditRepo(repo.dir), 'intent.skills-and-specs');
    expect(specs.status).toBe('warn');
    expect(specs.evidence.join('\n')).toContain('docs/ARCHITECTURE.md');
    expect(specs.fix.en).toContain('reusable skill');
    expect(specs.fix.en).not.toContain('standards, testing or architecture doc');
  });

  it('flags a committed settings.local.json and asks for deny rules when only allow rules exist', () => {
    const repo = temp('ha-localsettings-');
    repo.write('package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest run', deploy: 'wrangler deploy' } }));
    repo.write('wrangler.toml', 'name = "app"\n');
    repo.write('.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] } }));
    repo.write('.claude/settings.local.json', JSON.stringify({ permissions: { allow: ['Bash(rm:*)'] } }));
    repo.commit();
    const policy = check(auditRepo(repo.dir), 'harness.permissions-policy');
    expect(policy.status).toBe('warn');
    expect(policy.evidence.join('\n')).toContain('.claude/settings.local.json is committed');
    expect(policy.fix.en).toContain('The allow list is there; add `permissions.deny`');
    expect(policy.fix.en).toContain('Bash(npm run deploy:*)');
    expect(policy.fix.en).not.toContain('init');
  });
});

describe('lockfiles and deploys', () => {
  it('warns when two package managers left lockfiles at the root', () => {
    const repo = temp('ha-twolocks-');
    repo.write('package.json', JSON.stringify({ name: 'app', engines: { node: '>=22' } }));
    repo.write('package-lock.json', '{}\n');
    repo.write('bun.lockb', 'x\n');
    repo.write('.github/workflows/ci.yml', 'on: [pull_request]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n');
    const lock = check(auditRepo(repo.dir), 'loop.lockfile-reproducibility');
    expect(lock.status).toBe('warn');
    expect(lock.evidence.join('\n')).toContain('Lockfiles from 2 package managers at the root (bun, npm); CI installs with `npm ci`');
  });

  it('checks deny rules against the commands that really deploy, and ignores a script that only refuses', () => {
    const repo = temp('ha-deploy-');
    repo.write(
      'package.json',
      JSON.stringify({ name: 'app', scripts: { deploy: 'wrangler deploy', 'deploy:production': 'echo "Use CI" && exit 1' } }),
    );
    repo.write('wrangler.toml', 'name = "app"\n');
    repo.write('.claude/settings.json', JSON.stringify({ permissions: { deny: ['Bash(npm run deploy)', 'Bash(npm run deploy:*)'] } }));
    const partial = check(auditRepo(repo.dir), 'release.deploy-safety');
    expect(partial.status).toBe('warn');
    expect(partial.evidence.join('\n')).toContain('Neither a guard nor a deny rule covers `npx wrangler deploy`');
    expect(partial.evidence.join('\n')).not.toContain('deploy:production');

    repo.write('.claude/settings.json', JSON.stringify({ permissions: { deny: ['Bash(npm run deploy:*)', 'Bash(npx wrangler deploy:*)', 'Bash(wrangler deploy:*)'] } }));
    expect(check(auditRepo(repo.dir), 'release.deploy-safety').status).toBe('pass');
  });
});

describe('init follows the repository', () => {
  it('scaffolds only for the tools in use, with the globs of the stack', () => {
    const repo = temp('ha-init-swift-');
    repo.write('Package.swift', '// swift-tools-version: 6.0\n');
    repo.write('Sources/Kit/Kit.swift', 'public struct Kit {}\n');
    repo.write('Tests/KitTests/KitTests.swift', 'import XCTest\n');
    repo.write('CLAUDE.md', '# Kit\nA\nB\nC\nD\n');
    const plan = initHarness(repo.dir, { dryRun: true });
    expect(plan.tools).toEqual(['claude-code']);
    expect(plan.actions.map((a) => a.path)).not.toContain('.cursor/rules/testing.mdc');
    const rule = plan.actions.find((a) => a.path === '.claude/rules/testing.md')!.content;
    expect(rule).toContain('"Tests/**"');
    expect(rule).not.toContain('*.spec.*');
    const template = plan.actions.find((a) => a.path === '.github/pull_request_template.md')!.content;
    expect(template).toContain('| `swift test` | |');
  });
});

describe('weak evidence is no claim', () => {
  it('fails the boundary check when local development reaches production', () => {
    const repo = temp('ha-reach-');
    repo.write('package.json', JSON.stringify({ name: 'api', scripts: { dev: 'wrangler dev --remote' } }));
    repo.write('CLAUDE.md', '# API\n\nLocal API talks to production D1, R2, and secrets.\nNever force-push to main.\nA\nB\n');
    const reachReport = auditRepo(repo.dir);
    const sandbox = check(reachReport, 'harness.sandbox-readiness');
    expect(sandbox.status).toBe('fail');
    // "Never force-push to main" is a rule about history, not about the reach, yet it is a written
    // boundary: the reach is high, and it becomes critical only where nothing governs it at all.
    expect(sandbox.severity).toBe('high');
    expect(sandbox.evidence.join('\n')).toContain('CLAUDE.md:3 says local work reaches production');
    expect(sandbox.fix.en).toContain('local or preview bindings');
  });

  it('needs the prohibition and the production word in one sentence, close together', () => {
    const repo = temp('ha-farapart-');
    repo.write(
      'CLAUDE.md',
      [
        '# Farm',
        '',
        '5. The cron pokes stale claims that never settled, bumps their timestamp so a backlog is not re-poked, launches pending jobs, and later a separate worker may publish the finished articles.',
        'Develop on local Miniflare (`bun run dev`); reach for `--remote` deliberately, to diagnose.',
        "Don't commit secrets. Use env files.",
        '',
      ].join('\n'),
    );
    repo.write('package.json', JSON.stringify({ name: 'farm', scripts: { dev: 'wrangler dev', 'dev:remote': 'wrangler dev --remote' } }));
    const sandbox = check(auditRepo(repo.dir), 'harness.sandbox-readiness');
    const text = sandbox.evidence.join('\n');
    expect(text).toContain('Found no sentence in CLAUDE.md that forbids or reserves an action on production');
    // An explicit dev:remote script is an opt-in, not "local dev reaches production".
    expect(text).not.toContain('reaches production');
    expect(text).not.toContain('remote bindings');

    repo.write('CLAUDE.md', '# Farm\n\nDeploys: `.github/workflows/deploy.yml` is the only path. Every `--remote` command writes production D1.\nA\nB\n');
    expect(check(auditRepo(repo.dir), 'harness.sandbox-readiness').evidence.join('\n')).toContain('Boundary rule at CLAUDE.md:3');
  });

  it('claims a git-triggered deploy only when someone wrote that down', () => {
    const brand = temp('ha-brand-');
    brand.write('package.json', JSON.stringify({ name: 'app', dependencies: { ai: '^5.0.0' } }));
    brand.write('AGENTS.md', '# App\n\nBuilt with the Vercel AI SDK and Netlify-style functions.\nA\nB\nC\n');
    expect(evidence(auditRepo(brand.dir), 'release.deploy-safety')).toBe('No deploy workflow or local deploy command detected');

    const written = temp('ha-written-');
    written.write('package.json', JSON.stringify({ name: 'app' }));
    written.write('AGENTS.md', '# App\n\nWorkers Builds deploys master after merge; nothing deploys from a laptop.\nA\nB\nC\n');
    const said = check(auditRepo(written.dir), 'release.deploy-safety');
    expect(said.evidence[0]).toContain('AGENTS.md:3 mentions a git-triggered deploy');
    // A merge is the deploy and nothing checks a pull request first.
    expect(said.status).toBe('fail');
    expect(said.evidence.join('\n')).toContain('Merges deploy to production and no pull-request check runs first');

    written.write('package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest run' } }));
    written.write('.github/workflows/ci.yml', 'on: [pull_request]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n');
    expect(check(auditRepo(written.dir), 'release.deploy-safety').status).toBe('pass');
  });

  it('finds deploy commands by what they run, whatever they are called', () => {
    const repo = temp('ha-deploynames-');
    repo.write(
      'package.json',
      JSON.stringify({
        name: 'app',
        scripts: {
          'update:production': 'bun run build && wrangler deploy --env production',
          'deploy:tail': 'wrangler tail',
          build: 'vite build',
          test: 'vitest run',
        },
      }),
    );
    repo.write('cloudrun/deploy.sh', '#!/bin/bash\ngcloud run deploy api --source .\n');
    repo.write('AGENTS.md', '# App\n\nShip with `npm run update:production`. Test with `npm test`.\nA\nB\n');
    const report = auditRepo(repo.dir);
    const deploy = evidence(report, 'release.deploy-safety');
    expect(deploy).toContain('npm run update:production');
    expect(deploy).toContain('./cloudrun/deploy.sh');
    expect(deploy).not.toContain('deploy:tail');
    // A command that ships is never offered as a verify command.
    expect(report.stack.verifyCommands.join(' ')).not.toContain('update:production');
  });

  it('counts the files a test command runs even when nothing is named like a test', () => {
    const repo = temp('ha-fixtures-');
    repo.write('package.json', JSON.stringify({ name: 'site', scripts: { test: 'bun scripts/url-fixtures/run.ts && bun scripts/tracking-fixtures/run.ts' } }));
    repo.write('scripts/url-fixtures/run.ts', 'if (slug("A b") !== "a-b") process.exit(1);\n');
    repo.write('scripts/tracking-fixtures/run.ts', 'if (!event) process.exit(1);\n');
    for (let i = 0; i < 12; i++) repo.write(`src/page${i}.ts`, 'export {};\n');
    const report = auditRepo(repo.dir);
    const tests = check(report, 'verification.unit-tests');
    expect(tests.status).not.toBe('fail');
    expect(tests.evidence.join('\n')).toContain('2 of them are run by the test command without a test-style name');
    expect(check(report, 'verification.test-quality-scan').status).toBe('pass');
  });

  it('measures the brief behind a pointer file', () => {
    const repo = temp('ha-pointer-');
    repo.write('AGENTS.md', '# Site\n\nRead CLAUDE.md first.\n');
    repo.write('CLAUDE.md', `# Site\n\n${Array.from({ length: 22 }, (_, i) => `- Rule ${i}: run \`bun run verify\` before finishing.`).join('\n')}\n`);
    const report = auditRepo(repo.dir);
    expect(check(report, 'intent.instruction-budget').status).toBe('pass');
    expect(evidence(report, 'intent.instruction-budget')).toContain('CLAUDE.md: 24 lines');
    const single = check(report, 'intent.single-source');
    expect(single.status).toBe('pass');
    expect(single.evidence[0]).toContain('AGENTS.md (3 lines) only sends the reader to CLAUDE.md');
  });

  it('lists every committed credential by variable name and leaves public keys alone', () => {
    const repo = temp('ha-vars-');
    repo.write('package.json', JSON.stringify({ name: 'w' }));
    repo.write('.gitignore', '.env\n.env.local\n.dev.vars\n');
    const value = (seed: string): string => `${seed}9f8e7d6c5b4a39281706f5e4d3c2b1a0`;
    const names = ['FAL_KEY', 'AZURE_API_KEY', 'BYPASS_TOKEN', 'IMAGE_SECRET', 'UPSTREAM_API_KEY', 'SIGNING_SECRET', 'BACKUP_TOKEN', 'SEARCH_API_KEY', 'RENDER_KEY', 'QUEUE_TOKEN'];
    repo.write(
      'wrangler.toml',
      ['name = "w"', '[vars]', ...names.map((n, i) => `${n} = "${value(String(i))}"`), 'POSTHOG_PROJECT_KEY = "phc_abcdef1234567890abcdef1234567890"', 'NEXT_PUBLIC_MAPS_KEY = "a1b2c3d4e5f6a7b8c9d0e1f2"', ''].join('\n'),
    );
    repo.commit();
    const secret = check(auditRepo(repo.dir), 'harness.secret-hygiene');
    const text = secret.evidence.join('\n');
    expect(secret.status).toBe('fail');
    expect(text).toContain('wrangler.toml:3 credential in `FAL_KEY` (committed)');
    // Ten credentials: eight spelled out, the last two still named by line.
    expect(text).toContain('… and 2 more: wrangler.toml lines 11, 12');
    expect(text).not.toContain('POSTHOG_PROJECT_KEY');
    expect(text).not.toContain('NEXT_PUBLIC_MAPS_KEY');
    expect(text).not.toContain(value('0'));
  });

  it('does not take a formatter for a linter', () => {
    const repo = temp('ha-biome-');
    repo.write('package.json', JSON.stringify({ name: 'app', devDependencies: { '@biomejs/biome': '^2.0.0', typescript: '^6.0.0' } }));
    repo.write('biome.json', '{ "linter": { "enabled": false }, "formatter": { "enabled": true } }');
    const lint = check(auditRepo(repo.dir), 'loop.formatter-linter');
    expect(lint.status).toBe('warn');
    expect(lint.evidence[0]).toContain('Biome (linter disabled in biome.json)');
  });

  it('asks each ecosystem for its own lockfile', () => {
    const repo = temp('ha-pylock-');
    repo.write('pyproject.toml', '[project]\nname = "core"\nrequires-python = ">=3.12"\ndependencies = ["httpx>=0.27"]\n');
    repo.write('requirements.txt', 'httpx>=0.27\npandas>=2.0\n');
    repo.write('demo-site/package.json', JSON.stringify({ name: 'demo' }));
    repo.write('demo-site/package-lock.json', '{}\n');
    repo.write('core/main.py', 'print("hi")\n');
    const lock = check(auditRepo(repo.dir), 'loop.lockfile-reproducibility');
    expect(lock.status).toBe('warn');
    expect(lock.evidence.join('\n')).toContain('Python dependencies are not locked');
  });

  it('reads frameworks and dev servers from workspace members', () => {
    const repo = temp('ha-workspace-');
    repo.write('package.json', JSON.stringify({ name: 'mono', private: true, scripts: { dev: 'turbo dev' } }));
    repo.write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n');
    repo.write('apps/web/package.json', JSON.stringify({ name: 'web', dependencies: { react: '^19.0.0', vite: '^8.0.0' } }));
    repo.write('apps/api/package.json', JSON.stringify({ name: 'api', dependencies: { hono: '^5.0.0' } }));
    repo.write('apps/web/src/main.tsx', 'export {};\n');
    const report = auditRepo(repo.dir);
    expect(report.stack.frameworks).toEqual(expect.arrayContaining(['React', 'Hono']));
    // An app with a dev server and no end-to-end tier is a gap, not "library — nothing to test end to end".
    expect(check(report, 'verification.e2e-tests').status).toBe('warn');
    expect(check(report, 'graph.port-and-state-isolation').status).not.toBe('info');
  });

  it('finds the stack and the verify commands of a repository whose packages live in subfolders', () => {
    const repo = temp('ha-nested-');
    repo.write('micro/package.json', JSON.stringify({ name: 'micro', scripts: { test: 'vitest run', lint: 'eslint .' }, dependencies: { hono: '^5.0.0' }, devDependencies: { typescript: '^6.0.0' } }));
    repo.write('micro/package-lock.json', '{}\n');
    for (let i = 0; i < 8; i++) repo.write(`micro/src/m${i}.tsx`, 'export {};\n');
    const report = auditRepo(repo.dir);
    expect(report.stack.languages).toContain('TypeScript');
    expect(report.stack.frameworks).toContain('Hono');
    expect(report.stack.verifyCommands).toContain('`npm --prefix micro run test` → test');
    expect(report.stack.verifyCommands).toContain('`npm --prefix micro run lint` → lint');
  });

  it('does not pass Swift reproducibility while remote packages float', () => {
    const repo = temp('ha-xcodegen-');
    repo.write('project.yml', 'name: App\npackages:\n  Analytics:\n    url: https://github.com/example/analytics-ios\n    from: 3.9.0\ntargets:\n  App:\n    type: application\n');
    repo.write('.gitignore', 'Package.resolved\n*.xcodeproj/\n');
    repo.write('App/Main.swift', 'import SwiftUI\n');
    repo.write('App/View.swift', 'import SwiftUI\n');
    const lock = check(auditRepo(repo.dir), 'loop.lockfile-reproducibility');
    expect(lock.status).not.toBe('pass');
    expect(lock.evidence.join('\n')).toContain('Remote Swift packages use version ranges');
  });

  it('treats a missing worktree convention as a smaller gap when nothing local can collide', () => {
    const cli = temp('ha-cli-');
    cli.write('package.json', JSON.stringify({ name: 'cli', bin: { cli: 'dist/cli.js' } }));
    expect(check(auditRepo(cli.dir), 'graph.worktree-isolation').status).toBe('warn');

    const app = temp('ha-app-');
    app.write('package.json', JSON.stringify({ name: 'app', dependencies: { next: '^16.0.0' } }));
    // A handful of files: a second checkout is a rare need, so the gap is advice.
    expect(check(auditRepo(app.dir), 'graph.worktree-isolation').status).toBe('warn');
    for (let i = 0; i < 20; i++) app.write(`src/page${i}.ts`, 'export const page = 1;\n');
    expect(check(auditRepo(app.dir), 'graph.worktree-isolation').status).toBe('fail');
  });

  it('judges a quiet repository by who ever worked on it', () => {
    const repo = temp('ha-quiet-');
    repo.write('package.json', JSON.stringify({ name: 'lib' }));
    repo.commit('ana@example.com', '2025-01-10T10:00:00Z');
    repo.write('a.txt', 'a\n');
    repo.commit('ben@example.com', '2025-02-10T10:00:00Z');
    repo.write('b.txt', 'b\n');
    repo.commit('cyd@example.com', '2025-03-10T10:00:00Z');
    const report = auditRepo(repo.dir);
    expect(report.git.gitAuthors90d).toBe(0);
    expect(report.git.authorsAllTime).toBe(3);
    const oracle = check(report, 'verification.oracle-protection');
    expect(oracle.fix.en).toContain('CODEOWNERS');
    expect(oracle.fix.en).not.toContain('Solo repo');
  });
});

describe('init does not create a second brief', () => {
  it('leaves a CLAUDE.md-only repository with advice instead of a generic AGENTS.md', () => {
    const repo = temp('ha-init-claude-');
    repo.write('package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest run', lint: 'oxlint' } }));
    repo.write('package-lock.json', '{}\n');
    repo.write('CLAUDE.md', '# App\nRun `npm test`.\nA\nB\nC\n');
    const plan = initHarness(repo.dir, { dryRun: true });
    const agents = plan.actions.find((a) => a.path === 'AGENTS.md')!;
    expect(agents.action).toBe('skip');
    expect(agents.reason).toContain('git mv CLAUDE.md AGENTS.md');
    // No CI at all: a pull-request gate built from the detected commands is offered.
    const ci = plan.actions.find((a) => a.path === '.github/workflows/ci.yml')!;
    expect(ci.action).toBe('create');
    expect(ci.content).toContain('- run: npm ci');
    expect(ci.content).toContain('- run: npm run lint');
    expect(ci.content).toContain('- run: npm test');
  });
});

describe('levels rest on what is certain', () => {
  it('caps the level only where local production reach is ungoverned', () => {
    const repo = temp('ha-ungoverned-');
    repo.write('package.json', JSON.stringify({ name: 'api', scripts: { dev: 'wrangler dev --remote' } }));
    repo.write('CLAUDE.md', '# API\n\nRun the app with the dev script.\nA\nB\nC\n');
    const bare = check(auditRepo(repo.dir), 'harness.sandbox-readiness');
    expect(bare.severity).toBe('critical');
    expect(bare.meta?.['localDevReachesProduction']).toBe(true);

    repo.write('CLAUDE.md', '# API\n\nLive means production: write to it only when the write is the task, and say so first.\nA\nB\nC\n');
    const governed = check(auditRepo(repo.dir), 'harness.sandbox-readiness');
    expect(governed.status).toBe('fail');
    expect(governed.meta?.['localDevReachesProduction']).toBe(false);
  });

  it('never takes a test command from prose: no test script and no test file is a critical gap', () => {
    const repo = temp('ha-prose-');
    repo.write('package.json', JSON.stringify({ name: 'plugins', scripts: { check: 'bun check', lint: 'oxlint' }, devDependencies: { oxlint: '^1.0.0', typescript: '^6.0.0' } }));
    repo.write('tsconfig.json', '{ "compilerOptions": { "strict": true } }');
    repo.write('CLAUDE.md', '# Plugins\n\nRun `bun test` before finishing. No tests yet.\nRun `bun run check` and `bun run lint`.\nA\nB\n');
    for (let i = 0; i < 12; i++) repo.write(`src/plugin${i}.ts`, 'export {};\n');
    const report = auditRepo(repo.dir);
    const tests = check(report, 'verification.unit-tests');
    expect(tests.status).toBe('fail');
    expect(tests.severity).toBe('critical');
    // One finding for the missing suite, not two.
    expect(check(report, 'verification.test-quality-scan').status).toBe('info');
    expect(report.stack.verifyCommands.join(' ')).not.toContain('bun test');
    expect(check(report, 'release.ci-pipeline').fix.en).not.toContain('e.g. `bun run check`');
  });

  it('does not count a compile step or a helper script as a test', () => {
    const repo = temp('ha-helpers-');
    repo.write(
      'package.json',
      JSON.stringify({ name: 'app', scripts: { test: 'bun run i18n:compile && bash scripts/ensure-dev-server.sh && bun test', 'i18n:compile': 'node scripts/i18n-compile.mjs' } }),
    );
    repo.write('scripts/i18n-compile.mjs', 'export {};\n');
    repo.write('scripts/ensure-dev-server.sh', '#!/bin/bash\n');
    repo.write('src/a.test.ts', "it('adds', () => { expect(1 + 1).toBe(2); });\n");
    const report = auditRepo(repo.dir);
    expect(report.stack.testFileCount).toBe(1);
    expect(evidence(report, 'verification.unit-tests')).not.toContain('i18n-compile');
  });

  it('reads a boundary through emoji, bold and either word order', () => {
    const forms = [
      '🚨 **PRODUCTION DEPLOYS — ONE WAY ONLY**: `bun run update:production` is Michał\'s call, never an agent\'s.',
      '- `bun run deploy` — debug only. It bypasses the pipeline and can push stale local code.',
      'Live means production: write to it only when the write _is_ the task, and say so first.',
      'Remote D1 is production\'s database: migrations reach it only through the owner.',
    ];
    for (const sentence of forms) {
      const repo = temp('ha-forms-');
      repo.write('AGENTS.md', `# App\n\n${sentence}\nA\nB\nC\n`);
      const text = check(auditRepo(repo.dir), 'harness.sandbox-readiness').evidence.join('\n');
      expect(text, sentence).toContain('Boundary rule at AGENTS.md:3');
    }
  });

  it('fails on a test-mode or provider-less credential without capping the level on it', () => {
    const repo = temp('ha-testkey-');
    repo.write('package.json', JSON.stringify({ name: 'app' }));
    repo.write('.gitignore', '.env\n.env.local\n');
    repo.write('.env.development', `STRIPE_SECRET_KEY=sk_test_${'a1B2c3D4'.repeat(4)}\n`);
    repo.commit();
    const secret = check(auditRepo(repo.dir), 'harness.secret-hygiene');
    expect(secret.status).toBe('fail');
    expect(secret.evidence[0]).toBe('.env.development:1 Stripe test-mode secret key (committed)');
    expect(secret.severity).toBe('high');
    expect(secret.meta?.['hasHardcodedSecrets']).toBe(false);
  });

  it('treats a missing ignore rule as a precaution until the file is there', () => {
    const repo = temp('ha-absent-');
    repo.write('package.json', JSON.stringify({ name: 'w' }));
    repo.write('wrangler.toml', 'name = "w"\n');
    repo.write('.gitignore', '.env.local\n');
    repo.commit();
    const absent = check(auditRepo(repo.dir), 'harness.secret-hygiene');
    expect(absent.status).toBe('warn');
    expect(absent.evidence.join('\n')).toContain('Not gitignored: .dev.vars');

    repo.write('.dev.vars', 'MODE=local\n');
    const present = check(auditRepo(repo.dir), 'harness.secret-hygiene');
    expect(present.status).toBe('fail');
    expect(present.evidence.join('\n')).toContain('Present and not ignored: .dev.vars');
  });

  it('credits a PreToolUse guard hook that decides on deploy commands', () => {
    const repo = temp('ha-guard-');
    repo.write('package.json', JSON.stringify({ name: 'app', scripts: { deploy: 'wrangler deploy' } }));
    repo.write('wrangler.toml', 'name = "app"\n[observability]\nenabled = true\n');
    // A hook that only logs and lets everything through decides nothing.
    repo.write('.claude/hooks/guard-shell.sh', '#!/bin/bash\n# log wrangler deploy and --remote\necho "$1" >> /tmp/commands.log\nexit 0\n');
    repo.write('.claude/settings.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '.claude/hooks/guard-shell.sh' }] }] } }));
    expect(check(auditRepo(repo.dir), 'release.deploy-safety').status).toBe('warn');

    repo.write('.claude/hooks/guard-shell.sh', '#!/bin/bash\n# deny wrangler deploy and --remote inside worktrees\nif grep -q "wrangler deploy" <<< "$1"; then echo "blocked" >&2; exit 2; fi\nexit 0\n');
    const report = auditRepo(repo.dir);
    expect(check(report, 'release.deploy-safety').status).toBe('pass');
    expect(evidence(report, 'release.deploy-safety')).toContain('.claude/hooks/guard-shell.sh');
    expect(check(report, 'harness.permissions-policy').status).toBe('warn');
    // Workers Logs switched on in the Worker config is telemetry.
    expect(evidence(report, 'release.observability-and-safety')).toContain('Workers observability');
    expect(check(report, 'release.observability-and-safety').status).toBe('pass');
  });

  it('wants UI test sources, not UI test libraries', () => {
    const repo = temp('ha-uilibs-');
    repo.write('gradlew', '#!/bin/sh\n');
    repo.write('build.gradle.kts', 'plugins { id("com.android.application") }\ndependencies { testImplementation("org.robolectric:robolectric:4.14") }\n');
    repo.write('app/src/main/kotlin/App.kt', 'class App\n');
    repo.write('app/src/test/kotlin/MathTest.kt', 'class MathTest { fun adds() { check(1 + 1 == 2) } }\n');
    const declared = check(auditRepo(repo.dir), 'verification.e2e-tests');
    expect(declared.status).toBe('warn');
    expect(declared.evidence.join('\n')).toContain('declared in the build files, but no test source uses them');

    repo.write('app/src/test/kotlin/ScreenTest.kt', '@RunWith(RobolectricTestRunner::class)\nclass ScreenTest { val rule = createComposeRule() }\n');
    expect(check(auditRepo(repo.dir), 'verification.e2e-tests').status).toBe('pass');
  });

  it('names a stub AGENTS.md for what it is and measures the real brief', () => {
    const repo = temp('ha-stub-');
    repo.write('AGENTS.md', '<!-- BEGIN:turborepo -->\n# Turborepo\nUse turbo run.\n<!-- END:turborepo -->\n');
    repo.write('CLAUDE.md', `# App\n\n${Array.from({ length: 60 }, (_, i) => `- Rule ${i}: keep handlers thin and run \`pnpm test\`.`).join('\n')}\n`);
    const report = auditRepo(repo.dir);
    const single = check(report, 'intent.single-source');
    expect(single.status).toBe('fail');
    expect(single.evidence[0]).toContain('AGENTS.md is a 4-line stub');
    expect(single.evidence[0]).not.toContain('duplication');
    expect(evidence(report, 'intent.instruction-budget')).toContain('CLAUDE.md: 62 lines');
  });

  it('builds permission rules only from clean commands and keeps the runner the brief uses', () => {
    const repo = temp('ha-rules-');
    repo.write('package.json', JSON.stringify({ name: 'admin' }));
    repo.write('wrangler.jsonc', '{ "name": "admin" }');
    repo.write(
      'CLAUDE.md',
      '# Admin\n\n| Task | Command |\n| --- | --- |\n| Migrate | `bunx wrangler d1 migrations apply admin-db [--local\\|--remote]` |\n| Ship | `bunx wrangler deploy` |\n| New worktree | `bin/wt new <slug>` |\n',
    );
    repo.write('bin/wt', '#!/bin/bash\nbun install && bun run build\n');
    const report = auditRepo(repo.dir);
    const deploy = evidence(report, 'release.deploy-safety');
    expect(deploy).toContain('bunx wrangler deploy');
    expect(deploy).not.toContain('[');
    expect(deploy).not.toContain('npx wrangler deploy');
    // A worktree helper is not a verify command, whatever it runs inside.
    expect(evidence(report, 'loop.single-command-verify')).not.toContain('bin/wt');
  });

  it('runs every package\'s own test suite, not only the root one', () => {
    const repo = temp('ha-members-');
    repo.write('pyproject.toml', '[project]\nname = "core"\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
    repo.write('tests/test_core.py', 'def test_ok():\n    assert 1 + 1 == 2\n');
    repo.write('retriever/package.json', JSON.stringify({ name: 'retriever', scripts: { test: 'vitest run' } }));
    repo.write('retriever/wrangler.jsonc', '{ "name": "retriever", "r2_buckets": [{ "binding": "B", "bucket_name": "b", "remote": true }] }');
    repo.write('retriever/src/index.ts', 'export default {};\n');
    const report = auditRepo(repo.dir);
    expect(report.stack.frameworks).toContain('Cloudflare Workers');
    const plan = initHarness(repo.dir, { dryRun: true, tools: ['claude-code'] });
    const agents = plan.actions.find((a) => a.path === 'AGENTS.md')!.content;
    expect(agents).toContain('pytest');
    expect(agents).toContain('npm --prefix retriever run test');
    expect(evidence(report, 'harness.sandbox-readiness')).toContain('retriever/wrangler.jsonc marks 1 data binding(s) `remote: true` (r2_buckets)');
  });
});

describe('substance, not existence', () => {
  it('does not take a vendor\'s generic Cursor rule for a project brief', () => {
    const repo = temp('ha-starter-');
    repo.write('package.json', JSON.stringify({ name: 'starter', scripts: { check: 'tsc', test: 'vitest run' }, devDependencies: { typescript: '^6.0.0' } }));
    repo.write('.cursor/rules/cloudflare.mdc', '---\ndescription: Cloudflare Workers\nglobs:\nalwaysApply: false\n---\n<system_context>You are an advanced assistant specialized in generating Cloudflare Workers code.</system_context>\n');
    repo.write('src/index.ts', 'export default {};\n');
    const report = auditRepo(repo.dir);
    const brief = check(report, 'intent.instructions-file');
    expect(brief.status).toBe('fail');
    expect(brief.evidence.join('\n')).toContain('generic rule');
    expect(check(report, 'intent.scoped-rules').status).not.toBe('pass');

    // The same folder with a rule Cursor applies and that names the project's own paths and scripts.
    repo.write('.cursor/rules/api.mdc', '---\ndescription: API handlers\nglobs: "src/**"\nalwaysApply: false\n---\nKeep handlers in `src/index.ts` thin; run `npm run check` before finishing.\n');
    expect(check(auditRepo(repo.dir), 'intent.instructions-file').status).toBe('pass');
  });

  it('does not credit a workflow that never runs on the default branch', () => {
    const repo = temp('ha-deadci-');
    repo.write('package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest run', lint: 'eslint .' }, devDependencies: { eslint: '^9.0.0' } }));
    repo.write('.github/workflows/sanity-check.yml', 'on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n      - run: npm run lint\n');
    repo.commit();
    execFileSync('git', ['branch', '-m', 'master'], { cwd: repo.dir });
    const dead = check(auditRepo(repo.dir), 'release.ci-pipeline');
    expect(dead.status).toBe('fail');
    expect(dead.evidence.join('\n')).toContain('is filtered to `main`, but the default branch is `master`: pushes and pull requests to it never start this workflow');
    expect(dead.fix.en).toContain('branches:');

    execFileSync('git', ['branch', '-m', 'main'], { cwd: repo.dir });
    expect(check(auditRepo(repo.dir), 'release.ci-pipeline').status).toBe('pass');
  });

  it('credits only committed harness files', () => {
    const repo = temp('ha-untracked-harness-');
    repo.write('package.json', JSON.stringify({ name: 'app', dependencies: { next: '^16.0.0' } }));
    repo.commit();
    repo.write('.worktreeinclude', '.env.local\n');
    repo.write('AGENTS.md', '# App\nRun `npm test`.\nA\nB\nC\n');
    const report = auditRepo(repo.dir);
    const worktree = check(report, 'graph.worktree-isolation');
    expect(worktree.status).toBe('warn');
    expect(worktree.evidence.join('\n')).toContain('Not committed yet, so no other checkout has it: .worktreeinclude');
    const brief = check(report, 'intent.instructions-file');
    expect(brief.status).toBe('warn');
    expect(brief.evidence.join('\n')).toContain('AGENTS.md not committed yet');
  });

  it('says agents-only history for what it is and counts test support files out', () => {
    const repo = temp('ha-agents-only-');
    repo.write('package.json', JSON.stringify({ name: 'app', scripts: { test: 'bun test' } }));
    repo.write('test/preload/jsdom.mjs', 'export {};\n');
    repo.write('test/helpers/render.ts', 'export {};\n');
    repo.write('test/app.test.ts', "it('adds', () => { expect(1 + 1).toBe(2); });\n");
    repo.commit('noreply@anthropic.com');
    const report = auditRepo(repo.dir);
    expect(report.stack.testFileCount).toBe(1);
    expect(evidence(report, 'verification.oracle-protection')).toContain('1 commit(s) in the last 90 days, none by a human author');
  });

  it('builds an Xcode project from its shared scheme and has nothing to update without packages', () => {
    const repo = temp('ha-scheme-');
    repo.write('App.xcodeproj/project.pbxproj', '// !$*UTF8*$!\n');
    repo.write('App.xcodeproj/xcshareddata/xcschemes/App.xcscheme', '<Scheme><BuildAction/></Scheme>\n');
    repo.write('App/Main.swift', 'import SwiftUI\n');
    repo.write('App/View.swift', 'import SwiftUI\n');
    const report = auditRepo(repo.dir);
    expect(report.stack.verifyCommands).toContain('`xcodebuild -scheme App build` → typecheck + build');
    expect(check(report, 'release.dependency-automation').status).toBe('info');
    const plan = initHarness(repo.dir, { dryRun: true, tools: ['claude-code'] });
    const agents = plan.actions.find((a) => a.path === 'AGENTS.md')!.content;
    expect(agents).toContain('xcodebuild -scheme App build');
    expect(agents).toContain('XCTSkip');
    expect(agents).not.toContain('@ts-ignore');
  });

  it('labels tsc as a type check and flags a fixed dev port', () => {
    const repo = temp('ha-port-');
    repo.write('package.json', JSON.stringify({ name: 'w', scripts: { check: 'tsc', dev: 'wrangler dev --port 8790' }, devDependencies: { typescript: '^6.0.0' } }));
    repo.write('wrangler.toml', 'name = "w"\n');
    const report = auditRepo(repo.dir);
    expect(report.stack.verifyCommands).toContain('`npm run check` → typecheck');
    const ports = check(report, 'graph.port-and-state-isolation');
    expect(ports.status).toBe('warn');
    expect(ports.evidence.join('\n')).toContain('Dev server port 8790 is fixed');
  });

  it('quotes the brief verbatim and warns about an e2e suite that only drives a deployed site', () => {
    const repo = temp('ha-verbatim-');
    repo.write('package.json', JSON.stringify({ name: 'admin', devDependencies: { '@playwright/test': '^1.50.0' }, dependencies: { react: '^19.0.0' } }));
    repo.write('AGENTS.md', '# Admin\n\nNever point `PUBLIC_ADMIN_API` at production from a local session.\nA\nB\nC\n');
    repo.write('playwright.config.ts', "export default { use: { baseURL: 'https://admin.example.com' } };\n");
    repo.write('e2e/login.spec.ts', "test('logs in', async () => {});\n");
    const report = auditRepo(repo.dir);
    expect(evidence(report, 'harness.sandbox-readiness')).toContain('"Never point `PUBLIC_ADMIN_API` at production from a local session."');
    const e2e = check(report, 'verification.e2e-tests');
    expect(e2e.status).toBe('warn');
    expect(e2e.evidence.join('\n')).toContain('targets a deployed URL');
  });
});

describe('the repository\'s own words and guards', () => {
  it('reads a boundary rule written in Polish, and does not take a report of the past for a rule', () => {
    const pl = temp('ha-polish-');
    pl.write('package.json', JSON.stringify({ name: 'kolejka' }));
    pl.write('AGENTS.md', '# Kolejka\n\n- Zmiany przez feature branch i PR. Wdrożenie wyłącznie z czystego main, po walidacji.\nA\nB\nC\n');
    expect(evidence(auditRepo(pl.dir), 'harness.sandbox-readiness')).toContain('Boundary rule at AGENTS.md:3: "Zmiany przez feature branch i PR. Wdrożenie wyłącznie z czystego main, po walidacji."');

    const past = temp('ha-past-');
    past.write('package.json', JSON.stringify({ name: 'app' }));
    past.write('AGENTS.md', '# App\n\nThe first example was never deployed; it stays for history.\nA\nB\nC\n');
    expect(evidence(auditRepo(past.dir), 'harness.sandbox-readiness')).toContain('Found no sentence in AGENTS.md that forbids or reserves an action on production');

    // The clearest rule is the one quoted, wherever it stands in the file.
    past.write('AGENTS.md', '# App\n\nDeploys go only through CI.\nNever run `wrangler deploy` against production from a worktree.\nA\nB\n');
    expect(evidence(auditRepo(past.dir), 'harness.sandbox-readiness')).toContain('Boundary rule at AGENTS.md:4: "Never run `wrangler deploy` against production from a worktree." (+1 more)');
  });

  it('counts remote bindings that hold data, not comments and not remote-only services', () => {
    const repo = temp('ha-remote-');
    repo.write('package.json', JSON.stringify({ name: 'w' }));
    repo.write(
      'wrangler.jsonc',
      '{\n  "name": "w",\n  // remote: true is required for both\n  "ai": { "binding": "AI", "remote": true },\n  "browser": { "binding": "BROWSER", "remote": true }\n}\n',
    );
    expect(evidence(auditRepo(repo.dir), 'harness.sandbox-readiness')).not.toContain('remote: true');

    repo.write('wrangler.jsonc', '{ "name": "w", "ai": { "binding": "AI", "remote": true }, "d1_databases": [{ "binding": "DB", "database_id": "x", "remote": true }] }');
    expect(evidence(auditRepo(repo.dir), 'harness.sandbox-readiness')).toContain('wrangler.jsonc marks 1 data binding(s) `remote: true` (d1_databases)');

    const toml = temp('ha-remote-toml-');
    toml.write('package.json', JSON.stringify({ name: 'w' }));
    toml.write('wrangler.toml', 'name = "w"\n# remote = true would reach production\n[ai]\nbinding = "AI"\nremote = true\n\n[[kv_namespaces]]\nbinding = "KV"\nid = "x"\nremote = true # shared\n');
    expect(evidence(auditRepo(toml.dir), 'harness.sandbox-readiness')).toContain('wrangler.toml marks 1 data binding(s) `remote: true` (kv_namespaces)');
  });

  it('credits a deploy script that opens with its own guard, and names the Pages command for a Pages project', () => {
    const repo = temp('ha-guarded-');
    repo.write('package.json', JSON.stringify({ name: 'app', scripts: { deploy: 'bash scripts/assert-main-checkout.sh && npm run verify && wrangler deploy', verify: 'vitest run' } }));
    repo.write('scripts/assert-main-checkout.sh', '#!/bin/sh\nexit 0\n');
    repo.write('wrangler.toml', 'name = "app"\n');
    const guarded = evidence(auditRepo(repo.dir), 'release.deploy-safety');
    expect(guarded).toContain('`npm run deploy` opens with `bash scripts/assert-main-checkout.sh`, a guard that decides whether this checkout may ship');
    expect(guarded).toContain('Neither a guard nor a deny rule covers `npx wrangler deploy`');
    expect(guarded).not.toContain('Nothing stops');

    const pages = temp('ha-pages-');
    pages.write('package.json', JSON.stringify({ name: 'site', scripts: { deploy: 'astro build && wrangler pages deploy dist --project-name=site' } }));
    pages.write('wrangler.toml', 'name = "site"\npages_build_output_dir = "./dist"\n');
    const shipped = evidence(auditRepo(pages.dir), 'release.deploy-safety');
    expect(shipped).toContain('`npx wrangler pages deploy`');
    expect(shipped).not.toContain('`npx wrangler deploy`');
    const settings = initHarness(pages.dir, { dryRun: true, tools: ['claude-code'] }).actions.find((a) => a.path === '.claude/settings.json')!.content;
    expect(settings).toContain('Bash(npx wrangler pages deploy:*)');
    expect(settings).toContain('Read(./.env.local)');
    expect(settings).not.toContain('Read(./.env.*)"');
  });

  it('follows a brief that sends its reader to the README, and names the brief that exists', () => {
    const repo = temp('ha-readme-hop-');
    repo.write('package.json', JSON.stringify({ name: 'site', scripts: { verify: 'vitest run && eslint .', build: 'astro build' }, devDependencies: { eslint: '^9.0.0' } }));
    repo.write('CLAUDE.md', '# Site\n\n**[README.md](README.md)** — read it first.\n\nBuild with `npm run build`.\nA\nB\n');
    repo.write('README.md', '# Site\n\nRun `npm run verify` before you finish.\n');
    repo.write('src/a.test.ts', "it('adds', () => { expect(1 + 1).toBe(2); });\n");
    const loop = check(auditRepo(repo.dir), 'loop.single-command-verify');
    expect(loop.evidence.join('\n')).toContain('CLAUDE.md sends agents to README.md, which quotes 1 verify command(s), e.g. `npm run verify`');
    expect(loop.status).toBe('pass');

    repo.write('CLAUDE.md', '# Site\n\nBuild with `npm run build`.\nA\nB\nC\n');
    const bare = check(auditRepo(repo.dir), 'loop.single-command-verify');
    expect(bare.evidence.join('\n')).toContain('quote no test, lint or type-check command');
    expect(bare.fix.en).toContain('`CLAUDE.md`');
    expect(bare.fix.en).not.toContain('AGENTS.md');
  });

  it('sees runtime tests by what the test files boot, and a health route by the path the code serves', () => {
    const repo = temp('ha-workerd-');
    repo.write('package.json', JSON.stringify({ name: 'triage', scripts: { test: 'node --test tests/' }, devDependencies: { miniflare: '^4.0.0' } }));
    repo.write('wrangler.toml', 'name = "triage"\n\n[[migrations]]\ntag = "v1"\nnew_sqlite_classes = ["Queue"]\n');
    repo.write('src/index.js', "export default { fetch(request) { if (new URL(request.url).pathname === '/health') return new Response('ok'); return new Response('no', { status: 404 }); } };\n");
    repo.write('tests/workerd.test.mjs', "import { Miniflare } from 'miniflare';\nimport test from 'node:test';\ntest('boots', async () => { const mf = new Miniflare({ scriptPath: 'src/index.js' }); await mf.dispose(); });\n");
    const report = auditRepo(repo.dir);
    const e2e = check(report, 'verification.e2e-tests');
    expect(e2e.status).toBe('pass');
    expect(e2e.evidence.join('\n')).toContain('1 file(s) boot the Worker in Miniflare/workerd, e.g. tests/workerd.test.mjs');
    const observed = evidence(report, 'release.observability-and-safety');
    expect(observed).toContain('Healthcheck endpoint');
    expect(observed).toContain('Durable Object migrations versioned in the Worker config');
    // Plain JavaScript gets advice for JavaScript.
    expect(check(report, 'loop.static-types').fix.en).toContain('checkJs');
  });

  it('counts the skills a coding agent loads, not the product\'s own SKILL.md tree, and finds a named spec at the root', () => {
    const repo = temp('ha-product-skills-');
    repo.write('package.json', JSON.stringify({ name: 'assistant' }));
    repo.write('skills/platform/search/SKILL.md', '---\nname: search\n---\nModel-facing.\n');
    repo.write('src/a.ts', 'export const a = 1;\n');
    repo.write('src/b.ts', 'export const b = 1;\n');
    repo.write('assistant-spec.md', '# Spec\n');
    const product = evidence(auditRepo(repo.dir), 'intent.skills-and-specs');
    expect(product).not.toContain('Reusable skills');
    expect(product).toContain('1 SKILL.md file(s) outside the agent tool folders (e.g. skills/platform/search/SKILL.md) read as product content');
    expect(product).toContain('Design/spec/standard docs: assistant-spec.md');

    repo.write('.claude/skills/release/SKILL.md', '---\nname: release\n---\nSteps.\n');
    expect(evidence(auditRepo(repo.dir), 'intent.skills-and-specs')).toContain('Reusable skills: 1 (.claude/skills/release/SKILL.md)');
  });

  it('takes a port from the worktree helper or the environment as isolation, and flags a dev script that kills the port', () => {
    const repo = temp('ha-wt-port-');
    repo.write('package.json', JSON.stringify({ name: 'app', scripts: { dev: 'vite' }, devDependencies: { vite: '^8.0.0' } }));
    repo.write('wrangler.toml', 'name = "app"\n\n[dev]\nport = 8787\n');
    repo.write('bin/wt', '#!/bin/sh\necho "PORT=$((4000 + slot))" > .wt-env\n');
    const isolated = check(auditRepo(repo.dir), 'graph.port-and-state-isolation');
    expect(isolated.status).toBe('pass');
    expect(isolated.evidence.join('\n')).toContain('bin/wt allocates a port per worktree');
    expect(isolated.evidence.join('\n')).not.toContain('is fixed in the config');

    const killer = temp('ha-kill-port-');
    killer.write('package.json', JSON.stringify({ name: 'app', scripts: { dev: 'lsof -ti:8788 | xargs kill -9; wrangler dev --port 8788' } }));
    killer.write('wrangler.toml', 'name = "app"\n');
    const killed = check(auditRepo(killer.dir), 'graph.port-and-state-isolation');
    expect(killed.status).toBe('warn');
    expect(killed.evidence.join('\n')).toContain('The dev script kills whatever holds port 8788');
  });

  it('says when the checkout is behind the default branch and what that branch has', () => {
    const repo = temp('ha-behind-');
    repo.write('package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest run' } }));
    repo.commit();
    const git = (...args: string[]): void => void execFileSync('git', args, { cwd: repo.dir, stdio: 'ignore' });
    git('branch', '-m', 'main');
    git('branch', 'fix/geo');
    repo.write('.github/workflows/ci.yml', 'on: [pull_request]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n');
    repo.commit();
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    git('checkout', '-q', 'fix/geo');
    const report = auditRepo(repo.dir);
    expect(report.git.behindDefault).toBe(1);
    expect(report.git.defaultBranchOnly).toEqual(['.github/workflows/ci.yml']);
    expect(evidence(report, 'release.ci-pipeline')).toContain('main has .github/workflows/ci.yml: this branch is 1 commit(s) behind it');
    expect(branchNotes(report, 'en')[0]).toBe('Branch fix/geo is 1 commit(s) behind main: this audit describes the checkout, not what ships.');
  });

  it('judges the tsconfig that covers the application, and builds an iOS scheme for the simulator', () => {
    const repo = temp('ha-solution-');
    repo.write('package.json', JSON.stringify({ name: 'app', devDependencies: { typescript: '^6.0.0' } }));
    repo.write('tsconfig.json', JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }] }));
    repo.write('tsconfig.app.json', JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }));
    repo.write('tsconfig.node.json', JSON.stringify({ compilerOptions: { composite: true }, include: ['vite.config.ts'] }));
    repo.write('src/a.ts', 'export const a = 1;\n');
    expect(check(auditRepo(repo.dir), 'loop.static-types').status).toBe('pass');

    const ios = temp('ha-ios-scheme-');
    ios.write('App.xcodeproj/project.pbxproj', '// !$*UTF8*$!\nSDKROOT = iphoneos;\n');
    ios.write('App.xcodeproj/xcshareddata/xcschemes/App.xcscheme', '<Scheme><BuildAction/></Scheme>\n');
    ios.write('App/Main.swift', 'import SwiftUI\n');
    expect(auditRepo(ios.dir).stack.verifyCommands).toContain("`xcodebuild -scheme App -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build` → typecheck + build");

    // Tests on iOS need a named simulator: the audit says so instead of inventing a device.
    ios.write('App.xcodeproj/xcshareddata/xcschemes/App.xcscheme', '<Scheme><BuildAction/><TestAction><Testables><TestableReference/></Testables></TestAction></Scheme>\n');
    ios.write('AppTests/AppTests.swift', 'import XCTest\nfinal class AppTests: XCTestCase { func testAdds() { XCTAssertEqual(1 + 1, 2) } }\n');
    const withTests = auditRepo(ios.dir);
    expect(withTests.stack.verifyCommands.join('\n')).not.toContain('test`');
    expect(evidence(withTests, 'loop.single-command-verify')).toContain("Scheme App has a test action; its command needs a simulator this audit cannot choose");
  });

  it('gives a lone .worktreeinclude half the credit of a documented worktree convention', () => {
    const repo = temp('ha-include-only-');
    repo.write('package.json', JSON.stringify({ name: 'app', dependencies: { next: '^16.0.0' } }));
    repo.write('.worktreeinclude', '.env.local\n');
    const alone = check(auditRepo(repo.dir), 'graph.worktree-isolation');
    expect(alone.status).toBe('warn');
    expect(alone.evidence.join('\n')).toContain('no brief says that a second agent should work in one');

    repo.write('AGENTS.md', '# App\n\nWork in your own git worktree (`claude --worktree`).\nA\nB\nC\n');
    expect(check(auditRepo(repo.dir), 'graph.worktree-isolation').status).toBe('pass');
  });
});

describe('robustness: no input makes the audit hang', () => {
  it('reads a long XcodeGen list of local packages line by line', () => {
    const repo = temp('ha-xcodegen-local-');
    repo.write('project.yml', `name: App\npackages:\n${'  Kit:\n    path: Packages/Kit\n'.repeat(60)}targets:\n  App:\n    type: application\n`);
    repo.write('App/Main.swift', 'import SwiftUI\n');
    const started = Date.now();
    const report = auditRepo(repo.dir);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(evidence(report, 'loop.lockfile-reproducibility')).not.toContain('floating');
  });

  it('finishes on files full of repetitive, adversarial text', () => {
    const repo = temp('ha-hostile-');
    const blob = [
      `packages:\n${'  Kit:\n    path: Packages/Kit\n'.repeat(400)}`,
      '  - name: value   \n'.repeat(3000),
      `${' '.repeat(20000)}\n`,
      `${'\`a\` '.repeat(4000)}\n`,
      '---\n'.repeat(1500),
      `${'never deploy production only '.repeat(2500)}\n`,
      `${'A=B '.repeat(4000)}\n`,
      `[dev]\n${'port  \n'.repeat(2000)}`,
      `${'"remote" : tru '.repeat(3000)}\n`,
      `sk-ant-${'a'.repeat(30000)}\n`,
      `(${'docs/'.repeat(3000)}x\n`,
      `${'\t'.repeat(15000)}x\n`,
    ].join('');
    const files = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'project.yml', 'wrangler.toml', 'wrangler.jsonc', '.github/workflows/ci.yml', 'Makefile', 'pyproject.toml', 'Package.swift', 'build.gradle.kts', '.cursor/rules/x.mdc', '.claude/settings.json', 'playwright.config.ts', 'vite.config.ts', 'tsconfig.json', 'src/index.ts', 'tests/a.test.ts', '.env.example', 'Dockerfile', '.mcp.json', '.github/pull_request_template.md', 'App.xcodeproj/project.pbxproj', 'justfile', 'docs/architecture.md', '.claude/rules/a.md'];
    for (const f of files) repo.write(f, blob);
    repo.write('package.json', JSON.stringify({ name: 'x', scripts: { dev: `${'A=B '.repeat(3000)}vite`, test: `vitest run ${' && echo x'.repeat(2000)}`, deploy: `${' '.repeat(10000)}wrangler deploy` } }));
    const started = Date.now();
    const report = auditRepo(repo.dir);
    expect(Date.now() - started).toBeLessThan(10000);
    expect(report.checks.length).toBe(30);
  }, 60000);
});

describe('claims about the running app', () => {
  it('looks for a health route only where something serves requests', () => {
    const cli = temp('ha-cli-health-');
    cli.write('package.json', JSON.stringify({ name: 'cli', bin: { cli: 'dist/cli.js' } }));
    cli.write('src/prompt.ts', "export const advice = 'Expose `/health` and poll it';\nexport const route = '/health';\n");
    expect(check(auditRepo(cli.dir), 'release.observability-and-safety').status).toBe('info');
  });

  it('quotes an instruction before a sentence that only describes behaviour', () => {
    const repo = temp('ha-instruction-');
    repo.write('package.json', JSON.stringify({ name: 'app' }));
    repo.write('AGENTS.md', '# App\n\nAfter a deploy a missing table degrades to an empty list, never to a 500.\n\n- Do not run `wrangler deploy` from a worktree.\nA\nB\n');
    expect(evidence(auditRepo(repo.dir), 'harness.sandbox-readiness')).toContain('Boundary rule at AGENTS.md:5: "Do not run `wrangler deploy` from a worktree."');
  });
});

describe('review fixes: what a command, a rule and a file really are', () => {
  it('names a committed OAuth credential by path and key, and leaves design tokens and placeholders alone', () => {
    const repo = temp('ha-oauth-');
    repo.write('package.json', JSON.stringify({ name: 'ops' }));
    repo.write('gsc-tokens.json', `{\n  "refresh_token": "1//0gZz9${'Zz9'.repeat(10)}",\n  "client_secret": "GOCSPX-${'Zz9'.repeat(8)}"\n}\n`);
    repo.write('tokens.json', '{ "color": { "accent": "#ff4d00" }, "client_secret": "your-client-secret-goes-here-123" }\n');
    repo.commit();
    const report = auditRepo(repo.dir);
    const secrets = check(report, 'harness.secret-hygiene');
    expect(secrets.status).toBe('fail');
    expect(secrets.severity).toBe('critical');
    expect(secrets.evidence.join('\n')).toContain('gsc-tokens.json:2 OAuth refresh token (committed)');
    expect(secrets.evidence.join('\n')).toContain('gsc-tokens.json:3 OAuth client secret (committed)');
    expect(secrets.evidence.join('\n')).not.toContain('tokens.json:1');
    expect(secrets.evidence.join('\n')).not.toContain('Zz9');
    expect(report.level).toBeLessThanOrEqual(2);
  });

  it('flags an env file that git neither tracks nor ignores, and does not take a disabled sandbox for a sandbox', () => {
    const repo = temp('ha-stray-env-');
    repo.write('package.json', JSON.stringify({ name: 'site', dependencies: { astro: '^6.0.0' } }));
    repo.write('wrangler.toml', 'name = "site"\n');
    repo.write('.gitignore', '.dev.vars\nnode_modules\n');
    repo.write('.claude/settings.json', JSON.stringify({ sandbox: { enabled: false }, permissions: { allow: ['Bash(npm test:*)'] } }));
    repo.commit();
    repo.write('.env.development', 'API_URL=http://localhost\n');
    const report = auditRepo(repo.dir);
    const secrets = check(report, 'harness.secret-hygiene');
    expect(secrets.status).toBe('fail');
    expect(secrets.evidence.join('\n')).toContain('Present and not ignored: .env.development');
    expect(evidence(report, 'harness.sandbox-readiness')).toContain('No agent sandbox configured');
    expect(evidence(report, 'harness.permissions-policy')).not.toContain('sandbox enabled');
  });

  it('holds a deny rule to the command it names', () => {
    const repo = temp('ha-deny-exact-');
    repo.write('package.json', JSON.stringify({ name: 'app', scripts: { deploy: 'wrangler deploy', 'deploy:preview': 'wrangler versions upload' } }));
    repo.write('wrangler.toml', 'name = "app"\n');
    repo.write('.claude/settings.json', JSON.stringify({ permissions: { deny: ['Bash(npx wrangler deploy --dry-run)', 'Bash(npm run deploy:preview:*)'] } }));
    const loose = check(auditRepo(repo.dir), 'release.deploy-safety');
    expect(loose.status).toBe('warn');
    expect(loose.evidence.join('\n')).toContain('Nothing stops an agent running `npm run deploy`, `npx wrangler deploy`');
  });

  it('does not credit a command whose failure is swallowed, a script that only prints, or an argument', () => {
    const repo = temp('ha-swallowed-');
    repo.write(
      'package.json',
      JSON.stringify({ name: 'app', scripts: { test: 'vitest run || true', build: 'echo "no build step"', check: 'npm run typecheck lint', typecheck: 'tsc --noEmit', lint: 'eslint .' }, devDependencies: { typescript: '^6.0.0', eslint: '^9.0.0' } }),
    );
    repo.write('src/a.test.ts', "it('adds', () => { expect(1 + 1).toBe(2); });\n");
    const commands = auditRepo(repo.dir).stack.verifyCommands.join('\n');
    expect(commands).not.toContain('`npm test`');
    expect(commands).not.toContain('`npm run build`');
    expect(commands).toContain('`npm run check` → typecheck');
    expect(commands).not.toContain('`npm run check` → lint');
  });

  it('counts as a pull-request gate only a step that can fail the run and that runs for pull requests', () => {
    const repo = temp('ha-ci-gates-');
    repo.write('package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' }, devDependencies: { eslint: '^9.0.0', typescript: '^6.0.0' } }));
    repo.write(
      '.github/workflows/ci.yml',
      [
        'on: [push, pull_request]',
        'jobs:',
        '  checks:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm run lint',
        '      - name: tests (flaky)',
        '        run: npm test',
        '        continue-on-error: true',
        '  release-checks:',
        "    if: github.event_name == 'push'",
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm run typecheck',
        '',
      ].join('\n'),
    );
    expect(evidence(auditRepo(repo.dir), 'release.ci-pipeline')).toContain('tests: no · lint: yes · typecheck: no');
  });

  it('survives a malformed tsconfig and lets an earlier parent decide when a later one says nothing', () => {
    const broken = temp('ha-tsconfig-null-');
    broken.write('package.json', JSON.stringify({ name: 'app', devDependencies: { typescript: '^6.0.0' } }));
    broken.write('tsconfig.json', 'null');
    broken.write('src/a.ts', 'export const a = 1;\n');
    expect(() => auditRepo(broken.dir)).not.toThrow();

    const chain = temp('ha-tsconfig-chain-');
    chain.write('package.json', JSON.stringify({ name: 'app', devDependencies: { typescript: '^6.0.0' } }));
    chain.write('tsconfig.json', JSON.stringify({ extends: ['./base.json', './paths.json'] }));
    chain.write('base.json', JSON.stringify({ compilerOptions: { strict: true } }));
    chain.write('paths.json', JSON.stringify({ compilerOptions: { outDir: 'dist' } }));
    chain.write('src/a.ts', 'export const a = 1;\n');
    expect(check(auditRepo(chain.dir), 'loop.static-types').status).toBe('pass');

    const bare = temp('ha-ts-no-config-');
    bare.write('package.json', JSON.stringify({ name: 'ops' }));
    bare.write('sync.ts', 'export const a: number = 1;\n');
    const unchecked = check(auditRepo(bare.dir), 'loop.static-types');
    expect(unchecked.status).toBe('warn');
    expect(unchecked.evidence.join('\n')).toContain('TypeScript without a tsconfig.json');
  });

  it('does not follow a symlink out of the repository', () => {
    const outside = temp('ha-outside-');
    outside.write('notes.md', '# Private\n\nNever deploy to production without asking Zofia.\nA\nB\nC\n');
    const repo = temp('ha-symlink-out-');
    repo.write('package.json', JSON.stringify({ name: 'app' }));
    repo.symlink('AGENTS.md', join(outside.dir, 'notes.md'));
    repo.commit();
    const report = auditRepo(repo.dir);
    expect(JSON.stringify(report)).not.toContain('Zofia');
  });

  it('keeps git\'s ignore rules in a repository that has no commit yet', () => {
    const repo = temp('ha-fresh-init-');
    repo.write('package.json', JSON.stringify({ name: 'app' }));
    repo.write('.gitignore', '.env\n');
    repo.write('.env', `ANTHROPIC_API_KEY=${FAKE_KEY}\n`);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo.dir, stdio: 'ignore' });
    const report = auditRepo(repo.dir);
    expect(report.scan.mode).toBe('git');
    expect(evidence(report, 'harness.secret-hygiene')).not.toContain('Anthropic');
  });

  it('reads telemetry from SDK families, contract tests from worker.fetch, and a mobile client is not its own health endpoint', () => {
    const rn = temp('ha-rn-');
    rn.write('package.json', JSON.stringify({ name: 'app', scripts: { 'update:prod': 'eas update --branch production' }, dependencies: { expo: '^55.0.0', '@sentry/react-native': '^7.0.0', 'posthog-react-native': '^4.0.0' } }));
    rn.write('features/dev/ApiSwitcher.tsx', "export const ping = (base: string) => fetch(base + '/health');\n");
    const report = auditRepo(rn.dir);
    const observed = evidence(report, 'release.observability-and-safety');
    expect(observed).toContain('Sentry');
    expect(observed).toContain('PostHog');
    expect(observed).not.toContain('Healthcheck endpoint');
    expect(evidence(report, 'release.deploy-safety')).toContain('`npm run update:prod`');

    const worker = temp('ha-worker-fetch-');
    worker.write('package.json', JSON.stringify({ name: 'proxy', scripts: { test: 'node --test tests/' } }));
    worker.write('wrangler.toml', 'name = "proxy"\n');
    worker.write('src/worker.js', 'export default { fetch() { return new Response("ok"); } };\n');
    worker.write('tests/worker.test.js', "import worker from '../src/worker.js';\nimport test from 'node:test';\ntest('answers', async () => { await worker.fetch(new Request('https://x.test/')); });\n");
    const e2e = check(auditRepo(worker.dir), 'verification.e2e-tests');
    expect(e2e.status).toBe('pass');
    expect(e2e.evidence.join('\n')).toContain('HTTP contract tests (1 test file(s) call the app through its request handler)');
  });

  it('warns about a browser suite that nothing runs, and does not take an engines range for a pin', () => {
    const repo = temp('ha-e2e-idle-');
    repo.write('package.json', JSON.stringify({ name: 'site', engines: { node: '>=22.12.0' }, scripts: { 'test:e2e': 'playwright test', test: 'vitest run', verify: 'npm test' }, devDependencies: { '@playwright/test': '^1.50.0' }, dependencies: { astro: '^6.0.0' } }));
    repo.write('playwright.config.ts', "export default { webServer: { command: 'npm run dev' } };\n");
    repo.write('.github/workflows/ci.yml', 'on: [pull_request]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n');
    const report = auditRepo(repo.dir);
    const e2e = check(report, 'verification.e2e-tests');
    expect(e2e.status).toBe('warn');
    expect(e2e.evidence.join('\n')).toContain('Playwright is set up, but no CI job and no verify script runs it');
    expect(evidence(report, 'loop.lockfile-reproducibility')).toContain('engines.node >=22.12.0 is a range, not a pin');
  });

  it('counts an invariant check when the loop runs it, not a monitor someone runs by hand', () => {
    const repo = temp('ha-fitness-wired-');
    repo.write('package.json', JSON.stringify({ name: 'jobs', scripts: { 'check-jobs': 'node scripts/check-unfinished-jobs.js', 'check-unfinished': 'node scripts/check-unfinished-jobs.js', test: 'vitest run' } }));
    repo.write('scripts/check-unfinished-jobs.js', 'console.log("queue depth");\n');
    const monitor = check(auditRepo(repo.dir), 'verification.fitness-functions');
    expect(monitor.status).toBe('warn');
    expect(monitor.evidence.join('\n')).toContain('Defined but run by neither the verify script nor CI');

    repo.write('package.json', JSON.stringify({ name: 'ds', scripts: { lint: 'node scripts/lint-design.js', 'lint:design': 'node scripts/lint-design.js', test: 'vitest run' } }));
    repo.write('scripts/lint-design.js', 'process.exit(0);\n');
    const wired = check(auditRepo(repo.dir), 'verification.fitness-functions');
    expect(wired.status).toBe('pass');
    expect(wired.evidence.join('\n')).toContain('invariant check: `lint:design`');
  });

  it('denies a force push wherever the flag stands, and scopes test rules to every language in the repository', () => {
    const repo = temp('ha-init-rules-');
    repo.write('package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest run' } }));
    repo.write('src/a.ts', 'export const a = 1;\n');
    repo.write('ios/App.xcodeproj/project.pbxproj', '// !$*UTF8*$!\n');
    repo.write('ios/App/Main.swift', 'import SwiftUI\n');
    repo.write('ios/App/View.swift', 'import SwiftUI\n');
    const plan = initHarness(repo.dir, { dryRun: true, tools: ['claude-code'] });
    const settings = plan.actions.find((a) => a.path === '.claude/settings.json')!.content;
    expect(settings).toContain('Bash(git push * --force*)');
    expect(settings).toContain('Bash(git push * -f*)');
    const rule = plan.actions.find((a) => /rules\/testing/.test(a.path))!.content;
    expect(rule).toContain('**/*Tests.swift');
    expect(rule).toContain('**/*.test.*');
  });
});

describe('what the last fresh panel still got past the audit', () => {
  it('finds a provider key in a source file, and one that only the working copy has lost', () => {
    const live = `sk_live_${'Zz9'.repeat(9)}`;
    const repo = temp('ha-source-key-');
    repo.write('package.json', JSON.stringify({ name: 'ops' }));
    repo.write('cancel-users.js', `const stripe = require('stripe')('${live}');\n`);
    repo.write('names.js', `const stripe = require('stripe')('${live}');\n`);
    repo.commit();
    // Removed locally, never committed: the remote still serves it.
    repo.write('names.js', "const stripe = require('stripe')(process.env.STRIPE_KEY);\n");
    const report = auditRepo(repo.dir);
    const secrets = check(report, 'harness.secret-hygiene');
    expect(secrets.status).toBe('fail');
    expect(secrets.severity).toBe('critical');
    expect(secrets.evidence.join('\n')).toContain('cancel-users.js:1 Stripe secret key (committed)');
    expect(secrets.evidence.join('\n')).toContain('names.js:1 Stripe secret key (in the last commit; the working copy no longer has it)');
    expect(JSON.stringify(report)).not.toContain(live);
    expect(report.level).toBeLessThanOrEqual(2);
  });

  it('treats a backup copy of a credential file as the credential file, and committed node_modules as a finding', () => {
    const repo = temp('ha-bak-');
    repo.write('package.json', JSON.stringify({ name: 'ops', dependencies: { left: '1.0.0' } }));
    repo.write('package-lock.json', '{}\n');
    repo.write('node_modules/left/index.js', 'module.exports = 1;\n');
    repo.commit();
    repo.write('gsc-tokens.json.bak', `{\n  "refresh_token": "1//0g${'Zz9'.repeat(10)}"\n}\n`);
    const report = auditRepo(repo.dir);
    expect(evidence(report, 'harness.secret-hygiene')).toContain('gsc-tokens.json.bak:2 OAuth refresh token (untracked, not gitignored)');
    const lock = check(report, 'loop.lockfile-reproducibility');
    expect(lock.status).toBe('warn');
    expect(lock.evidence.join('\n')).toContain('node_modules/ is committed (1 tracked files)');
  });

  it('does not allow-list a command the brief forbids, and does not take "the same worktree" for a worktree convention', () => {
    const repo = temp('ha-forbidden-');
    repo.write('package.json', JSON.stringify({ name: 'mono', scripts: { test: 'vitest run', check: 'tsc --noEmit' }, dependencies: { vite: '^8.0.0' }, devDependencies: { typescript: '^6.0.0' } }));
    repo.write('AGENTS.md', '# Mono\n\n- Never run `npm test` from the root; run the package you changed.\n- Multiple agents may work on different files in the same worktree simultaneously.\n- After code changes run `npm run check`.\nA\n');
    for (let i = 0; i < 20; i++) repo.write(`src/m${i}.ts`, 'export const m = 1;\n');
    const settings = initHarness(repo.dir, { dryRun: true, tools: ['claude-code'] }).actions.find((a) => a.path === '.claude/settings.json')!.content;
    expect(settings).toContain('Bash(npm run check:*)');
    expect(settings).not.toContain('Bash(npm test:*)');
    const worktree = check(auditRepo(repo.dir), 'graph.worktree-isolation');
    expect(worktree.status).not.toBe('pass');
    expect(worktree.evidence.join('\n')).toContain('several agents work in the same worktree');
  });

  it('reads a drawn directory tree as a map, flags strict types nothing runs, and names a script that writes remote data', () => {
    const repo = temp('ha-tree-');
    repo.write('package.json', JSON.stringify({ name: 'app', scripts: { lint: 'eslint .', 'dev:remote': 'wrangler dev --remote' }, devDependencies: { eslint: '^9.0.0', typescript: '^6.0.0' } }));
    repo.write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }));
    repo.write('wrangler.toml', 'name = "app"\n');
    repo.write('src/a.ts', 'export const a = 1;\n');
    repo.write('README.md', '# App\n\n## Stos\n\n```\napp/\n├── core/      domain\n├── data/      storage\n└── ui/        screens\n```\n');
    const report = auditRepo(repo.dir);
    expect(evidence(report, 'graph.workspace-boundaries')).toContain('README.md has an architecture / structure section');
    const types = check(report, 'loop.static-types');
    expect(types.status).toBe('warn');
    expect(types.evidence.join('\n')).toContain('none of the verify commands runs the type checker');
    expect(evidence(report, 'release.deploy-safety')).toContain('`npm run dev:remote`');
  });
});

describe('second review: edge cases that changed a verdict', () => {
  it('quotes the whole line when no single sentence of it says how the repository ships', () => {
    const repo = temp('ha-deploy-line-');
    repo.write('package.json', JSON.stringify({ name: 'app' }));
    repo.write('AGENTS.md', '# App\n\nDeploys are manual; on push we run tests.\nA\nB\nC\n');
    expect(() => auditRepo(repo.dir)).not.toThrow();
  });

  it('takes only a deny rule for a restriction, and a literal port for a fixed one', () => {
    const repo = temp('ha-allow-edit-');
    repo.write('package.json', JSON.stringify({ name: 'app', scripts: { dev: 'wrangler dev --port 8790', test: 'vitest run' } }));
    repo.write('wrangler.toml', 'name = "app"\n');
    repo.write('.env.example', 'PORT=9000\n');
    repo.write('.claude/settings.json', JSON.stringify({ permissions: { allow: ['Edit(tests/**)'] } }));
    repo.write('tests/a.test.ts', "it('adds', () => { expect(1 + 1).toBe(2); });\n");
    const report = auditRepo(repo.dir);
    expect(evidence(report, 'verification.oracle-protection')).not.toContain('restricts agent edits');
    const ports = check(report, 'graph.port-and-state-isolation');
    expect(ports.status).toBe('warn');
    expect(ports.evidence.join('\n')).toContain('Dev server port 8790 is fixed');
  });

  it('does not count migration tooling as telemetry, or a guard that the deploy does not wait for', () => {
    const repo = temp('ha-prisma-');
    repo.write('package.json', JSON.stringify({ name: 'api', scripts: { deploy: 'bash scripts/assert-main.sh; wrangler deploy' }, dependencies: { hono: '^5.0.0', prisma: '^7.0.0' } }));
    repo.write('scripts/assert-main.sh', '#!/bin/sh\nexit 1\n');
    repo.write('wrangler.toml', 'name = "api"\n');
    const report = auditRepo(repo.dir);
    const observed = check(report, 'release.observability-and-safety');
    expect(observed.status).toBe('warn');
    expect(observed.evidence.join('\n')).toContain('No error tracking or structured logging detected');
    expect(evidence(report, 'release.deploy-safety')).toContain('Nothing stops an agent running `npm run deploy`');
  });

  it('keeps pull-request checks of a workflow whose pushes are filtered to a release branch, and sees a deploy behind a script', () => {
    const repo = temp('ha-release-branch-');
    repo.write('package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest run', ship: 'wrangler deploy' } }));
    repo.write('wrangler.toml', 'name = "app"\n');
    repo.write('.github/workflows/ci.yml', 'on:\n  push:\n    branches: [release]\n  pull_request:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n');
    repo.write('.github/workflows/ship.yml', 'on:\n  push:\n    branches: [release]\njobs:\n  d:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run ship\n');
    repo.commit();
    const report = auditRepo(repo.dir);
    expect(evidence(report, 'release.ci-pipeline')).toContain('tests: yes');
    expect(evidence(report, 'release.ci-pipeline')).not.toContain('never start');
    expect(evidence(report, 'release.deploy-safety')).toContain('.github/workflows/ship.yml: deploys (`npm run ship`)');
  });

  it('writes no CI workflow that could not run, and takes a backticked import for what it is', () => {
    const repo = temp('ha-no-lock-');
    repo.write('package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest run' } }));
    repo.write('src/a.test.ts', "it('adds', () => { expect(1 + 1).toBe(2); });\n");
    const plan = initHarness(repo.dir, { dryRun: true, tools: ['claude-code'] });
    expect(plan.actions.some((a) => a.path === '.github/workflows/ci.yml')).toBe(false);
    repo.write('package-lock.json', '{}\n');
    expect(initHarness(repo.dir, { dryRun: true, tools: ['claude-code'] }).actions.some((a) => a.path === '.github/workflows/ci.yml')).toBe(true);

    const inert = temp('ha-inert-import-');
    inert.write('package.json', JSON.stringify({ name: 'app' }));
    inert.write('AGENTS.md', `# App\n\n${'Run the checks before you finish.\n'.repeat(12)}`);
    inert.write('CLAUDE.md', 'Use `@AGENTS.md`\n');
    expect(check(auditRepo(inert.dir), 'intent.single-source').status).not.toBe('pass');
  });
});
