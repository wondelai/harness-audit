import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditRepo, initHarness } from '../src/index.js';
import type { AuditReport, CheckResult } from '../src/types.js';
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
    repo.write('AGENTS.md', '# App\n\n## Read before you touch\n- Payments → `src/payments/README.md`\n- Tests → `tests/e2e/README.md`\n');
    repo.write('src/payments/README.md', '# Payments rules\n');
    repo.write('tests/e2e/README.md', '# E2E rules\n');
    repo.write('migrations/CLAUDE.md', '# Migration rules\n');
    repo.write('.cursor/rules/README.md', '# How these rules are organised\n');
    repo.write('.cursor/rules/api.mdc', '---\nglobs: "src/api/**"\n---\nKeep handlers thin.\n');
    for (let i = 0; i < 45; i++) repo.write(`src/mod${i}.ts`, 'export {};\n');

    const report = auditRepo(repo.dir);
    expect(check(report, 'intent.scoped-rules').status).toBe('pass');
    expect(evidence(report, 'intent.scoped-rules')).toContain('migrations/CLAUDE.md');
    expect(evidence(report, 'intent.scoped-rules')).toContain('routes agents to 2 area docs');
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
    expect(none.evidence.join('\n')).toContain('names no production or shared resource');

    const rule = temp('ha-boundary-rule-');
    rule.write('CLAUDE.md', '# App\n\n- Never run `wrangler deploy` or a `--remote` migration from a local session.\nA\nB\nC\n');
    rule.write('Dockerfile', 'FROM node:24\n');
    const some = check(auditRepo(rule.dir), 'harness.sandbox-readiness');
    expect(some.status).toBe('warn');
    expect(some.evidence.join('\n')).toContain('states a boundary: "Never run `wrangler deploy`');
    // The product image is not a place agents run in, and the fix asks only for what is missing.
    expect(some.evidence.join('\n')).toContain('Dockerfile exists but the brief does not use it');
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
    expect(partial.evidence.join('\n')).toContain('covers some deploy commands but not `npx wrangler deploy`');
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
