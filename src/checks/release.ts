import type { RepoContext } from '../fs-scanner.js';
import type { CheckResult } from '../types.js';

export function runReleaseChecks(ctx: RepoContext): CheckResult[] {
  const results: CheckResult[] = [];

  const ghWorkflows = ctx.findFiles((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f));
  const otherCi = [
    '.gitlab-ci.yml',
    '.circleci/config.yml',
    'azure-pipelines.yml',
    '.buildkite/pipeline.yml',
    'Jenkinsfile',
  ].filter((f) => ctx.hasFile(f));
  const allCiFiles = [...ghWorkflows, ...otherCi];

  // 1. release.ci-pipeline
  {
    let runsOnPr = false;
    let runsTests = false;
    let runsLint = false;
    let runsTypecheck = false;

    for (const wf of allCiFiles) {
      const content = ctx.readText(wf) ?? '';
      if (/\bpull_request\b|\bmerge_request\b/i.test(content)) runsOnPr = true;
      if (/\b(test|pytest|vitest|jest|playwright|cargo test|go test|rspec|phpunit|dotnet test|vp test)\b/i.test(content)) {
        runsTests = true;
      }
      if (/\b(lint|eslint|oxlint|biome|ruff|clippy|golangci-lint|rubocop|check)\b/i.test(content)) {
        runsLint = true;
      }
      if (/\b(typecheck|type-check|tsc|mypy|pyright|astro check|cargo check|go vet|go build)\b/i.test(content)) {
        runsTypecheck = true;
      }
    }

    const evidence: string[] = [];
    if (allCiFiles.length === 0) {
      evidence.push('No CI pipeline found (.github/workflows/*.yml, .gitlab-ci.yml, .circleci/config.yml, etc.)');
    } else {
      evidence.push(`CI workflows: ${allCiFiles.slice(0, 5).join(', ')}`);
      evidence.push(
        `PR trigger: ${runsOnPr ? 'yes' : 'no'} · tests: ${runsTests ? 'yes' : 'no'} · lint: ${runsLint ? 'yes' : 'no'} · typecheck: ${runsTypecheck ? 'yes' : 'no'}`,
      );
    }

    let status: CheckResult['status'] = 'fail';
    if (allCiFiles.length > 0 && runsOnPr && runsTests && (runsLint || runsTypecheck)) {
      status = 'pass';
    } else if (allCiFiles.length > 0 && (runsTests || runsLint || runsTypecheck)) {
      status = 'warn';
    }

    results.push({
      id: 'release.ci-pipeline',
      station: 'release',
      weight: 35,
      status,
      severity: status === 'fail' ? 'critical' : status === 'warn' ? 'high' : 'low',
      title: {
        en: 'CI verification pipeline on pull requests',
        pl: 'Potok CI weryfikujący pull requesty',
      },
      evidence,
      why: {
        en: 'Agents will confidently report that a change works; independent CI running lint, typecheck, and tests on every pull request is what actually decides.',
        pl: 'Agenci często pewnie zgłaszają, że zmiana działa — to niezależny potok CI uruchamiający lint, typecheck i testy na każdym PR realnie decyduje.',
      },
      fix: {
        en: 'Add a CI workflow triggered on `pull_request` that installs from the lockfile and runs lint, typecheck, and tests before merge.',
        pl: 'Dodaj workflow CI wyzwalany na `pull_request`, który instaluje zależności z lockfile’a i uruchamia lint, typecheck oraz testy przed scaleniem.',
      },
      docsPath: 'workflows/ship/ci-cd-pipelines/',
    });
  }

  // 2. release.evidence-pr-template
  {
    const templatePath =
      ctx.hasAnyFile([
        '.github/pull_request_template.md',
        '.github/PULL_REQUEST_TEMPLATE.md',
        'docs/pull_request_template.md',
      ]) ??
      ctx.findFiles((f) => /^\.github\/PULL_REQUEST_TEMPLATE\/.+\.md$/i.test(f))[0] ??
      ctx.findFiles((f) => /^\.gitlab\/merge_request_templates\/.+\.md$/i.test(f))[0];

    const evidence: string[] = [];
    let status: CheckResult['status'] = 'fail';

    if (templatePath) {
      const content = ctx.readText(templatePath) ?? '';
      const hasChecklist = /-\s*\[\s*\]/.test(content);
      const hasEvidenceTerms = /\b(test|verif|evidence|screenshot|risk|rollback|migration|command|output)\b/i.test(content);
      evidence.push(`${templatePath} found`);
      if (hasChecklist) evidence.push('Includes verification checklist');
      if (hasEvidenceTerms) evidence.push('Prompts for verification evidence / risk notes');

      status = hasChecklist && hasEvidenceTerms ? 'pass' : 'warn';
    } else {
      evidence.push('No pull request / merge request template found');
    }

    results.push({
      id: 'release.evidence-pr-template',
      station: 'release',
      weight: 20,
      status,
      severity: status === 'fail' ? 'medium' : 'low',
      title: {
        en: 'Evidence-oriented pull request template',
        pl: 'Szablon PR z sekcją dowodów weryfikacji',
      },
      evidence,
      why: {
        en: 'At Level 3–4, reviewers stop reading every mechanical line and review the evidence bundle instead: commands run, test output, risk class, and rollback path.',
        pl: 'Na Poziomie 3–4 recenzenci przestają czytać każdą mechaniczną linię i oceniają pakiet dowodów: uruchomione komendy, wynik testów, klasę ryzyka i plan wycofania.',
      },
      fix: {
        en: 'Add `.github/pull_request_template.md` requiring: summary, exact verification commands + results, risk/escalation paths touched (auth/money/migrations/tests/CI), and rollback notes.',
        pl: 'Dodaj `.github/pull_request_template.md` wymagający: podsumowania, dokładnych komend weryfikacji z wynikami, listy wrażliwych ścieżek (auth/płatności/migracje/testy/CI) i planu wycofania.',
      },
      docsPath: 'workflows/ship/evidence-bundle/',
    });
  }

  // 3. release.dependency-automation
  {
    const depConfigs = [
      'renovate.json',
      'renovate.json5',
      '.renovaterc',
      '.renovaterc.json',
      '.github/renovate.json',
      '.github/dependabot.yml',
      '.github/dependabot.yaml',
    ].filter((f) => ctx.hasFile(f));

    const status: CheckResult['status'] = depConfigs.length > 0 ? 'pass' : 'warn';

    results.push({
      id: 'release.dependency-automation',
      station: 'release',
      weight: 15,
      status,
      severity: 'low',
      title: {
        en: 'Automated dependency update loop',
        pl: 'Zautomatyzowana pętla aktualizacji zależności',
      },
      evidence:
        depConfigs.length > 0
          ? [`Configured: ${depConfigs.join(', ')}`]
          : ['No Renovate or Dependabot configuration found'],
      why: {
        en: 'Patch and minor dependency updates are the safest first candidate for a Level 4–5 automated loop because your CI suite already serves as their oracle.',
        pl: 'Aktualizacje patch i minor zależności to najbezpieczniejszy pierwszy kandydat na pętlę Poziomu 4–5, bo zestaw CI jest już dla nich gotową wyrocznią.',
      },
      fix: {
        en: 'Add `renovate.json` or `.github/dependabot.yml` with grouped patch/minor PRs validated by required CI checks.',
        pl: 'Dodaj `renovate.json` lub `.github/dependabot.yml` grupujący aktualizacje patch/minor weryfikowane przez wymagane testy CI.',
      },
      docsPath: 'workflows/test/dependency-verification/',
    });
  }

  // 4. release.observability-and-safety
  {
    const signals: string[] = [];
    const depsToCheck: Array<[string, string]> = [
      ['@sentry/node', 'Sentry'],
      ['@sentry/nextjs', 'Sentry'],
      ['@sentry/browser', 'Sentry'],
      ['@sentry/cloudflare', 'Sentry'],
      ['@opentelemetry/api', 'OpenTelemetry'],
      ['posthog-js', 'PostHog'],
      ['posthog-node', 'PostHog'],
      ['pino', 'Pino structured logging'],
      ['winston', 'Winston structured logging'],
      ['drizzle-orm', 'Drizzle migrations'],
      ['prisma', 'Prisma migrations'],
    ];
    for (const [dep, label] of depsToCheck) {
      if (ctx.hasDependency(dep) && !signals.includes(label)) signals.push(label);
    }

    const pyproject = ctx.readText('pyproject.toml') ?? '';
    if (/sentry-sdk/i.test(pyproject)) signals.push('Sentry');
    if (/opentelemetry/i.test(pyproject)) signals.push('OpenTelemetry');
    if (/structlog/i.test(pyproject)) signals.push('structlog');
    if (/alembic/i.test(pyproject)) signals.push('Alembic migrations');

    if (ctx.findFiles((f) => /(^|\/)migrations\//.test(f)).length > 0) {
      signals.push('Versioned migrations directory');
    }
    if (ctx.findFiles((f) => /(^|\/)health(\.[a-z]+)?$/.test(f)).length > 0) {
      signals.push('Healthcheck endpoint');
    }
    if (ctx.hasAnyFile(['CHANGELOG.md', 'CHANGES.md'])) {
      signals.push('CHANGELOG.md');
    }

    const isApp = ctx.stack.frameworks.length > 0 || ctx.hasFile('wrangler.toml') || ctx.hasFile('Dockerfile');
    let status: CheckResult['status'] = 'pass';
    if (signals.length >= 2) {
      status = 'pass';
    } else if (signals.length === 1) {
      status = isApp ? 'pass' : 'pass';
    } else if (isApp) {
      status = 'warn';
      signals.push('No error tracking (Sentry/OTel/PostHog), structured logging, healthcheck, or migration discipline detected');
    } else {
      status = 'info';
      signals.push('No runtime telemetry detected (typically optional for small libraries/CLIs)');
    }

    results.push({
      id: 'release.observability-and-safety',
      station: 'release',
      weight: 15,
      status,
      severity: status === 'warn' ? 'medium' : 'low',
      title: {
        en: 'Runtime observability & migration discipline',
        pl: 'Obserwowalność runtime i dyscyplina migracji',
      },
      evidence: signals,
      why: {
        en: 'Faster agent shipping without telemetry and reversible migrations increases blast radius when a subtle bug passes CI.',
        pl: 'Szybsze wydawanie kodu przez agentów bez telemetrii i odwracalnych migracji zwiększa pole rażenia błędów, które prześlizgną się przez CI.',
      },
      fix: {
        en: 'Wire error tracking/telemetry (Sentry, OpenTelemetry, or structured logs), a healthcheck endpoint, and versioned database migrations with rollback notes.',
        pl: 'Podepnij śledzenie błędów/telemetrię (Sentry, OpenTelemetry lub logi strukturalne), endpoint healthcheck oraz wersjonowane migracje bazy z opisem wycofania.',
      },
      docsPath: 'workflows/ship/progressive-delivery/',
    });
  }

  // 5. release.deploy-safety
  {
    const evidence: string[] = [];
    let hasDeployWorkflow = false;
    let hasDeployGate = false;

    for (const wf of allCiFiles) {
      const content = ctx.readText(wf) ?? '';
      if (/\b(deploy|publish|release)\b/i.test(wf) || /\b(wrangler deploy|vercel|flyctl|kubectl|terraform apply|npm publish|gh release)\b/i.test(content)) {
        hasDeployWorkflow = true;
        if (/\bneeds\s*:|environment\s*:|workflow_dispatch|if:\s*github\.ref\s*==/i.test(content)) {
          hasDeployGate = true;
          evidence.push(`${wf}: gated deploy/release workflow (uses needs/environment/branch condition)`);
        } else {
          evidence.push(`${wf}: deploy workflow detected without explicit job dependency (` + '`needs:`' + `) or environment gate`);
        }
      }
    }

    const claudeDeny = ctx.readJson<{ permissions?: { deny?: string[] } }>('.claude/settings.json')?.permissions?.deny ?? [];
    const blocksLocalDeploy = claudeDeny.some((d) => /deploy|publish|prod|remote/i.test(d));
    if (blocksLocalDeploy) {
      evidence.push('.claude/settings.json denies local agent deploy/production commands');
    }

    let status: CheckResult['status'] = 'info';
    if (hasDeployGate || blocksLocalDeploy) {
      status = 'pass';
    } else if (hasDeployWorkflow) {
      status = 'warn';
    } else {
      status = 'info';
      evidence.push('No automated deploy workflow detected in repo CI configs');
    }

    results.push({
      id: 'release.deploy-safety',
      station: 'release',
      weight: 15,
      status,
      severity: status === 'warn' ? 'medium' : 'low',
      title: {
        en: 'Gated deploys & local-deploy guardrails',
        pl: 'Bramkowane wdrożenia i blokada lokalnego deployu',
      },
      evidence,
      why: {
        en: 'Deploys should flow strictly through gated CI after verification passes — never from an agent running `deploy` directly from a laptop checkout.',
        pl: 'Wdrożenia powinny przechodzić wyłącznie przez bramkowane CI po zielonych testach — nigdy przez agenta uruchamiającego `deploy` bezpośrednio z lokalnego repozytorium.',
      },
      fix: {
        en: 'Gate CI deploy jobs behind verification jobs (`needs: [test, lint, typecheck]`) and add local deploy commands to `.claude/settings.json` `permissions.deny`.',
        pl: 'Uzależnij zadania deploy w CI od zielonej weryfikacji (`needs: [test, lint, typecheck]`) i dodaj lokalne komendy deploy do `permissions.deny` w `.claude/settings.json`.',
      },
      docsPath: 'workflows/ship/progressive-delivery/',
    });
  }

  return results;
}
