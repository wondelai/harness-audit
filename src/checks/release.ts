import type { RepoContext } from '../fs-scanner.js';
import type { CheckResult } from '../types.js';

export function runReleaseChecks(ctx: RepoContext): CheckResult[] {
  const results: CheckResult[] = [];

  const ci = ctx.ci;
  const allCiFiles = ci.files;
  const solo = ctx.isSolo;

  // 1. release.ci-pipeline
  {
    const prWorkflows = ci.workflows.filter((w) => w.onPullRequest);
    const runsOnPr = prWorkflows.length > 0;
    const gates = (kind: 'test' | 'lint' | 'typecheck'): boolean => ci.prKinds.has(kind);
    const anywhere = (kind: 'test' | 'lint' | 'typecheck'): boolean => ci.workflows.some((w) => w.kinds.has(kind));
    const mark = (kind: 'test' | 'lint' | 'typecheck'): string => (gates(kind) ? 'yes' : anywhere(kind) ? 'not on PRs' : 'no');

    const evidence: string[] = [];
    if (allCiFiles.length === 0) {
      evidence.push('No CI pipeline found (.github/workflows/*.yml, .gitlab-ci.yml, .circleci/config.yml, etc.)');
    } else {
      evidence.push(`CI workflows (${allCiFiles.length}): ${allCiFiles.slice(0, 5).join(', ')}${allCiFiles.length > 5 ? ', …' : ''}`);
      evidence.push(`Pull requests are gated on — tests: ${mark('test')} · lint: ${mark('lint')} · typecheck: ${mark('typecheck')}`);
      // The commands that provide the gate, so the reading can be checked at a glance.
      const shown = new Set<string>();
      for (const kind of ['test', 'lint', 'typecheck'] as const) {
        const hit = ci.prCommands.find((c) => c.kinds.includes(kind));
        if (hit && !shown.has(hit.command)) {
          shown.add(hit.command);
          const cmd = hit.command.length > 110 ? `${hit.command.slice(0, 110)}…` : hit.command;
          evidence.push(`${hit.path}: \`${cmd}\` → ${hit.kinds.join(' + ')}`);
        }
      }
    }

    let status: CheckResult['status'] = 'fail';
    if (runsOnPr && gates('test') && (gates('lint') || gates('typecheck'))) {
      status = 'pass';
    } else if (allCiFiles.length > 0 && (anywhere('test') || anywhere('lint') || anywhere('typecheck'))) {
      status = 'warn';
    }

    const verify = ctx.verify;
    const gateCommand = verify.unified?.command ?? verify.commands.filter((c) => c.kinds.includes('test') || c.kinds.includes('lint') || c.kinds.includes('typecheck')).slice(0, 3).map((c) => c.command).join('`, `');
    const missingOnPr = (['test', 'lint', 'typecheck'] as const).filter((k) => !gates(k));

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
        en: 'Agents will confidently report that a change works; independent CI running static checks and tests on every pull request is what actually decides.',
        pl: 'Agenci często pewnie zgłaszają, że zmiana działa — to niezależny potok CI uruchamiający sprawdzenia statyczne i testy na każdym PR realnie decyduje.',
      },
      fix: {
        en:
          allCiFiles.length === 0
            ? `Add a CI workflow triggered on \`pull_request\` that installs from the lockfile and runs ${gateCommand ? `\`${gateCommand}\`` : 'your lint, typecheck and test commands'} before merge.`
            : `Run ${missingOnPr.join(' and ')} on \`pull_request\`${gateCommand ? ` (e.g. \`${gateCommand}\`)` : ''} so a red result blocks the merge, not just the main branch.`,
        pl:
          allCiFiles.length === 0
            ? `Dodaj workflow CI wyzwalany na \`pull_request\`, który instaluje zależności z lockfile’a i uruchamia ${gateCommand ? `\`${gateCommand}\`` : 'lint, typecheck oraz testy'} przed scaleniem.`
            : `Uruchamiaj na \`pull_request\` brakujące kroki (${missingOnPr.join(', ')})${gateCommand ? `, np. \`${gateCommand}\`` : ''}, aby czerwony wynik blokował scalenie, a nie tylko gałąź główną.`,
      },
      docsPath: 'method/lifecycle/deploy/',
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
      if (!hasChecklist) evidence.push('No checklist items (`- [ ]`) for the author or agent to tick');
      if (!hasEvidenceTerms) evidence.push('Does not ask for verification commands, results, risk or rollback notes');
    } else {
      // Nobody else reads a solo repo's pull requests, so the missing template is a gap, not a failure.
      status = solo ? 'warn' : 'fail';
      evidence.push(
        solo
          ? 'No pull request template (one active contributor: agent-written PRs have no fixed evidence format to fill in)'
          : 'No pull request / merge request template found',
      );
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
        en: templatePath
          ? `Extend ${templatePath} with what is missing above: a "Verification" section asking for the exact commands run and their results, and a checklist for risky paths touched (auth, money, migrations, tests, CI) with rollback notes.`
          : 'Add `.github/pull_request_template.md` requiring: summary, exact verification commands + results, risk/escalation paths touched (auth/money/migrations/tests/CI), and rollback notes. `npx harness-audit init` writes one.',
        pl: templatePath
          ? `Uzupełnij ${templatePath} o brakujące elementy: sekcję „Weryfikacja” z dokładnymi komendami i ich wynikami oraz checklistę wrażliwych ścieżek (auth, płatności, migracje, testy, CI) z planem wycofania.`
          : 'Dodaj `.github/pull_request_template.md` wymagający: podsumowania, dokładnych komend weryfikacji z wynikami, listy wrażliwych ścieżek (auth/płatności/migracje/testy/CI) i planu wycofania. `npx harness-audit init` utworzy taki plik.',
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

    // Manifests of the non-Node stacks, where telemetry is a line in a build file.
    const manifestText = ctx
      .findFiles(
        (f) =>
          f.split('/').length <= 3 &&
          /(^|\/)(pyproject\.toml|requirements[\w.-]*\.txt|Package\.swift|project\.yml|Podfile|build\.gradle(\.kts)?|libs\.versions\.toml|pubspec\.yaml|go\.mod|Cargo\.toml|Gemfile|composer\.json|mix\.exs)$/.test(f),
      )
      .slice(0, 20)
      .map((f) => ctx.readText(f) ?? '')
      .join('\n');
    const manifestSignals: Array<[RegExp, string]> = [
      [/sentry/i, 'Sentry'],
      [/opentelemetry|otel/i, 'OpenTelemetry'],
      [/posthog/i, 'PostHog'],
      [/crashlytics/i, 'Firebase Crashlytics'],
      [/datadog|bugsnag|honeybadger|rollbar/i, 'Error tracking SDK'],
      [/structlog|zerolog|\bzap\b|slog/i, 'Structured logging'],
      [/alembic/i, 'Alembic migrations'],
    ];
    for (const [pattern, label] of manifestSignals) {
      if (pattern.test(manifestText) && !signals.includes(label)) signals.push(label);
    }

    if (ctx.findFiles((f) => /(^|\/)migrations\//.test(f)).length > 0) {
      signals.push('Versioned migrations directory');
    }
    if (ctx.findFiles((f) => /(^|\/)health(\.[a-z]+)?$/.test(f)).length > 0) {
      signals.push('Healthcheck endpoint');
    }
    if (ctx.hasAnyFile(['CHANGELOG.md', 'CHANGES.md'])) {
      signals.push('CHANGELOG.md');
    }

    const isApp =
      ctx.stack.frameworks.length > 0 ||
      ctx.stack.packageManagers.includes('xcodebuild') ||
      ctx.hasFile('wrangler.toml') ||
      ctx.hasFile('Dockerfile');
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
      signals.push('No runtime telemetry detected (optional for a library, CLI or tooling repo)');
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
      docsPath: 'workflows/operate/codebase-health/',
    });
  }

  // 5. release.deploy-safety
  {
    const evidence: string[] = [];
    // A deploy is a command that ships; `wrangler deploy --dry-run` in a verify job is a build check.
    const deployWorkflows = ci.workflows.filter((w) => w.deployCommands.length > 0);
    const gated = deployWorkflows.filter((w) => w.deployGated);
    const ungated = deployWorkflows.filter((w) => !w.deployGated);
    for (const w of gated.slice(0, 3)) {
      evidence.push(`${w.path}: deploys (\`${w.deployCommands[0]!.slice(0, 70)}\`) behind a job dependency, environment or branch/manual trigger`);
    }
    for (const w of ungated.slice(0, 3)) {
      evidence.push(`${w.path}: deploys (\`${w.deployCommands[0]!.slice(0, 70)}\`) with no \`needs:\`, environment or branch condition in front of it`);
    }

    const claudeDeny = ctx.readJson<{ permissions?: { deny?: string[] } }>('.claude/settings.json')?.permissions?.deny ?? [];
    const blocksLocalDeploy = claudeDeny.some((d) => /deploy|publish|prod|remote/i.test(d));
    if (blocksLocalDeploy) {
      evidence.push('.claude/settings.json denies local agent deploy/production commands');
    }

    // The repository can deploy from a laptop: a deploy script or a platform config is present.
    const deployScripts = Object.keys(ctx.packageJson?.scripts ?? {}).filter((k) => /^(deploy|publish|release)([:._-].*)?$/.test(k));
    const hasWrangler = ctx.hasAnyFile(['wrangler.toml', 'wrangler.jsonc', 'wrangler.json']) !== undefined;
    const canDeployLocally = deployScripts.length > 0 || hasWrangler;

    let status: CheckResult['status'] = 'info';
    if (ungated.length > 0) {
      status = 'warn';
    } else if (gated.length > 0 || blocksLocalDeploy) {
      status = 'pass';
    } else if (canDeployLocally) {
      status = 'warn';
      evidence.push(
        `Deploys happen outside CI (${deployScripts.length > 0 ? `package script \`${deployScripts[0]}\`` : 'wrangler config'} present) and nothing stops an agent running them from a local checkout`,
      );
    } else {
      evidence.push('No deploy workflow or local deploy command detected');
    }

    const denyExample = hasWrangler ? '`Bash(npx wrangler deploy:*)`, `Bash(bunx wrangler deploy:*)`' : deployScripts.length > 0 ? `\`Bash(npm run ${deployScripts[0]}:*)\`` : '`Bash(<your deploy command>:*)`';
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
        en:
          ungated.length > 0
            ? `Put the deploy job in ${ungated[0]!.path} behind the verify job (\`needs: [verify]\`) or a protected \`environment:\`, and deny local deploys in \`.claude/settings.json\` (${denyExample}).`
            : `Deny local deploy commands for agents in \`.claude/settings.json\` \`permissions.deny\` (${denyExample}) and say in \`AGENTS.md\` which path is the only way to production.`,
        pl:
          ungated.length > 0
            ? `Uzależnij zadanie deploy w ${ungated[0]!.path} od zadania weryfikacji (\`needs: [verify]\`) lub chronionego \`environment:\` i zablokuj lokalny deploy w \`.claude/settings.json\` (${denyExample}).`
            : `Zablokuj agentom lokalne komendy deploy w \`permissions.deny\` w \`.claude/settings.json\` (${denyExample}) i napisz w \`AGENTS.md\`, która ścieżka jest jedyną drogą na produkcję.`,
      },
      docsPath: 'workflows/operate/codebase-health/',
    });
  }

  return results;
}
