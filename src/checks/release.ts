import { deployScriptGuards, localDeployCommands, minimalVerifySet } from '../capabilities.js';
import { guardHooks } from './harness.js';
import type { RepoContext } from '../fs-scanner.js';
import type { CheckResult } from '../types.js';

export function runReleaseChecks(ctx: RepoContext): Array<CheckResult> {
  const results: Array<CheckResult> = [];

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

    const evidence: Array<string> = [];
    if (allCiFiles.length === 0) {
      evidence.push('No CI pipeline found (.github/workflows/*.yml, .gitlab-ci.yml, .circleci/config.yml, etc.)');
      const onDefault = (ctx.git.defaultBranchOnly ?? []).filter((f) => f.startsWith('.github/workflows/'));
      if (onDefault.length > 0) {
        evidence.push(`${ctx.git.defaultBranch} has ${onDefault.slice(0, 3).join(', ')}: this branch is ${ctx.git.behindDefault} commit(s) behind it, so re-run the audit there for what ships`);
      }
    } else {
      evidence.push(`CI workflows (${allCiFiles.length}): ${allCiFiles.slice(0, 5).join(', ')}${allCiFiles.length > 5 ? ', …' : ''}`, `Pull requests are gated on — tests: ${mark('test')} · lint: ${mark('lint')} · typecheck: ${mark('typecheck')}`);
      for (const dead of ci.workflows.filter((w) => w.deadBranches)) {
        evidence.push(`${dead.path} is filtered to ${(dead.deadBranches ?? []).map((b) => `\`${b}\``).join(', ')}, but the default branch is \`${ctx.git.defaultBranch}\`: pushes and pull requests to it never start this workflow`);
      }
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
    } else if (ctx.sourceFiles.length === 0 && ctx.verify.commands.length === 0) {
      // Documentation or configuration only: there is no program for CI to verify.
      status = 'info';
      evidence.push('No source code detected — no verification pipeline to require');
    }

    // The same minimal set a brief should quote: never a watcher, always the build when there is one.
    const gateCommand = minimalVerifySet(ctx.verify).join('`, `');
    const missingOnPr = (['test', 'lint', 'typecheck'] as const).filter((k) => !gates(k));
    const deadWorkflow = ci.workflows.find((w) => w.deadBranches);

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
          deadWorkflow
            ? `Point ${deadWorkflow.path} at the default branch: change its \`branches:\` filter to \`[${ctx.git.defaultBranch}]\` (or drop the filter), so the checks it defines actually run.`
            : allCiFiles.length === 0
            ? `Add a CI workflow triggered on \`pull_request\` that installs from the lockfile and runs ${gateCommand ? `\`${gateCommand}\`` : 'your lint, typecheck and test commands'} before merge.`
            : !ctx.verify.kinds.has('test') && missingOnPr.includes('test')
              ? `There is no test command to run yet: write the first tests (see verification.unit-tests), then add them to the pull-request workflow next to ${gateCommand ? `\`${gateCommand}\`` : 'the static checks'}.`
              : `Run ${missingOnPr.join(' and ')} on \`pull_request\`${gateCommand ? ` (e.g. \`${gateCommand}\`)` : ''} so a red result blocks the merge, not just the main branch.`,
        pl:
          deadWorkflow
            ? `Skieruj ${deadWorkflow.path} na gałąź domyślną: zmień filtr \`branches:\` na \`[${ctx.git.defaultBranch}]\` (lub go usuń), aby zdefiniowane w nim sprawdzenia faktycznie działały.`
            : allCiFiles.length === 0
            ? `Dodaj workflow CI wyzwalany na \`pull_request\`, który instaluje zależności z lockfile’a i uruchamia ${gateCommand ? `\`${gateCommand}\`` : 'lint, typecheck oraz testy'} przed scaleniem.`
            : !ctx.verify.kinds.has('test') && missingOnPr.includes('test')
              ? `Nie ma jeszcze komendy testów: napisz pierwsze testy (patrz verification.unit-tests), a potem dodaj je do workflow na pull requestach obok ${gateCommand ? `\`${gateCommand}\`` : 'sprawdzeń statycznych'}.`
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

    const evidence: Array<string> = [];
    let status: CheckResult['status'];

    if (templatePath) {
      const content = ctx.readText(templatePath) ?? '';
      const hasChecklist = /-\s*\[\s*\]/.test(content) || /^\s*\|.*\|\s*$/m.test(content);
      // Language-neutral: a heading about verification in any of the common spellings, or a
      // command in backticks the author is asked to run.
      const hasEvidenceTerms =
        /(test|verif|weryfik|evidence|dow[oó]d|screenshot|zrzut|risk|ryzyk|rollback|wycofan|migration|migrac|command|komend|output|wynik|pr[uü]f|prueba|preuve)/i.test(content) ||
        /`[^`\n]{3,}`/.test(content);
      evidence.push(`${templatePath} found`);
      if (hasChecklist) {evidence.push('Includes verification checklist');}
      if (hasEvidenceTerms) {evidence.push('Prompts for verification evidence / risk notes');}

      status = hasChecklist && hasEvidenceTerms ? 'pass' : 'warn';
      if (!hasChecklist) {evidence.push('No checklist items (`- [ ]`) for the author or agent to tick');}
      if (!hasEvidenceTerms) {evidence.push('Does not ask for verification commands, results, risk or rollback notes');}
    } else {
      // Nobody else reads a solo repo's pull requests, so the missing template is a gap, not a failure.
      status = solo ? 'warn' : 'fail';
      evidence.push(
        solo
          ? `No pull request template (${ctx.teamLabel.toLowerCase()}: agent-written PRs have no fixed evidence format to fill in)`
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

    // A repository that resolves no packages (an Xcode app without SPM, a docs repo) has nothing to update.
    const resolves = ctx.stack.packageManagers.some((pm) => !['make', 'cmake', 'xcodebuild'].includes(pm)) || ctx.findFiles((f) => /(^|\/)Package\.resolved$/.test(f)).length > 0;
    const status: CheckResult['status'] = depConfigs.length > 0 ? 'pass' : resolves ? 'warn' : 'info';

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
          : resolves
            ? ['No Renovate or Dependabot configuration found']
            : ['No package dependencies to keep up to date'],
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
    const signals: Array<string> = [];
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
      if (ctx.hasDependency(dep) && !signals.includes(label)) {signals.push(label);}
    }
    // SDK families by name, in the root package and its workspace members: `@sentry/react-native`,
    // `posthog-react-native`, `@opentelemetry/sdk-node`, `langsmith`.
    const depNames = [ctx.packageJson, ...ctx.workspaceManifests.map((m) => m.manifest)].flatMap((p) => Object.keys({ ...p?.dependencies, ...p?.devDependencies }));
    const depFamilies: Array<[RegExp, string]> = [
      [/^@sentry\//, 'Sentry'],
      [/^@opentelemetry\//, 'OpenTelemetry'],
      [/^posthog-/, 'PostHog'],
      [/^(dd-trace|@datadog\/.+)$/, 'Datadog'],
      [/^@bugsnag\//, 'Bugsnag'],
      [/crashlytics/, 'Firebase Crashlytics'],
      [/^langsmith$/, 'LangSmith tracing'],
    ];
    for (const [family, label] of depFamilies) {
      if (depNames.some((d) => family.test(d)) && !signals.includes(label)) {signals.push(label);}
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
      [/opentelemetry|\botel\b/i, 'OpenTelemetry'],
      [/posthog/i, 'PostHog'],
      [/crashlytics/i, 'Firebase Crashlytics'],
      [/datadog|bugsnag|honeybadger|rollbar/i, 'Error tracking SDK'],
      [/structlog|zerolog|\bzap\b|\bslog\b|\btimber\b/i, 'Structured logging'],
      [/schemaDirectory|room\.schemaLocation/i, 'Room schema export (versioned migrations)'],
      [/alembic/i, 'Alembic migrations'],
    ];
    for (const [pattern, label] of manifestSignals) {
      if (pattern.test(manifestText) && !signals.includes(label)) {signals.push(label);}
    }

    // Workers Logs and Traces switched on in the Worker config are structured telemetry.
    const workerConfigs = ctx.findFiles((f) => /(^|\/)wrangler\.(toml|jsonc|json)$/.test(f) && f.split('/').length <= 3);
    if (workerConfigs.some((f) => /\[observability[\w.]*\][\s\S]{0,200}?enabled\s*=\s*true|"observability"\s*:\s*\{[\s\S]{0,200}?"enabled"\s*:\s*true/.test(ctx.readText(f) ?? ''))) {
      signals.push('Workers observability (logs/traces enabled in wrangler config)');
    }
    // The repository's own telemetry module (`src/posthog.ts`, `lib/logger.ts`) when no SDK is a dependency.
    const telemetryModule = ctx.sourceFiles.find((f) => /(^|\/)(posthog|sentry|telemetry|otel|tracing|logger|logging)\.[a-z]+$/i.test(f));
    if (telemetryModule && !signals.some((s) => /Sentry|PostHog|OpenTelemetry|logging/i.test(s))) {signals.push(`Telemetry module (${telemetryModule})`);}
    // Migration tooling says how the schema changes, not what the running app reports.
    const telemetrySignals = signals.filter((s) => !/migration|schema export/i.test(s)).length;
    if (ctx.findFiles((f) => /(^|\/)migrations\//.test(f)).length > 0) {
      signals.push('Versioned migrations directory');
    }
    if (workerConfigs.some((f) => /^\s*\[\[migrations\]\]|"migrations"\s*:\s*\[/m.test(ctx.readText(f) ?? ''))) {
      signals.push('Durable Object migrations versioned in the Worker config');
    }
    // A health route: a file named for it, or the path in the code that serves requests.
    const HEALTH_ROUTE = /['"`]\/(?:api\/)?(?:health|healthz|healthcheck|readyz|livez)['"`/]/;
    // A server, not a client that calls one: a mobile app's `fetch('/health')` is not its own endpoint.
    const SERVER_FRAMEWORKS = new Set(['Express', 'Fastify', 'Hono', 'NestJS', 'FastAPI', 'Django', 'Flask', 'Rails', 'Laravel', 'Phoenix', 'Spring Boot', 'Cloudflare Workers', 'Next.js', 'Nuxt', 'SvelteKit', 'Astro']);
    const isMobileClient = ctx.stack.frameworks.some((fw) => ['Expo', 'Android', 'SwiftUI', 'Flutter'].includes(fw));
    const servesRequests = !isMobileClient && (ctx.stack.frameworks.some((fw) => SERVER_FRAMEWORKS.has(fw)) || workerConfigs.length > 0 || ctx.hasFile('Dockerfile'));
    const servesHealth =
      servesRequests &&
      (ctx.findFiles((f) => /(^|\/)health(\.[a-z]+)?$/.test(f)).length > 0 ||
        [...ctx.sourceFiles].sort((a, b) => a.split('/').length - b.split('/').length).slice(0, 300).some((f) => HEALTH_ROUTE.test(ctx.readText(f) ?? '')));
    if (servesHealth) {
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
    let status: CheckResult['status'];
    if (isApp && telemetrySignals === 0 && signals.length > 0) {
      // Migrations are versioned, but nothing reports an error from the running app.
      status = 'warn';
      signals.push('No error tracking or structured logging detected (Sentry, OpenTelemetry, PostHog, Workers observability)');
    } else if (signals.length >= 1) {
      status = 'pass';
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
      fix: ctx.stack.frameworks.some((fw) => ['Android', 'SwiftUI', 'Flutter', 'Expo', 'Jetpack Compose'].includes(fw)) || ctx.stack.packageManagers.includes('xcodebuild')
        ? {
            // An app on a phone has no healthcheck to poll: it reports its own crashes.
            en: 'Wire crash and error reporting (Firebase Crashlytics, Sentry or MetricKit) and keep the on-device schema versioned (Room schema export, Core Data model versions).',
            pl: 'Podepnij raportowanie awarii i błędów (Firebase Crashlytics, Sentry lub MetricKit) i wersjonuj schemat danych na urządzeniu (eksport schematu Room, wersje modelu Core Data).',
          }
        : {
            en: 'Wire error tracking/telemetry (Sentry, OpenTelemetry, or structured logs), a healthcheck endpoint, and versioned database migrations with rollback notes.',
            pl: 'Podepnij śledzenie błędów/telemetrię (Sentry, OpenTelemetry lub logi strukturalne), endpoint healthcheck oraz wersjonowane migracje bazy z opisem wycofania.',
          },
      docsPath: 'workflows/operate/codebase-health/',
    });
  }

  // 5. release.deploy-safety
  {
    const evidence: Array<string> = [];
    // A deploy is a command that ships; `wrangler deploy --dry-run` in a verify job is a build check.
    const deployWorkflows = ci.workflows.filter((w) => w.deployCommands.length > 0);
    const gated = deployWorkflows.filter((w) => w.deployGated);
    const ungated = deployWorkflows.filter((w) => !w.deployGated);
    for (const w of gated.slice(0, 3)) {
      evidence.push(`${w.path}: deploys (\`${(w.deployCommands[0] ?? '').slice(0, 70)}\`) behind a job dependency, environment or branch/manual trigger`);
    }
    for (const w of ungated.slice(0, 3)) {
      evidence.push(`${w.path}: deploys (\`${(w.deployCommands[0] ?? '').slice(0, 70)}\`) with no \`needs:\`, environment or branch condition in front of it`);
    }

    // The platform deploys from git only when someone wrote that down: "Workers Builds" (the
    // product that does exactly this) or a sentence saying deploys happen on merge or push. A
    // brand name on its own ("Vercel AI SDK") says nothing about how this repository ships.
    // "Workers Builds" next to a word about shipping, or "deploys … on merge/push". The product's
    // name beside something else ("Workers Builds reads packageManager") is not a statement about deploys.
    const GIT_DEPLOY = /\bWorkers Builds\b[^.\n]{0,40}\b(?:deploy\w*|ships?|builds? (?:every|each|on)|releases?)\b|\b(?:deploy\w*|ships?|merg\w+)\b[^.\n]{0,60}\bWorkers Builds\b|\bdeploy\w*\b[^.\n]{0,60}\b(?:on|after|upon)\s+(?:every\s+|each\s+)?(?:merge|push)\b/i;
    const platformLine = [...ctx.brief.files, ...ci.files, ...['README.md', 'wrangler.toml', 'wrangler.jsonc'].filter((f) => ctx.hasFile(f))]
      .flatMap((f) => (ctx.readText(f) ?? '').split(/\r?\n/).map((text, i) => ({ f, line: i + 1, text })))
      // A line about `--dry-run` describes a check, not how the repository ships.
      .find((l) => GIT_DEPLOY.test(l.text) && !/--dry-run\b/.test(l.text));
    const platform = platformLine !== undefined;
    if (platformLine && deployWorkflows.length === 0) {
      // Quote the sentence that says it, whole words only.
      // The line matched as a whole; when no single sentence of it does, the whole line is the quote.
      const sentence = (platformLine.text.split(/(?<=[.!?;])\s+/).find((s) => GIT_DEPLOY.test(s)) ?? platformLine.text).trim().replace(/^[-*#>\s]+/, '');
      const quote = sentence.length > 120 ? `${sentence.slice(0, sentence.lastIndexOf(' ', 120))}…` : sentence;
      evidence.push(`${platformLine.f}:${platformLine.line} mentions a git-triggered deploy: "${quote}"`);
    }

    // What can ship from a laptop, and which of it a committed deny rule stops.
    const localDeploys = localDeployCommands(ctx);
    const claudeDeny = ctx.readJson<{ permissions?: { deny?: Array<string> } }>('.claude/settings.json')?.permissions?.deny ?? [];
    // `bun run deploy` is covered by a rule naming the script under any runner; `npx wrangler deploy`
    // by one naming the CLI call. The rule has to be that command or a prefix of it: a rule for
    // `wrangler deploy --dry-run` or for the script `deploy:preview` denies neither.
    const denyPatterns = claudeDeny
      .map((rule) => /^Bash\((.*)\)$/.exec(rule)?.[1])
      .filter((p): p is string => p !== undefined)
      .map((p) => bare(p.replace(/^\*\s+/, '').replace(/(?::\*|\s*\*)$/, '')));
    const denied = (command: string): boolean => {
      const needle = bare(command);
      return denyPatterns.some((p) => p !== '' && (needle === p || needle.startsWith(`${p} `)));
    };
    const guards = guardHooks(ctx);
    // A deploy script that opens with its own guard decides for itself where it may run from.
    const scriptGuards = deployScriptGuards(ctx);
    const selfGuarded = localDeploys.filter((c) => scriptGuards.has(c));
    const unguarded = guards.length > 0 ? [] : localDeploys.filter((c) => !denied(c) && !scriptGuards.has(c));
    if (localDeploys.length > 0 && guards.length > 0) {
      evidence.push(`A PreToolUse guard hook decides on deploy commands before they run: ${guards.join(', ')} (read it for what it allows from the main checkout)`);
    } else if (localDeploys.length > 0) {
      if (selfGuarded.length > 0) {
        evidence.push(`${code(selfGuarded)} ${selfGuarded.length === 1 ? 'opens' : 'open'} with \`${scriptGuards.get(selfGuarded[0] ?? '')}\`, a guard that decides whether this checkout may ship`);
      }
      const denyCovered = localDeploys.filter((c) => denied(c) && !scriptGuards.has(c));
      if (unguarded.length > 0) {
        evidence.push(
          selfGuarded.length > 0 || denyCovered.length > 0
            ? `Neither a guard nor a deny rule covers ${code(unguarded)}`
            : `Nothing stops an agent running ${code(unguarded)} from a local checkout`,
        );
      } else if (denyCovered.length > 0) {
        evidence.push(`.claude/settings.json denies ${selfGuarded.length > 0 ? 'the rest' : 'every local deploy command'} (${code(denyCovered)})`);
      }
    }

    // Merging is the deploy, and nothing checks a pull request first: every merge ships untested.
    const mergeShipsUnchecked = platform && deployWorkflows.length === 0 && ci.prKinds.size === 0;
    if (mergeShipsUnchecked) {evidence.push('Merges deploy to production and no pull-request check runs first');}

    let status: CheckResult['status'];
    if (mergeShipsUnchecked) {
      status = 'fail';
    } else if (ungated.length > 0) {
      status = 'warn';
    } else if (localDeploys.length > 0) {
      status = unguarded.length === 0 ? 'pass' : 'warn';
    } else if (gated.length > 0 || platform) {
      status = 'pass';
    } else {
      status = 'info';
      evidence.push('No deploy workflow or local deploy command detected');
    }

    const denyExample = unguarded.length > 0 ? unguarded.slice(0, 3).map((c) => `\`Bash(${c}:*)\``).join(', ') : '`Bash(<your deploy command>:*)`';
    results.push({
      id: 'release.deploy-safety',
      station: 'release',
      weight: 15,
      status,
      severity: status === 'fail' ? 'high' : status === 'warn' ? 'medium' : 'low',
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
          mergeShipsUnchecked
            ? `A merge ships to production here, so add a pull-request workflow that runs ${minimalVerifySet(ctx.verify).length > 0 ? `\`${minimalVerifySet(ctx.verify).join('`, `')}\`` : 'your checks'} and require it before merging.`
            : ungated.length > 0
            ? `Put the deploy job in ${ungated[0]?.path ?? ''} behind the verify job (\`needs: [verify]\`) or a protected \`environment:\`${unguarded.length > 0 ? `, and deny local deploys in \`.claude/settings.json\` (${denyExample})` : ''}.`
            : unguarded.length > 0
              ? `Add to \`permissions.deny\` in \`.claude/settings.json\`: ${denyExample}.`
              : 'Keep the deny list in step with new deploy scripts.',
        pl:
          mergeShipsUnchecked
            ? `Scalenie wdraża tu na produkcję, więc dodaj workflow na pull requestach uruchamiający ${minimalVerifySet(ctx.verify).length > 0 ? `\`${minimalVerifySet(ctx.verify).join('`, `')}\`` : 'sprawdzenia'} i wymagaj go przed scaleniem.`
            : ungated.length > 0
            ? `Uzależnij zadanie deploy w ${ungated[0]?.path ?? ''} od zadania weryfikacji (\`needs: [verify]\`) lub chronionego \`environment:\`${unguarded.length > 0 ? ` i zablokuj lokalny deploy w \`.claude/settings.json\` (${denyExample})` : ''}.`
            : unguarded.length > 0
              ? `Dodaj do \`permissions.deny\` w \`.claude/settings.json\`: ${denyExample}.`
              : 'Aktualizuj listę deny wraz z nowymi skryptami deploy.',
      },
      docsPath: 'workflows/operate/codebase-health/',
    });
  }

  return results;
}

function bare(command: string): string {
  return command.replace(/^(npx|bunx)\s+/, '').replace(/^(?:npm|pnpm|bun|yarn|vp)\s+(?:run\s+)?/, '').trim();
}

function code(commands: Array<string>): string {
  return commands.map((c) => `\`${c}\``).join(', ');
}
