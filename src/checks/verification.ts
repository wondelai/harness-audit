import type { RepoContext } from '../fs-scanner.js';
import type { CheckResult } from '../types.js';

export function runVerificationChecks(ctx: RepoContext): CheckResult[] {
  const results: CheckResult[] = [];

  // A test command that comes from a manifest, a build tool or a checked-in script. Never from the
  // brief alone: "run `bun test`" above the words "no tests yet" is not a suite.
  const testCommands = ctx.verify.commands.filter((c) => c.kinds.includes('test') && c.source !== 'AGENTS.md' && c.source !== 'CLAUDE.md');
  const allTestFiles = ctx.suiteFiles;
  const commandTargets = allTestFiles.filter((f) => !ctx.testFiles.includes(f));

  // 1. verification.unit-tests
  {
    const testCount = allTestFiles.length;
    const srcCount = ctx.sourceFiles.length;
    const ratio = srcCount > 0 ? testCount / srcCount : testCount > 0 ? 1 : 0;

    const evidence: string[] = [
      `Detected ${testCount} test file(s) vs ${srcCount} source file(s) (ratio: ${srcCount > 0 ? (ratio * 100).toFixed(1) + '%' : 'n/a'})`,
    ];
    if (testCount > 0) {
      evidence.push(`Sample: ${allTestFiles.slice(0, 4).join(', ')}`);
    }
    if (commandTargets.length > 0) evidence.push(`${commandTargets.length} of them are run by the test command without a test-style name (${commandTargets.slice(0, 2).join(', ')})`);

    let status: CheckResult['status'] = 'fail';
    if (testCount >= 3 && (ratio >= 0.12 || testCount >= 15)) {
      status = 'pass';
    } else if (testCount >= 1) {
      status = srcCount <= 10 && testCount >= 2 ? 'pass' : 'warn';
    } else if (srcCount === 0 || (srcCount < 3 && ctx.stack.languages.length === 0)) {
      // Documentation, prompts or configuration only: there is no program to test.
      status = 'info';
      evidence[0] = 'No source code detected (documentation / configuration repository) — nothing to unit-test';
    } else if (testCommands.length > 0 && testCommands.some((c) => c.source !== 'Gradle' && c.source !== 'pytest')) {
      // A real test script exists and something runs: the audit could not see the files, which is its limit, not a missing suite.
      status = 'warn';
      evidence.push(`A test command exists (\`${testCommands[0]!.command}\`, from ${testCommands[0]!.source}), but no file it runs could be identified — coverage unknown`);
    }

    results.push({
      id: 'verification.unit-tests',
      station: 'verification',
      weight: 25,
      status,
      severity: status === 'fail' ? 'critical' : status === 'warn' ? 'high' : 'low',
      title: {
        en: 'Unit & integration test coverage footprint',
        pl: 'Pokrycie testami jednostkowymi i integracyjnymi',
      },
      evidence,
      why: {
        en: 'Without a real test suite, agents verify changes only by reading their own code — which lets plausible regressions ship silently.',
        pl: 'Bez prawdziwego zestawu testów agenci sprawdzają zmiany wyłącznie czytając własny kod, co przepuszcza wiarygodnie wyglądające regresje.',
      },
      fix: {
        en: 'Add fast deterministic unit/integration tests covering core business logic and edge cases, and wire them to your verify command.',
        pl: 'Dodaj szybkie, deterministyczne testy jednostkowe i integracyjne dla kluczowej logiki oraz przypadków brzegowych i podepnij je pod komendę weryfikacji.',
      },
      docsPath: 'workflows/test/',
    });
  }

  // 2. verification.e2e-tests
  {
    const e2eSignals: string[] = [];
    if (ctx.hasAnyFile(['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs']) || ctx.hasDependency('@playwright/test') || ctx.hasDependency('playwright')) {
      e2eSignals.push('Playwright');
    }
    const e2eNamed = ctx.findFiles((f) => /(^|\/)[\w.-]*e2e[\w.-]*\//i.test(f) || /\.e2e(-spec)?\.[jt]sx?$/.test(f)).length;
    if (e2eNamed > 0) e2eSignals.push(`e2e suites (${e2eNamed} files in *e2e* paths)`);
    // Rendered-UI tiers that run without a device: screenshot and Compose/SwiftUI snapshot tests.
    const buildText = ['gradle/libs.versions.toml', 'build.gradle.kts', 'Package.swift', 'project.yml'].map((f) => ctx.readText(f) ?? '').join('\n');
    // A declared library is not a test: look for sources that use it.
    const uiTestSources = allTestFiles
      .filter((f) => /\.(kt|java|swift)$/.test(f))
      .slice(0, 400)
      .filter((f) => /captureRoboImage|Paparazzi|createComposeRule|createAndroidComposeRule|RobolectricTestRunner|assertSnapshot|XCUIApplication/.test(ctx.readText(f) ?? '')).length;
    if (uiTestSources > 0) e2eSignals.push(`Rendered-UI tests (${uiTestSources} files using Compose rules, Robolectric, Roborazzi/Paparazzi or snapshot assertions)`);
    const uiLibsOnly = uiTestSources === 0 && /roborazzi|paparazzi|robolectric|ui-test-junit4|swift-snapshot-testing/i.test(buildText);
    if (ctx.hasAnyFile(['cypress.config.ts', 'cypress.config.js', 'cypress.json']) || ctx.hasDependency('cypress')) {
      e2eSignals.push('Cypress');
    }
    if (ctx.hasDependency('@cloudflare/vitest-pool-workers') || ctx.findFiles((f) => /^tests\/workers\//.test(f)).length > 0) {
      e2eSignals.push('Cloudflare Workers runtime tests');
    }
    if (ctx.hasDependency('supertest') || ctx.hasDependency('httpx')) {
      e2eSignals.push('HTTP/API contract tests');
    }
    const e2eDirs = ctx.findFiles((f) => /(^|\/)(e2e|integration)\//.test(f));
    if (e2eDirs.length > 0) {
      e2eSignals.push(`e2e/integration files (${e2eDirs.length})`);
    }
    const androidUi = ctx.findFiles((f) => /\/androidTest\//.test(f)).length;
    if (androidUi > 0) e2eSignals.push(`Android instrumented tests (${androidUi} files in androidTest/)`);
    const xcUi = ctx.findFiles((f) => /UITests\/[^/]+\.swift$/.test(f)).length;
    if (xcUi > 0) e2eSignals.push(`XCUITest UI tests (${xcUi} files)`);
    if (ctx.findFiles((f) => /^\.maestro\//.test(f)).length > 0) e2eSignals.push('Maestro flows');
    if (ctx.hasDependency('detox')) e2eSignals.push('Detox');
    if (ctx.findFiles((f) => /(^|\/)integration_test\/.+\.dart$/.test(f)).length > 0) e2eSignals.push('Flutter integration tests');

    const isMobileApp = ctx.stack.frameworks.some((fw) => ['Android', 'SwiftUI', 'Flutter', 'Expo'].includes(fw)) || ctx.stack.packageManagers.includes('xcodebuild');
    const isWebOrService =
      isMobileApp ||
      ctx.stack.frameworks.some((fw) =>
        ['Next.js', 'Astro', 'React', 'Vue', 'Nuxt', 'Svelte', 'SvelteKit', 'Express', 'Fastify', 'Hono', 'NestJS', 'FastAPI', 'Django', 'Flask', 'Rails', 'Laravel', 'Phoenix', 'Spring Boot', 'Cloudflare Workers'].includes(fw),
      );

    let status: CheckResult['status'] = 'pass';
    if (e2eSignals.length > 0) {
      status = 'pass';
    } else if (isWebOrService) {
      status = 'warn';
      e2eSignals.push(
        isMobileApp
          ? uiLibsOnly
            ? 'UI test libraries are declared in the build files, but no test source uses them'
            : 'Mobile app without a UI or end-to-end test suite (XCUITest, Espresso/androidTest, Maestro)'
          : 'Web/service stack detected without E2E or runtime contract test suite',
      );
    } else {
      status = 'info';
      e2eSignals.push('No app or service surface detected (library, CLI or tooling repo) — unit and integration tests suffice');
    }

    results.push({
      id: 'verification.e2e-tests',
      station: 'verification',
      weight: 15,
      status,
      severity: status === 'warn' ? 'medium' : 'low',
      title: {
        en: 'End-to-end & runtime contract tests',
        pl: 'Testy end-to-end i kontrakty runtime',
      },
      evidence: e2eSignals,
      why: {
        en: 'Unit tests mock away routing, auth, serialization, and runtime boundaries where agent-generated glue code breaks most often.',
        pl: 'Testy jednostkowe mockują routing, autoryzację, serializację i granice runtime — czyli dokładnie te miejsca, gdzie kod agentów psuje się najczęściej.',
      },
      fix: {
        en: isMobileApp
          ? 'Add a small must-pass UI tier for the critical flows (XCUITest, Espresso under `androidTest/`, or Maestro flows) that an agent can run headlessly.'
          : 'Add a focused must-have E2E or runtime contract tier (e.g., Playwright, Workers pool, or HTTP contract tests) covering critical user/API flows.',
        pl: isMobileApp
          ? 'Dodaj mały, obowiązkowy zestaw testów UI dla krytycznych ścieżek (XCUITest, Espresso w `androidTest/` lub scenariusze Maestro), który agent uruchomi bez nadzoru.'
          : 'Dodaj szybki zestaw krytycznych testów E2E lub kontraktowych runtime (np. Playwright, Workers pool lub testy HTTP) pokrywający kluczowe ścieżki użytkownika/API.',
      },
      docsPath: 'workflows/test/oracle-strength/',
    });
  }

  // 3. verification.oracle-protection
  {
    const evidence: string[] = [];
    const codeownersPath = ctx.hasAnyFile(['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']);
    let protectsOracle = false;

    if (codeownersPath) {
      // A rule guards the oracle when its pattern covers the tests or the CI definitions, not
      // when it merely names a file that lives under .github/.
      const patterns = (ctx.readText(codeownersPath) ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split(/\s+/)[0]!);
      const catchAll = patterns.some((p) => p === '*' || p === '/' || p === '**');
      const guardsTests = catchAll || patterns.some((p) => /^\/?(\*\*\/)?(tests?|__tests__|e2e|specs?|Tests)(\/|\/\*\*?|$)/.test(p) || /\*\.(test|spec)\./.test(p));
      // The whole workflows directory, not one workflow file.
      const guardsCi = catchAll || patterns.some((p) => /^\/?\.github(\/(\*\*?)?|\/workflows(\/(\*\*?)?)?)?$/.test(p));
      const guardsBrief = catchAll || patterns.some((p) => /^\/?(AGENTS\.md|CLAUDE\.md|\.claude(\/.*)?|\.codex(\/.*)?)$/.test(p));
      const covered = [guardsTests ? 'tests' : '', guardsCi ? 'CI workflows' : '', guardsBrief ? 'agent rules' : ''].filter(Boolean);
      evidence.push(
        covered.length > 0
          ? `${codeownersPath} covers ${covered.join(', ')}`
          : `${codeownersPath} exists but covers neither tests nor .github/workflows (${patterns.length} rule(s): ${patterns.slice(0, 3).join(', ')}${patterns.length > 3 ? ', …' : ''})`,
      );
      if (guardsTests || guardsCi) protectsOracle = true;
    }

    // Also check if .claude/settings.json denies editing tests or CI workflows
    const claudeRaw = ctx.readText('.claude/settings.json') ?? '';
    if (/"(?:Edit|Write|MultiEdit)\([^)]*(?:tests?\b|\.github|playwright|vitest|e2e)/i.test(claudeRaw)) {
      evidence.push('.claude/settings.json restricts agent edits to test/CI paths');
      protectsOracle = true;
    }

    // A CI job that fails (or flags) a change which weakens tests or edits protected paths
    const workflows = ctx.findFiles((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f));
    for (const wf of workflows) {
      const body = ctx.readText(wf) ?? '';
      if (/protected[-_ ]paths?|oracle[-_ ]guard|test[-_ ]?(files?)?[-_ ](deleted|removed|weakened|guard)|guard[-_ ]tests/i.test(body)) {
        evidence.push(`${wf} guards protected paths / test changes`);
        protectsOracle = true;
      }
    }

    const solo = ctx.isSolo;
    let status: CheckResult['status'] = 'fail';
    if (protectsOracle) {
      status = 'pass';
    } else if (codeownersPath || solo) {
      // With one contributor there is nobody for CODEOWNERS to route a review to; the gap is real
      // but smaller, and the fix is a guard rather than a second reviewer.
      status = 'warn';
    }
    if (!protectsOracle && !codeownersPath) {
      evidence.push(
        solo
          ? `${ctx.teamLabel}: no CI or harness guard stops an agent from weakening tests or editing .github/workflows to get to green`
          : 'No CODEOWNERS or CI/harness protection found for tests/, .github/workflows/, or rule files',
      );
    }

    results.push({
      id: 'verification.oracle-protection',
      station: 'verification',
      weight: 20,
      status,
      severity: status === 'fail' ? 'high' : 'medium',
      title: {
        en: 'Oracle protection (tests, CI & rules guarded)',
        pl: 'Ochrona wyroczni (testy, CI i reguły chronione przed osłabieniem)',
      },
      evidence,
      why: {
        en: 'An agent that can weaken tests, delete assertions, or edit CI workflows to go green turns your verification gate into a suggestion.',
        pl: 'Agent, który może osłabić testy, usunąć asercje lub zmienić workflow CI, aby uzyskać zielony wynik, zamienia bramkę weryfikacji w fikcję.',
      },
      fix: {
        en: solo
          ? 'Solo repo, so skip CODEOWNERS and add a guard instead: a CI step that fails when a pull request deletes test files, adds `.skip`/`.only`, or edits `.github/workflows/` without an explicit label; or deny agent edits to CI config in `.claude/settings.json` (`"deny": ["Edit(.github/workflows/**)"]`).'
          : 'Add `.github/CODEOWNERS` rules for `tests/`, `.github/workflows/`, `AGENTS.md` and the lint/type config, and require Code Owner review on the protected branch.',
        pl: solo
          ? 'Repozytorium jednoosobowe, więc zamiast CODEOWNERS dodaj bezpiecznik: krok CI, który pada, gdy pull request usuwa pliki testów, dodaje `.skip`/`.only` lub zmienia `.github/workflows/` bez jawnej etykiety; albo zablokuj agentom edycję konfiguracji CI w `.claude/settings.json` (`"deny": ["Edit(.github/workflows/**)"]`).'
          : 'Dodaj reguły `.github/CODEOWNERS` dla `tests/`, `.github/workflows/`, `AGENTS.md` oraz konfiguracji lintera/typów i wymagaj zatwierdzenia Code Owners na chronionej gałęzi.',
      },
      docsPath: 'workflows/test/protect-the-oracle/',
    });
  }

  // 4. verification.test-quality-scan
  {
    const onlyHits: string[] = [];
    const skipHits: string[] = [];
    const emptyTestHits: string[] = [];
    const tautologyHits: string[] = [];
    let tsIgnoreCount = 0;
    let eslintDisableCount = 0;
    const tsIgnoreFiles: Array<{ file: string; count: number }> = [];

    // The whole suite up to a generous bound; the evidence says so when a bound applied.
    const sampleTests = allTestFiles.slice(0, 1500);
    for (const tf of sampleTests) {
      const content = ctx.readText(tf);
      if (!content) continue;
      // Skip fixtures or test files that explicitly test our own scanner or regex literals if they mention tautology?
      // No — check line by line accurately outside comments!
      const lines = content.split(/\r?\n/);
      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx] ?? '';
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;

        // Matchers are anchored to the start of the statement: the same call quoted inside a
        // string (a fixture a test writes to disk) is data, not a test.
        if (/^(?:(?:test|describe)\.)?(?:it|test|describe|context)\.only\b/.test(trimmed) || /^f(?:it|describe)\s*\(/.test(trimmed)) {
          onlyHits.push(`${tf}:${idx + 1}`);
        }
        // A skipped test is declared with a title: `it.skip('…')`. `test.skip(isMobile, 'why')`
        // inside a test body is a runtime condition, which is how Playwright scopes a test.
        if (
          /^(?:(?:test|describe)\.)?(?:it|test|describe)\.(?:skip|todo|fixme)\s*\(\s*['"`]/.test(trimmed) ||
          /^x(?:it|test|describe)\s*\(/.test(trimmed) ||
          /@pytest\.mark\.skip\b|@unittest\.skip\b/.test(trimmed) ||
          /^@(?:Ignore|Disabled)\b/.test(trimmed) ||
          /\bt\.Skip\(\)/.test(trimmed)
        ) {
          skipHits.push(`${tf}:${idx + 1}`);
        }
        if (/^(?:it|test)\s*\([^)]+,\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*\}\s*\)/.test(trimmed)) {
          emptyTestHits.push(`${tf}:${idx + 1}`);
        }
        if (
          /^(?:await\s+)?expect\s*\(\s*(true|false|\d+|['"][^'"]*['"])\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/.test(
            trimmed,
          ) ||
          /^\s*assert\s+True\s*$/.test(line)
        ) {
          tautologyHits.push(`${tf}:${idx + 1}`);
        }
      }
    }

    const sampleSources = ctx.sourceFiles.slice(0, 5000);
    for (const sf of sampleSources) {
      const content = ctx.readText(sf);
      if (!content) continue;
      // A suppression only works as the start of a comment; the same words inside a string or a
      // regular expression (a linter's own source, a prompt) suppress nothing.
      const tsMatches = content.match(/(?:\/\/|\/\*)\s*@ts-(?:ignore|nocheck)\b/g);
      if (tsMatches) {
        tsIgnoreCount += tsMatches.length;
        tsIgnoreFiles.push({ file: sf, count: tsMatches.length });
      }
      const esMatches = content.match(/(?:\/\/|\/\*)\s*(?:eslint|oxlint|biome)-(?:disable|ignore)(?:-next-line|-line)?\b|#\s*type:\s*ignore\b|@Suppress(?:Warnings)?\(|\/\/\s*swiftlint:disable\b/g);
      if (esMatches) eslintDisableCount += esMatches.length;
    }

    const suppressionRate = sampleSources.length > 0 ? (tsIgnoreCount + eslintDisableCount) / sampleSources.length : 0;
    // Five are worth a warning anywhere; a failure needs both volume and density, so a large
    // codebase with a few dozen is not graded like a small one riddled with them.
    const tsIgnoreWarn = tsIgnoreCount >= 5;
    // Empty and constant-to-constant tests: one in a hundred test files is where it becomes a pattern.
    const placeholders = tautologyHits.length + emptyTestHits.length;
    const tsIgnoreFail = tsIgnoreCount >= 15 && tsIgnoreCount / Math.max(sampleSources.length, 1) > 0.02;

    const evidence: string[] = [];
    const nothingToTest =
      sampleTests.length === 0 && (ctx.sourceFiles.length === 0 || (ctx.sourceFiles.length < 3 && ctx.stack.languages.length === 0));
    // A test command runs, but its files could not be identified: nothing to scan, and no verdict.
    const unseenSuite = sampleTests.length === 0 && testCommands.length > 0;
    if (nothingToTest) {
      evidence.push('No source code detected — nothing to scan');
    } else if (unseenSuite) {
      evidence.push(`The files \`${testCommands[0]!.command}\` runs could not be identified, so they were not scanned`);
    } else if (sampleTests.length === 0) {
      evidence.push('No test files to scan (counted once, under verification.unit-tests)');
    } else {
      const of = (read: number, total: number): string => (read < total ? `${read} of ${total}` : String(read));
      evidence.push(`Scanned ${of(sampleTests.length, allTestFiles.length)} test file(s) and ${of(sampleSources.length, ctx.sourceFiles.length)} source file(s)`);
    }
    if (onlyHits.length > 0) evidence.push(`.only() left in tests (${onlyHits.length}): ${onlyHits.slice(0, 3).join(', ')}`);
    if (emptyTestHits.length > 0) evidence.push(`Empty test blocks (${emptyTestHits.length}): ${emptyTestHits.slice(0, 3).join(', ')}`);
    if (tautologyHits.length > 0) evidence.push(`Constant-to-constant tautology assertions (${tautologyHits.length}): ${tautologyHits.slice(0, 3).join(', ')}`);
    if (skipHits.length > 0) evidence.push(`Skipped tests (${skipHits.length}): ${skipHits.slice(0, 3).join(', ')}`);
    if (tsIgnoreCount > 0 || eslintDisableCount > 0) {
      evidence.push(`Suppressions in ${sampleSources.length} source file(s): ${tsIgnoreCount} @ts-ignore/@ts-nocheck, ${eslintDisableCount} lint/type suppressions`);
    }
    if (tsIgnoreWarn) {
      const worst = tsIgnoreFiles.sort((a, b) => b.count - a.count).slice(0, 3);
      evidence.push(`@ts-ignore/@ts-nocheck in: ${worst.map((w) => `${w.file} (${w.count})`).join(', ')}`);
    }

    let status: CheckResult['status'] = 'pass';
    if (nothingToTest || unseenSuite || sampleTests.length === 0) {
      // No suite to read: verification.unit-tests carries that finding once.
      status = 'info';
    } else if (onlyHits.length > 0 || placeholders >= Math.max(2, Math.ceil(sampleTests.length * 0.01)) || tsIgnoreFail) {
      status = 'fail';
    } else if (skipHits.length >= 5 || placeholders > 0 || suppressionRate > 0.35 || tsIgnoreWarn) {
      status = 'warn';
    } else {
      evidence.push('No .only(), empty test blocks, constant tautologies, or heavy suppression sprawl detected');
    }

    // One sentence per kind of finding, so the fix never talks about something the scan did not see.
    const qualityFix = { en: [] as string[], pl: [] as string[] };
    if (onlyHits.length > 0) {
      qualityFix.en.push('Remove the `.only()` calls listed above (they silently drop every other test from the run).');
      qualityFix.pl.push('Usuń wymienione wyżej wywołania `.only()` (po cichu wyłączają pozostałe testy).');
    }
    if (tautologyHits.length > 0 || emptyTestHits.length > 0) {
      qualityFix.en.push('Replace the empty and constant-to-constant tests with assertions on real behaviour against hand-computed values.');
      qualityFix.pl.push('Zastąp puste i tautologiczne testy asercjami realnego zachowania wobec ręcznie wyliczonych wartości.');
    }
    if (skipHits.length >= 5) {
      qualityFix.en.push('Un-skip or delete the skipped tests listed above; a skipped test that stays is a hole agents learn to dig.');
      qualityFix.pl.push('Włącz lub usuń wymienione wyżej pominięte testy; pominięty test, który zostaje, to furtka, z której agenci nauczą się korzystać.');
    }
    if (tsIgnoreWarn) {
      qualityFix.en.push('Replace `@ts-ignore` in the files listed above with proper narrowing, or with `@ts-expect-error` plus a reason so it fails once the cause is gone.');
      qualityFix.pl.push('Zastąp `@ts-ignore` w wymienionych plikach właściwym zawężaniem typów albo `@ts-expect-error` z uzasadnieniem, aby zgłaszał błąd, gdy przyczyna zniknie.');
    } else if (suppressionRate > 0.35) {
      qualityFix.en.push(`${eslintDisableCount} lint/type suppression comments in ${sampleSources.length} files: remove the ones that hide a real problem and give each one that stays a reason. A suppression only means something when the linter it silences runs.`);
      qualityFix.pl.push(`${eslintDisableCount} komentarzy wyciszających linter/typy w ${sampleSources.length} plikach: usuń te, które ukrywają realny problem, a pozostałym dodaj uzasadnienie. Wyciszenie ma sens tylko wtedy, gdy wyciszany linter faktycznie działa.`);
    }

    results.push({
      id: 'verification.test-quality-scan',
      station: 'verification',
      weight: 20,
      status,
      severity: status === 'fail' ? 'high' : status === 'warn' ? 'medium' : 'low',
      title: {
        en: 'Test oracle quality & suppression scan',
        pl: 'Jakość testów (wyroczni) i skala wyciszeń lintera/typów',
      },
      evidence,
      why: {
        en: 'Tautological assertions (`expect(true).toBe(true)`), `.only()`, skipped tests, and `@ts-ignore` sprawl create green builds that prove nothing.',
        pl: 'Tautologiczne asercje (`expect(true).toBe(true)`), `.only()`, pominięte testy i nadmiar `@ts-ignore` dają zielone buildy, które niczego nie dowodzą.',
      },
      fix: {
        en: sampleTests.length === 0
          ? 'Write the first tests (see verification.unit-tests); this scan has nothing to read until they exist.'
          : qualityFix.en.join(' ') || 'Keep it this way: no `.only()`, no title-skipped tests, no constant assertions.',
        pl: sampleTests.length === 0
          ? 'Napisz pierwsze testy (patrz verification.unit-tests); dopóki ich nie ma, ten skan nie ma czego czytać.'
          : qualityFix.pl.join(' ') || 'Utrzymaj ten stan: bez `.only()`, bez testów pomijanych po tytule, bez asercji na stałych.',
      },
      docsPath: 'workflows/test/oracle-strength/',
    });
  }

  // 5. verification.automated-pr-review
  {
    const reviewConfigs: string[] = [];
    if (ctx.hasFile('.cursor/BUGBOT.md')) reviewConfigs.push('.cursor/BUGBOT.md');
    if (ctx.hasAnyFile(['.coderabbit.yaml', '.coderabbit.yml'])) reviewConfigs.push('CodeRabbit config');
    if (ctx.hasAnyFile(['dangerfile.ts', 'dangerfile.js', '.reviewdog.yml'])) reviewConfigs.push('Danger/reviewdog');

    const workflows = ctx.findFiles((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f));
    for (const wf of workflows) {
      const content = ctx.readText(wf) ?? '';
      if (/anthropics\/claude-code-action|openai\/codex-action|coderabbit|pr-review|code-review/i.test(content)) {
        reviewConfigs.push(`${wf}`);
      }
    }

    const status: CheckResult['status'] = reviewConfigs.length > 0 ? 'pass' : 'warn';

    results.push({
      id: 'verification.automated-pr-review',
      station: 'verification',
      weight: 10,
      status,
      severity: 'low',
      title: {
        en: 'Automated PR review & second-opinion layer',
        pl: 'Automatyczny przegląd PR i druga opinia',
      },
      evidence:
        reviewConfigs.length > 0
          ? reviewConfigs
          : ['No automated PR review config found (.cursor/BUGBOT.md, .coderabbit.yaml, or Claude/Codex review workflow)'],
      why: {
        en: 'Automated PR review catches cross-file bugs, security mistakes, and missing edge cases before a human reviewer spends attention on the queue.',
        pl: 'Automatyczny przegląd PR wyłapuje błędy między plikami, luki bezpieczeństwa i brakujące przypadki brzegowe, zanim człowiek poświęci czas na kolejkę review.',
      },
      fix: {
        en: 'Configure an advisory PR review pass (`.cursor/BUGBOT.md`, `.coderabbit.yaml`, or `claude-code-action`/`codex-action`) — always paired with deterministic CI gates.',
        pl: 'Skonfiguruj doradczą warstwę review PR (`.cursor/BUGBOT.md`, `.coderabbit.yaml` lub `claude-code-action`/`codex-action`) — zawsze obok deterministycznych bramek CI.',
      },
      docsPath: 'workflows/ship/agent-pr-review/',
    });
  }

  // 6. verification.fitness-functions
  {
    const fitnessSignals: string[] = [];
    if (ctx.hasAnyFile(['lighthouserc.json', 'lighthouserc.js', '.lighthouserc.json'])) fitnessSignals.push('Lighthouse CI');
    if (ctx.hasAnyFile(['.dependency-cruiser.js', '.dependency-cruiser.cjs', '.dependency-cruiser.mjs'])) fitnessSignals.push('dependency-cruiser');
    if (ctx.hasAnyFile(['stryker.config.mjs', 'stryker.config.json', 'stryker.conf.json'])) fitnessSignals.push('Stryker mutation testing');
    if (ctx.hasAnyFile(['.size-limit.json', '.size-limit.cjs']) || ctx.hasDependency('size-limit')) fitnessSignals.push('size-limit bundle budget');

    const pkg = ctx.packageJson;
    if (pkg?.scripts) {
      for (const [k, v] of Object.entries(pkg.scripts)) {
        if (
          /(^|[:._-])(audit|seo|budget|links|size|architecture|arch|a11y|deps|boundaries|knip|deadcode)($|[:._-])/i.test(k) ||
          /\b(seo-audit|check-links|size-limit|depcruise|knip|madge|lhci|pa11y|linkinator|lychee|ts-prune|bundlesize)\b/i.test(v)
        ) {
          fitnessSignals.push(`script: ${k}`);
        }
        // A repository's own invariant checks: `check:design`, or a lint script that runs scripts/check-*.mjs.
        const ownChecks = v.match(/\bscripts\/check-[\w.-]+/g);
        if (ownChecks) fitnessSignals.push(`invariant checks in \`${k}\`: ${[...new Set(ownChecks)].slice(0, 3).join(', ')}`);
        // `check:design`, `lint:design`, `verify:deps`: a named check that runs the repository's own program.
        else if (/^(check|lint|verify|guard|validate):(?!types?$|ts$|fix$)[\w-]+$/.test(k) && /\b(node|bun|tsx|deno|python3?)\s+\S*scripts?\//.test(v)) {
          fitnessSignals.push(`invariant check: \`${k}\``);
        } else if (/^check:(?!types?$|ts$)[\w-]+$/.test(k)) fitnessSignals.push(`script: ${k}`);
      }
    }
    if (ctx.hasAnyFile(['knip.json', 'knip.jsonc', 'knip.ts', '.knip.json'])) fitnessSignals.push('Knip (unused code and dependencies)');
    if (ctx.hasFile('.periphery.yml')) fitnessSignals.push('Periphery (unused Swift code)');
    const gradleCatalog = `${ctx.readText('gradle/libs.versions.toml') ?? ''}\n${ctx.readText('build.gradle.kts') ?? ''}`;
    if (/kover|jacoco/i.test(gradleCatalog)) fitnessSignals.push('JVM coverage tooling (Kover/JaCoCo)');
    if (/dependency-?guard|dependencyAnalysis/i.test(gradleCatalog)) fitnessSignals.push('Gradle dependency guard');

    // Coverage thresholds in vitest/jest/pyproject
    const testConfigs = ['vitest.config.ts', 'vite.config.ts', 'jest.config.ts', 'jest.config.js', 'pyproject.toml'];
    for (const tc of testConfigs) {
      const content = ctx.readText(tc);
      if (content && /thresholds|coverageThreshold|--cov-fail-under/i.test(content)) {
        fitnessSignals.push(`coverage threshold in ${tc}`);
      }
    }

    const status: CheckResult['status'] = fitnessSignals.length > 0 ? 'pass' : 'warn';

    results.push({
      id: 'verification.fitness-functions',
      station: 'verification',
      weight: 10,
      status,
      severity: 'low',
      title: {
        en: 'Automated fitness functions & quality budgets',
        pl: 'Automatyczne funkcje dopasowania (fitness functions) i budżety jakości',
      },
      evidence:
        fitnessSignals.length > 0
          ? [...new Set(fitnessSignals)].slice(0, 6)
          : ['No architectural, bundle, coverage, SEO, or mutation-testing fitness functions detected'],
      why: {
        en: 'Fitness functions turn architectural invariants (bundle budgets, dependency directions, SEO/a11y rules, mutation scores) into executable checks agents cannot drift past.',
        pl: 'Funkcje dopasowania zamieniają niezmienniki architektury (budżet paczki, kierunek zależności, reguły SEO/a11y, testy mutacyjne) w wykonywalne bramki.',
      },
      fix: {
        en: 'Add at least one automated fitness check matching your biggest regression risk (dependency boundaries, bundle budget, Lighthouse/SEO audit, or coverage/mutation gate).',
        pl: 'Dodaj co najmniej jedną automatyczną funkcję dopasowania dla największego ryzyka regresji (granice zależności, budżet bundle, audyt Lighthouse/SEO lub bramkę pokrycia/mutacji).',
      },
      docsPath: 'workflows/test/fitness-functions/',
    });
  }

  return results;
}
