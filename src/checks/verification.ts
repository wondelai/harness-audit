import type { RepoContext } from '../fs-scanner.js';
import type { CheckResult } from '../types.js';

export function runVerificationChecks(ctx: RepoContext): CheckResult[] {
  const results: CheckResult[] = [];

  // 1. verification.unit-tests
  {
    const testCount = ctx.testFiles.length;
    const srcCount = ctx.sourceFiles.length;
    const ratio = srcCount > 0 ? testCount / srcCount : testCount > 0 ? 1 : 0;

    const evidence: string[] = [
      `Detected ${testCount} test file(s) vs ${srcCount} source file(s) (ratio: ${srcCount > 0 ? (ratio * 100).toFixed(1) + '%' : 'n/a'})`,
    ];
    if (testCount > 0) {
      evidence.push(`Sample: ${ctx.testFiles.slice(0, 4).join(', ')}`);
    }

    let status: CheckResult['status'] = 'fail';
    if (testCount >= 3 && (ratio >= 0.12 || testCount >= 15)) {
      status = 'pass';
    } else if (testCount >= 1) {
      status = srcCount <= 10 && testCount >= 2 ? 'pass' : 'warn';
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
      docsPath: 'workflows/test/unit-testing/',
    });
  }

  // 2. verification.e2e-tests
  {
    const e2eSignals: string[] = [];
    if (ctx.hasAnyFile(['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs']) || ctx.hasDependency('@playwright/test')) {
      e2eSignals.push('Playwright');
    }
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

    const isWebOrService =
      ctx.stack.frameworks.some((fw) =>
        ['Next.js', 'Astro', 'React', 'Vue', 'Nuxt', 'Svelte', 'SvelteKit', 'Express', 'Fastify', 'Hono', 'NestJS', 'FastAPI', 'Django', 'Flask', 'Rails', 'Laravel', 'Cloudflare Workers'].includes(fw),
      );

    let status: CheckResult['status'] = 'pass';
    if (e2eSignals.length > 0) {
      status = 'pass';
    } else if (isWebOrService) {
      status = 'warn';
      e2eSignals.push('Web/service stack detected without E2E or runtime contract test suite');
    } else {
      status = 'info';
      e2eSignals.push('No separate browser E2E suite (library/CLI repo — CLI/integration tests suffice)');
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
        en: 'Add a focused must-have E2E or runtime contract tier (e.g., Playwright, Workers pool, or HTTP contract tests) covering critical user/API flows.',
        pl: 'Dodaj szybki zestaw krytycznych testów E2E lub kontraktowych runtime (np. Playwright, Workers pool lub testy HTTP) pokrywający kluczowe ścieżki użytkownika/API.',
      },
      docsPath: 'workflows/test/e2e-testing/',
    });
  }

  // 3. verification.oracle-protection
  {
    const evidence: string[] = [];
    const codeownersPath = ctx.hasAnyFile(['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']);
    let protectsOracle = false;

    if (codeownersPath) {
      const content = ctx.readText(codeownersPath) ?? '';
      const guardsTests = /(^|\s)\/?(tests?|__tests__|e2e|spec)\b/m.test(content);
      const guardsCi = /(^|\s)\/?\.github\b/m.test(content);
      const guardsBrief = /(^|\s)\/?(AGENTS\.md|CLAUDE\.md|\.claude|\.codex)/m.test(content);
      evidence.push(
        `${codeownersPath} present (guards: ${[guardsTests ? 'tests' : '', guardsCi ? '.github' : '', guardsBrief ? 'agent rules' : ''].filter(Boolean).join(', ') || 'general paths'})`,
      );
      if (guardsTests || guardsCi) protectsOracle = true;
    }

    // Also check if .claude/settings.json denies editing tests or CI workflows
    const claudeRaw = ctx.readText('.claude/settings.json') ?? '';
    if (/"(?:Edit|Write)\([^)]*(?:tests|\.github|playwright|vitest)/i.test(claudeRaw)) {
      evidence.push('.claude/settings.json restricts agent edits to test/CI paths');
      protectsOracle = true;
    }

    // Check CI workflows for oracle / protected-path guard
    const workflows = ctx.findFiles((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f));
    for (const wf of workflows) {
      const body = ctx.readText(wf) ?? '';
      if (/protected.*path|oracle|CODEOWNERS|test.*modified/i.test(body)) {
        evidence.push(`${wf} includes protected-path / oracle guard`);
        protectsOracle = true;
      }
    }

    let status: CheckResult['status'] = 'fail';
    if (protectsOracle) {
      status = 'pass';
    } else if (codeownersPath) {
      status = 'warn';
    } else {
      evidence.push('No CODEOWNERS or CI/harness protection found for tests/, .github/workflows/, or rule files');
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
        en: 'Add `.github/CODEOWNERS` protecting `tests/`, `.github/`, `AGENTS.md`, and linter/tsconfig files, and require Code Owner review on protected branches.',
        pl: 'Dodaj `.github/CODEOWNERS` chroniący `tests/`, `.github/`, `AGENTS.md` oraz konfigurację lintera/TS i wymagaj zatwierdzenia Code Owners na chronionych gałęziach.',
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

    // Scan up to 150 test files for test anti-patterns
    const sampleTests = ctx.testFiles.slice(0, 150);
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

        if (/\b(?:it|test|describe|context)\.only\s*\(/.test(trimmed) || /\bf(?:it|describe)\s*\(/.test(trimmed)) {
          onlyHits.push(`${tf}:${idx + 1}`);
        }
        if (
          /\b(?:it|test|describe)\.skip\s*\(/.test(trimmed) ||
          /\bx(?:it|test|describe)\s*\(/.test(trimmed) ||
          /@pytest\.mark\.skip\b/.test(trimmed)
        ) {
          skipHits.push(`${tf}:${idx + 1}`);
        }
        if (/\b(?:it|test)\s*\([^)]+,\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*\}\s*\)/.test(trimmed)) {
          emptyTestHits.push(`${tf}:${idx + 1}`);
        }
        if (
          /\bexpect\s*\(\s*(true|false|\d+|['"][^'"]*['"])\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/.test(
            trimmed,
          ) ||
          /^\s*assert\s+True\s*$/.test(line)
        ) {
          tautologyHits.push(`${tf}:${idx + 1}`);
        }
      }
    }

    // Scan up to 250 source files for suppression sprawl
    const sampleSources = ctx.sourceFiles.slice(0, 250);
    for (const sf of sampleSources) {
      const content = ctx.readText(sf);
      if (!content) continue;
      const tsMatches = content.match(/@ts-(?:ignore|nocheck)\b/g);
      if (tsMatches) tsIgnoreCount += tsMatches.length;
      const esMatches = content.match(/\beslint-disable(?:-next-line|-line)?\b|#\s*type:\s*ignore\b/g);
      if (esMatches) eslintDisableCount += esMatches.length;
    }

    const evidence: string[] = [];
    if (sampleTests.length === 0) {
      evidence.push('No test files to scan');
    } else {
      evidence.push(`Scanned ${sampleTests.length} test file(s) and ${sampleSources.length} source file(s)`);
    }
    if (onlyHits.length > 0) evidence.push(`.only() left in tests (${onlyHits.length}): ${onlyHits.slice(0, 3).join(', ')}`);
    if (emptyTestHits.length > 0) evidence.push(`Empty test blocks (${emptyTestHits.length}): ${emptyTestHits.slice(0, 3).join(', ')}`);
    if (tautologyHits.length > 0) evidence.push(`Constant-to-constant tautology assertions (${tautologyHits.length}): ${tautologyHits.slice(0, 3).join(', ')}`);
    if (skipHits.length > 0) evidence.push(`Skipped tests (${skipHits.length}): ${skipHits.slice(0, 3).join(', ')}`);
    if (tsIgnoreCount > 0 || eslintDisableCount > 0) {
      evidence.push(`Suppressions in source: ${tsIgnoreCount} @ts-ignore/@ts-nocheck, ${eslintDisableCount} eslint-disable/type:ignore`);
    }

    const suppressionRate = sampleSources.length > 0 ? (tsIgnoreCount + eslintDisableCount) / sampleSources.length : 0;
    let status: CheckResult['status'] = 'pass';
    if (sampleTests.length === 0) {
      status = 'fail';
    } else if (onlyHits.length > 0 || tautologyHits.length > 0 || emptyTestHits.length >= 2 || tsIgnoreCount >= 15) {
      status = 'fail';
    } else if (skipHits.length >= 5 || emptyTestHits.length > 0 || suppressionRate > 0.35 || tsIgnoreCount >= 5) {
      status = 'warn';
    } else {
      evidence.push('No .only(), empty test blocks, constant tautologies, or heavy suppression sprawl detected');
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
        en: 'Remove `.only()`, delete or replace tautological/empty tests with behavioral assertions against hand-computed expected values, and replace `@ts-ignore` with proper narrowing or `@ts-expect-error` with rationale.',
        pl: 'Usuń `.only()`, zastąp puste i tautologiczne testy asercjami zachowania wobec ręcznie wyliczonych oczekiwań oraz zamień `@ts-ignore` na właściwe typowanie.',
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
        if (/(audit|seo|budget|check:links|check:size|architecture|arch)/i.test(k) || /seo-audit|check-links|size-limit|depcruise/i.test(v)) {
          fitnessSignals.push(`script: ${k}`);
        }
      }
    }

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
