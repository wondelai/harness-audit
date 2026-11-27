import { hasMapSection } from '../brief.js';
import type { RepoContext } from '../fs-scanner.js';
import type { CheckResult } from '../types.js';

/** A long-running local server or local runtime state: what parallel checkouts collide on. */
function hasDevServer(ctx: RepoContext): boolean {
  const serverDeps = ['next', 'astro', 'express', 'fastify', 'hono', 'vite', '@nestjs/core', 'nuxt', '@sveltejs/kit', '@remix-run/dev', 'react-router', 'expo'];
  if (serverDeps.some((d) => ctx.hasDependency(d))) return true;
  if (ctx.hasAnyFile(['wrangler.toml', 'wrangler.jsonc', 'wrangler.json', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'manage.py']) !== undefined) return true;
  return ctx.stack.frameworks.some((f) => ['FastAPI', 'Django', 'Flask', 'Rails', 'Laravel', 'Phoenix', 'Spring Boot'].includes(f));
}

export function runGraphChecks(ctx: RepoContext): CheckResult[] {
  const results: CheckResult[] = [];
  const brief = `${ctx.readText('AGENTS.md') ?? ''}\n${ctx.readText('CLAUDE.md') ?? ''}`;

  // 1. graph.worktree-isolation
  {
    const wtFiles = ctx.findFiles((f) => /^(bin|scripts)\/(wt|worktree)([.-].*)?$/.test(f) || f === '.worktreeinclude');
    // On this machine only: another clone, or an agent's fresh checkout, never gets an uncommitted file.
    const wtScripts = wtFiles.filter((f) => ctx.isTracked(f) !== false);
    const wtLocalOnly = wtFiles.filter((f) => ctx.isTracked(f) === false);
    const pkgScripts = Object.keys(ctx.packageJson?.scripts ?? {}).filter((k) =>
      /worktree|\bwt\b/i.test(k),
    );
    // A brief that has agents share one tree says the opposite of a worktree convention.
    const sharesOneTree =
      /\b(?:same|one|single|shared)\s+(?:git\s+)?worktree\b/i.test(brief) &&
      !/\b(?:own|separate|dedicated|new|fresh|isolated|per[- ]task)\s+(?:git\s+)?worktree|git worktree add|--worktree\b|\bbin\/wt\b/i.test(brief);
    const briefMentionsWorktree = /\bworktree\b/i.test(brief) && !sharesOneTree;

    const evidence: string[] = [];
    if (wtScripts.length > 0) evidence.push(`Worktree tooling: ${wtScripts.join(', ')}`);
    if (pkgScripts.length > 0) evidence.push(`Package scripts: ${pkgScripts.join(', ')}`);
    if (wtLocalOnly.length > 0) evidence.push(`Not committed yet, so no other checkout has it: ${wtLocalOnly.join(', ')}`);
    if (briefMentionsWorktree) evidence.push('Worktree workflow documented in root instructions');
    if (sharesOneTree) evidence.push('The brief has several agents work in the same worktree: their edits, builds and test runs share one directory');

    // Two agents in one tree collide hardest on ports and local state. A repository with neither
    // (a CLI, a library, a mobile app) risks overlapping edits only, which a one-line convention covers.
    const hasLocalState = hasDevServer(ctx);
    // A helper script is a convention in itself. `.worktreeinclude` only lists what a new worktree
    // copies: without a word in the brief, nothing tells a second agent to make one.
    const helperScripts = wtScripts.filter((f) => f !== '.worktreeinclude');
    const includeOnly = helperScripts.length === 0 && pkgScripts.length === 0 && wtScripts.length > 0 && !briefMentionsWorktree;
    if (includeOnly) evidence.push('.worktreeinclude lists what a new worktree needs, but no brief says that a second agent should work in one');
    let status: CheckResult['status'] = 'warn';
    if (includeOnly) {
      status = 'warn';
    } else if (wtScripts.length > 0 || pkgScripts.length > 0) {
      status = 'pass';
    } else if (briefMentionsWorktree || wtLocalOnly.length > 0) {
      status = 'warn';
    } else {
      // In a repository of a handful of files, a second checkout is a rare need: advice, not a failure.
      // The same goes for one person's repository: a failure is for a team whose agents share a dev server.
      status = hasLocalState && ctx.sourceFiles.length >= 20 && !ctx.isSolo ? 'fail' : 'warn';
      evidence.push(
        hasLocalState
          ? 'No git worktree scripts, .worktreeinclude, or parallel checkout workflow documented'
          : 'No worktree convention documented (no dev server or local state here, so the risk is overlapping edits, not colliding ports)',
      );
    }

    results.push({
      id: 'graph.worktree-isolation',
      station: 'graph',
      weight: 35,
      status,
      severity: status === 'fail' ? 'medium' : 'low',
      title: {
        en: 'Git worktree isolation for parallel agents',
        pl: 'Izolacja git worktree dla równoległych agentów',
      },
      evidence,
      why: {
        en: 'Running two agents in the same working tree causes overwritten edits, dirty git states, and broken test runs.',
        pl: 'Uruchamianie wielu agentów w tym samym katalogu roboczym prowadzi do nadpisywania zmian, brudnego stanu gita i zafałszowanych testów.',
      },
      fix: {
        en: `Say in ${ctx.brief.primary} how a second agent gets its own checkout: a small worktree helper script, or the \`git worktree\` / \`claude --worktree\` convention plus a \`.worktreeinclude\` listing the untracked config a fresh worktree needs.`,
        pl: `Napisz w ${ctx.brief.primary}, jak drugi agent dostaje własny checkout: mały skrypt do worktree albo konwencję \`git worktree\` / \`claude --worktree\` oraz \`.worktreeinclude\` z listą nieśledzonej konfiguracji potrzebnej w nowym worktree.`,
      },
      docsPath: 'workflows/harness/git-worktrees/',
    });
  }

  // 2. graph.port-and-state-isolation
  {
    const evidence: string[] = [];
    const envFiles = ['.env.example', '.env.test.example', '.dev.vars.example', '.wt-env'];
    let hasPortEnv = false;
    for (const ef of envFiles) {
      const content = ctx.readText(ef);
      if (content && /\b(PORT|APP_PORT|DEV_PORT|API_PORT|WEB_PORT)\s*=/m.test(content)) {
        hasPortEnv = true;
        evidence.push(`${ef} exposes configurable port variable(s)`);
      }
    }
    if (ctx.hasFile('.wt-env')) {
      evidence.push('.wt-env allocates per-worktree ports');
    }
    // The dev server takes its port from the environment: a worktree helper that allocates one per
    // checkout, a config that reads it, or a dev script that passes it on.
    const devScripts = Object.entries(ctx.packageJson?.scripts ?? {}).filter(([n]) => /^(dev|start|serve)/.test(n)).map(([, b]) => b);
    const wtAllocates = ctx.findFiles((f) => /^(bin|scripts)\/(wt|worktree)([.-].*)?$/.test(f)).find((f) => /(?:^|[^A-Za-z])PORT\b/m.test(ctx.readText(f) ?? ''));
    const portReader = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'astro.config.mjs', 'astro.config.ts', 'next.config.js', 'next.config.mjs', 'next.config.ts'].find((f) =>
      /\b(?:process\.env|import\.meta\.env|env)\.(?:[A-Z0-9]+_)*PORT\b|\benv\[['"](?:[A-Z0-9]+_)*PORT['"]\]/.test(ctx.readText(f) ?? ''),
    );
    if (!hasPortEnv && (wtAllocates || portReader || devScripts.some((b) => /\$\{?(?:[A-Z0-9]+_)*PORT\b/.test(b)))) {
      hasPortEnv = true;
      evidence.push(
        wtAllocates ? `${wtAllocates} allocates a port per worktree` : portReader ? `${portReader} reads the dev server port from the environment` : 'The dev script takes its port from the environment',
      );
    }

    const hasEphemeralLocalState =
      ctx.hasAnyFile(['wrangler.toml', 'wrangler.jsonc', 'wrangler.json']) !== undefined ||
      ctx.hasFile('docker-compose.yml') ||
      ctx.hasFile('docker-compose.yaml') ||
      ctx.hasDependency('testcontainers') ||
      ctx.hasDependency('@testcontainers/postgresql') ||
      ctx.hasDependency('better-sqlite3') ||
      ctx.hasDependency('@cloudflare/vitest-pool-workers') ||
      /sqlite|:memory:|testcontainers|miniflare|tmp_path|tmpdir/i.test(
        ctx.readText('vitest.config.ts') ??
          ctx.readText('vite.config.ts') ??
          ctx.readText('playwright.config.ts') ??
          ctx.readText('pyproject.toml') ??
          '',
      );

    if (hasEphemeralLocalState) {
      evidence.push('Local ephemeral / isolated runtime state detected (Miniflare, Docker, SQLite, Testcontainers, or tmpdir)');
    }

    const isPureLibrary = !hasDevServer(ctx);

    // A port written into the config or the dev script: two checkouts cannot both bind it.
    const fixedPort =
      /\[dev\][^\[]*?\bport\s*=\s*(\d+)/.exec(ctx.readText('wrangler.toml') ?? '')?.[1] ??
      /--port[= ](\d{2,5})\b/.exec(devScripts.join('\n'))?.[1];
    // A literal `--port 8790` in the dev script is fixed even when an env template offers PORT: the script never reads it.
    const scriptPort = /--port[= ](\d{2,5})\b/.exec(devScripts.join('\n'))?.[1];
    const literalPort = scriptPort !== undefined && !devScripts.some((b) => /\$\{?(?:[A-Z0-9]+_)*PORT\b/.test(b));
    const portIsFixed = literalPort || Boolean(fixedPort && !hasPortEnv);
    if (portIsFixed) evidence.push(`Dev server port ${scriptPort ?? fixedPort} is fixed in the config: parallel checkouts collide on it`);
    // A dev script that frees its port by force takes it from whoever holds it, another checkout included.
    const killed = devScripts.map((b) => /lsof\s+-ti\s*:?\s*(\d{2,5})[^|]*\|\s*xargs\s+kill|kill-port\s+(\d{2,5})/.exec(b)).find(Boolean);
    const killedPort = killed?.[1] ?? killed?.[2];
    if (killedPort) evidence.push(`The dev script kills whatever holds port ${killedPort}: starting it in one checkout stops another checkout's server`);

    let status: CheckResult['status'] = 'warn';
    if (portIsFixed || killedPort) {
      status = 'warn';
    } else if (hasPortEnv && hasEphemeralLocalState) {
      status = 'pass';
    } else if (hasPortEnv || hasEphemeralLocalState || isPureLibrary) {
      status = isPureLibrary && !hasPortEnv && !hasEphemeralLocalState ? 'info' : 'pass';
      if (isPureLibrary && evidence.length === 0) {
        evidence.push('No long-running dev server detected (mobile app, library or CLI) — no ports to collide');
      }
    } else {
      status = 'warn';
      evidence.push('No configurable PORT env vars or isolated local state setup detected for parallel checkouts');
    }

    results.push({
      id: 'graph.port-and-state-isolation',
      station: 'graph',
      weight: 35,
      status,
      severity: 'medium',
      title: {
        en: 'Port & local state isolation per checkout',
        pl: 'Izolacja portów i lokalnego stanu per checkout',
      },
      evidence,
      why: {
        en: 'Parallel worktrees collide immediately if every agent binds port 3000 or shares a single mutable local database.',
        pl: 'Równoległe worktree natychmiast ze sobą kolidują, jeśli każdy agent zajmuje port 3000 lub współdzieli jedną lokalną bazę danych.',
      },
      fix: {
        en: 'Parameterize dev/test server ports via env vars (`.env.example` / `.wt-env`) and give each checkout or test run ephemeral local state (Miniflare, SQLite, Testcontainers, or tmpdir).',
        pl: 'Sparametryzuj porty serwerów dev/test przez zmienne środowiskowe (`.env.example` / `.wt-env`) i zapewnij każdemu checkoutowi izolowany lokalny stan (Miniflare, SQLite, Testcontainers lub tmpdir).',
      },
      docsPath: 'workflows/harness/ephemeral-environments/',
    });
  }

  // 3. graph.subagent-definitions
  {
    const agentFiles = ctx.findFiles((f) =>
      /^(\.claude|\.cursor|\.codex)\/agents\/.+\.md$/i.test(f) ||
      /^\.factory\//.test(f) ||
      f === 'loops.yaml' ||
      f === 'loops.yml',
    );
    const orchestrationDocs = ctx.findFiles((f) =>
      /^(docs\/agents\/|scripts\/workflows\/)/i.test(f),
    );

    const evidence: string[] = [];
    if (agentFiles.length > 0) evidence.push(`Agent/loop definitions: ${agentFiles.slice(0, 6).join(', ')}`);
    if (orchestrationDocs.length > 0) evidence.push(`Agent docs/workflows: ${orchestrationDocs.slice(0, 5).join(', ')}`);

    const status: CheckResult['status'] =
      // Docs about orchestration are not definitions, and having them must not read worse than having nothing.
      agentFiles.length > 0 ? 'pass' : 'info';
    if (evidence.length === 0) {
      evidence.push('No versioned subagent definitions (.claude/agents/, .cursor/agents/, .factory/, loops.yaml) yet');
    }

    results.push({
      id: 'graph.subagent-definitions',
      station: 'graph',
      weight: 20,
      status,
      severity: 'low',
      title: {
        en: 'Subagent & loop topology definitions',
        pl: 'Definicje podagentów i topologii pętli',
      },
      evidence,
      why: {
        en: 'Separating planner, builder, and reviewer roles into committed agent specs (or a `loops.yaml` register) prevents context pollution and unreviewed self-approval.',
        pl: 'Rozdzielenie ról planisty, wykonawcy i recenzenta na wersjonowane definicje agentów (lub rejestr `loops.yaml`) zapobiega zaśmiecaniu kontekstu i samozatwierdzaniu.',
      },
      fix: {
        en: 'When scaling to multi-agent runs, commit focused agent specs under `.claude/agents/` (e.g., read-only reviewer, test verifier) and track unattended loops in `loops.yaml`.',
        pl: 'Przy przechodzeniu na pracę wieloagentową dodaj wyspecjalizowane definicje w `.claude/agents/` (np. recenzent read-only, weryfikator testów) i opisz pętle w `loops.yaml`.',
      },
      docsPath: 'workflows/automate/orchestration-patterns/',
    });
  }

  // 4. graph.workspace-boundaries
  {
    const boundaryArtifacts: string[] = [];
    for (const f of ['pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'go.work', 'ARCHITECTURE.md']) {
      if (ctx.hasFile(f)) boundaryArtifacts.push(f);
    }
    if (ctx.packageJson?.workspaces) boundaryArtifacts.push('package.json workspaces');
    if (/\[workspace\]/.test(ctx.readText('Cargo.toml') ?? '')) boundaryArtifacts.push('Cargo.toml [workspace]');
    const gradleModules = (`${ctx.readText('settings.gradle.kts') ?? ''}\n${ctx.readText('settings.gradle') ?? ''}`.match(/["']:[\w:-]+["']/g) ?? []).length;
    if (gradleModules >= 2) boundaryArtifacts.push(`Gradle modules (${gradleModules} in settings.gradle)`);
    const swiftTargets = (ctx.readText('Package.swift') ?? '').match(/\.(?:target|testTarget|executableTarget)\(/g)?.length ?? 0;
    if (swiftTargets >= 2) boundaryArtifacts.push(`Swift package targets (${swiftTargets})`);
    // The same routing a scoped-context check credits: a map section, a path table, or nested briefs.
    const facts = ctx.brief;
    if (facts.hasModuleMap) {
      boundaryArtifacts.push(
        facts.routedDocs.length > 0
          ? `${facts.primary} maps areas to ${facts.routedDocs.length} doc(s) (${facts.routedDocs.slice(0, 2).join(', ')}${facts.routedDocs.length > 2 ? ', …' : ''})`
          : `Module map section in ${facts.primary}`,
      );
    }
    if (facts.nestedBriefs.length >= 2) boundaryArtifacts.push(`Nested briefs per area (${facts.nestedBriefs.length})`);
    if (ctx.findFiles((f) => /^docs\/[^/]*architecture[^/]*\.mdx?$/i.test(f)).length > 0) boundaryArtifacts.push('docs/ architecture doc');

    // An architecture section in the README is the map, written where no agent brief loads it.
    const readmeMap = boundaryArtifacts.length === 0 && hasMapSection(ctx.readText('README.md') ?? '');

    const status: CheckResult['status'] =
      boundaryArtifacts.length > 0 ? 'pass' : ctx.stack.monorepo && !readmeMap ? 'fail' : 'warn';

    results.push({
      id: 'graph.workspace-boundaries',
      station: 'graph',
      weight: 10,
      status,
      severity: status === 'fail' ? 'medium' : 'low',
      title: {
        en: 'Explicit module & workspace boundaries',
        pl: 'Jawne granice modułów i workspace’ów',
      },
      evidence:
        boundaryArtifacts.length > 0
          ? boundaryArtifacts
          : readmeMap
            ? [`README.md has an architecture / structure section, but ${ctx.brief.files.length > 0 ? `${ctx.brief.primary} does not point to it` : 'no agent brief loads it'}`]
            : [`No workspace config, architecture doc, nested briefs, or module map in ${ctx.brief.files.length > 0 ? ctx.brief.primary : 'a root brief'}`],
      why: {
        en: 'Clear module boundaries let you assign disjoint ownership slices to parallel agents without merge conflicts.',
        pl: 'Jasne granice modułów pozwalają przydzielać równoległym agentom rozłączne obszary odpowiedzialności bez konfliktów przy scalaniu.',
      },
      fix: {
        en: readmeMap
          ? `Link README.md's architecture section from ${ctx.brief.primary} (or move it there), and add for each directory the invariant an agent must keep.`
          : `Add a short "Read before you touch" table to ${ctx.brief.primary} (or an \`ARCHITECTURE.md\`) mapping each directory to its invariants and the doc that explains them.`,
        pl: readmeMap
          ? `Podlinkuj sekcję architektury z README.md w ${ctx.brief.primary} (lub ją tam przenieś) i dopisz dla każdego katalogu niezmiennik, którego agent ma pilnować.`
          : `Dodaj do ${ctx.brief.primary} (lub \`ARCHITECTURE.md\`) krótką tabelę „Read before you touch”, wiążącą każdy katalog z jego niezmiennikami i dokumentem, który je opisuje.`,
      },
      docsPath: 'workflows/build/',
    });
  }

  return results;
}
